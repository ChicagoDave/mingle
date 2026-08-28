/**
 * Behavioral tests for the Collaboration murmur commands and read
 * models (Phase 20).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * `postMurmur` and `addCardComment`: every DOES asserts on rows
 * reloaded from the database — the murmur row, its mention rows, its
 * card links, the card version the comment rode on — never on a
 * return value alone, and every REJECTS WHEN has its own test that
 * also proves nothing was written. Includes the phase's exit
 * criterion: posting a card comment persists a murmur linked to the
 * card, and a mention of a real team member is queryable as a
 * distinct persisted fact rather than a render-time text match.
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations — no stubs, no fakes.
 *
 * Owner context: Collaboration verification.
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
import {
  groupMemberships,
  groups,
  teamMemberships,
} from "../app/db/schema/membership";
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import {
  cardMurmurLinks,
  murmurMentions,
  murmurs,
} from "../app/db/schema/murmurs";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import {
  addTeamMember,
  addUserToGroup,
  createGroup,
} from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard, deleteCard } from "../app/domain/cards/commands.server";
import {
  addCardComment,
  postMurmur,
} from "../app/domain/murmurs/commands.server";
import {
  cardCommentCount,
  cardDiscussion,
  listProjectMurmurs,
  murmursMentioning,
  renderMurmurBody,
} from "../app/domain/murmurs/read.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-murmurs-"));
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
let projectAdminId: number; // project_admin
let devId: number; //          full_member, login "dev"
let quinnId: number; //        full_member, login "quinn"
let readonlyId: number; //     readonly_member
let outsiderId: number; //     registered user, not on the team
let projectId: number;
let defaultTypeId: number;

function register(login: string): number {
  const result = registerUser(db, {
    login,
    name: login.toUpperCase(),
    password: "murmurs-phase-20!",
  });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok)
    throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
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

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(cardMurmurLinks).run();
  db.delete(murmurMentions).run();
  db.delete(murmurs).run();
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(groupMemberships).run();
  db.delete(groups).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  siteAdminId = register("boss");
  projectAdminId = register("lead");
  devId = register("dev");
  quinnId = register("quinn");
  readonlyId = register("viewer");
  outsiderId = register("outsider");
  projectId = mustOk(
    createProject(db, {
      name: "Murmur Land",
      identifier: "murmur_land",
      actorUserId: siteAdminId,
    }),
    "test project creation",
  ).id;
  defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  for (const [userId, role] of [
    [projectAdminId, "project_admin"],
    [devId, "full_member"],
    [quinnId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const) {
    mustOk(
      addTeamMember(db, { projectId, userId, role, actorUserId: siteAdminId }),
      `test membership setup for ${userId}`,
    );
  }
  db.delete(domainEvents).run(); // only events under test matter below
});

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

function allMurmurs() {
  return db
    .select()
    .from(murmurs)
    .where(eq(murmurs.projectId, projectId))
    .orderBy(asc(murmurs.id))
    .all();
}

function mentionsOf(murmurId: number) {
  return db
    .select()
    .from(murmurMentions)
    .where(eq(murmurMentions.murmurId, murmurId))
    .orderBy(asc(murmurMentions.id))
    .all();
}

function linksOf(murmurId: number) {
  return db
    .select()
    .from(cardMurmurLinks)
    .where(eq(cardMurmurLinks.murmurId, murmurId))
    .all();
}

function versionsOf(cardId: number) {
  return db
    .select()
    .from(cardVersions)
    .where(eq(cardVersions.cardId, cardId))
    .orderBy(asc(cardVersions.version))
    .all();
}

function eventsOfType(type: string) {
  return db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
}

function reloadCard(number: number) {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .get()!;
}

describe("postMurmur", () => {
  it("persists the murmur, stripped, with its author and a MurmurPosted event", () => {
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "  standup at ten  ",
        actorUserId: devId,
      }),
      "post",
    );

    const stored = allMurmurs();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(posted.id);
    expect(stored[0].body).toBe("standup at ten");
    expect(stored[0].authorUserId).toBe(devId);
    expect(stored[0].originType).toBe("project");
    expect(stored[0].originCardId).toBeNull();
    expect(stored[0].originCardVersion).toBeNull();

    const events = eventsOfType("MurmurPosted");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(posted.id);
    expect(events[0].actorUserId).toBe(devId);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      projectId,
      originType: "project",
      mentionedUserIds: [],
      linkedCardIds: [],
    });
  });

  it("records an @login mention of a team member as a persisted row", () => {
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "can @quinn take this?",
        actorUserId: devId,
      }),
      "post",
    );

    const mentions = mentionsOf(posted.id);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      projectId,
      kind: "user",
      userId: quinnId,
      groupId: null,
      mentionText: "quinn",
    });
  });

  it("expands @team to one row per activated team member", () => {
    const posted = mustOk(
      postMurmur(db, { projectId, body: "@team heads up", actorUserId: devId }),
      "post",
    );

    const mentions = mentionsOf(posted.id);
    expect(mentions.map((m) => m.userId).sort()).toEqual(
      [projectAdminId, devId, quinnId, readonlyId].sort(),
    );
    expect(mentions.every((m) => m.kind === "team")).toBe(true);
    expect(mentions.every((m) => m.mentionText === "team")).toBe(true);
    // The site admin never joined this project's team.
    expect(mentions.map((m) => m.userId)).not.toContain(siteAdminId);
  });

  it("expands a group mention to its members, recording the group it came through", () => {
    const group = mustOk(
      createGroup(db, {
        projectId,
        name: "Reviewers",
        actorUserId: projectAdminId,
      }),
      "group",
    );
    mustOk(
      addUserToGroup(db, {
        groupId: group.id,
        userId: quinnId,
        actorUserId: projectAdminId,
      }),
      "group membership",
    );

    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "@reviewers please look",
        actorUserId: devId,
      }),
      "post",
    );

    const mentions = mentionsOf(posted.id);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      kind: "group",
      userId: quinnId,
      groupId: group.id,
      mentionText: "reviewers",
    });
  });

  it("mentions a user named twice exactly once, first mention winning", () => {
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "@team and especially @quinn",
        actorUserId: devId,
      }),
      "post",
    );

    const forQuinn = mentionsOf(posted.id).filter((m) => m.userId === quinnId);
    expect(forQuinn).toHaveLength(1);
    expect(forQuinn[0].kind).toBe("team");
  });

  it("does not mention a deactivated user, even through @team", () => {
    db.update(users).set({ activated: false }).where(eq(users.id, quinnId)).run();

    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "@team ping, and @quinn too",
        actorUserId: devId,
      }),
      "post",
    );

    expect(mentionsOf(posted.id).map((m) => m.userId)).not.toContain(quinnId);
  });

  it("does not mention a group member who is no longer an active team member", () => {
    const group = mustOk(
      createGroup(db, {
        projectId,
        name: "Reviewers",
        actorUserId: projectAdminId,
      }),
      "group",
    );
    for (const userId of [devId, quinnId]) {
      mustOk(
        addUserToGroup(db, { groupId: group.id, userId, actorUserId: projectAdminId }),
        "group membership",
      );
    }
    db.update(users).set({ activated: false }).where(eq(users.id, quinnId)).run();

    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "@reviewers please look",
        actorUserId: projectAdminId,
      }),
      "post",
    );

    const mentioned = mentionsOf(posted.id).map((m) => m.userId);
    expect(mentioned).toEqual([devId]);
    expect(mentioned).not.toContain(quinnId);
  });

  it("does not link a card that lives in another project", () => {
    const otherProjectId = mustOk(
      createProject(db, {
        name: "Elsewhere",
        identifier: "elsewhere",
        actorUserId: siteAdminId,
      }),
      "second project",
    ).id;
    mustOk(
      addTeamMember(db, {
        projectId: otherProjectId,
        userId: devId,
        role: "full_member",
        actorUserId: siteAdminId,
      }),
      "second project membership",
    );
    const otherTypeId = db
      .select({ id: cardTypes.id })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, otherProjectId))
      .get()!.id;
    const foreign = mustOk(
      createCard(db, {
        projectId: otherProjectId,
        name: "Foreign card",
        cardTypeId: otherTypeId,
        actorUserId: devId,
      }),
      "foreign card",
    );

    // This project has no card with that number at all.
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: `see #${foreign.number}`,
        actorUserId: devId,
      }),
      "post",
    );

    expect(linksOf(posted.id)).toHaveLength(0);
    expect(
      db.select().from(cardMurmurLinks).where(eq(cardMurmurLinks.cardId, foreign.id)).all(),
    ).toHaveLength(0);
  });

  it("does not mention a login that is not on this project's team", () => {
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "hello @outsider",
        actorUserId: devId,
      }),
      "post",
    );

    expect(mentionsOf(posted.id)).toHaveLength(0);
  });

  it("resolves a mention written with a trailing period", () => {
    const posted = mustOk(
      postMurmur(db, { projectId, body: "ask @dev.", actorUserId: quinnId }),
      "post",
    );

    const mentions = mentionsOf(posted.id);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].userId).toBe(devId);
    expect(mentions[0].mentionText).toBe("dev");
  });

  it("links every #n that names a card in the project", () => {
    const first = seedCard("First");
    const second = seedCard("Second");

    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: `blocked by #${first.number} and #${second.number}`,
        actorUserId: devId,
      }),
      "post",
    );

    const links = linksOf(posted.id);
    expect(links.map((l) => l.cardId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(links.every((l) => l.projectId === projectId)).toBe(true);
    expect(JSON.parse(eventsOfType("MurmurPosted")[0].payload)).toMatchObject({
      linkedCardIds: expect.arrayContaining([first.id, second.id]),
    });
  });

  it("writes no link for a number that names no card", () => {
    seedCard("Only card");

    const posted = mustOk(
      postMurmur(db, { projectId, body: "see #999", actorUserId: devId }),
      "post",
    );

    expect(linksOf(posted.id)).toHaveLength(0);
  });

  it("rejects an unknown project and writes nothing", () => {
    expectRejected(
      postMurmur(db, { projectId: 987654, body: "hi", actorUserId: devId }),
      "project",
      "does not exist",
    );
    expect(allMurmurs()).toHaveLength(0);
  });

  it("rejects a readonly member and writes nothing", () => {
    const result = postMurmur(db, {
      projectId,
      body: "can I speak?",
      actorUserId: readonlyId,
    });

    expect(result.ok).toBe(false);
    expect(allMurmurs()).toHaveLength(0);
    expect(eventsOfType("MurmurPosted")).toHaveLength(0);
  });

  it("rejects a non-member and writes nothing", () => {
    const result = postMurmur(db, {
      projectId,
      body: "let me in",
      actorUserId: outsiderId,
    });

    expect(result.ok).toBe(false);
    expect(allMurmurs()).toHaveLength(0);
  });

  it("rejects a blank body and writes nothing", () => {
    expectRejected(
      postMurmur(db, { projectId, body: "", actorUserId: devId }),
      "body",
      "can't be blank",
    );
    expect(allMurmurs()).toHaveLength(0);
  });

  it("rejects a whitespace-only body and writes nothing", () => {
    expectRejected(
      postMurmur(db, { projectId, body: "   \n\t ", actorUserId: devId }),
      "body",
      "can't be blank",
    );
    expect(allMurmurs()).toHaveLength(0);
  });
});

describe("addCardComment", () => {
  it("appends a card version carrying the comment and advances the card", () => {
    const card = seedCard("Needs discussion");
    const before = reloadCard(card.number);

    mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "  looks wrong to me  ",
        actorUserId: quinnId,
      }),
      "comment",
    );

    const versions = versionsOf(card.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].comment).toBeNull();
    expect(versions[1].version).toBe(before.version + 1);
    expect(versions[1].comment).toBe("looks wrong to me");
    // The comment changes nothing else about the card.
    expect(versions[1].name).toBe(before.name);
    expect(versions[1].description).toBe(before.description);
    expect(versions[1].cardTypeName).toBe(versions[0].cardTypeName);
    expect(versions[1].propertyValues).toBe(versions[0].propertyValues);
    expect(versions[1].modifiedByUserId).toBe(quinnId);
    expect(versions[1].createdByUserId).toBe(before.createdByUserId);

    const after = reloadCard(card.number);
    expect(after.version).toBe(before.version + 1);
    expect(after.modifiedByUserId).toBe(quinnId);
    expect(after.name).toBe(before.name);
  });

  it("stamps the card as updated when a comment is added", () => {
    const card = seedCard("Needs discussion");
    // A known past stamp, so "moved forward" is a falsifiable claim
    // rather than a same-millisecond coincidence.
    const stale = new Date("2020-01-01T00:00:00.000Z");
    db.update(cards).set({ updatedAt: stale }).where(eq(cards.id, card.id)).run();

    mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "still relevant?",
        actorUserId: quinnId,
      }),
      "comment",
    );

    expect(reloadCard(card.number).updatedAt.getTime()).toBeGreaterThan(
      stale.getTime(),
    );
  });

  it("persists a murmur tied to the card and to the version it rode on", () => {
    const card = seedCard("Needs discussion");

    const result = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "shipping tomorrow",
        actorUserId: devId,
      }),
      "comment",
    );

    const stored = allMurmurs();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: result.murmur.id,
      body: "shipping tomorrow",
      authorUserId: devId,
      originType: "card",
      originCardId: card.id,
      originCardVersion: 2,
    });
    // The murmur and the version trail agree about what was said.
    const version = versionsOf(card.id).find(
      (v) => v.version === stored[0].originCardVersion,
    )!;
    expect(version.comment).toBe(stored[0].body);

    const events = eventsOfType("CardCommentAdded");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      projectId,
      originType: "card",
      cardNumber: card.number,
      cardVersion: 2,
    });
  });

  it("records mentions and card links from a comment body", () => {
    const card = seedCard("Subject");
    const other = seedCard("Related");

    const result = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: `@quinn compare with #${other.number}`,
        actorUserId: devId,
      }),
      "comment",
    );

    expect(mentionsOf(result.murmur.id)).toMatchObject([
      { kind: "user", userId: quinnId, mentionText: "quinn" },
    ]);
    expect(linksOf(result.murmur.id).map((l) => l.cardId)).toEqual([other.id]);
  });

  it("does not link a comment to the very card it comments on", () => {
    const card = seedCard("Subject");
    const other = seedCard("Related");

    const result = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: `this card #${card.number} duplicates #${other.number}`,
        actorUserId: devId,
      }),
      "comment",
    );

    const linked = linksOf(result.murmur.id).map((l) => l.cardId);
    expect(linked).toEqual([other.id]);
    expect(linked).not.toContain(card.id);
  });

  it("rejects an unknown project, leaving no version and no murmur", () => {
    const card = seedCard("Untouched");

    expectRejected(
      addCardComment(db, {
        projectId: 987654,
        cardNumber: card.number,
        body: "wrong project",
        actorUserId: devId,
      }),
      "project",
      "does not exist",
    );

    expect(versionsOf(card.id)).toHaveLength(1);
    expect(reloadCard(card.number).version).toBe(1);
    expect(allMurmurs()).toHaveLength(0);
  });

  it("rejects an unknown card, leaving no version and no murmur", () => {
    const card = seedCard("Untouched");

    expectRejected(
      addCardComment(db, {
        projectId,
        cardNumber: 4242,
        body: "into the void",
        actorUserId: devId,
      }),
      "card",
      "does not exist",
    );

    expect(versionsOf(card.id)).toHaveLength(1);
    expect(reloadCard(card.number).version).toBe(1);
    expect(allMurmurs()).toHaveLength(0);
  });

  it("rejects a blank comment, leaving the card version untouched", () => {
    const card = seedCard("Untouched");

    expectRejected(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "  \n ",
        actorUserId: devId,
      }),
      "body",
      "can't be blank",
    );

    expect(versionsOf(card.id)).toHaveLength(1);
    expect(reloadCard(card.number).version).toBe(1);
    expect(allMurmurs()).toHaveLength(0);
  });

  it("rejects a readonly member, leaving the card version untouched", () => {
    const card = seedCard("Untouched");

    const result = addCardComment(db, {
      projectId,
      cardNumber: card.number,
      body: "may I?",
      actorUserId: readonlyId,
    });

    expect(result.ok).toBe(false);
    expect(versionsOf(card.id)).toHaveLength(1);
    expect(reloadCard(card.number).version).toBe(1);
    expect(allMurmurs()).toHaveLength(0);
    expect(eventsOfType("CardCommentAdded")).toHaveLength(0);
  });
});

describe("murmur read models", () => {
  it("lists a project's stream newest first, and pages back with a cursor", () => {
    const first = mustOk(
      postMurmur(db, { projectId, body: "one", actorUserId: devId }),
      "post",
    );
    const second = mustOk(
      postMurmur(db, { projectId, body: "two", actorUserId: devId }),
      "post",
    );
    const third = mustOk(
      postMurmur(db, { projectId, body: "three", actorUserId: quinnId }),
      "post",
    );

    const page = listProjectMurmurs(db, projectId);
    expect(page.map((m) => m.id)).toEqual([third.id, second.id, first.id]);
    expect(page[0].authorName).toBe("QUINN");

    const older = listProjectMurmurs(db, projectId, { beforeId: second.id });
    expect(older.map((m) => m.id)).toEqual([first.id]);
  });

  it("shows a card's own comments and every murmur that referenced it", () => {
    const card = seedCard("Discussed");
    const comment = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "a comment",
        actorUserId: devId,
      }),
      "comment",
    );
    const referencing = mustOk(
      postMurmur(db, {
        projectId,
        body: `also about #${card.number}`,
        actorUserId: quinnId,
      }),
      "post",
    );
    const unrelated = mustOk(
      postMurmur(db, { projectId, body: "unrelated", actorUserId: quinnId }),
      "post",
    );

    const discussion = cardDiscussion(db, projectId, card.id);
    expect(discussion.map((m) => m.id)).toEqual([
      referencing.id,
      comment.murmur.id,
    ]);
    expect(discussion.map((m) => m.id)).not.toContain(unrelated.id);
    expect(discussion[1].originCardNumber).toBe(card.number);
    expect(discussion[0].originCardNumber).toBeNull();
    expect(cardCommentCount(db, card.id)).toBe(1);
  });

  it("answers which murmurs mentioned a user from the stored mention rows", () => {
    const direct = mustOk(
      postMurmur(db, { projectId, body: "@quinn look", actorUserId: devId }),
      "post",
    );
    const viaTeam = mustOk(
      postMurmur(db, { projectId, body: "@team look", actorUserId: devId }),
      "post",
    );
    mustOk(
      postMurmur(db, { projectId, body: "nobody in particular", actorUserId: devId }),
      "post",
    );

    const forQuinn = murmursMentioning(db, projectId, quinnId);
    expect(forQuinn.map((m) => m.id)).toEqual([viaTeam.id, direct.id]);

    const forOutsider = murmursMentioning(db, projectId, outsiderId);
    expect(forOutsider).toHaveLength(0);
  });

  it("keeps a comment on a deleted card, recovering its number from the version trail", () => {
    const card = seedCard("Doomed");
    const comment = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: `about #${card.number} itself`,
        actorUserId: devId,
      }),
      "comment",
    );
    const referencing = mustOk(
      postMurmur(db, {
        projectId,
        body: `also about #${card.number}`,
        actorUserId: quinnId,
      }),
      "post",
    );

    mustOk(
      deleteCard(db, {
        projectId,
        cardNumber: card.number,
        actorUserId: projectAdminId,
      }),
      "delete",
    );
    // The card row is gone; its version trail is not.
    expect(
      db.select().from(cards).where(eq(cards.id, card.id)).all(),
    ).toHaveLength(0);

    const stream = listProjectMurmurs(db, projectId);
    const commentView = stream.find((m) => m.id === comment.murmur.id)!;
    expect(commentView.originCardNumber).toBe(card.number);
    expect(commentView.originCardDeleted).toBe(true);
    // A reference to a card that no longer exists stops being a link.
    expect(commentView.body).toEqual([
      { kind: "text", text: `about #${card.number} itself` },
    ]);

    const referencingView = stream.find((m) => m.id === referencing.id)!;
    expect(referencingView.originCardNumber).toBeNull();
    expect(referencingView.originCardDeleted).toBe(false);
  });

  it("marks a comment on a live card as not deleted", () => {
    const card = seedCard("Alive");
    const comment = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "still here",
        actorUserId: devId,
      }),
      "comment",
    );

    const view = listProjectMurmurs(db, projectId).find(
      (m) => m.id === comment.murmur.id,
    )!;
    expect(view.originCardNumber).toBe(card.number);
    expect(view.originCardDeleted).toBe(false);
  });

  it("segments a body into text, mention, and card pieces without losing characters", () => {
    const card = seedCard("Linked");
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: `hey @quinn see #${card.number} today`,
        actorUserId: devId,
      }),
      "post",
    );

    const view = listProjectMurmurs(db, projectId).find(
      (m) => m.id === posted.id,
    )!;
    expect(view.body).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", token: "quinn" },
      { kind: "text", text: " see " },
      { kind: "card", number: card.number },
      { kind: "text", text: " today" },
    ]);
    const roundTrip = view.body
      .map((segment) =>
        segment.kind === "text"
          ? segment.text
          : segment.kind === "mention"
            ? `@${segment.token}`
            : `#${segment.number}`,
      )
      .join("");
    expect(roundTrip).toBe(`hey @quinn see #${card.number} today`);
  });

  it("leaves an @ token that resolved to nobody as plain text", () => {
    const posted = mustOk(
      postMurmur(db, {
        projectId,
        body: "mail me at bob@example.com or ask @nobody",
        actorUserId: devId,
      }),
      "post",
    );

    const view = listProjectMurmurs(db, projectId).find(
      (m) => m.id === posted.id,
    )!;
    expect(view.body).toEqual([
      { kind: "text", text: "mail me at bob@example.com or ask @nobody" },
    ]);
  });

  it("renders a trailing-period mention as the resolved name, keeping the period", () => {
    const posted = mustOk(
      postMurmur(db, { projectId, body: "ask @dev.", actorUserId: quinnId }),
      "post",
    );

    const view = listProjectMurmurs(db, projectId).find(
      (m) => m.id === posted.id,
    )!;
    expect(view.body).toEqual([
      { kind: "text", text: "ask " },
      { kind: "mention", token: "dev" },
      { kind: "text", text: "." },
    ]);
  });

  it("does not link a #n whose card does not exist", () => {
    const segments = renderMurmurBody("see #7 now", {
      mentionTokens: new Set(),
      cardExists: () => false,
    });
    expect(segments).toEqual([{ kind: "text", text: "see #7 now" }]);
  });
});

describe("Phase 20 exit criterion", () => {
  it("a card comment persists a murmur linked to the card, and its mention is queryable", () => {
    const card = seedCard("Exit criterion");

    const result = mustOk(
      addCardComment(db, {
        projectId,
        cardNumber: card.number,
        body: "@quinn can you confirm?",
        actorUserId: devId,
      }),
      "comment",
    );

    // Linked to the card, read straight from the murmurs table.
    const stored = db
      .select()
      .from(murmurs)
      .where(eq(murmurs.id, result.murmur.id))
      .get()!;
    expect(stored.originType).toBe("card");
    expect(stored.originCardId).toBe(card.id);

    // The mention is a row, not a text match: queried by user id alone,
    // never touching the body.
    const mentionRows = db
      .select()
      .from(murmurMentions)
      .where(
        and(
          eq(murmurMentions.projectId, projectId),
          eq(murmurMentions.userId, quinnId),
        ),
      )
      .all();
    expect(mentionRows).toHaveLength(1);
    expect(mentionRows[0].murmurId).toBe(stored.id);
    expect(mentionRows[0].kind).toBe("user");

    // And both halves surface through the read models a route uses.
    expect(cardDiscussion(db, projectId, card.id).map((m) => m.id)).toEqual([
      stored.id,
    ]);
    expect(murmursMentioning(db, projectId, quinnId).map((m) => m.id)).toEqual([
      stored.id,
    ]);
  });
});
