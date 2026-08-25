/**
 * Behavioral tests for the card wall / grid view (Phase 10).
 *
 * Derived from the lane rules documented in
 * app/domain/cards/grid-view.server.ts and the drop Behavior Statement
 * (session log): lanes for enumerated properties follow defined
 * position order with "(not set)" first, user lanes follow member name
 * order, filters reuse Phase 9 semantics, non-groupable kinds are
 * rejected. Includes the phase's exit-criterion REAL-PATH assertions:
 * a lane drop (SetCardPropertyValue with the target lane's value, as
 * dispatched by the grid route's drop action) persists the new
 * property value AND appends a card_versions row whose snapshot
 * carries the new value — both read back from the database, never
 * from return values alone.
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
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import { cardPropertyValues } from "../app/db/schema/properties";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import { buildGridView } from "../app/domain/cards/grid-view.server";
import { encodeFilterString } from "../app/domain/cards/list-view.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-card-grid-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number;
let memberId: number;
let readonlyId: number;
let projectId: number;
let statusId: number;
let ownerPropId: number;
let openCard: number; //   Status=Open
let newCard: number; //    Status=New, Owner=member
let closedCard: number; // Status=Closed, Estimate=9
let unsetCard: number; //  nothing set

beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "admin", name: "Admin", password: "card-wall-2010!" }),
    "register admin",
  ).id;
  memberId = mustOk(
    registerUser(db, { login: "member", name: "Mia Member", password: "card-wall-2010!" }),
    "register member",
  ).id;
  readonlyId = mustOk(
    registerUser(db, { login: "reader", name: "Ron Reader", password: "card-wall-2010!" }),
    "register reader",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "Wall", actorUserId: adminId }),
    "create project",
  ).id;
  mustOk(
    addTeamMember(db, { projectId, userId: memberId, actorUserId: adminId }),
    "add member",
  );
  mustOk(
    addTeamMember(db, {
      projectId,
      userId: readonlyId,
      role: "readonly_member",
      actorUserId: adminId,
    }),
    "add readonly member",
  );

  statusId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Status",
      kind: "enumerated",
      values: ["New", "Open", "Closed"],
      actorUserId: adminId,
    }),
    "define Status",
  ).id;
  ownerPropId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Owner",
      kind: "user",
      actorUserId: adminId,
    }),
    "define Owner",
  ).id;
  const estimateId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Estimate",
      kind: "number",
      actorUserId: adminId,
    }),
    "define Estimate",
  ).id;

  const cardType = db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.name, "Card")))
    .get()!;
  const card = (name: string) =>
    mustOk(
      createCard(db, { projectId, name, cardTypeId: cardType.id, actorUserId: adminId }),
      name,
    ).number;
  const set = (cardNumber: number, propertyDefinitionId: number, value: string) =>
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber,
        propertyDefinitionId,
        value,
        actorUserId: adminId,
      }),
      `set on #${cardNumber}`,
    );

  openCard = card("Open story");
  set(openCard, statusId, "Open");
  newCard = card("New story");
  set(newCard, statusId, "New");
  set(newCard, ownerPropId, String(memberId));
  closedCard = card("Closed story");
  set(closedCard, statusId, "Closed");
  set(closedCard, estimateId, "9");
  unsetCard = card("Blank story");
});

/** Lane titles → card numbers, for compact lane assertions. */
function laneMap(groupBy: string, filters: string[] = []): Record<string, number[]> {
  const view = buildGridView(db, projectId, groupBy, filters);
  expect(view.errors).toEqual([]);
  return Object.fromEntries(
    view.lanes.map((lane) => [lane.title, lane.cards.map((c) => c.number)]),
  );
}

function statusRow(cardNumber: number) {
  const card = db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, cardNumber)))
    .get()!;
  return {
    card,
    value: db
      .select()
      .from(cardPropertyValues)
      .where(
        and(
          eq(cardPropertyValues.cardId, card.id),
          eq(cardPropertyValues.propertyDefinitionId, statusId),
        ),
      )
      .get(),
    versions: db
      .select()
      .from(cardVersions)
      .where(eq(cardVersions.cardId, card.id))
      .orderBy(desc(cardVersions.version))
      .all(),
  };
}

describe("lane building", () => {
  it("orders enumerated lanes by defined position with (not set) first", () => {
    const view = buildGridView(db, projectId, "Status", []);
    expect(view.errors).toEqual([]);
    expect(view.lanes.map((l) => l.title)).toEqual(["(not set)", "New", "Open", "Closed"]);
    expect(view.groupBy?.id).toBe(statusId);
  });

  it("distributes every matching card into exactly its value's lane", () => {
    expect(laneMap("Status")).toEqual({
      "(not set)": [unsetCard],
      New: [newCard],
      Open: [openCard],
      Closed: [closedCard],
    });
  });

  it("groups by a user property with member-name lanes", () => {
    const lanes = laneMap("Owner");
    // Lanes are TEAM MEMBERS only — the site admin never joined the team.
    expect(Object.keys(lanes)).toEqual(["(not set)", "Mia Member", "Ron Reader"]);
    expect(lanes["Mia Member"]).toEqual([newCard]);
    expect(lanes["(not set)"].sort()).toEqual([openCard, closedCard, unsetCard].sort());
  });

  it("renders an ungrouped wall as one lane holding every card", () => {
    const view = buildGridView(db, projectId, "", []);
    expect(view.groupBy).toBeUndefined();
    expect(view.lanes).toHaveLength(1);
    expect(view.lanes[0].cards.map((c) => c.number).sort()).toEqual(
      [openCard, newCard, closedCard, unsetCard].sort(),
    );
  });

  it("applies Phase 9 filters before grouping", () => {
    const lanes = laneMap("Status", [encodeFilterString("Estimate", "is greater than", "5")]);
    expect(lanes).toEqual({
      "(not set)": [],
      New: [],
      Open: [],
      Closed: [closedCard],
    });
  });

  it("rejects an unknown or non-groupable group-by property", () => {
    expect(buildGridView(db, projectId, "Nope", []).errors).toEqual([
      "Property Nope does not exist.",
    ]);
    expect(buildGridView(db, projectId, "Estimate", []).errors).toEqual([
      "Property Estimate cannot be used to group the grid.",
    ]);
  });

  it("propagates filter validation errors", () => {
    const view = buildGridView(db, projectId, "Status", ["[Nope][is][x]"]);
    expect(view.errors).toEqual(["Property Nope does not exist."]);
    expect(view.lanes).toEqual([]);
  });
});

describe("lane drop (exit criterion — REAL-PATH, rule 13a shape)", () => {
  it("persists the new value AND appends a version row snapshotting it", () => {
    const before = statusRow(newCard);
    const result = setCardPropertyValue(db, {
      projectId,
      cardNumber: newCard,
      propertyDefinitionId: statusId,
      value: "Open", // the drop action dispatches the target lane's value
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);

    const after = statusRow(newCard);
    expect(after.value?.value).toBe("Open"); // reloaded from the DB
    expect(after.card.version).toBe(before.card.version + 1);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    const snapshot = JSON.parse(after.versions[0].propertyValues) as Record<string, string>;
    expect(snapshot[String(statusId)]).toBe("Open");

    // The wall itself reflects the move.
    const lanes = laneMap("Status");
    expect(lanes.Open.sort()).toEqual([openCard, newCard].sort());
    expect(lanes.New).toEqual([]);
  });

  it("clears the value on a (not set) lane drop, still appending a version", () => {
    const before = statusRow(newCard);
    const result = setCardPropertyValue(db, {
      projectId,
      cardNumber: newCard,
      propertyDefinitionId: statusId,
      value: null, // the drop action translates the "" lane to null
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);

    const after = statusRow(newCard);
    expect(after.value).toBeUndefined(); // the row is gone
    expect(after.versions).toHaveLength(before.versions.length + 1);
    const snapshot = JSON.parse(after.versions[0].propertyValues) as Record<string, string>;
    expect(snapshot[String(statusId)]).toBeUndefined();
    expect(laneMap("Status")["(not set)"].sort()).toEqual([newCard, unsetCard].sort());
  });

  it("rejects a drop onto an invalid lane value with no state change", () => {
    const before = statusRow(openCard);
    const result = setCardPropertyValue(db, {
      projectId,
      cardNumber: openCard,
      propertyDefinitionId: statusId,
      value: "Banana",
      actorUserId: memberId,
    });
    expect(result.ok).toBe(false);
    const after = statusRow(openCard);
    expect(after.value?.value).toBe("Open");
    expect(after.versions).toHaveLength(before.versions.length);
  });

  it("rejects a readonly member's drop with no state change", () => {
    const before = statusRow(openCard);
    const result = setCardPropertyValue(db, {
      projectId,
      cardNumber: openCard,
      propertyDefinitionId: statusId,
      value: "New",
      actorUserId: readonlyId,
    });
    expect(result.ok).toBe(false);
    const after = statusRow(openCard);
    expect(after.value?.value).toBe("Open");
    expect(after.versions).toHaveLength(before.versions.length);
  });
});
