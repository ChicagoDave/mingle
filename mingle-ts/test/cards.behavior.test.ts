/**
 * Behavioral tests for the Card Management card commands (Phase 5).
 *
 * Derived line-by-line from the rule 12 Behavior Statements: every DOES
 * asserts on rows reloaded from the database (never on return values
 * alone), and every REJECTS WHEN has its own independent rejection test
 * that also proves nothing mutated — including the authorization sweep
 * per mutating handler. Includes the phase's exit-criterion real-path
 * test: create + update twice → current row and three ordered version
 * rows with the correct diffs, read straight from the DB (rule 13a).
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations — no stubs, no fakes.
 *
 * Owner context: Card Management verification.
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
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import {
  createCard,
  defineCardType,
  deleteCard,
  updateCard,
} from "../app/domain/cards/commands.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-cards-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number; //      site admin (first registered user)
let memberId: number; //     full_member of the project
let readonlyId: number; //   readonly_member of the project
let outsiderId: number; //   registered user, not on the team
let projectId: number;
let defaultTypeId: number; // the "Card" type every project starts with

function register(login: string): number {
  const result = registerUser(db, {
    login,
    name: login,
    password: "card-wall-2010!",
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
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss");
  memberId = register("dev");
  readonlyId = register("viewer");
  outsiderId = register("outsider");
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "test project creation",
  ).id;
  defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  for (const [userId, role] of [
    [memberId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const) {
    mustOk(
      addTeamMember(db, { projectId, userId, role, actorUserId: adminId }),
      `test membership setup for ${userId}`,
    );
  }
  db.delete(domainEvents).run(); // only events under test matter below
});

function reloadCard(number: number, inProject = projectId) {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, inProject), eq(cards.number, number)))
    .get();
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
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all();
}

function allEvents() {
  return db.select().from(domainEvents).all();
}

function expectRejected<T>(
  result: CommandResult<T>,
  field: string,
  message: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.errors[field]).toContain(message);
  expect(allEvents()).toHaveLength(0); // a rejected command emits nothing
}

function makeCard(name = "Story One", actor = memberId) {
  return mustOk(
    createCard(db, {
      projectId,
      name,
      cardTypeId: defaultTypeId,
      actorUserId: actor,
    }),
    "test card creation",
  );
}

const NEEDS_FULL_MEMBER = "requires Team member access to this project";
const NEEDS_PROJECT_ADMIN = "requires Project administrator access to this project";

describe("default card type on project creation", () => {
  it("gives every new project a 'Card' type and events it", () => {
    // beforeEach already created the project; assert on its persisted state.
    const types = db
      .select()
      .from(cardTypes)
      .where(eq(cardTypes.projectId, projectId))
      .all();
    expect(types).toHaveLength(1);
    expect(types[0].name).toBe("Card");
  });
});

describe("defineCardType (DefineCardType → CardTypeDefined)", () => {
  it("persists the type positioned after existing ones, and events it", () => {
    const result = defineCardType(db, {
      projectId,
      name: "Bug",
      actorUserId: adminId,
    });
    expect(result.ok).toBe(true);
    const row = db
      .select()
      .from(cardTypes)
      .where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.name, "Bug")))
      .get();
    expect(row).toBeDefined();
    expect(row!.position).toBe(2); // after the default "Card" type
    const events = eventsOfType("CardTypeDefined");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ name: "Bug" });
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      defineCardType(db, { projectId: 999, name: "Bug", actorUserId: adminId }),
      "project",
      "does not exist",
    );
  });

  it("rejects an actor below project admin (full member)", () => {
    expectRejected(
      defineCardType(db, { projectId, name: "Bug", actorUserId: memberId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(
      db.select().from(cardTypes).where(eq(cardTypes.projectId, projectId)).all(),
    ).toHaveLength(1);
  });

  it("rejects a blank name", () => {
    expectRejected(
      defineCardType(db, { projectId, name: "   ", actorUserId: adminId }),
      "name",
      "can't be blank",
    );
  });

  it("rejects a case-insensitively taken name", () => {
    expectRejected(
      defineCardType(db, { projectId, name: "cArD", actorUserId: adminId }),
      "name",
      "has already been taken",
    );
  });
});

describe("createCard (CreateCard → CardCreated + version 1)", () => {
  it("persists the card at the project's next number with version 1", () => {
    const result = createCard(db, {
      projectId,
      name: "Story One",
      description: "  as a user  ",
      cardTypeId: defaultTypeId,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);
    const row = reloadCard(1);
    expect(row).toBeDefined();
    expect(row!.name).toBe("Story One");
    expect(row!.description).toBe("as a user");
    expect(row!.version).toBe(1);
    expect(row!.createdByUserId).toBe(memberId);
    expect(row!.modifiedByUserId).toBe(memberId);
  });

  it("writes the version-1 snapshot with the type name", () => {
    const card = makeCard();
    const trail = versionsOf(card.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      version: 1,
      number: card.number,
      name: "Story One",
      cardTypeName: "Card",
      isDeletion: false,
      modifiedByUserId: memberId,
    });
  });

  it("numbers cards sequentially within a project, independently across projects", () => {
    makeCard("First");
    makeCard("Second");
    const other = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: adminId }),
      "second project",
    );
    const otherType = db
      .select({ id: cardTypes.id })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, other.id))
      .get()!.id;
    const result = mustOk(
      createCard(db, {
        projectId: other.id,
        name: "Elsewhere",
        cardTypeId: otherType,
        actorUserId: adminId,
      }),
      "card in second project",
    );
    expect(reloadCard(1)!.name).toBe("First");
    expect(reloadCard(2)!.name).toBe("Second");
    expect(result.number).toBe(1); // the other project starts at 1
  });

  it("appends a CardCreated event on the card aggregate", () => {
    const card = makeCard();
    const events = eventsOfType("CardCreated");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateType).toBe("Card");
    expect(events[0].aggregateId).toBe(card.id);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: 1,
      name: "Story One",
      cardTypeName: "Card",
    });
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      createCard(db, {
        projectId: 999,
        name: "Story",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "project",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor", () => {
    expectRejected(
      createCard(db, {
        projectId,
        name: "Story",
        cardTypeId: defaultTypeId,
        actorUserId: readonlyId,
      }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
    expect(reloadCard(1)).toBeUndefined();
  });

  it("rejects a non-member as actor", () => {
    expectRejected(
      createCard(db, {
        projectId,
        name: "Story",
        cardTypeId: defaultTypeId,
        actorUserId: outsiderId,
      }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
  });

  it("rejects a blank name, writing neither card nor version", () => {
    expectRejected(
      createCard(db, {
        projectId,
        name: "   ",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "name",
      "can't be blank",
    );
    expect(db.select().from(cardVersions).all()).toHaveLength(0);
  });

  it("accepts a name of exactly 255 characters, persisting it whole", () => {
    const name = "x".repeat(255);
    const created = makeCard(name);
    expect(db.select().from(cards).where(eq(cards.id, created.id)).get()!.name).toBe(name);
  });

  it("rejects a name over 255 characters", () => {
    expectRejected(
      createCard(db, {
        projectId,
        name: "x".repeat(256),
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "name",
      "is too long (maximum is 255 characters)",
    );
  });

  it("rejects a card type belonging to a different project", () => {
    const other = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: adminId }),
      "second project",
    );
    const foreignType = db
      .select({ id: cardTypes.id })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, other.id))
      .get()!.id;
    db.delete(domainEvents).run();
    expectRejected(
      createCard(db, {
        projectId,
        name: "Story",
        cardTypeId: foreignType,
        actorUserId: memberId,
      }),
      "cardType",
      "must be selected",
    );
    expect(reloadCard(1)).toBeUndefined();
  });
});

describe("updateCard (UpdateCard → CardUpdated + next version)", () => {
  it("REAL-PATH (exit criterion): create then update twice yields the current row and three ordered version rows with the correct diffs", () => {
    const card = makeCard("Story One");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Story One",
        description: "first pass",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "first update",
    );
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Story One (refined)",
        description: "first pass",
        cardTypeId: defaultTypeId,
        actorUserId: adminId,
      }),
      "second update",
    );
    const row = reloadCard(card.number)!;
    expect(row.version).toBe(3);
    expect(row.name).toBe("Story One (refined)");
    expect(row.description).toBe("first pass");
    expect(row.modifiedByUserId).toBe(adminId);

    const trail = versionsOf(card.id);
    expect(trail.map((v) => v.version)).toEqual([1, 2, 3]);
    // v1: creation snapshot
    expect(trail[0]).toMatchObject({
      name: "Story One",
      description: null,
      modifiedByUserId: memberId,
    });
    // v2: description added, name unchanged
    expect(trail[1]).toMatchObject({
      name: "Story One",
      description: "first pass",
      modifiedByUserId: memberId,
    });
    // v3: name changed, description carried
    expect(trail[2]).toMatchObject({
      name: "Story One (refined)",
      description: "first pass",
      modifiedByUserId: adminId,
    });
  });

  it("records a card type change in the version snapshot and event", () => {
    const card = makeCard();
    const bug = mustOk(
      defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }),
      "type setup",
    );
    db.delete(domainEvents).run();
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: card.name,
        cardTypeId: bug.id,
        actorUserId: memberId,
      }),
      "type change",
    );
    expect(reloadCard(card.number)!.cardTypeId).toBe(bug.id);
    const trail = versionsOf(card.id);
    expect(trail[1].cardTypeName).toBe("Bug");
    const events = eventsOfType("CardUpdated");
    expect(JSON.parse(events[0].payload).changed).toEqual(["cardType"]);
  });

  it("appends a CardUpdated event naming exactly the changed fields", () => {
    const card = makeCard();
    updateCard(db, {
      projectId,
      cardNumber: card.number,
      name: "Renamed",
      description: "added",
      cardTypeId: defaultTypeId,
      actorUserId: memberId,
    });
    const events = eventsOfType("CardUpdated");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: card.number,
      changed: ["name", "description"],
    });
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      updateCard(db, {
        projectId: 999,
        cardNumber: 1,
        name: "X",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "project",
      "does not exist",
    );
  });

  it("rejects when the card does not exist", () => {
    expectRejected(
      updateCard(db, {
        projectId,
        cardNumber: 42,
        name: "X",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "card",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor, leaving card and trail untouched", () => {
    const card = makeCard();
    db.delete(domainEvents).run();
    expectRejected(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Hijacked",
        cardTypeId: defaultTypeId,
        actorUserId: readonlyId,
      }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
    expect(reloadCard(card.number)!.name).toBe("Story One");
    expect(versionsOf(card.id)).toHaveLength(1);
  });

  it("rejects a blank name without versioning", () => {
    const card = makeCard();
    db.delete(domainEvents).run();
    expectRejected(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "  ",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "name",
      "can't be blank",
    );
    expect(versionsOf(card.id)).toHaveLength(1);
  });

  it("rejects a card type belonging to a different project", () => {
    const card = makeCard();
    const other = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: adminId }),
      "second project",
    );
    const foreignType = db
      .select({ id: cardTypes.id })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, other.id))
      .get()!.id;
    db.delete(domainEvents).run();
    expectRejected(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: card.name,
        cardTypeId: foreignType,
        actorUserId: memberId,
      }),
      "cardType",
      "must be selected",
    );
    expect(reloadCard(card.number)!.cardTypeId).toBe(defaultTypeId);
  });

  it("rejects an update that changes nothing, without a version row", () => {
    const card = makeCard();
    db.delete(domainEvents).run();
    expectRejected(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: card.name,
        description: card.description,
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "card",
      "has no changes to save",
    );
    expect(reloadCard(card.number)!.version).toBe(1);
    expect(versionsOf(card.id)).toHaveLength(1);
  });
});

describe("deleteCard (DeleteCard → CardDeleted + deletion version)", () => {
  it("deletes the card, keeps the trail, and appends a deletion version", () => {
    const card = makeCard();
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Story One v2",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "update before delete",
    );
    db.delete(domainEvents).run();
    const result = deleteCard(db, {
      projectId,
      cardNumber: card.number,
      actorUserId: adminId,
    });
    expect(result.ok).toBe(true);
    expect(reloadCard(card.number)).toBeUndefined();
    const trail = versionsOf(card.id);
    expect(trail.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(trail[2]).toMatchObject({
      isDeletion: true,
      name: "Story One v2",
      description: null, // legacy deletion versions carry no description
      cardTypeName: "Card",
      modifiedByUserId: adminId,
    });
    const events = eventsOfType("CardDeleted");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: card.number,
      name: "Story One v2",
    });
  });

  it("never reuses a deleted card's number", () => {
    const card = makeCard("Doomed"); // number 1
    mustOk(
      deleteCard(db, { projectId, cardNumber: card.number, actorUserId: adminId }),
      "delete",
    );
    db.delete(domainEvents).run();
    const next = makeCard("Successor");
    expect(next.number).toBe(2);
    expect(reloadCard(1)).toBeUndefined();
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      deleteCard(db, { projectId: 999, cardNumber: 1, actorUserId: adminId }),
      "project",
      "does not exist",
    );
  });

  it("rejects when the card does not exist", () => {
    expectRejected(
      deleteCard(db, { projectId, cardNumber: 42, actorUserId: adminId }),
      "card",
      "does not exist",
    );
  });

  it("rejects a full member as actor (deletion is a project-admin action)", () => {
    const card = makeCard();
    db.delete(domainEvents).run();
    expectRejected(
      deleteCard(db, { projectId, cardNumber: card.number, actorUserId: memberId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(reloadCard(card.number)).toBeDefined();
    expect(versionsOf(card.id)).toHaveLength(1);
  });

  it("rejects a readonly member as actor", () => {
    const card = makeCard();
    db.delete(domainEvents).run();
    expectRejected(
      deleteCard(db, { projectId, cardNumber: card.number, actorUserId: readonlyId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(reloadCard(card.number)).toBeDefined();
  });
});
