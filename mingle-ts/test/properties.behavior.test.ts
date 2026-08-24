/**
 * Behavioral tests for managed card properties (Phase 7).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * DefinePropertyDefinition and SetCardPropertyValue: every DOES asserts
 * on rows reloaded from the database, and every REJECTS WHEN has its
 * own independent rejection test proving nothing mutated — including
 * the exit-criterion tests: a card carrying one property of each of the
 * five kinds (verified against persisted rows and the version
 * snapshot), and rejection (not coercion) of an invalid enum value and
 * a non-numeric Number value.
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
import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { projects } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import { teamMemberships } from "../app/db/schema/membership";
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
} from "../app/db/schema/properties";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import {
  createCard,
  deleteCard,
  updateCard,
} from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-properties-"));
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
let projectAdminId: number; // project_admin of the project
let memberId: number; //     full_member of the project
let readonlyId: number; //   readonly_member of the project
let outsiderId: number; //   registered user, not on the team
let projectId: number;
let defaultTypeId: number; // the "Card" type every project starts with
let cardNumber: number; //   a card created fresh per test

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

function mustReject<T>(result: CommandResult<T>, what: string) {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return result.errors;
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(cardPropertyValues).run();
  db.delete(enumerationValues).run();
  db.delete(propertyDefinitions).run();
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss");
  projectAdminId = register("lead");
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
    [projectAdminId, "project_admin"],
    [memberId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const) {
    mustOk(
      addTeamMember(db, { projectId, userId, role, actorUserId: adminId }),
      `test membership setup for ${userId}`,
    );
  }
  cardNumber = mustOk(
    createCard(db, {
      projectId,
      name: "Story one",
      cardTypeId: defaultTypeId,
      actorUserId: memberId,
    }),
    "test card creation",
  ).number;
  db.delete(domainEvents).run(); // only events under test matter below
});

function define(
  name: string,
  kind: string,
  values?: string[],
  actorUserId = projectAdminId,
) {
  return definePropertyDefinition(db, {
    projectId,
    name,
    kind,
    values,
    actorUserId,
  });
}

function reloadDefinitions() {
  return db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, projectId))
    .orderBy(asc(propertyDefinitions.position))
    .all();
}

function reloadCard() {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, cardNumber)))
    .get()!;
}

function reloadValues(cardId: number) {
  return db
    .select({
      propertyDefinitionId: cardPropertyValues.propertyDefinitionId,
      value: cardPropertyValues.value,
    })
    .from(cardPropertyValues)
    .where(eq(cardPropertyValues.cardId, cardId))
    .all();
}

function latestVersion(cardId: number) {
  return db
    .select()
    .from(cardVersions)
    .where(eq(cardVersions.cardId, cardId))
    .orderBy(desc(cardVersions.version))
    .get()!;
}

function eventsOfType(type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all();
}

describe("DefinePropertyDefinition", () => {
  it("persists a definition of each kind with appended positions", () => {
    const kinds = ["text", "number", "date", "user", "enumerated"] as const;
    for (const kind of kinds) mustOk(define(`p ${kind}`, kind), `define ${kind}`);
    const rows = reloadDefinitions();
    expect(rows.map((row) => [row.name, row.kind, row.position])).toEqual(
      kinds.map((kind, i) => [`p ${kind}`, kind, i + 1]),
    );
  });

  it("persists ordered enumeration values with their exact casing", () => {
    const definition = mustOk(
      define("Priority", "enumerated", ["High", "Medium", "LOW"]),
      "define enumerated",
    );
    const rows = db
      .select()
      .from(enumerationValues)
      .where(eq(enumerationValues.propertyDefinitionId, definition.id))
      .orderBy(asc(enumerationValues.position))
      .all();
    expect(rows.map((row) => [row.value, row.position])).toEqual([
      ["High", 1],
      ["Medium", 2],
      ["LOW", 3],
    ]);
  });

  it("emits PropertyDefinitionDefined with name, kind, and values", () => {
    mustOk(define("Priority", "enumerated", ["High", "Low"]), "define");
    const events = eventsOfType("PropertyDefinitionDefined");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      name: "Priority",
      kind: "enumerated",
      values: ["High", "Low"],
    });
  });

  it("rejects an unknown project and persists nothing", () => {
    const errors = mustReject(
      definePropertyDefinition(db, {
        projectId: 424242,
        name: "Estimate",
        kind: "number",
        actorUserId: projectAdminId,
      }),
      "unknown project",
    );
    expect(errors.project).toEqual(["does not exist"]);
    expect(reloadDefinitions()).toHaveLength(0);
  });

  it("rejects actors below project administrator and persists nothing", () => {
    for (const actorUserId of [memberId, readonlyId, outsiderId]) {
      const errors = mustReject(
        define("Estimate", "number", undefined, actorUserId),
        `actor ${actorUserId}`,
      );
      expect(errors.authorization).toBeDefined();
    }
    expect(reloadDefinitions()).toHaveLength(0);
    expect(eventsOfType("PropertyDefinitionDefined")).toHaveLength(0);
  });

  it("rejects invalid names and persists nothing", () => {
    const cases: [string, string][] = [
      ["", "can't be blank"],
      ["x".repeat(41), "is too long (maximum is 40 characters)"],
      [
        "bad[name]",
        "should not contain '&', '=', '#', '\"', ';', '[' and ']' characters",
      ],
      ["_", "cannot be '_'"],
      ["Type", "is a reserved property name"],
      ["Created By", "is a reserved property name"],
      ["modified on", "is a reserved property name"],
    ];
    for (const [name, message] of cases) {
      const errors = mustReject(define(name, "text"), `name ${JSON.stringify(name)}`);
      expect(errors.name, name).toEqual([message]);
    }
    expect(reloadDefinitions()).toHaveLength(0);
  });

  it("rejects a case-insensitively taken name", () => {
    mustOk(define("Priority", "text"), "first define");
    const errors = mustReject(define("PRIORITY", "date"), "duplicate name");
    expect(errors.name).toEqual(["has already been taken"]);
    expect(reloadDefinitions()).toHaveLength(1);
  });

  it("rejects an unknown kind", () => {
    const errors = mustReject(define("Estimate", "formula"), "unknown kind");
    expect(errors.kind).toEqual(["must be selected"]);
    expect(reloadDefinitions()).toHaveLength(0);
  });

  it("rejects values supplied for a non-enumerated kind", () => {
    const errors = mustReject(define("Estimate", "number", ["1", "2"]), "values");
    expect(errors.values).toEqual([
      "are only allowed for a managed list property",
    ]);
    expect(reloadDefinitions()).toHaveLength(0);
  });

  it("rejects invalid enumeration values and persists nothing", () => {
    const cases: [string[], string][] = [
      [["High", " "], "can't include a blank value"],
      [
        ["x".repeat(256)],
        `'${"x".repeat(256)}' is too long (maximum is 255 characters)`,
      ],
      [["(plv)"], "cannot both start with '(' and end with ')'"],
      [["High", "high"], "'high' has already been taken"],
    ];
    for (const [values, message] of cases) {
      const errors = mustReject(
        define("Priority", "enumerated", values),
        `values ${JSON.stringify(values)}`,
      );
      expect(errors.values, JSON.stringify(values)).toEqual([message]);
    }
    expect(reloadDefinitions()).toHaveLength(0);
    expect(
      db.select().from(enumerationValues).all(),
    ).toHaveLength(0);
  });
});

describe("SetCardPropertyValue", () => {
  /** Defines one property of each kind; returns their rows by kind. */
  function defineAllKinds() {
    return {
      text: mustOk(define("Notes", "text"), "define text"),
      number: mustOk(define("Estimate", "number"), "define number"),
      date: mustOk(define("Due", "date"), "define date"),
      user: mustOk(define("Owner", "user"), "define user"),
      enumerated: mustOk(
        define("Priority", "enumerated", ["High", "Medium", "Low"]),
        "define enumerated",
      ),
    };
  }

  function set(propertyDefinitionId: number, value: string | null, actorUserId = memberId) {
    return setCardPropertyValue(db, {
      projectId,
      cardNumber,
      propertyDefinitionId,
      value,
      actorUserId,
    });
  }

  it("EXIT CRITERION: a card carries one property of each of the five kinds, canonically stored and snapshotted", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.text.id, "needs review"), "set text");
    mustOk(set(defs.number.id, "8"), "set number");
    mustOk(set(defs.date.id, "2026-09-01"), "set date");
    mustOk(set(defs.user.id, String(memberId)), "set user");
    mustOk(set(defs.enumerated.id, "high"), "set enumerated (wrong case)");

    const card = reloadCard();
    expect(card.version).toBe(6); // created at 1, five property versions

    const values = reloadValues(card.id);
    const byDefinition = Object.fromEntries(
      values.map((row) => [row.propertyDefinitionId, row.value]),
    );
    expect(byDefinition).toEqual({
      [defs.text.id]: "needs review",
      [defs.number.id]: "8",
      [defs.date.id]: "2026-09-01",
      [defs.user.id]: String(memberId),
      [defs.enumerated.id]: "High", // canonicalized to the defined casing
    });

    // snapshots key by definition id, not name (ADR-0004: rename-immutable)
    const version = latestVersion(card.id);
    expect(version.version).toBe(6);
    expect(JSON.parse(version.propertyValues)).toEqual({
      [String(defs.text.id)]: "needs review",
      [String(defs.number.id)]: "8",
      [String(defs.date.id)]: "2026-09-01",
      [String(defs.user.id)]: String(memberId),
      [String(defs.enumerated.id)]: "High",
    });
  });

  it("appends one version row per mutation with the cumulative snapshot", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.number.id, "3"), "set number");
    mustOk(set(defs.enumerated.id, "Low"), "set enumerated");
    const card = reloadCard();
    const versions = db
      .select()
      .from(cardVersions)
      .where(eq(cardVersions.cardId, card.id))
      .orderBy(asc(cardVersions.version))
      .all();
    expect(versions.map((v) => [v.version, JSON.parse(v.propertyValues)])).toEqual([
      [1, {}],
      [2, { [String(defs.number.id)]: "3" }],
      [
        3,
        {
          [String(defs.number.id)]: "3",
          [String(defs.enumerated.id)]: "Low",
        },
      ],
    ]);
  });

  it("replaces an existing value in place (one row, new version)", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.enumerated.id, "High"), "first set");
    mustOk(set(defs.enumerated.id, "Medium"), "second set");
    const card = reloadCard();
    const rows = reloadValues(card.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("Medium");
    expect(card.version).toBe(3);
  });

  it("clears a value by deleting its row and snapshots the absence", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.text.id, "temp"), "set");
    mustOk(set(defs.text.id, null), "clear");
    const card = reloadCard();
    expect(reloadValues(card.id)).toHaveLength(0);
    expect(JSON.parse(latestVersion(card.id).propertyValues)).toEqual({});
    expect(card.version).toBe(3);
  });

  it("emits CardPropertyValueSet with the property name and canonical value", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.enumerated.id, "medium"), "set");
    const events = eventsOfType("CardPropertyValueSet");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: cardNumber,
      property: "Priority",
      value: "Medium",
    });
  });

  it("UpdateCard snapshots the card's property values into its version row", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.number.id, "5"), "set number");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber,
        name: "Story one renamed",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "update card",
    );
    const version = latestVersion(reloadCard().id);
    expect(version.name).toBe("Story one renamed");
    expect(JSON.parse(version.propertyValues)).toEqual({
      [String(defs.number.id)]: "5",
    });
  });

  it("DeleteCard cascades property value rows and keeps the version trail", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.number.id, "5"), "set number");
    const cardId = reloadCard().id;
    mustOk(
      deleteCard(db, { projectId, cardNumber, actorUserId: projectAdminId }),
      "delete card",
    );
    expect(reloadValues(cardId)).toHaveLength(0);
    const deletion = latestVersion(cardId);
    expect(deletion.isDeletion).toBe(true);
    expect(deletion.propertyValues).toBe("{}");
    // the pre-deletion snapshot survives in the trail
    const trail = db
      .select()
      .from(cardVersions)
      .where(and(eq(cardVersions.cardId, cardId), eq(cardVersions.version, 2)))
      .get()!;
    expect(JSON.parse(trail.propertyValues)).toEqual({
      [String(defs.number.id)]: "5",
    });
  });

  /** Asserts a rejection left no version row, no value change, no event. */
  function expectNothingMutated(versionBefore: number) {
    const card = reloadCard();
    expect(card.version).toBe(versionBefore);
    expect(latestVersion(card.id).version).toBe(versionBefore);
    expect(eventsOfType("CardPropertyValueSet")).toHaveLength(0);
  }

  it("rejects unknown project, card, and property definition", () => {
    const defs = defineAllKinds();
    const otherProjectId = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: adminId }),
      "other project",
    ).id;
    mustOk(
      addTeamMember(db, {
        projectId: otherProjectId,
        userId: memberId,
        role: "full_member",
        actorUserId: adminId,
      }),
      "other membership",
    );
    const foreign = mustOk(
      definePropertyDefinition(db, {
        projectId: otherProjectId,
        name: "Foreign",
        kind: "text",
        actorUserId: adminId,
      }),
      "foreign definition",
    );
    expect(
      mustReject(
        setCardPropertyValue(db, {
          projectId: 424242,
          cardNumber,
          propertyDefinitionId: defs.text.id,
          value: "x",
          actorUserId: memberId,
        }),
        "unknown project",
      ).project,
    ).toEqual(["does not exist"]);
    expect(
      mustReject(
        setCardPropertyValue(db, {
          projectId,
          cardNumber: 999,
          propertyDefinitionId: defs.text.id,
          value: "x",
          actorUserId: memberId,
        }),
        "unknown card",
      ).card,
    ).toEqual(["does not exist"]);
    expect(
      mustReject(set(foreign.id, "x"), "foreign definition").property,
    ).toEqual(["does not exist"]);
    expectNothingMutated(1);
  });

  it("rejects actors below full team member and mutates nothing", () => {
    const defs = defineAllKinds();
    for (const actorUserId of [readonlyId, outsiderId]) {
      const errors = mustReject(
        set(defs.text.id, "x", actorUserId),
        `actor ${actorUserId}`,
      );
      expect(errors.authorization).toBeDefined();
    }
    expect(reloadValues(reloadCard().id)).toHaveLength(0);
    expectNothingMutated(1);
  });

  it("EXIT CRITERION: rejects a non-numeric value for a Number property (no coercion)", () => {
    const defs = defineAllKinds();
    for (const bad of ["abc", "1.2.3", "12abc", "1,5"]) {
      const errors = mustReject(set(defs.number.id, bad), `number ${bad}`);
      expect(errors.value, bad).toEqual([
        `Estimate: '${bad}' is an invalid numeric value`,
      ]);
    }
    expect(reloadValues(reloadCard().id)).toHaveLength(0);
    expectNothingMutated(1);
  });

  it("EXIT CRITERION: rejects a value outside an enumerated definition's list (no coercion)", () => {
    const defs = defineAllKinds();
    const errors = mustReject(set(defs.enumerated.id, "Urgent"), "invalid enum");
    expect(errors.value).toEqual([
      "Priority is restricted to High, Medium, Low",
    ]);
    expect(reloadValues(reloadCard().id)).toHaveLength(0);
    expectNothingMutated(1);
  });

  it("rejects setting an enumerated property that has no defined values", () => {
    const empty = mustOk(define("Empty", "enumerated", []), "empty enum");
    const errors = mustReject(set(empty.id, "anything"), "empty list");
    expect(errors.value).toEqual(["Empty does not have any defined values"]);
    expectNothingMutated(1);
  });

  it("rejects invalid dates", () => {
    const defs = defineAllKinds();
    for (const bad of ["not-a-date", "01/09/2026", "2026-13-45"]) {
      const errors = mustReject(set(defs.date.id, bad), `date ${bad}`);
      expect(errors.value, bad).toEqual([
        `Due: '${bad}' is an invalid date. Enter dates in yyyy-mm-dd format`,
      ]);
    }
    expectNothingMutated(1);
  });

  it("rejects a user value that is not a valid user or not a team member", () => {
    const defs = defineAllKinds();
    expect(
      mustReject(set(defs.user.id, "424242"), "unknown user").value,
    ).toEqual(["Owner: '424242' is not a valid user"]);
    expect(
      mustReject(set(defs.user.id, String(outsiderId)), "non-member").value,
    ).toEqual(["Owner: outsider is not a project member"]);
    expect(reloadValues(reloadCard().id)).toHaveLength(0);
    expectNothingMutated(1);
  });

  it("rejects over-long and parenthesis-wrapped text values", () => {
    const defs = defineAllKinds();
    expect(
      mustReject(set(defs.text.id, "x".repeat(256)), "over-long").value,
    ).toEqual(["Notes: value is too long (maximum is 255 characters)"]);
    expect(
      mustReject(set(defs.text.id, "(plv)"), "parens").value,
    ).toEqual(["Notes: value cannot both start with '(' and end with ')'"]);
    expectNothingMutated(1);
  });

  it("rejects a no-change set: same value, numerically equal number, or clearing an unset property", () => {
    const defs = defineAllKinds();
    mustOk(set(defs.number.id, "5"), "seed number");
    mustOk(set(defs.text.id, "same"), "seed text");
    db.delete(domainEvents).run();
    const versionBefore = reloadCard().version;
    expect(mustReject(set(defs.text.id, "same"), "same text").card).toEqual([
      "has no changes to save",
    ]);
    expect(mustReject(set(defs.number.id, "5.0"), "5.0 == 5").card).toEqual([
      "has no changes to save",
    ]);
    expect(mustReject(set(defs.date.id, null), "clear unset").card).toEqual([
      "has no changes to save",
    ]);
    expectNothingMutated(versionBefore);
  });
});
