/**
 * Behavioral tests for the card list view and filters (Phase 9).
 *
 * Derived line-by-line from the matching rules documented in
 * app/domain/cards/list-view.server.ts (the CardListView read model):
 * per-kind equality and ordinal comparisons (numeric CAST for numbers
 * and number formulas, ISO-lexical for dates, defined-position order
 * for enumerated values), legacy unset semantics ("is (not set)",
 * "is not X" matching unset cards, ordinals rejecting (not set)),
 * legacy combination semantics (same-property equality ORs, equality
 * OR collective within a group, groups AND across properties), the
 * Type pseudo-property, filter validation errors in legacy phrasing,
 * and column selection. This is the phase exit criterion: filtering by
 * one or more property values returns exactly the matching cards,
 * verified against seeded DB rows.
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations — no stubs, no fakes.
 * Cards and values are seeded through the real command handlers.
 *
 * Owner context: Card Management verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardTypes } from "../app/db/schema/cards";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard, defineCardType } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import {
  buildCardListView,
  encodeFilterString,
  parseFilterString,
  queryCardList,
} from "../app/domain/cards/list-view.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-card-list-"));
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
let ownerId: number;
let projectId: number;

// Seeded card numbers, named for readability in assertions.
let storyOne: number; //   Card, Status=Open,   Estimate=10, Due=2026-09-10, Notes=alpha, Owner=owner
let storyTwo: number; //   Card, Status=New,    Estimate=3,  Due=2026-08-01
let bugOne: number; //     Bug,  Status=Closed, Estimate=9
let storyThree: number; // Card, nothing set

let statusId: number;
let estimateId: number;
let dueId: number;
let notesId: number;
let ownerPropId: number;

beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "admin", name: "Admin", password: "card-wall-2010!" }),
    "register admin",
  ).id;
  ownerId = mustOk(
    registerUser(db, { login: "owner", name: "Olive Owner", password: "card-wall-2010!" }),
    "register owner",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "List View", actorUserId: adminId }),
    "create project",
  ).id;
  mustOk(
    addTeamMember(db, { projectId, userId: ownerId, actorUserId: adminId }),
    "add owner to team",
  );

  const defaultType = db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.name, "Card")))
    .get()!;
  const bugType = mustOk(
    defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }),
    "define Bug type",
  );

  const define = (input: Parameters<typeof definePropertyDefinition>[1]) =>
    mustOk(definePropertyDefinition(db, input), `define ${input.name}`);
  // Enumeration order (New, Open, Closed) deliberately differs from
  // lexical order (Closed, New, Open) so position tests can't pass by
  // accident of string comparison.
  statusId = define({
    projectId,
    name: "Status",
    kind: "enumerated",
    values: ["New", "Open", "Closed"],
    actorUserId: adminId,
  }).id;
  estimateId = define({ projectId, name: "Estimate", kind: "number", actorUserId: adminId }).id;
  dueId = define({ projectId, name: "Due", kind: "date", actorUserId: adminId }).id;
  notesId = define({ projectId, name: "Notes", kind: "text", actorUserId: adminId }).id;
  ownerPropId = define({ projectId, name: "Owner", kind: "user", actorUserId: adminId }).id;
  define({
    projectId,
    name: "Points",
    kind: "formula",
    formula: "Estimate * 2",
    actorUserId: adminId,
  });

  const card = (name: string, cardTypeId: number) =>
    mustOk(createCard(db, { projectId, name, cardTypeId, actorUserId: adminId }), name).number;
  const set = (cardNumber: number, propertyDefinitionId: number, value: string) =>
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber,
        propertyDefinitionId,
        value,
        actorUserId: adminId,
      }),
      `set ${propertyDefinitionId}=${value} on #${cardNumber}`,
    );

  storyOne = card("Story one", defaultType.id);
  set(storyOne, statusId, "Open");
  set(storyOne, estimateId, "10");
  set(storyOne, dueId, "2026-09-10");
  set(storyOne, notesId, "alpha");
  set(storyOne, ownerPropId, String(ownerId));

  storyTwo = card("Story two", defaultType.id);
  set(storyTwo, statusId, "New");
  set(storyTwo, estimateId, "3");
  set(storyTwo, dueId, "2026-08-01");

  bugOne = card("Bug one", bugType.id);
  set(bugOne, statusId, "Closed");
  set(bugOne, estimateId, "9");

  storyThree = card("Story three", defaultType.id);
});

/** Runs filters through the real view builder + query; returns numbers. */
function listNumbers(filterStrings: string[]): number[] {
  const view = buildCardListView(db, projectId, filterStrings, []);
  expect(view.errors).toEqual([]);
  return queryCardList(db, projectId, view.filters).map((r) => r.number);
}

/** Runs filters expecting validation errors; returns them. */
function listErrors(filterStrings: string[]): string[] {
  return buildCardListView(db, projectId, filterStrings, []).errors;
}

const f = encodeFilterString;

describe("filter string codec", () => {
  it("decodes the legacy encoded form and round-trips through encode", () => {
    expect(parseFilterString("[Status][is][Open]")).toEqual({
      propertyName: "Status",
      operator: "is",
      value: "Open",
    });
    expect(parseFilterString(f("Status", "is not", ""))).toEqual({
      propertyName: "Status",
      operator: "is not",
      value: "",
    });
    expect(parseFilterString("garbage")).toBeNull();
  });
});

describe("equality filters", () => {
  it("returns exactly the cards whose value matches, case-insensitively", () => {
    expect(listNumbers([f("Status", "is", "Open")])).toEqual([storyOne]);
    expect(listNumbers([f("Notes", "is", "ALPHA")])).toEqual([storyOne]);
  });

  it("compares number values numerically, not textually", () => {
    // "10.0" must match the stored "10" (legacy numeric comparison).
    expect(listNumbers([f("Estimate", "is", "10.0")])).toEqual([storyOne]);
  });

  it("matches a user property by the member's id", () => {
    expect(listNumbers([f("Owner", "is", String(ownerId))])).toEqual([storyOne]);
  });

  it("'is (not set)' returns exactly the cards with no value row", () => {
    expect(listNumbers([f("Status", "is", "")])).toEqual([storyThree]);
    expect(listNumbers([f("Owner", "is", "")]).sort()).toEqual(
      [storyTwo, bugOne, storyThree].sort(),
    );
  });

  it("'is not X' matches differing AND unset cards (legacy IS NULL branch)", () => {
    expect(listNumbers([f("Status", "is not", "Open")]).sort()).toEqual(
      [storyTwo, bugOne, storyThree].sort(),
    );
  });

  it("'is not (not set)' returns exactly the cards with any value", () => {
    expect(listNumbers([f("Status", "is not", "")]).sort()).toEqual(
      [storyOne, storyTwo, bugOne].sort(),
    );
  });
});

describe("range filters", () => {
  it("compares number properties numerically (CAST, not lexical)", () => {
    // Lexically "10" < "5", so a text comparison would drop storyOne.
    expect(listNumbers([f("Estimate", "is greater than", "5")]).sort()).toEqual(
      [storyOne, bugOne].sort(),
    );
    expect(listNumbers([f("Estimate", "is less than", "5")])).toEqual([storyTwo]);
  });

  it("compares date properties chronologically, accepting the date alias names", () => {
    expect(listNumbers([f("Due", "is before", "2026-09-01")])).toEqual([storyTwo]);
    expect(listNumbers([f("Due", "is after", "2026-09-01")])).toEqual([storyOne]);
    expect(listNumbers([f("Due", "is less than", "2026-09-01")])).toEqual([storyTwo]);
  });

  it("orders enumerated values by defined position, not lexically", () => {
    // Positions: New(1) < Open(2) < Closed(3); lexically Closed < Open.
    // A lexical comparison would return only storyOne here.
    expect(listNumbers([f("Status", "is greater than", "New")]).sort()).toEqual(
      [storyOne, bugOne].sort(),
    );
    expect(listNumbers([f("Status", "is less than", "Open")])).toEqual([storyTwo]);
  });

  it("compares a number-valued formula property numerically", () => {
    // Points = Estimate * 2: storyOne=20, storyTwo=6, bugOne=18, storyThree unset.
    expect(listNumbers([f("Points", "is greater than", "10")]).sort()).toEqual(
      [storyOne, bugOne].sort(),
    );
    expect(listNumbers([f("Points", "is", "")])).toEqual([storyThree]);
  });
});

describe("filter combination (legacy FilterGroup semantics)", () => {
  it("ORs equality filters on the same property", () => {
    expect(
      listNumbers([f("Status", "is", "New"), f("Status", "is", "Open")]).sort(),
    ).toEqual([storyOne, storyTwo].sort());
  });

  it("ORs the equality half against the collective half within one property", () => {
    // Estimate is 3 OR Estimate > 8 — an AND reading would return nothing.
    expect(
      listNumbers([f("Estimate", "is", "3"), f("Estimate", "is greater than", "8")]).sort(),
    ).toEqual([storyOne, storyTwo, bugOne].sort());
  });

  it("ANDs collective filters on the same property", () => {
    // 5 < Estimate < 9.5 — only bugOne (9).
    expect(
      listNumbers([
        f("Estimate", "is greater than", "5"),
        f("Estimate", "is less than", "9.5"),
      ]),
    ).toEqual([bugOne]);
  });

  it("ANDs filters across different properties", () => {
    // Not Closed AND Estimate > 5: bugOne is Closed, storyTwo is 3,
    // storyThree has no Estimate — only storyOne survives.
    expect(
      listNumbers([
        f("Status", "is not", "Closed"),
        f("Estimate", "is greater than", "5"),
      ]),
    ).toEqual([storyOne]);
  });
});

describe("the Type pseudo-property", () => {
  it("filters by card type, case-insensitively", () => {
    expect(listNumbers([f("Type", "is", "bug")])).toEqual([bugOne]);
    expect(listNumbers([f("Type", "is not", "Bug")]).sort()).toEqual(
      [storyOne, storyTwo, storyThree].sort(),
    );
  });
});

describe("filter validation (legacy phrasing)", () => {
  it("rejects an unknown property", () => {
    expect(listErrors([f("Priority", "is", "High")])).toEqual([
      "Property Priority does not exist.",
    ]);
  });

  it("rejects an unknown operator", () => {
    expect(listErrors(["[Status][was][Open]"])).toEqual([
      "'was' is not a valid filter operator.",
    ]);
  });

  it("rejects ordinal operators on text and user properties", () => {
    expect(listErrors([f("Notes", "is less than", "b")])).toEqual([
      "Property Notes does not support operator 'is less than'.",
    ]);
    expect(listErrors([f("Owner", "is greater than", String(ownerId))])).toEqual([
      "Property Owner does not support operator 'is greater than'.",
    ]);
  });

  it("rejects (not set) under an ordinal operator", () => {
    expect(listErrors([f("Estimate", "is greater than", "")])).toEqual([
      "(not set) is not a valid filter for operator 'is greater than'.",
    ]);
  });

  it("rejects per-kind invalid values, never silently coercing", () => {
    expect(listErrors([f("Estimate", "is", "abc")])).toEqual([
      "Estimate: 'abc' is an invalid numeric value",
    ]);
    expect(listErrors([f("Due", "is", "next week")])).toEqual([
      "Due: 'next week' is an invalid date. Enter dates in yyyy-mm-dd format",
    ]);
    expect(listErrors([f("Status", "is", "Banana")])).toEqual([
      "Property Status contains invalid value Banana",
    ]);
    expect(listErrors([f("Type", "is", "Epic")])).toEqual([
      "Card Type Type contains invalid value Epic",
    ]);
  });

  it("skips blank rows from the empty add-a-filter form row", () => {
    expect(listErrors([f("", "is", "")])).toEqual([]);
    expect(listNumbers([f("", "is", "")]).sort()).toEqual(
      [storyOne, storyTwo, bugOne, storyThree].sort(),
    );
  });
});

describe("column selection", () => {
  it("resolves requested columns case-insensitively, in request order", () => {
    const view = buildCardListView(db, projectId, [], ["status", "Type", "Estimate"]);
    expect(view.columns.map((c) => c.name)).toEqual(["Status", "Type", "Estimate"]);
    expect(view.columns[1].key).toBe("type");
    expect(view.columns[0].key).toBe(String(statusId));
  });

  it("drops unknown column names and duplicates", () => {
    const view = buildCardListView(db, projectId, [], ["Nope", "Status", "STATUS"]);
    expect(view.columns.map((c) => c.name)).toEqual(["Status"]);
    expect(view.errors).toEqual([]);
  });
});

describe("unfiltered list", () => {
  it("returns every card in the project, newest number first", () => {
    expect(listNumbers([])).toEqual([storyThree, bugOne, storyTwo, storyOne]);
  });
});
