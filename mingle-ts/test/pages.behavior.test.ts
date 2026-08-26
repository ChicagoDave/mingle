/**
 * Behavioral tests for the Wiki & Content page commands (Phase 16).
 *
 * Derived line-by-line from the rule 12 Behavior Statements: every DOES
 * asserts on rows reloaded from the database (never on return values
 * alone), and every REJECTS WHEN has its own independent rejection test
 * that also proves nothing mutated — including each authorization
 * branch separately, so the "may edit but may not delete" boundary is
 * pinned rather than inferred from the readonly sweep. Includes the
 * phase's exit-criterion real-path test: create + edit twice → the
 * current row and three ordered version rows read straight from the DB
 * (rule 13a).
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations — no stubs, no fakes.
 *
 * Owner context: Wiki & Content verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { projects } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import { teamMemberships } from "../app/db/schema/membership";
import { cards, cardTypes } from "../app/db/schema/cards";
import { pages, pageVersions } from "../app/db/schema/pages";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard } from "../app/domain/cards/commands.server";
import {
  createPage,
  deletePage,
  updatePage,
} from "../app/domain/pages/commands.server";
import {
  existingPageIdentifiers,
  findPage,
  findPageVersion,
  listPages,
  pageHistory,
  pageRenderContext,
  pageVersionTrail,
  pagesLinkingTo,
} from "../app/domain/pages/read.server";
import { renderPageContent } from "../app/domain/pages/content.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-pages-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let siteAdminId: number; //    site admin (first registered user)
let projectAdminId: number; // project_admin of the project
let memberId: number; //       full_member — may edit pages, may not delete
let readonlyId: number; //     readonly_member
let outsiderId: number; //     registered user, not on the team
let projectId: number;
let defaultTypeId: number;

function register(login: string): number {
  const result = registerUser(db, {
    login,
    name: login,
    password: "wiki-pages-2010!",
  });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(pageVersions).run();
  db.delete(pages).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  siteAdminId = register("boss");
  projectAdminId = register("lead");
  memberId = register("dev");
  readonlyId = register("viewer");
  outsiderId = register("outsider");
  projectId = mustOk(
    createProject(db, { name: "Wiki Land", identifier: "wiki_land", actorUserId: siteAdminId }),
    "test project creation",
  ).id;
  defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  for (const [userId, role] of [
    [projectAdminId, "project_admin"],
    [memberId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const) {
    mustOk(
      addTeamMember(db, { projectId, userId, role, actorUserId: siteAdminId }),
      `test membership setup for ${userId}`,
    );
  }
  db.delete(domainEvents).run(); // only events under test matter below
});

function reloadPage(identifier: string, inProject = projectId) {
  return findPage(db, inProject, identifier);
}

function versionsOf(pageId: number) {
  return db
    .select()
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(asc(pageVersions.version))
    .all();
}

function eventsOfType(type: string) {
  return db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
}

function allPages() {
  return db.select().from(pages).where(eq(pages.projectId, projectId)).all();
}

function allVersions() {
  return db
    .select()
    .from(pageVersions)
    .where(eq(pageVersions.projectId, projectId))
    .all();
}

function expectRejected<T>(
  result: CommandResult<T>,
  field: string,
  message: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors[field]).toContain(message);
}

function seedPage(name: string, content: string | null = "<p>Body</p>") {
  return mustOk(
    createPage(db, { projectId, name, content, actorUserId: memberId }),
    `test page seed for ${name}`,
  );
}

describe("createPage", () => {
  it("persists the page, its version 1, and a PageCreated event", () => {
    const created = createPage(db, {
      projectId,
      name: "Release Plan",
      content: "<p>Ship it</p>",
      actorUserId: memberId,
    });
    expect(created.ok).toBe(true);

    const row = reloadPage("Release_Plan")!;
    expect(row).toBeDefined();
    expect(row.name).toBe("Release Plan");
    expect(row.content).toBe("<p>Ship it</p>");
    expect(row.version).toBe(1);
    expect(row.createdByUserId).toBe(memberId);
    expect(row.modifiedByUserId).toBe(memberId);

    const versions = versionsOf(row.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].name).toBe("Release Plan");
    expect(versions[0].content).toBe("<p>Ship it</p>");
    expect(versions[0].isDeletion).toBe(false);

    const events = eventsOfType("PageCreated");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      projectId,
      name: "Release Plan",
      identifier: "Release_Plan",
    });
    expect(events[0].actorUserId).toBe(memberId);
  });

  it("stores the body sanitized, not as submitted", () => {
    seedPage("Danger", '<p onclick="steal()">Hi<script>steal()</script></p>');
    const row = reloadPage("Danger")!;
    expect(row.content).toBe("<p>Hi</p>");
    expect(versionsOf(row.id)[0].content).toBe("<p>Hi</p>");
  });

  it("stores an empty body as NULL rather than an empty string", () => {
    seedPage("Blank", "   ");
    const row = reloadPage("Blank")!;
    expect(row.content).toBeNull();
    expect(versionsOf(row.id)[0].content).toBeNull();
  });

  it("stores the editor's empty document as no body at all", () => {
    seedPage("Untouched", "<p></p>");
    expect(reloadPage("Untouched")!.content).toBeNull();
    seedPage("Cleared", "<p><br /></p>");
    expect(reloadPage("Cleared")!.content).toBeNull();
  });

  it("rejects an unknown project and writes nothing", () => {
    expectRejected(
      createPage(db, {
        projectId: projectId + 9999,
        name: "Ghost",
        actorUserId: memberId,
      }),
      "project",
      "does not exist",
    );
    expect(allPages()).toHaveLength(0);
    expect(allVersions()).toHaveLength(0);
  });

  it("rejects a readonly team member and writes nothing", () => {
    const result = createPage(db, {
      projectId,
      name: "Readonly Attempt",
      actorUserId: readonlyId,
    });
    expect(result.ok).toBe(false);
    expect(allPages()).toHaveLength(0);
    expect(allVersions()).toHaveLength(0);
    expect(eventsOfType("PageCreated")).toHaveLength(0);
  });

  it("rejects a user who is not on the team and writes nothing", () => {
    const result = createPage(db, {
      projectId,
      name: "Outsider Attempt",
      actorUserId: outsiderId,
    });
    expect(result.ok).toBe(false);
    expect(allPages()).toHaveLength(0);
  });

  it("rejects a blank name", () => {
    expectRejected(
      createPage(db, { projectId, name: "   ", actorUserId: memberId }),
      "name",
      "Name can't be blank.",
    );
    expect(allPages()).toHaveLength(0);
  });

  it("rejects a name containing a slash, naming the offending name", () => {
    expectRejected(
      createPage(db, { projectId, name: "Docs/Setup", actorUserId: memberId }),
      "name",
      "The page name Docs/Setup contains at least one invalid character.",
    );
    expect(allPages()).toHaveLength(0);
  });

  it("rejects a name longer than 255 characters", () => {
    expectRejected(
      createPage(db, { projectId, name: "x".repeat(256), actorUserId: memberId }),
      "name",
      "The page name is too long.",
    );
    expect(allPages()).toHaveLength(0);
  });

  it("accepts a name of exactly 255 characters", () => {
    const name = "y".repeat(255);
    expect(createPage(db, { projectId, name, actorUserId: memberId }).ok).toBe(true);
    expect(allPages()).toHaveLength(1);
  });

  it("rejects a name already taken, regardless of case", () => {
    seedPage("Release Plan");
    expectRejected(
      createPage(db, { projectId, name: "release plan", actorUserId: memberId }),
      "name",
      "has already been taken",
    );
    expect(allPages()).toHaveLength(1);
    expect(allVersions()).toHaveLength(1);
  });

  it("allows the same page name in a different project", () => {
    seedPage("Release Plan");
    const other = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: siteAdminId }),
      "second project",
    );
    mustOk(
      addTeamMember(db, {
        projectId: other.id,
        userId: memberId,
        role: "full_member",
        actorUserId: siteAdminId,
      }),
      "second project membership",
    );
    expect(
      createPage(db, { projectId: other.id, name: "Release Plan", actorUserId: memberId }).ok,
    ).toBe(true);
    expect(reloadPage("Release_Plan", other.id)).toBeDefined();
  });
});

describe("updatePage", () => {
  it("appends the next version and moves the page row to it", () => {
    const created = seedPage("Release Plan", "<p>First</p>");
    const updated = updatePage(db, {
      projectId,
      identifier: "Release_Plan",
      content: "<p>Second</p>",
      actorUserId: projectAdminId,
    });
    expect(updated.ok).toBe(true);

    const row = reloadPage("Release_Plan")!;
    expect(row.content).toBe("<p>Second</p>");
    expect(row.version).toBe(2);
    expect(row.modifiedByUserId).toBe(projectAdminId);
    expect(row.createdByUserId).toBe(memberId); // authorship never moves

    const versions = versionsOf(created.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].content).toBe("<p>First</p>"); // untouched
    expect(versions[1].content).toBe("<p>Second</p>");
    expect(versions[1].name).toBe("Release Plan");
    expect(versions[1].createdByUserId).toBe(memberId);
    expect(versions[1].modifiedByUserId).toBe(projectAdminId);

    const events = eventsOfType("PageUpdated");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      identifier: "Release_Plan",
      version: 2,
    });
  });

  it("sanitizes the submitted body before storing the new version", () => {
    const created = seedPage("Notes", "<p>One</p>");
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Notes",
        content: '<p>Two</p><iframe src="http://evil"></iframe>',
        actorUserId: memberId,
      }),
      "sanitizing update",
    );
    expect(reloadPage("Notes")!.content).toBe("<p>Two</p>");
    expect(versionsOf(created.id)[1].content).toBe("<p>Two</p>");
  });

  it("finds the page from an underscored identifier, case-insensitively", () => {
    seedPage("Release Plan", "<p>First</p>");
    expect(
      updatePage(db, {
        projectId,
        identifier: "release_PLAN",
        content: "<p>Second</p>",
        actorUserId: memberId,
      }).ok,
    ).toBe(true);
    expect(reloadPage("Release_Plan")!.version).toBe(2);
  });

  it("clears the body when the submission is empty, as a real version", () => {
    const created = seedPage("Notes", "<p>One</p>");
    mustOk(
      updatePage(db, { projectId, identifier: "Notes", content: "", actorUserId: memberId }),
      "clearing update",
    );
    expect(reloadPage("Notes")!.content).toBeNull();
    const versions = versionsOf(created.id);
    expect(versions).toHaveLength(2);
    expect(versions[1].content).toBeNull();
    expect(versions[1].isDeletion).toBe(false); // an empty page is not a deleted one
  });

  it("treats emptying the body through the editor as a real change", () => {
    const created = seedPage("Notes", "<p>One</p>");
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Notes",
        content: "<p></p>", // what the editor posts for an emptied document
        actorUserId: memberId,
      }),
      "emptying edit",
    );
    expect(reloadPage("Notes")!.content).toBeNull();
    expect(versionsOf(created.id)).toHaveLength(2);
  });

  it("rejects an unknown project and writes nothing", () => {
    const created = seedPage("Notes", "<p>One</p>");
    expectRejected(
      updatePage(db, {
        projectId: projectId + 9999,
        identifier: "Notes",
        content: "<p>Two</p>",
        actorUserId: memberId,
      }),
      "project",
      "does not exist",
    );
    expect(reloadPage("Notes")!.version).toBe(1);
    expect(versionsOf(created.id)).toHaveLength(1);
  });

  it("rejects an identifier no page answers to", () => {
    expectRejected(
      updatePage(db, {
        projectId,
        identifier: "No_Such_Page",
        content: "<p>Two</p>",
        actorUserId: memberId,
      }),
      "page",
      "does not exist",
    );
    expect(allVersions()).toHaveLength(0);
  });

  it("rejects a readonly team member and leaves the page at its version", () => {
    const created = seedPage("Notes", "<p>One</p>");
    const result = updatePage(db, {
      projectId,
      identifier: "Notes",
      content: "<p>Two</p>",
      actorUserId: readonlyId,
    });
    expect(result.ok).toBe(false);
    expect(reloadPage("Notes")!.content).toBe("<p>One</p>");
    expect(reloadPage("Notes")!.version).toBe(1);
    expect(versionsOf(created.id)).toHaveLength(1);
    expect(eventsOfType("PageUpdated")).toHaveLength(0);
  });

  it("rejects a body that sanitizes to what is already stored", () => {
    const created = seedPage("Notes", "<p>One</p>");
    expectRejected(
      updatePage(db, {
        projectId,
        identifier: "Notes",
        content: '<p onclick="x()">One</p>', // differs only in a stripped attribute
        actorUserId: memberId,
      }),
      "page",
      "has no changes to save",
    );
    expect(reloadPage("Notes")!.version).toBe(1);
    expect(versionsOf(created.id)).toHaveLength(1);
    expect(eventsOfType("PageUpdated")).toHaveLength(0);
  });

  it("gives a page created empty its first real body, as version 2", () => {
    const created = seedPage("Stub", null);
    expect(reloadPage("Stub")!.content).toBeNull();
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Stub",
        content: "<p>Written at last</p>",
        actorUserId: memberId,
      }),
      "first body for an empty page",
    );
    const row = reloadPage("Stub")!;
    expect(row.content).toBe("<p>Written at last</p>");
    expect(row.version).toBe(2);
    const versions = versionsOf(created.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].content).toBeNull();
    expect(versions[1].content).toBe("<p>Written at last</p>");
    expect(versions[1].version).toBe(2);
  });

  it("rejects an empty submission against an already-empty page", () => {
    const created = seedPage("Blank", null);
    expectRejected(
      updatePage(db, { projectId, identifier: "Blank", content: "  ", actorUserId: memberId }),
      "page",
      "has no changes to save",
    );
    expect(versionsOf(created.id)).toHaveLength(1);
  });
});

describe("deletePage", () => {
  it("removes the page, keeps its trail, and appends a deletion version", () => {
    const created = seedPage("Obsolete", "<p>Old</p>");
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Obsolete",
        content: "<p>Older</p>",
        actorUserId: memberId,
      }),
      "second version",
    );

    const deleted = deletePage(db, {
      projectId,
      identifier: "Obsolete",
      actorUserId: projectAdminId,
    });
    expect(deleted.ok).toBe(true);

    expect(reloadPage("Obsolete")).toBeUndefined();
    const versions = versionsOf(created.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions[0].content).toBe("<p>Old</p>"); // history survives deletion
    expect(versions[1].content).toBe("<p>Older</p>");
    expect(versions[2].isDeletion).toBe(true);
    expect(versions[2].content).toBeNull();
    expect(versions[2].name).toBe("Obsolete");
    expect(versions[2].modifiedByUserId).toBe(projectAdminId);
    expect(versions[2].createdByUserId).toBe(memberId);

    const events = eventsOfType("PageDeleted");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ identifier: "Obsolete" });
  });

  it("rejects a full team member — editing a page is not deleting it", () => {
    const created = seedPage("Obsolete", "<p>Old</p>");
    const result = deletePage(db, {
      projectId,
      identifier: "Obsolete",
      actorUserId: memberId,
    });
    expect(result.ok).toBe(false);
    expect(reloadPage("Obsolete")).toBeDefined();
    expect(versionsOf(created.id)).toHaveLength(1);
    expect(eventsOfType("PageDeleted")).toHaveLength(0);
  });

  it("rejects a readonly team member", () => {
    const created = seedPage("Obsolete");
    expect(
      deletePage(db, { projectId, identifier: "Obsolete", actorUserId: readonlyId }).ok,
    ).toBe(false);
    expect(reloadPage("Obsolete")).toBeDefined();
    expect(versionsOf(created.id)).toHaveLength(1);
  });

  it("allows a site admin, who outranks a project admin", () => {
    seedPage("Obsolete");
    expect(
      deletePage(db, { projectId, identifier: "Obsolete", actorUserId: siteAdminId }).ok,
    ).toBe(true);
    expect(reloadPage("Obsolete")).toBeUndefined();
  });

  it("rejects an identifier no page answers to", () => {
    expectRejected(
      deletePage(db, {
        projectId,
        identifier: "No_Such_Page",
        actorUserId: projectAdminId,
      }),
      "page",
      "does not exist",
    );
    expect(allVersions()).toHaveLength(0);
  });

  it("frees the name for reuse, and the new page starts its own trail", () => {
    const first = seedPage("Recycled", "<p>First life</p>");
    mustOk(
      deletePage(db, { projectId, identifier: "Recycled", actorUserId: projectAdminId }),
      "deletion before reuse",
    );
    const second = seedPage("Recycled", "<p>Second life</p>");
    expect(second.id).not.toBe(first.id);
    expect(second.version).toBe(1);
    expect(versionsOf(first.id)).toHaveLength(2); // the old trail is untouched
    expect(versionsOf(second.id)).toHaveLength(1);
  });
});

describe("page read models", () => {
  it("lists pages ordered case-insensitively by name", () => {
    seedPage("zebra");
    seedPage("Apple");
    seedPage("mango");
    expect(listPages(db, projectId).map((p) => p.name)).toEqual([
      "Apple",
      "mango",
      "zebra",
    ]);
  });

  it("derives the URL identifier from the name", () => {
    seedPage("Release Plan Q3");
    expect(listPages(db, projectId)[0].identifier).toBe("Release_Plan_Q3");
  });

  it("returns the version trail oldest first, and one version by number", () => {
    const created = seedPage("Notes", "<p>One</p>");
    mustOk(
      updatePage(db, { projectId, identifier: "Notes", content: "<p>Two</p>", actorUserId: memberId }),
      "second version",
    );
    expect(pageVersionTrail(db, created.id).map((v) => v.content)).toEqual([
      "<p>One</p>",
      "<p>Two</p>",
    ]);
    expect(findPageVersion(db, created.id, 1)!.content).toBe("<p>One</p>");
    expect(findPageVersion(db, created.id, 3)).toBeUndefined();
  });

  it("reports history newest first with the user who made each version", () => {
    const created = seedPage("Notes", "<p>One</p>");
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Notes",
        content: "<p>Two</p>",
        actorUserId: projectAdminId,
      }),
      "second version",
    );
    const history = pageHistory(db, created.id);
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    expect(history[0].modifiedBy).toBe("lead");
    expect(history[1].modifiedBy).toBe("dev");
  });

  it("finds the pages that link to a page, by name and by display form", () => {
    seedPage("Release Plan", "<p>see [[Release Plan]]</p>");
    seedPage("Roadmap", "<p>see [[the plan|Release Plan]]</p>");
    seedPage("Unrelated", "<p>nothing here</p>");
    seedPage("Empty", null);
    const linking = pagesLinkingTo(db, projectId, "Release Plan").map((p) => p.name);
    expect(linking).toEqual(["Release Plan", "Roadmap"]);
  });

  it("resolves which of several identifiers name real pages, in one query", () => {
    seedPage("Alpha");
    seedPage("Beta Two");
    const found = existingPageIdentifiers(db, projectId, [
      "Alpha",
      "Beta_Two",
      "Missing_Page",
    ]);
    expect([...found].sort()).toEqual(["alpha", "beta_two"]);
  });
});

describe("page rendering against real project data", () => {
  it("links an existing page plainly and a missing one with the legacy class", () => {
    seedPage("Release Plan");
    const html = renderPageContent(
      "<p>See [[Release Plan]] and [[Nowhere]].</p>",
      pageRenderContext(db, "wiki_land"),
    );
    expect(html).toContain('<a href="/projects/wiki_land/wiki/Release_Plan">Release Plan</a>');
    expect(html).toContain(
      '<a href="/projects/wiki_land/wiki/Nowhere" class="non-existent-wiki-page-link">Nowhere</a>',
    );
  });

  it("links a card that exists and leaves a number that does not as text", () => {
    const card = mustOk(
      createCard(db, {
        projectId,
        name: "Fix the thing",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "card for linking",
    );
    const html = renderPageContent(
      `<p>Blocked by #${card.number} not #4242.</p>`,
      pageRenderContext(db, "wiki_land"),
    );
    expect(html).toContain(
      `<a href="/projects/wiki_land/cards/${card.number}" class="card-link-${card.number}">#${card.number}</a>`,
    );
    expect(html).toContain("not #4242.");
  });

  it("resolves a cross-project wiki link against the other project's pages", () => {
    const other = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: siteAdminId }),
      "second project",
    );
    mustOk(
      addTeamMember(db, {
        projectId: other.id,
        userId: memberId,
        role: "full_member",
        actorUserId: siteAdminId,
      }),
      "second project membership",
    );
    mustOk(
      createPage(db, { projectId: other.id, name: "Shared Page", actorUserId: memberId }),
      "page in the other project",
    );
    const html = renderPageContent(
      "<p>[[other/Shared Page]] and [[other/Absent]]</p>",
      pageRenderContext(db, "wiki_land"),
    );
    expect(html).toContain('<a href="/projects/other/wiki/Shared_Page">Shared Page</a>');
    expect(html).toContain('class="non-existent-wiki-page-link"');
  });
});

describe("Phase 16 exit criterion (real path)", () => {
  it("editing a page twice leaves three ordered versions and a current row at the latest", () => {
    const created = mustOk(
      createPage(db, {
        projectId,
        name: "Team Charter",
        content: "<p>Draft</p>",
        actorUserId: memberId,
      }),
      "exit-criterion create",
    );
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Team_Charter",
        content: "<p>Revised</p>",
        actorUserId: memberId,
      }),
      "exit-criterion first edit",
    );
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "Team_Charter",
        content: "<p>Final</p>",
        actorUserId: projectAdminId,
      }),
      "exit-criterion second edit",
    );

    // Read straight from the database, not through the read models.
    const current = db
      .select()
      .from(pages)
      .where(and(eq(pages.projectId, projectId), eq(pages.name, "Team Charter")))
      .get()!;
    expect(current.version).toBe(3);
    expect(current.content).toBe("<p>Final</p>");
    expect(current.modifiedByUserId).toBe(projectAdminId);

    const trail = db
      .select()
      .from(pageVersions)
      .where(eq(pageVersions.pageId, created.id))
      .orderBy(asc(pageVersions.version))
      .all();
    expect(trail.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(trail.map((v) => v.content)).toEqual([
      "<p>Draft</p>",
      "<p>Revised</p>",
      "<p>Final</p>",
    ]);
    expect(trail.every((v) => v.isDeletion === false)).toBe(true);
    expect(trail.map((v) => v.modifiedByUserId)).toEqual([
      memberId,
      memberId,
      projectAdminId,
    ]);
  });
});
