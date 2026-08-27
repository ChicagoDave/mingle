/**
 * Behavioral tests for the MQL evaluator and the advanced (MQL) filter
 * (Phase 13).
 *
 * Derived from the rule 12 Behavior Statements for `mqlCondition` /
 * `queryCardList` with MQL, `buildCardListView` in MQL mode, and
 * `saveFavorite` with an MQL view. This is the phase's exit-criterion
 * REAL-PATH suite (rule 13a, "database"-shaped): a seeded set of cards
 * with real persisted property values is queried through the real
 * Drizzle translation against a real, file-backed SQLite database with
 * the real migrations, and every result is compared row-for-row (by
 * card number) with the expected subset computed by hand from the
 * seed. No query layer is mocked.
 *
 * Owner context: Query verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cards } from "../app/db/schema/cards";
import { favorites } from "../app/db/schema/favorites";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import {
  createProject,
  defineProjectVariable,
} from "../app/domain/projects/commands.server";
import { createCard, defineCardType } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import {
  buildCardListView,
  encodeFilterString,
  queryCardList,
} from "../app/domain/cards/list-view.server";
import { buildGridView } from "../app/domain/cards/grid-view.server";
import {
  mqlCondition,
  queryCardsByMql,
  todayIso,
  type MqlEvaluationContext,
} from "../app/domain/cards/mql-evaluator.server";
import type { MqlCondition, MqlValue } from "../app/domain/cards/mql.server";
import { parseProjectMql } from "../app/domain/cards/mql-schema.server";
import { favoriteHref, saveFavorite } from "../app/domain/cards/favorites.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-mql-filter-"));
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

let projectId: number;
let adminId: number;
let devId: number;
let qaId: number;
let context: MqlEvaluationContext;
const ids: Record<string, number> = {};
const TODAY = todayIso();

/**
 * Seed (card number → values). "-" is unset.
 *
 *  #  type   status         priority  estimate  due          owner  notes
 *  1  Story  open           low       2         2026-01-10   dev    alpha
 *  2  Story  in development high      5         2026-03-01   qa     Beta
 *  3  Story  closed         medium    8         TODAY        dev    -
 *  4  Task   open           -         3         -            -      alpha
 *  5  Task   -              low       -         2026-03-01   dev    gamma
 *  6  Card   closed         high      13        2026-01-10   -      -
 * Effort (formula) = Estimate * 2 → 4, 10, 16, 6, -, 26
 */
beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "boss", name: "Boss", password: "card-wall-2010!" }),
    "boss",
  ).id;
  devId = mustOk(
    registerUser(db, { login: "dev", name: "Dev", password: "card-wall-2010!" }),
    "dev",
  ).id;
  qaId = mustOk(
    registerUser(db, { login: "qa", name: "QA", password: "card-wall-2010!" }),
    "qa",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "project",
  ).id;
  for (const userId of [devId, qaId]) {
    mustOk(
      addTeamMember(db, { projectId, userId, role: "full_member", actorUserId: adminId }),
      "member",
    );
  }
  const typeRows = new Map<string, number>();
  for (const name of ["Story", "Task"]) {
    typeRows.set(
      name,
      mustOk(defineCardType(db, { projectId, name, actorUserId: adminId }), name).id,
    );
  }
  const cardTypeId = (name: string) =>
    name === "Card"
      ? sqlite
          .prepare("select id from card_types where project_id = ? and name = 'Card'")
          .pluck()
          .get(projectId) as number
      : typeRows.get(name)!;

  const define = (input: { name: string; kind: string; values?: string[]; formula?: string }) =>
    mustOk(
      definePropertyDefinition(db, { projectId, actorUserId: adminId, ...input }),
      input.name,
    ).id;
  ids.status = define({ name: "Status", kind: "enumerated", values: ["open", "in development", "closed"] });
  ids.priority = define({ name: "Priority", kind: "enumerated", values: ["low", "medium", "high"] });
  ids.estimate = define({ name: "Estimate", kind: "number" });
  ids.due = define({ name: "Due date", kind: "date" });
  ids.owner = define({ name: "Owner", kind: "user" });
  ids.notes = define({ name: "Notes", kind: "text" });
  ids.effort = define({ name: "Effort", kind: "formula", formula: "Estimate * 2" });
  mustOk(
    defineProjectVariable(db, {
      projectId,
      name: "Current Status",
      dataType: "StringType",
      value: "open",
      actorUserId: adminId,
    }),
    "plv",
  );
  mustOk(
    defineProjectVariable(db, {
      projectId,
      name: "Unset Target",
      dataType: "NumericType",
      value: null,
      actorUserId: adminId,
    }),
    "plv unset",
  );

  const seed: [string, string, Record<string, string | null>][] = [
    ["Story", "Login page", { status: "open", priority: "low", estimate: "2", due: "2026-01-10", owner: String(devId), notes: "alpha" }],
    ["Story", "Search", { status: "in development", priority: "high", estimate: "5", due: "2026-03-01", owner: String(qaId), notes: "Beta" }],
    ["Story", "Checkout", { status: "closed", priority: "medium", estimate: "8", due: TODAY, owner: String(devId) }],
    ["Task", "Write tests", { status: "open", estimate: "3", notes: "alpha" }],
    ["Task", "Deploy", { priority: "low", due: "2026-03-01", owner: String(devId), notes: "gamma" }],
    ["Card", "Spike", { status: "closed", priority: "high", estimate: "13", due: "2026-01-10" }],
  ];
  for (const [type, name, values] of seed) {
    const number = mustOk(
      createCard(db, { projectId, name, cardTypeId: cardTypeId(type), actorUserId: devId }),
      name,
    ).number;
    for (const [key, value] of Object.entries(values)) {
      if (value === null) continue;
      mustOk(
        setCardPropertyValue(db, {
          projectId,
          cardNumber: number,
          propertyDefinitionId: ids[key],
          value,
          actorUserId: devId,
        }),
        `${name}.${key}`,
      );
    }
  }
  context = { currentUserId: devId, today: TODAY };
});

/** Card numbers matched by an MQL filter, ascending. */
function numbers(mql: string, ctx: MqlEvaluationContext = context): number[] {
  const view = buildCardListView(db, projectId, [], [], mql);
  if (view.errors.length > 0) throw new Error(`${mql} → ${view.errors.join(" | ")}`);
  return queryCardList(db, projectId, view.filters, { condition: view.mqlCondition, context: ctx })
    .map((r) => r.number)
    .sort((a, b) => a - b);
}

function filterErrors(mql: string): string[] {
  return buildCardListView(db, projectId, [], [], mql).errors;
}

describe("MQL filter — REAL-PATH evaluation against seeded cards", () => {
  it("sanity: the seed persisted six cards", () => {
    expect(db.select().from(cards).where(eq(cards.projectId, projectId)).all()).toHaveLength(6);
  });

  it("enumerated equality (case-insensitive) and inequality (unset cards match !=)", () => {
    expect(numbers("Status = OPEN")).toEqual([1, 4]);
    expect(numbers("Status IS NOT open")).toEqual([2, 3, 5, 6]);
    expect(numbers("NOT Status = open")).toEqual([2, 3, 5, 6]);
  });

  it("NULL tests are no-row / any-row", () => {
    expect(numbers("Status IS NULL")).toEqual([5]);
    expect(numbers("Status IS NOT NULL")).toEqual([1, 2, 3, 4, 6]);
    expect(numbers("Owner = NULL")).toEqual([4, 6]);
  });

  it("enumerated ordinals compare by defined position, not alphabetically", () => {
    // low(1) < medium(2) < high(3): "> low" is medium+high even though
    // "high" < "low" alphabetically.
    expect(numbers("Priority > low")).toEqual([2, 3, 6]);
    expect(numbers("Priority <= medium")).toEqual([1, 3, 5]);
    expect(numbers("Status < closed")).toEqual([1, 2, 4]);
  });

  it("numbers compare numerically (13 > 5) and formulas by their computed value", () => {
    expect(numbers("Estimate > 5")).toEqual([3, 6]);
    expect(numbers("Estimate >= 5")).toEqual([2, 3, 6]);
    expect(numbers("Estimate < 10")).toEqual([1, 2, 3, 4]);
    expect(numbers("Estimate = 13.0")).toEqual([6]);
    expect(numbers("Effort > 10")).toEqual([3, 6]);
    expect(numbers("Effort = 4")).toEqual([1]);
  });

  it("dates compare chronologically; TODAY binds from the context", () => {
    expect(numbers("'Due date' < 2026-02-01")).toEqual([1, 6]);
    expect(numbers("'Due date' = 2026-03-01")).toEqual([2, 5]);
    expect(numbers("'Due date' IS TODAY")).toEqual([3]);
    expect(numbers("'Due date' IS NOT TODAY")).toEqual([1, 2, 4, 5, 6]);
    expect(numbers("'Due date' IS TODAY", { ...context, today: "1999-01-01" })).toEqual([]);
  });

  it("user properties match by login and by CURRENT USER from the context", () => {
    expect(numbers("Owner = dev")).toEqual([1, 3, 5]);
    expect(numbers("Owner = CURRENT USER")).toEqual([1, 3, 5]);
    expect(numbers("Owner = CURRENT USER", { ...context, currentUserId: qaId })).toEqual([2]);
    expect(numbers("Owner != CURRENT USER", { ...context, currentUserId: qaId })).toEqual([1, 3, 4, 5, 6]);
    expect(numbers("Owner = CURRENT USER", { ...context, currentUserId: null })).toEqual([]);
  });

  it("free text equality is case-insensitive; Name and Number are card columns", () => {
    expect(numbers("Notes = ALPHA")).toEqual([1, 4]);
    expect(numbers("Notes != alpha")).toEqual([2, 3, 5, 6]);
    expect(numbers("Name = 'search'")).toEqual([2]);
    expect(numbers("Number > 4")).toEqual([5, 6]);
    expect(numbers("Number <= 2")).toEqual([1, 2]);
  });

  it("Type resolves through card_types; Created On is a real date", () => {
    expect(numbers("Type = story")).toEqual([1, 2, 3]);
    expect(numbers("Type != Story")).toEqual([4, 5, 6]);
    expect(numbers("Type IN (Task, Card)")).toEqual([4, 5, 6]);
    expect(numbers("'Created On' = TODAY")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(numbers("created_on < TODAY")).toEqual([]);
  });

  it("boolean structure: AND binds tighter than OR, NOT and parentheses", () => {
    expect(numbers("type = story and status = open")).toEqual([1]);
    expect(numbers("status = open or status = closed and priority = high")).toEqual([1, 4, 6]);
    expect(numbers("(status = open or status = closed) and priority = high")).toEqual([6]);
    expect(numbers("type = story and not (priority = low or priority = medium)")).toEqual([2]);
    expect(numbers("WHERE Status = open AND Owner = dev")).toEqual([1]);
  });

  it("IN lists, project variables (set and unset), and PROPERTY comparisons", () => {
    expect(numbers("Status IN (open, 'in development')")).toEqual([1, 2, 4]);
    expect(numbers("Status = (Current Status)")).toEqual([1, 4]);
    expect(numbers("Estimate = (Unset Target)")).toEqual([5]); // unset PLV ⇒ IS NULL
    expect(numbers("Estimate != (Unset Target)")).toEqual([1, 2, 3, 4, 6]);
    expect(numbers("Effort > PROPERTY Estimate")).toEqual([1, 2, 3, 4, 6]);
    expect(numbers("Estimate > Number")).toEqual([1, 2, 3, 6]); // bare Number = the Number column
  });

  it("nested IN (SELECT …) correlates against the project's cards", () => {
    // Estimates of dev-owned cards: 2, 8 → cards whose Number is 2 or 8 → #2.
    expect(numbers("Number IN (SELECT Estimate WHERE Owner = dev)")).toEqual([2]);
    // Notes shared with a Task: alpha, gamma → #1 (alpha), #4, #5.
    expect(numbers("Notes IN (SELECT Notes WHERE Type = Task)")).toEqual([1, 4, 5]);
    expect(numbers("Type = Story AND Notes IN (SELECT Notes WHERE Type = Task)")).toEqual([1]);
  });

  it("queryCardsByMql honors ORDER BY numerically, by position, and desc", () => {
    const q = (mql: string) => {
      const parsed = parseProjectMql(db, projectId, mql);
      if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
      return queryCardsByMql(db, projectId, parsed.query, context).map((r) => r.number);
    };
    expect(q("SELECT name WHERE Estimate IS NOT NULL ORDER BY Estimate")).toEqual([1, 4, 2, 3, 6]);
    expect(q("SELECT name WHERE Estimate IS NOT NULL ORDER BY Estimate DESC")).toEqual([6, 3, 2, 4, 1]);
    expect(q("SELECT name WHERE Priority IS NOT NULL ORDER BY Priority, Number")).toEqual([1, 5, 3, 2, 6]);
    expect(q("SELECT name")).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("agrees with the simple filters on the same question", () => {
    const simple = buildCardListView(db, projectId, [encodeFilterString("Priority", "is greater than", "low")], []);
    expect(queryCardList(db, projectId, simple.filters).map((r) => r.number).sort()).toEqual(
      numbers("Priority > low").sort(),
    );
  });
});

describe("buildCardListView — MQL mode", () => {
  it("MQL replaces the simple filters and records the text", () => {
    const view = buildCardListView(
      db,
      projectId,
      [encodeFilterString("Status", "is", "closed")],
      ["Status"],
      "type = story",
    );
    expect(view.errors).toEqual([]);
    expect(view.filters).toEqual([]);
    expect(view.mql).toBe("type = story");
    expect(view.mqlCondition).toMatchObject({ type: "comparison" });
    expect(view.columns.map((c) => c.name)).toEqual(["Status"]);
  });

  it("passes parse and resolution errors through verbatim", () => {
    expect(filterErrors("Status = bogus")).toEqual([
      "Status is a managed text property, and value bogus is not one of its values.",
    ]);
    expect(filterErrors("Status =")).toEqual(["parse error: unexpected end of query"]);
    expect(filterErrors("tagged with bug")).toEqual([
      "TAGGED WITH is not supported yet: this Mingle has no card tags.",
    ]);
  });

  it("accepts conditions only", () => {
    const only = "MQL filters accept conditions only — remove SELECT, GROUP BY, ORDER BY, and AS OF.";
    expect(filterErrors("SELECT name WHERE type = story")).toEqual([only]);
    expect(filterErrors("type = story ORDER BY name")).toEqual([
      'parse error on value "ORDER BY" (ORDER_BY)',
    ]);
    expect(filterErrors("WHERE type = story ORDER BY name")).toEqual([only]);
  });

  it("refuses THIS CARD, which has no context in a filter", () => {
    expect(filterErrors("Estimate > THIS CARD.Estimate")).toEqual([
      "THIS CARD is not supported in MQL filters.",
    ]);
  });

  it("the grid view filters its lanes by MQL too", () => {
    const grid = buildGridView(db, projectId, "Status", [], "Type = Story", context);
    expect(grid.errors).toEqual([]);
    const byLane = Object.fromEntries(
      grid.lanes.map((l) => [l.title, l.cards.map((c) => c.number)]),
    );
    expect(byLane).toEqual({ "(not set)": [], open: [1], "in development": [2], closed: [3] });
    expect(buildGridView(db, projectId, "Status", [], "Nope = 1", context).errors).toEqual([
      "Card property 'Nope' does not exist!",
    ]);
  });
});

describe("saveFavorite — MQL views", () => {
  it("persists the MQL text with empty simple filters and reopens via filters[mql]", () => {
    const row = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Open stories",
        style: "list",
        filters: [encodeFilterString("Status", "is", "closed")], // ignored: MQL wins
        columns: ["Status"],
        groupBy: "",
        mql: "type = story AND status = open",
        personal: false,
        actorUserId: devId,
      }),
      "save mql favorite",
    );
    const stored = db.select().from(favorites).where(eq(favorites.id, row.id)).get()!;
    expect(stored.mql).toBe("type = story AND status = open");
    expect(stored.filters).toBe("[]");
    expect(stored.columns).toBe(JSON.stringify(["Status"]));
    const href = favoriteHref("card_wall", stored);
    const search = new URL(`http://x${href}`).searchParams;
    expect(search.get("filters[mql]")).toBe("type = story AND status = open");
    expect(search.getAll("filters[]")).toEqual([]);
    expect(search.get("columns")).toBe("Status");
    // And the reopened view returns the same subset the seed predicts.
    expect(numbers(search.get("filters[mql]")!)).toEqual([1]);
  });

  it("stores null mql for a simply-filtered favorite", () => {
    const row = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Closed",
        style: "list",
        filters: [encodeFilterString("Status", "is", "closed")],
        columns: [],
        groupBy: "",
        personal: false,
        actorUserId: devId,
      }),
      "save simple favorite",
    );
    const stored = db.select().from(favorites).where(eq(favorites.id, row.id)).get()!;
    expect(stored.mql).toBeNull();
    expect(favoriteHref("card_wall", stored)).not.toContain("filters%5Bmql%5D");
  });

  it("rejects an invalid MQL view with the resolver's message, persisting nothing", () => {
    const before = db.select().from(favorites).all().length;
    const result = saveFavorite(db, {
      projectId,
      name: "Broken",
      style: "grid",
      filters: [],
      columns: [],
      groupBy: "Status",
      mql: "Nope = 1",
      personal: false,
      actorUserId: devId,
    });
    expect(result).toEqual({ ok: false, errors: { view: ["Card property 'Nope' does not exist!"] } });
    expect(db.select().from(favorites).all().length).toBe(before);
  });
});

/**
 * The evaluator's own refusals and its predefined-column arms. The
 * 2026-08-27 mutation audit found these arms unreached: several are
 * deliberate throws for MQL the parser accepts into an AST but no
 * backing model can answer yet (tags, plans, card relationships,
 * THIS CARD). They matter precisely because a later phase will teach
 * the parser to accept them — at which point this evaluator must fail
 * loudly rather than quietly translate them into wrong SQL.
 *
 * The conditions below are built directly, because `parseMql` rejects
 * these constructs by name and so can never hand one to the evaluator
 * today. The column references inside them are taken from real parses,
 * not hand-written, so they stay honest about what a resolved ref is.
 */
describe("mqlCondition — predefined columns and unsupported constructs", () => {
  /** The resolved column of a real parse, for reuse in built conditions. */
  function columnOf(mql: string) {
    const parsed = parseProjectMql(db, projectId, mql);
    if (!parsed.ok) throw new Error(`${mql} → ${parsed.errors.join(" | ")}`);
    const w = parsed.query.where;
    if (!w || w.type !== "comparison") throw new Error(`${mql} is not a comparison`);
    return w.column;
  }

  const evaluate = (cond: MqlCondition) => mqlCondition(db, projectId, cond, context);
  const comparisonWith = (value: MqlValue): MqlCondition => ({
    type: "comparison",
    column: columnOf("Status = open"),
    operator: "=",
    value,
  });

  it("reads Modified On from the modified date, not the created date", () => {
    // Every seeded card is created and modified today, which makes the two
    // columns indistinguishable. Back-date one card's creation so they differ.
    const card = db
      .select()
      .from(cards)
      .where(and(eq(cards.projectId, projectId), eq(cards.number, 3)))
      .get()!;
    const createdOn = new Date(Date.UTC(2020, 0, 15));
    db.update(cards).set({ createdAt: createdOn }).where(eq(cards.id, card.id)).run();
    try {
      expect(numbers("'Created On' = '2020-01-15'")).toEqual([3]);
      expect(numbers(`'Created On' = '${TODAY}'`)).toEqual([1, 2, 4, 5, 6]);
      expect(numbers(`'Modified On' = '${TODAY}'`)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(numbers("'Modified On' = '2020-01-15'")).toEqual([]);
      expect(numbers(`'Modified On' > '${TODAY}'`)).toEqual([]);
    } finally {
      db.update(cards).set({ createdAt: card.createdAt }).where(eq(cards.id, card.id)).run();
    }
    expect(numbers(`'Created On' = '${TODAY}'`)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses to compare against Project, which is a SELECT-only column", () => {
    const parsed = parseProjectMql(db, projectId, "SELECT project");
    if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
    const column = parsed.query.select!.columns[0];
    if (column.type === "aggregate") throw new Error("expected a plain column");
    expect(() =>
      evaluate({ type: "comparison", column, operator: "=", value: { type: "null" } }),
    ).toThrow("Project is not a comparable property");
  });

  it("refuses THIS CARD in either form, rather than translating it", () => {
    expect(() => evaluate(comparisonWith({ type: "thisCard" }))).toThrow(
      "THIS CARD is not supported in MQL filters.",
    );
    expect(() =>
      evaluate(comparisonWith({ type: "thisCardProperty", column: columnOf("Status = open") })),
    ).toThrow("THIS CARD is not supported in MQL filters.");
  });

  it("refuses a card-number value, which needs a card relationship property", () => {
    expect(() => evaluate(comparisonWith({ type: "cardNumber", number: "5" }))).toThrow(
      "card relationship properties are not available",
    );
  });

  it("refuses NUMBERS IN, TAGGED WITH, and IN PLAN by name", () => {
    expect(() =>
      evaluate({
        type: "in",
        column: columnOf("Status = open"),
        values: [{ type: "literal", text: "5", canonical: "5" }],
        byNumber: true,
      }),
    ).toThrow("NUMBERS IN needs card relationship properties");
    expect(() => evaluate({ type: "taggedWith", tag: "urgent" })).toThrow(
      "TAGGED WITH needs card tags",
    );
    expect(() => evaluate({ type: "inPlan", plan: "Q3" })).toThrow(
      "IN PLAN needs program plans",
    );
  });
});
