/**
 * Behavioral tests for formula properties (Phase 8).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for the
 * formula kind of DefinePropertyDefinition and the recompute behavior
 * of SetCardPropertyValue. Includes the phase's exit-criterion
 * REAL-PATH test (rule 13a, "engine"-shaped): changing an input
 * property on a real persisted card recomputes and persists the
 * formula's stored value, read back from the database; and malformed
 * formulas are rejected at definition time, never at evaluation time.
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
import { createCard } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-formulas-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let memberId: number;
let projectId: number;
let defaultTypeId: number;
let cardNumber: number;
let estimateId: number; // "Estimate", number kind
let dueId: number; //      "Due", date kind
let startId: number; //    "Start", date kind

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

function define(input: {
  name: string;
  kind: string;
  values?: string[];
  formula?: string | null;
  nullIsZero?: boolean;
}) {
  return definePropertyDefinition(db, {
    projectId,
    actorUserId: adminId,
    ...input,
  });
}

function set(propertyDefinitionId: number, value: string | null) {
  return setCardPropertyValue(db, {
    projectId,
    cardNumber,
    propertyDefinitionId,
    value,
    actorUserId: memberId,
  });
}

function cardId(): number {
  return db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, cardNumber)))
    .get()!.id;
}

/** The stored (materialized) value of one property on the test card. */
function storedValue(propertyDefinitionId: number): string | null {
  const row = db
    .select({ value: cardPropertyValues.value })
    .from(cardPropertyValues)
    .where(
      and(
        eq(cardPropertyValues.cardId, cardId()),
        eq(cardPropertyValues.propertyDefinitionId, propertyDefinitionId),
      ),
    )
    .get();
  return row?.value ?? null;
}

function latestVersion() {
  return db
    .select()
    .from(cardVersions)
    .where(eq(cardVersions.cardId, cardId()))
    .orderBy(desc(cardVersions.version))
    .get()!;
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
  memberId = register("dev");
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "test project creation",
  ).id;
  defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  mustOk(
    addTeamMember(db, {
      projectId,
      userId: memberId,
      role: "full_member",
      actorUserId: adminId,
    }),
    "test membership setup",
  );
  cardNumber = mustOk(
    createCard(db, {
      projectId,
      name: "Story one",
      cardTypeId: defaultTypeId,
      actorUserId: memberId,
    }),
    "test card creation",
  ).number;
  estimateId = mustOk(define({ name: "Estimate", kind: "number" }), "Estimate").id;
  dueId = mustOk(define({ name: "Due", kind: "date" }), "Due").id;
  startId = mustOk(define({ name: "Start", kind: "date" }), "Start").id;
  db.delete(domainEvents).run(); // only events under test matter below
});

describe("DefinePropertyDefinition — formula kind", () => {
  it("persists the definition with formula text and emits the event", () => {
    const row = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2" }),
      "define formula",
    );
    const reloaded = db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.id, row.id))
      .get()!;
    expect(reloaded.kind).toBe("formula");
    expect(reloaded.formula).toBe("Estimate * 2");
    expect(reloaded.nullIsZero).toBe(false);
    const events = db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.type, "PropertyDefinitionDefined"))
      .all();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      name: "Points",
      kind: "formula",
      formula: "Estimate * 2",
    });
  });

  it("backfills computed values for existing cards without appending versions", () => {
    mustOk(set(estimateId, "3"), "seed Estimate"); // card now at version 2
    const versionBefore = latestVersion().version;
    const formula = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2 + 1" }),
      "define formula",
    );
    expect(storedValue(formula.id)).toBe("7");
    expect(latestVersion().version).toBe(versionBefore); // no version churn
  });

  it("backfills every existing card, each from its own input values", () => {
    mustOk(set(estimateId, "3"), "seed card #1 Estimate");
    const secondNumber = mustOk(
      createCard(db, {
        projectId,
        name: "Story two",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "second card",
    ).number;
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: secondNumber,
        propertyDefinitionId: estimateId,
        value: "10",
        actorUserId: memberId,
      }),
      "seed card #2 Estimate",
    );
    const thirdNumber = mustOk(
      createCard(db, {
        projectId,
        name: "Story three (no Estimate)",
        cardTypeId: defaultTypeId,
        actorUserId: memberId,
      }),
      "third card",
    ).number;
    const formula = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2" }),
      "define formula",
    );
    const valueOf = (number: number) => {
      const card = db
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
        .get()!;
      return (
        db
          .select({ value: cardPropertyValues.value })
          .from(cardPropertyValues)
          .where(
            and(
              eq(cardPropertyValues.cardId, card.id),
              eq(cardPropertyValues.propertyDefinitionId, formula.id),
            ),
          )
          .get()?.value ?? null
      );
    };
    expect(valueOf(cardNumber)).toBe("6"); //     3 * 2
    expect(valueOf(secondNumber)).toBe("20"); // 10 * 2 — its own inputs
    expect(valueOf(thirdNumber)).toBeNull(); //  unset input, no row
  });

  it("backfills nothing when the result is unset (null input, no nullIsZero)", () => {
    const formula = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2" }),
      "define formula",
    );
    expect(storedValue(formula.id)).toBeNull();
  });

  it("EXIT CRITERION: rejects malformed formulas at definition time, persisting nothing", () => {
    const cases: [string, RegExp][] = [
      ["", /^Formula cannot be blank\.$/],
      ["   ", /^Formula cannot be blank\.$/],
      ["1 +", /not well formed/],
      ["((2)", /not well formed/],
      ["2 3", /not well formed/],
      ["Estimate & 2", /not well formed|Unexpected characters/],
    ];
    for (const [formula, pattern] of cases) {
      const errors = mustReject(
        define({ name: "Bad", kind: "formula", formula }),
        `formula ${JSON.stringify(formula)}`,
      );
      expect(errors.formula!.join(" "), formula).toMatch(pattern);
    }
    expect(
      db
        .select()
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.kind, "formula"))
        .all(),
    ).toHaveLength(0);
  });

  it("rejects unknown, non-numeric, and formula-typed operands", () => {
    mustOk(define({ name: "Notes", kind: "text" }), "Notes");
    mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2" }),
      "Points",
    );
    expect(
      mustReject(
        define({ name: "F1", kind: "formula", formula: "Missing + 1" }),
        "unknown property",
      ).formula,
    ).toEqual(["No such property: Missing"]);
    expect(
      mustReject(
        define({ name: "F2", kind: "formula", formula: "Notes + 1" }),
        "text operand",
      ).formula,
    ).toEqual(["Property Notes is not numeric."]);
    expect(
      mustReject(
        define({ name: "F3", kind: "formula", formula: "Points + 1" }),
        "formula operand",
      ).formula,
    ).toEqual([
      "Property Points is a formula property and cannot be used within another formula.",
    ]);
  });

  it("rejects type-incompatible operations at definition time", () => {
    const cases: [string, RegExp][] = [
      ["Due + Start", /cannot be added to a date/],
      ["Estimate - Due", /cannot be subtracted from a number/],
      ["Due * 2", /cannot be multiplied or divided/],
      ["Due / 2", /cannot be multiplied or divided/],
      ["-Due", /cannot be negated/],
    ];
    for (const [formula, pattern] of cases) {
      const errors = mustReject(
        define({ name: "Bad", kind: "formula", formula }),
        formula,
      );
      expect(errors.formula!.join(" "), formula).toMatch(pattern);
    }
  });

  it("rejects formula or nullIsZero supplied for a non-formula kind", () => {
    expect(
      mustReject(
        define({ name: "N", kind: "number", formula: "1 + 1" }),
        "formula on number",
      ).formula,
    ).toEqual(["is only allowed for a formula property"]);
    expect(
      mustReject(
        define({ name: "N", kind: "number", nullIsZero: true }),
        "nullIsZero on number",
      ).formula,
    ).toEqual(["is only allowed for a formula property"]);
  });
});

describe("SetCardPropertyValue — formula recomputation", () => {
  it("EXIT CRITERION (real path): changing an input recomputes and persists the formula value", () => {
    mustOk(set(estimateId, "3"), "seed Estimate");
    const formula = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2 + 1" }),
      "define formula",
    );
    expect(storedValue(formula.id)).toBe("7");

    mustOk(set(estimateId, "5"), "change Estimate");
    // read straight from the DB: the materialized value is fresh
    expect(storedValue(formula.id)).toBe("11");
    // and the appended version's snapshot carries it under the formula's id
    const snapshot = JSON.parse(latestVersion().propertyValues);
    expect(snapshot[String(formula.id)]).toBe("11");
    expect(snapshot[String(estimateId)]).toBe("5");
  });

  it("clearing an input clears the formula value (row deleted)", () => {
    mustOk(set(estimateId, "3"), "seed");
    const formula = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2" }),
      "define",
    );
    expect(storedValue(formula.id)).toBe("6");
    mustOk(set(estimateId, null), "clear Estimate");
    expect(storedValue(formula.id)).toBeNull();
    expect(
      JSON.parse(latestVersion().propertyValues)[String(formula.id)],
    ).toBeUndefined();
  });

  it("nullIsZero evaluates unset numeric inputs as 0", () => {
    const formula = mustOk(
      define({
        name: "Padded",
        kind: "formula",
        formula: "Estimate + 10",
        nullIsZero: true,
      }),
      "define",
    );
    expect(storedValue(formula.id)).toBe("10"); // backfill with Estimate unset
    mustOk(set(estimateId, "4"), "set Estimate");
    expect(storedValue(formula.id)).toBe("14");
  });

  it("date arithmetic: date ± number and date - date", () => {
    const plus = mustOk(
      define({ name: "Slack", kind: "formula", formula: "Due + 2" }),
      "date plus",
    );
    const minus = mustOk(
      define({ name: "Lead", kind: "formula", formula: "Due - 3" }),
      "date minus",
    );
    const span = mustOk(
      define({ name: "Span", kind: "formula", formula: "Due - Start" }),
      "date diff",
    );
    mustOk(set(dueId, "2026-09-10"), "set Due");
    mustOk(set(startId, "2026-09-01"), "set Start");
    expect(storedValue(plus.id)).toBe("2026-09-12");
    expect(storedValue(minus.id)).toBe("2026-09-07");
    expect(storedValue(span.id)).toBe("9");
  });

  it("division by zero yields unset, not an error", () => {
    const formula = mustOk(
      define({ name: "Ratio", kind: "formula", formula: "10 / Estimate" }),
      "define",
    );
    mustOk(set(estimateId, "0"), "zero divisor");
    expect(storedValue(formula.id)).toBeNull();
    mustOk(set(estimateId, "4"), "nonzero divisor");
    expect(storedValue(formula.id)).toBe("2.5");
  });

  it("results round to precision 2 with trailing zeros trimmed (legacy default)", () => {
    const formula = mustOk(
      define({ name: "Third", kind: "formula", formula: "Estimate / 3" }),
      "define",
    );
    mustOk(set(estimateId, "10"), "set");
    expect(storedValue(formula.id)).toBe("3.33");
    mustOk(set(estimateId, "6"), "set integral");
    expect(storedValue(formula.id)).toBe("2");
  });

  it("quoted identifiers, grouping brackets, and unary minus evaluate correctly", () => {
    const spacey = mustOk(
      define({ name: "Story Points", kind: "number" }),
      "spacey property",
    );
    const formula = mustOk(
      define({
        name: "Weighted",
        kind: "formula",
        formula: "-{'Story Points' * [2 + 1]}",
      }),
      "define",
    );
    mustOk(set(spacey.id, "4"), "set");
    expect(storedValue(formula.id)).toBe("-12");
  });

  it("rejects setting a formula property directly, mutating nothing", () => {
    const formula = mustOk(
      define({ name: "Points", kind: "formula", formula: "Estimate * 2" }),
      "define",
    );
    const versionBefore = latestVersion().version;
    const errors = mustReject(set(formula.id, "99"), "direct set");
    expect(errors.property).toEqual([
      "Points is a formula property and cannot be set directly",
    ]);
    expect(storedValue(formula.id)).toBeNull();
    expect(latestVersion().version).toBe(versionBefore);
    expect(
      db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.type, "CardPropertyValueSet"))
        .all(),
    ).toHaveLength(0);
  });

  it("one input change updates several dependent formulas in the same version", () => {
    const double = mustOk(
      define({ name: "Double", kind: "formula", formula: "Estimate * 2" }),
      "double",
    );
    const triple = mustOk(
      define({ name: "Triple", kind: "formula", formula: "Estimate * 3" }),
      "triple",
    );
    mustOk(set(estimateId, "5"), "set");
    expect(storedValue(double.id)).toBe("10");
    expect(storedValue(triple.id)).toBe("15");
    const snapshot = JSON.parse(latestVersion().propertyValues);
    expect(snapshot[String(double.id)]).toBe("10");
    expect(snapshot[String(triple.id)]).toBe("15");
  });
});
