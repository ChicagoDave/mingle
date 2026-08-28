/**
 * Behavioral tests for the project history feed and its Atom
 * serialization (Phase 21).
 *
 * Derived from the phase's exit criterion: a real card update, page
 * edit, and murmur post each appear in the history feed AND the Atom
 * feed, verified against the feed's actually emitted entries. Every
 * fixture is produced by the real domain commands against a real
 * file-backed SQLite database created with the real generated
 * migrations.
 *
 * REAL PATH, deliberately (rule 13a): the Atom half drives the actual
 * route loader — `app/routes/projects.feed.atom.ts`, imported after
 * DATABASE_FILE is pointed at this suite's database — with a Request
 * carrying a session cookie minted by the real session helper. The
 * assertions read the Response the route returns, not a hand-rolled
 * stand-in for it. Phases 17 through 20 each deferred route-level
 * coverage; this suite stops deferring it for the routes it adds.
 *
 * Owner context: Collaboration verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Must be set BEFORE app/db/client.server is first imported: it resolves
// the database file at module load and applies migrations there.
const dir = mkdtempSync(join(tmpdir(), "mingle-history-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "history-feed-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const atomRoute = await import("../app/routes/projects.feed.atom");

const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { pages, pageVersions } = await import("../app/db/schema/pages");
const { cardMurmurLinks, murmurMentions, murmurs } = await import(
  "../app/db/schema/murmurs"
);
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, deleteCard, updateCard } = await import(
  "../app/domain/cards/commands.server"
);
const { createPage, deletePage, updatePage } = await import(
  "../app/domain/pages/commands.server"
);
const { addCardComment, postMurmur } = await import(
  "../app/domain/murmurs/commands.server"
);
const { projectHistory, projectHistoryCount, HISTORY_PAGE_SIZE } = await import(
  "../app/domain/history/read.server"
);
const { renderAtomFeed } = await import("../app/domain/history/atom.server");
const { pageIdentifier } = await import("../app/domain/pages/naming.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: unknown };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let devId: number;
let projectId: number;
let projectIdentifier: string;
let projectName: string;
let defaultTypeId: number;

function register(login: string): number {
  const result = registerUser(db, {
    login,
    name: login.toUpperCase(),
    password: "history-phase-21!",
  });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok)
    throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(cardMurmurLinks).run();
  db.delete(murmurMentions).run();
  db.delete(murmurs).run();
  db.delete(pageVersions).run();
  db.delete(pages).run();
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss");
  devId = register("dev");
  const project = mustOk(
    createProject(db, {
      name: "History Land",
      identifier: "history_land",
      actorUserId: adminId,
    }),
    "test project creation",
  );
  projectId = project.id;
  projectIdentifier = project.identifier;
  projectName = project.name;
  defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  mustOk(
    addTeamMember(db, {
      projectId,
      userId: devId,
      role: "full_member",
      actorUserId: adminId,
    }),
    "test membership setup",
  );
});

/** The project record the read model takes. */
function projectRef() {
  return { id: projectId, identifier: projectIdentifier, name: projectName };
}

function seedCard(name: string) {
  return mustOk(
    createCard(db, {
      projectId,
      name,
      cardTypeId: defaultTypeId,
      actorUserId: devId,
    }),
    `test card seed for ${name}`,
  );
}

/** Drives the real Atom route loader with a real session cookie. */
async function fetchAtom(query = ""): Promise<Response> {
  const session = await createUserSession(devId, "/");
  const cookie = session.headers.get("Set-Cookie")!;
  const url = `http://localhost:3000/projects/${projectIdentifier}/feed.atom${query}`;
  return (await atomRoute.loader({
    request: new Request(url, { headers: { Cookie: cookie } }),
    params: { identifier: projectIdentifier },
    context: {},
  } as never)) as Response;
}

describe("projectHistory", () => {
  it("carries card, page, and murmur activity in one stream, newest first", () => {
    const card = seedCard("Fix login");
    mustOk(
      createPage(db, {
        projectId,
        name: "Roadmap",
        content: "<p>Plan</p>",
        actorUserId: devId,
      }),
      "page",
    );
    mustOk(
      postMurmur(db, { projectId, body: "standup at ten", actorUserId: devId }),
      "murmur",
    );

    const entries = projectHistory(db, projectRef());
    expect(entries.map((e) => e.kind).sort()).toEqual(["card", "murmur", "page"]);
    expect(entries.map((e) => e.title).sort()).toEqual(
      [
        `Murmur in ${projectName}`,
        "Page Roadmap",
        `Card #${card.number} Fix login`,
      ].sort(),
    );
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].occurredAt.getTime()).toBeGreaterThanOrEqual(
        entries[i].occurredAt.getTime(),
      );
    }
  });

  it("orders the merged stream newest first across all three sources", () => {
    const card = seedCard("Fix login");
    const page = mustOk(
      createPage(db, {
        projectId,
        name: "Roadmap",
        content: "<p>Plan</p>",
        actorUserId: devId,
      }),
      "page",
    );
    const murmur = mustOk(
      postMurmur(db, { projectId, body: "standup", actorUserId: devId }),
      "murmur",
    );
    // Stamp distinct times so the assertion pins ORDERING rather than
    // whichever way a same-millisecond tie happened to break: the card
    // is oldest, then the murmur, then the page.
    db.update(cardVersions)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(cardVersions.cardId, card.id))
      .run();
    db.update(murmurs)
      .set({ createdAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(murmurs.id, murmur.id))
      .run();
    db.update(pageVersions)
      .set({ createdAt: new Date("2026-01-03T00:00:00.000Z") })
      .where(eq(pageVersions.pageId, page.id))
      .run();

    expect(projectHistory(db, projectRef()).map((e) => e.kind)).toEqual([
      "page",
      "murmur",
      "card",
    ]);
  });

  it("names each action from the source row", () => {
    const card = seedCard("Fix login");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Fix login properly",
        cardTypeId: defaultTypeId,
        actorUserId: devId,
      }),
      "update",
    );
    mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "looked at it",
        actorUserId: devId,
      }),
      "comment",
    );
    mustOk(
      deleteCard(db, {
        projectId,
        cardNumber: card.number,
        actorUserId: adminId,
      }),
      "delete",
    );

    const actions = projectHistory(db, projectRef())
      .filter((e) => e.kind === "card")
      .map((e) => e.action);
    // Newest first: deletion, comment, update, creation.
    expect(actions).toEqual(["deleted", "commented", "changed", "created"]);
  });

  it("names page creation, edit, and deletion", () => {
    const page = mustOk(
      createPage(db, {
        projectId,
        name: "Roadmap",
        content: "<p>One</p>",
        actorUserId: devId,
      }),
      "page",
    );
    mustOk(
      updatePage(db, {
        projectId,
        identifier: pageIdentifier(page.name),
        content: "<p>Two</p>",
        actorUserId: devId,
      }),
      "edit",
    );
    mustOk(
      deletePage(db, {
        projectId,
        identifier: pageIdentifier(page.name),
        actorUserId: adminId,
      }),
      "delete page",
    );

    const actions = projectHistory(db, projectRef())
      .filter((e) => e.kind === "page")
      .map((e) => e.action);
    expect(actions).toEqual(["deleted", "changed", "created"]);
  });

  it("shows each entry under the name it had at the time, not today's", () => {
    const card = seedCard("Original name");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Renamed later",
        cardTypeId: defaultTypeId,
        actorUserId: devId,
      }),
      "rename",
    );

    const cardEntries = projectHistory(db, projectRef()).filter(
      (e) => e.kind === "card",
    );
    // This is the whole reason the feed reads version trails rather
    // than command events joined back to the live row.
    expect(cardEntries.map((e) => e.title)).toEqual([
      `Card #${card.number} Renamed later`,
      `Card #${card.number} Original name`,
    ]);
  });

  it("carries the comment and murmur text on their entries", () => {
    const card = seedCard("Subject");
    mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "a real comment",
        actorUserId: devId,
      }),
      "comment",
    );
    mustOk(
      postMurmur(db, { projectId, body: "a real murmur", actorUserId: devId }),
      "murmur",
    );

    const entries = projectHistory(db, projectRef());
    expect(entries.find((e) => e.kind === "murmur")!.text).toBe("a real murmur");
    expect(entries.find((e) => e.action === "commented")!.text).toBe(
      "a real comment",
    );
    expect(entries.find((e) => e.action === "created")!.text).toBeNull();
  });

  it("attributes each entry to the user who caused it", () => {
    const card = seedCard("Fix login");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Fix login properly",
        cardTypeId: defaultTypeId,
        actorUserId: adminId,
      }),
      "update by admin",
    );

    const entries = projectHistory(db, projectRef()).filter(
      (e) => e.kind === "card",
    );
    expect(entries[0].authorName).toBe("BOSS");
    expect(entries[1].authorName).toBe("DEV");
  });

  it("links each entry to the thing it is about", () => {
    const card = seedCard("Fix login");
    mustOk(
      createPage(db, {
        projectId,
        name: "Release Plan",
        content: "<p>Plan</p>",
        actorUserId: devId,
      }),
      "page",
    );
    mustOk(
      postMurmur(db, { projectId, body: "hello", actorUserId: devId }),
      "murmur",
    );

    const byKind = Object.fromEntries(
      projectHistory(db, projectRef()).map((e) => [e.kind, e.href]),
    );
    expect(byKind.card).toBe(
      `/projects/${projectIdentifier}/cards/${card.number}`,
    );
    expect(byKind.page).toBe(
      `/projects/${projectIdentifier}/wiki/Release_Plan`,
    );
    expect(byKind.murmur).toBe(`/projects/${projectIdentifier}/murmurs`);
  });

  it("pages across the union without repeating or dropping an entry", () => {
    for (let i = 0; i < 5; i++) seedCard(`Card ${i}`);
    mustOk(
      createPage(db, {
        projectId,
        name: "Roadmap",
        content: "<p>Plan</p>",
        actorUserId: devId,
      }),
      "page",
    );
    for (let i = 0; i < 3; i++)
      mustOk(
        postMurmur(db, { projectId, body: `murmur ${i}`, actorUserId: devId }),
        "murmur",
      );

    const total = projectHistoryCount(db, projectId);
    expect(total).toBe(9); // 5 card versions + 1 page version + 3 murmurs

    const first = projectHistory(db, projectRef(), { page: 1, limit: 4 });
    const second = projectHistory(db, projectRef(), { page: 2, limit: 4 });
    const third = projectHistory(db, projectRef(), { page: 3, limit: 4 });
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(third).toHaveLength(1);

    const ids = [...first, ...second, ...third].map((e) => e.id);
    expect(new Set(ids).size).toBe(total);
    const all = projectHistory(db, projectRef(), { limit: total });
    expect(ids).toEqual(all.map((e) => e.id));
  });

  it("shows only the project's own activity", () => {
    seedCard("Ours");
    const other = mustOk(
      createProject(db, {
        name: "Elsewhere",
        identifier: "elsewhere",
        actorUserId: adminId,
      }),
      "second project",
    );
    const otherTypeId = db
      .select({ id: cardTypes.id })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, other.id))
      .get()!.id;
    mustOk(
      createCard(db, {
        projectId: other.id,
        name: "Theirs",
        cardTypeId: otherTypeId,
        actorUserId: adminId,
      }),
      "foreign card",
    );

    const titles = projectHistory(db, projectRef()).map((e) => e.title);
    expect(titles.some((t) => t.includes("Ours"))).toBe(true);
    expect(titles.some((t) => t.includes("Theirs"))).toBe(false);
    expect(projectHistoryCount(db, projectId)).toBe(1);
  });

  it("gives every entry a distinct, source-stable id", () => {
    seedCard("One");
    mustOk(
      createPage(db, {
        projectId,
        name: "Roadmap",
        content: "<p>Plan</p>",
        actorUserId: devId,
      }),
      "page",
    );
    mustOk(
      postMurmur(db, { projectId, body: "hi", actorUserId: devId }),
      "murmur",
    );

    const entries = projectHistory(db, projectRef());
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^(card|page|murmur)-\d+$/.test(id))).toBe(true);
    // Re-reading returns the same ids — they are not positional.
    expect(projectHistory(db, projectRef()).map((e) => e.id)).toEqual(ids);
  });

  it("is empty for a project where nothing has happened", () => {
    expect(projectHistory(db, projectRef())).toEqual([]);
    expect(projectHistoryCount(db, projectId)).toBe(0);
  });
});

describe("Atom serialization", () => {
  it("escapes text rather than emitting it raw", () => {
    const card = seedCard('Fix <script> & "quotes"');

    const xml = renderAtomFeed(projectHistory(db, projectRef()), {
      siteUrl: "https://mingle.example",
      projectIdentifier,
      projectName,
      projectCreatedAt: new Date("2020-01-01T00:00:00.000Z"),
      page: 1,
      totalPages: 1,
    });

    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;quotes&quot;");
    expect(xml).not.toContain("<script>");
    expect(xml).toContain(`Card #${card.number}`);
  });

  it("falls back to the project's creation stamp when there is nothing yet", () => {
    const created = new Date("2020-01-01T00:00:00.000Z");
    const xml = renderAtomFeed([], {
      siteUrl: "https://mingle.example",
      projectIdentifier,
      projectName,
      projectCreatedAt: created,
      page: 1,
      totalPages: 1,
    });

    expect(xml).toContain(`<updated>${created.toISOString()}</updated>`);
    expect(xml).not.toContain("<entry>");
  });

  it("emits paging links in the feed's reversed direction", () => {
    seedCard("One");
    const entries = projectHistory(db, projectRef());
    const ctx = {
      siteUrl: "https://mingle.example",
      projectIdentifier,
      projectName,
      projectCreatedAt: new Date("2020-01-01T00:00:00.000Z"),
      totalPages: 3,
    };

    const first = renderAtomFeed(entries, { ...ctx, page: 1 });
    expect(first).toContain('rel="next"');
    expect(first).not.toContain('rel="previous"');

    const middle = renderAtomFeed(entries, { ...ctx, page: 2 });
    expect(middle).toContain('rel="next"');
    expect(middle).toContain('rel="previous"');
    expect(middle).toContain('rel="self" href="https://mingle.example/projects/history_land/feed.atom?page=2"');

    const last = renderAtomFeed(entries, { ...ctx, page: 3 });
    expect(last).not.toContain('rel="next"');
    expect(last).toContain('rel="previous"');
  });

  it("stamps the FEED itself with its newest entry's time", () => {
    seedCard("One");
    mustOk(
      postMurmur(db, { projectId, body: "later", actorUserId: devId }),
      "murmur",
    );
    const entries = projectHistory(db, projectRef());
    const projectCreatedAt = new Date("2020-01-01T00:00:00.000Z");
    const xml = renderAtomFeed(entries, {
      siteUrl: "https://mingle.example",
      projectIdentifier,
      projectName,
      projectCreatedAt,
      page: 1,
      totalPages: 1,
    });

    // Entries carry their own <updated>, so the assertion has to look at
    // the feed HEAD — everything before the first <entry> — or it would
    // pass against a feed stamp that never moved off the project's
    // creation date.
    const head = xml.slice(0, xml.indexOf("<entry>"));
    expect(head).toContain(
      `<updated>${entries[0].occurredAt.toISOString()}</updated>`,
    );
    expect(head).not.toContain(projectCreatedAt.toISOString());
  });
});

describe("Phase 21 exit criterion — the real Atom route", () => {
  it("serves a card update, a page edit, and a murmur post as Atom entries", async () => {
    const card = seedCard("Fix login");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Fix login properly",
        cardTypeId: defaultTypeId,
        actorUserId: devId,
      }),
      "card update",
    );
    const page = mustOk(
      createPage(db, {
        projectId,
        name: "Roadmap",
        content: "<p>One</p>",
        actorUserId: devId,
      }),
      "page",
    );
    mustOk(
      updatePage(db, {
        projectId,
        identifier: pageIdentifier(page.name),
        content: "<p>Two</p>",
        actorUserId: devId,
      }),
      "page edit",
    );
    mustOk(
      postMurmur(db, {
        projectId,
        body: "shipping tomorrow",
        actorUserId: devId,
      }),
      "murmur",
    );

    // The in-app half, over the shared projection.
    const entries = projectHistory(db, projectRef());
    expect(
      entries.find(
        (e) => e.kind === "card" && e.title.includes("Fix login properly"),
      ),
    ).toBeDefined();
    expect(
      entries.filter((e) => e.kind === "page" && e.action === "changed"),
    ).toHaveLength(1);
    expect(entries.find((e) => e.kind === "murmur")!.text).toBe(
      "shipping tomorrow",
    );

    // The Atom half, through the route the browser would hit.
    const response = await fetchAtom();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "application/atom+xml",
    );
    const xml = await response.text();

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<title>${projectName} history</title>`);

    // One <entry> per projected entry, and each of the three named
    // activities present in the emitted document.
    expect(xml.match(/<entry>/g)).toHaveLength(entries.length);
    expect(xml).toContain(`Card #${card.number} Fix login properly`);
    expect(xml).toContain("Page Roadmap");
    expect(xml).toContain("shipping tomorrow");
    expect(xml).toContain('<category term="card"/>');
    expect(xml).toContain('<category term="page"/>');
    expect(xml).toContain('<category term="murmur"/>');
    expect(xml).toContain(
      `href="http://localhost:3000/projects/${projectIdentifier}/cards/${card.number}"`,
    );
    for (const entry of entries)
      expect(xml).toContain(`tag:${projectIdentifier},${entry.id}`);
  });

  it("refuses an unknown project with a 404", async () => {
    const session = await createUserSession(devId, "/");
    const cookie = session.headers.get("Set-Cookie")!;
    await expect(
      atomRoute.loader({
        request: new Request("http://localhost:3000/projects/nope/feed.atom", {
          headers: { Cookie: cookie },
        }),
        params: { identifier: "nope" },
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("redirects an unauthenticated reader instead of serving the feed", async () => {
    seedCard("Private work");
    await expect(
      atomRoute.loader({
        request: new Request(
          `http://localhost:3000/projects/${projectIdentifier}/feed.atom`,
        ),
        params: { identifier: projectIdentifier },
        context: {},
      } as never),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("serves the requested page of the feed", async () => {
    for (let i = 0; i < 3; i++) seedCard(`Card ${i}`);

    const response = await fetchAtom("?page=2");
    const xml = await response.text();
    // Page size is the full HISTORY_PAGE_SIZE, so page 2 is empty here —
    // and an empty page is still a well-formed feed, not an error.
    expect(HISTORY_PAGE_SIZE).toBeGreaterThan(3);
    expect(response.status).toBe(200);
    expect(xml).toContain('rel="previous"');
    expect(xml.match(/<entry>/g)).toBeNull();
  });
});
