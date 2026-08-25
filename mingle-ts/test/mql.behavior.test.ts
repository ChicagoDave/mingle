/**
 * Behavioral tests for the MQL parser (Phase 12).
 *
 * Derived line-by-line from the rule 12 Behavior Statement for
 * `parseMql`. The corpus is harvested from `mingle/help/topics/
 * mql_reference.xml` and legacy `test/unit/card_query/*_test.rb`
 * (parsing, lexer, and validation tests); each entry asserts on the
 * resulting AST shape or the specific error message — never merely
 * "did not throw" or "returned something".
 *
 * Resolution runs against a project's real definitions: properties,
 * enumeration values, card types, team members, and project variables
 * are created through the domain commands into a real, file-backed
 * SQLite database with the real migrations, and loaded back through
 * `loadMqlSchema` — the exit criterion's "validated against a project's
 * actual property definitions" path, with no stub schema.
 *
 * Owner context: Query verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import {
  createProject,
  defineProjectVariable,
} from "../app/domain/projects/commands.server";
import { defineCardType } from "../app/domain/cards/commands.server";
import { definePropertyDefinition } from "../app/domain/cards/properties.server";
import {
  type MqlCondition,
  type MqlQuery,
  type MqlSchema,
  parseMql,
} from "../app/domain/cards/mql.server";
import {
  loadMqlSchema,
  parseProjectMql,
} from "../app/domain/cards/mql-schema.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-mql-"));
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
let devId: number;
let schema: MqlSchema;
const ids: Record<string, number> = {};

beforeAll(() => {
  const adminId = mustOk(
    registerUser(db, { login: "boss", name: "Boss", password: "card-wall-2010!" }),
    "register boss",
  ).id;
  devId = mustOk(
    registerUser(db, { login: "dev", name: "Dev", password: "card-wall-2010!" }),
    "register dev",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "create project",
  ).id;
  mustOk(
    addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }),
    "add dev",
  );
  for (const name of ["Story", "Task"]) {
    mustOk(defineCardType(db, { projectId, name, actorUserId: adminId }), `type ${name}`);
  }
  const define = (input: { name: string; kind: string; values?: string[]; formula?: string }) =>
    mustOk(
      definePropertyDefinition(db, { projectId, actorUserId: adminId, ...input }),
      `define ${input.name}`,
    ).id;
  ids.status = define({ name: "Status", kind: "enumerated", values: ["open", "in development", "closed"] });
  ids.priority = define({ name: "Priority", kind: "enumerated", values: ["low", "medium", "high"] });
  ids.iteration = define({ name: "Iteration", kind: "number" });
  ids.estimate = define({ name: "Estimate", kind: "number" });
  ids.due = define({ name: "Due date", kind: "date" });
  ids.completed = define({ name: "Date completed", kind: "date" });
  ids.owner = define({ name: "Owner", kind: "user" });
  ids.notes = define({ name: "Notes", kind: "text" });
  ids.effort = define({ name: "Effort", kind: "formula", formula: "Estimate * 2" });
  mustOk(
    defineProjectVariable(db, {
      projectId,
      name: "Target",
      dataType: "NumericType",
      value: "5",
      actorUserId: adminId,
    }),
    "plv Target",
  );
  mustOk(
    defineProjectVariable(db, {
      projectId,
      name: "Current Iteration",
      dataType: "StringType",
      value: "open",
      actorUserId: adminId,
    }),
    "plv Current Iteration",
  );
  schema = loadMqlSchema(db, projectId);
});

function ok(text: string): MqlQuery {
  const result = parseMql(text, schema);
  if (!result.ok) throw new Error(`${text} → ${result.errors.join(" | ")}`);
  return result.query;
}

function errors(text: string): string[] {
  const result = parseMql(text, schema);
  if (result.ok) throw new Error(`${text} unexpectedly parsed`);
  return result.errors;
}

function where(text: string): MqlCondition {
  const q = ok(text);
  if (!q.where) throw new Error(`${text} has no WHERE`);
  return q.where;
}

const defined = (name: string, kind: string) =>
  expect.objectContaining({ source: "defined", id: ids[name], kind });
const predefined = (key: string) => expect.objectContaining({ source: "predefined", key });

describe("loadMqlSchema — real project definitions", () => {
  it("loads properties with enumeration values, card types, team logins, and variables", () => {
    expect(schema.properties.find((p) => p.id === ids.status)).toEqual({
      id: ids.status,
      name: "Status",
      kind: "enumerated",
      values: ["open", "in development", "closed"],
    });
    expect(schema.properties.find((p) => p.id === ids.effort)?.values).toBeUndefined();
    expect(schema.cardTypes).toEqual(["Card", "Story", "Task"]);
    expect(schema.users).toEqual([{ id: devId, login: "dev" }]);
    expect(schema.projectVariables).toContainEqual({
      name: "Target",
      dataType: "NumericType",
      value: "5",
    });
  });

  it("returns an empty schema for an unknown project, so every property is unknown", () => {
    const empty = loadMqlSchema(db, 999_999);
    expect(empty.properties).toEqual([]);
    expect(parseMql("Status = open", empty)).toEqual({
      ok: false,
      errors: ["Card property 'Status' does not exist!"],
    });
  });
});

describe("parseMql — SELECT and clause structure (help corpus)", () => {
  it("parses the empty string as an empty query, not an error", () => {
    expect(ok("")).toEqual({
      select: null,
      asOf: null,
      from: null,
      where: null,
      groupBy: null,
      orderBy: null,
    });
    expect(ok("   ")).toEqual(ok(""));
  });

  it("SELECT 'iteration', count(*) WHERE 'status' = 'open'", () => {
    const q = ok("SELECT 'iteration', count(*) WHERE 'status' = 'open'");
    expect(q.select).toEqual({
      distinct: false,
      columns: [
        { type: "column", property: defined("iteration", "number") },
        { type: "aggregate", fn: "count", column: null },
      ],
    });
    expect(q.where).toEqual({
      type: "comparison",
      column: { type: "column", property: defined("status", "enumerated") },
      operator: "=",
      value: { type: "literal", text: "open", canonical: "open" },
    });
  });

  it("SELECT DISTINCT and case-insensitive keywords", () => {
    const q = ok("select DISTINCT status, Type");
    expect(q.select?.distinct).toBe(true);
    expect(q.select?.columns).toEqual([
      { type: "column", property: defined("status", "enumerated") },
      { type: "column", property: predefined("type") },
    ]);
  });

  it("aggregates over properties: SUM(Estimate), avg(Effort), MIN/MAX", () => {
    const q = ok("SELECT SUM(Estimate), avg(Effort), min(Iteration), MAX('Due date')");
    expect(q.select?.columns.map((c) => (c.type === "aggregate" ? c.fn : null))).toEqual([
      "sum",
      "avg",
      "min",
      "max",
    ]);
    expect(q.select?.columns[1]).toEqual({
      type: "aggregate",
      fn: "avg",
      column: { type: "column", property: defined("effort", "formula") },
    });
  });

  it("GROUP BY and ORDER BY with directions", () => {
    const q = ok("SELECT Status, COUNT(*) WHERE Type = Story GROUP BY Status ORDER BY Status DESC, Name");
    expect(q.groupBy).toEqual([{ type: "column", property: defined("status", "enumerated") }]);
    expect(q.orderBy).toEqual([
      { column: { type: "column", property: defined("status", "enumerated") }, direction: "desc" },
      { column: { type: "column", property: predefined("name") }, direction: null },
    ]);
  });

  it("the six predefined properties resolve without definitions, in either spelling", () => {
    const q = ok("SELECT number, name, type, 'Created On', modified_on, Project WHERE created_on > 2026-01-01");
    expect(q.select?.columns.map((c) => (c.type === "column" ? c.property : null))).toEqual([
      predefined("number"),
      predefined("name"),
      predefined("type"),
      predefined("created_on"),
      predefined("modified_on"),
      predefined("project"),
    ]);
    expect(q.where).toEqual({
      type: "comparison",
      column: { type: "column", property: expect.objectContaining({ key: "created_on", kind: "date" }) },
      operator: ">",
      value: { type: "literal", text: "2026-01-01", canonical: "2026-01-01" },
    });
  });

  it("AS OF takes a date between SELECT and WHERE", () => {
    const q = ok("SELECT name AS OF '2026-01-15' WHERE type = story");
    expect(q.asOf).toBe("2026-01-15");
    expect(q.where?.type).toBe("comparison");
  });

  it("parseProjectMql loads the schema and parses in one call", () => {
    const result = parseProjectMql(db, projectId, "SELECT count(*) WHERE Status = closed");
    expect(result).toEqual({
      ok: true,
      query: expect.objectContaining({
        select: { distinct: false, columns: [{ type: "aggregate", fn: "count", column: null }] },
        where: {
          type: "comparison",
          column: { type: "column", property: defined("status", "enumerated") },
          operator: "=",
          value: { type: "literal", text: "closed", canonical: "closed" },
        },
      }),
    });
  });
});

describe("parseMql — conditions and boolean structure (legacy parsing tests)", () => {
  it("a bare condition without WHERE is a query with only a where clause", () => {
    const q = ok("Status = open");
    expect(q.select).toBeNull();
    expect(q.where?.type).toBe("comparison");
  });

  it("AND binds tighter than OR; NOT binds tightest: ((a AND b) AND NOT c)", () => {
    const c = where("type = story and iteration = 1 and not priority = low");
    expect(c).toMatchObject({
      type: "and",
      left: {
        type: "and",
        left: { type: "comparison", column: { property: predefined("type") } },
        right: { type: "comparison", column: { property: defined("iteration", "number") } },
      },
      right: { type: "not", operand: { type: "comparison", value: { canonical: "low" } } },
    });
  });

  it("parentheses group: ((a AND b) AND NOT (c OR d))", () => {
    const c = where("type = story and iteration = 1 and not (priority = low or priority = medium)");
    expect(c).toMatchObject({
      type: "and",
      left: { type: "and" },
      right: {
        type: "not",
        operand: {
          type: "or",
          left: { type: "comparison", value: { canonical: "low" } },
          right: { type: "comparison", value: { canonical: "medium" } },
        },
      },
    });
  });

  it("a OR b AND c parses as a OR (b AND c)", () => {
    const c = where("Status = open OR Status = closed AND Priority = high");
    expect(c.type).toBe("or");
    expect((c as Extract<MqlCondition, { type: "or" }>).right.type).toBe("and");
  });

  it("every null spelling: IS NULL, = NULL, IS NOT NULL, NOT = NULL, != NULL, NOT x = NULL", () => {
    const isNull = { type: "comparison", operator: "=", value: { type: "null" } };
    const notNull = { type: "comparison", operator: "!=", value: { type: "null" } };
    expect(where("Status IS NULL")).toMatchObject(isNull);
    expect(where("Status = NULL")).toMatchObject(isNull);
    expect(where("Status Is NOT NULL")).toMatchObject(notNull);
    expect(where("Status NOT = NULL")).toMatchObject(notNull);
    expect(where("Status != NULL")).toMatchObject(notNull);
    expect(where("NOT Status Is NULL")).toMatchObject({ type: "not", operand: isNull });
  });

  it("IS / IS NOT alias = / !=; all six operators lex", () => {
    expect(where("Status is open")).toMatchObject({ operator: "=" });
    expect(where("Status is not open")).toMatchObject({ operator: "!=" });
    expect(where("NOT Status=open")).toMatchObject({ type: "not", operand: { operator: "=" } });
    for (const op of ["<", ">", "<=", ">="] as const) {
      expect(where(`Iteration ${op} 2`)).toMatchObject({ operator: op });
    }
    expect(where("Iteration > 2.0")).toMatchObject({ value: { text: "2.0", canonical: "2.0" } });
  });

  it("quoting: single, double, mixed, and backslash-escaped quotes (legacy lexer tests)", () => {
    expect(where(`'Status' = 'CLOSED'`)).toMatchObject({ value: { canonical: "closed" } });
    expect(where(`"Status" = "in development"`)).toMatchObject({ value: { canonical: "in development" } });
    expect(where(`Notes = 'hello"world'`)).toMatchObject({ value: { text: `hello"world` } });
    expect(where(`Notes = "hello'world"`)).toMatchObject({ value: { text: "hello'world" } });
    expect(where(`Notes = 'hello\\' world'`)).toMatchObject({ value: { text: "hello' world" } });
    expect(where(`Notes = hello\\'world`)).toMatchObject({ value: { text: "hello'world" } });
  });

  it("IN with a value list canonicalizes each value", () => {
    expect(where("Status IN (Open, 'In Development')")).toEqual({
      type: "in",
      byNumber: false,
      column: { type: "column", property: defined("status", "enumerated") },
      values: [
        { type: "literal", text: "Open", canonical: "open" },
        { type: "literal", text: "In Development", canonical: "in development" },
      ],
    });
    expect(where("Iteration IN (1, 2, 3)")).toMatchObject({
      values: [{ text: "1" }, { text: "2" }, { text: "3" }],
    });
  });

  it("nested IN (SELECT ...) resolves the sub-query with its own clauses", () => {
    const c = where(
      "type = task and Iteration IN (SELECT Iteration WHERE type = story AND status = 'in development')",
    );
    expect(c).toMatchObject({
      type: "and",
      right: {
        type: "inQuery",
        column: { property: defined("iteration", "number") },
        query: {
          select: { distinct: false, columns: [{ type: "column", property: defined("iteration", "number") }] },
          where: { type: "and", right: { value: { canonical: "in development" } } },
        },
      },
    });
  });

  it("PROPERTY compares two properties of the same family", () => {
    expect(where("'Due date' < PROPERTY 'Date completed'")).toEqual({
      type: "comparison",
      column: { type: "column", property: defined("due", "date") },
      operator: "<",
      value: { type: "property", column: { type: "column", property: defined("completed", "date") } },
    });
    expect(where("Estimate > PROPERTY Iteration")).toMatchObject({ value: { type: "property" } });
    expect(where("Effort > PROPERTY Estimate")).toMatchObject({ value: { type: "property" } });
    // Legacy: a bare `Number` right-hand side is the Number column.
    expect(where("Iteration = Number")).toMatchObject({
      value: { type: "property", column: { property: predefined("number") } },
    });
  });

  it("THIS CARD.property compares against the context card's value", () => {
    expect(where("Estimate > THIS CARD.Estimate")).toEqual({
      type: "comparison",
      column: { type: "column", property: defined("estimate", "number") },
      operator: ">",
      value: { type: "thisCardProperty", column: { type: "column", property: defined("estimate", "number") } },
    });
  });

  it("project variables in parentheses resolve to their stored value", () => {
    expect(where("Estimate = (Target)")).toEqual({
      type: "comparison",
      column: { type: "column", property: defined("estimate", "number") },
      operator: "=",
      value: { type: "projectVariable", name: "Target", value: "5" },
    });
    expect(where("Status = (Current Iteration)")).toMatchObject({
      value: { type: "projectVariable", name: "Current Iteration", value: "open" },
    });
    expect(where("Status IN ((Current Iteration), closed)")).toMatchObject({
      values: [{ type: "projectVariable", value: "open" }, { canonical: "closed" }],
    });
  });
});

describe("parseMql — literal canonicalization by property kind", () => {
  it("enumerated values take the defined casing; card types take theirs", () => {
    expect(where("Priority < MEDIUM")).toMatchObject({ value: { text: "MEDIUM", canonical: "medium" } });
    expect(where("Type = story")).toMatchObject({ value: { text: "story", canonical: "Story" } });
  });

  it("user values are logins on the wire and user ids in the AST", () => {
    expect(where("Owner = DEV")).toMatchObject({ value: { text: "DEV", canonical: String(devId) } });
  });

  it("CURRENT USER and TODAY are symbolic nodes on user/date properties", () => {
    expect(where("Owner = CURRENT USER")).toMatchObject({ value: { type: "currentUser" } });
    expect(where("Owner IS NOT CURRENT USER")).toMatchObject({ operator: "!=", value: { type: "currentUser" } });
    expect(where("'Due date' IS TODAY")).toMatchObject({ value: { type: "today" } });
    expect(where("'Modified On' < TODAY")).toMatchObject({ operator: "<", value: { type: "today" } });
  });

  it("numbers, dates, formulas, and free text pass through", () => {
    expect(where("Estimate >= 2.5")).toMatchObject({ value: { canonical: "2.5" } });
    expect(where("'Due date' = 2026-02-01")).toMatchObject({ value: { canonical: "2026-02-01" } });
    expect(where("Effort > 10")).toMatchObject({ value: { canonical: "10" } });
    expect(where("Effort = 2026-02-01")).toMatchObject({ value: { canonical: "2026-02-01" } });
    expect(where("Notes = 'anything at all'")).toMatchObject({ value: { canonical: "anything at all" } });
  });
});

describe("parseMql — rejections: lexer and grammar", () => {
  it("unknown characters name the offending text", () => {
    expect(errors("Status = $x")).toEqual(["unexpected characters $x"]);
  });

  it("premature end and unexpected tokens are specific parse errors", () => {
    expect(errors("Status =")).toEqual(["parse error: unexpected end of query"]);
    expect(errors("SELECT")).toEqual(["parse error: unexpected end of query"]);
    expect(errors("Status = open ORDER name")).toEqual(['parse error on value "ORDER" (IDENTIFIER)']);
    expect(errors("SELECT name WHERE")).toEqual(["parse error: unexpected end of query"]);
    expect(errors("Status = open extra")).toEqual(['parse error on value "extra" (IDENTIFIER)']);
    expect(errors("WHERE Status = open SELECT name")).toEqual(['parse error on value "SELECT" (SELECT)']);
  });

  it("TAGGED WITH refuses keywords (legacy tagged_with_can_not_use_*)", () => {
    expect(errors("tagged with today")).toEqual(['parse error on value "today" (TODAY)']);
    expect(errors("tagged with current user")).toEqual(['parse error on value "current user" (CURRENT_USER)']);
    expect(errors("tagged with this card")).toEqual(['parse error on value "this card" (THIS_CARD)']);
  });

  it("NULL and CURRENT USER only accept = and !=", () => {
    expect(errors("Iteration < NULL")).toEqual(['parse error on value "NULL" (NULL)']);
    expect(errors("Owner > CURRENT USER")).toEqual(['parse error on value "CURRENT USER" (CURRENT_USER)']);
  });

  it("a nested IN must start with SELECT", () => {
    expect(errors("Iteration IN (WHERE type = story)")).toEqual(['parse error on value "WHERE" (WHERE)']);
  });
});

describe("parseMql — rejections: resolution against the project", () => {
  it("unknown properties use legacy wording, wherever they appear", () => {
    expect(errors("prop_not_exists = story")).toEqual(["Card property 'prop_not_exists' does not exist!"]);
    expect(errors("SELECT Nope")).toEqual(["Card property 'Nope' does not exist!"]);
    expect(errors("SELECT name GROUP BY Nope")).toEqual(["Card property 'Nope' does not exist!"]);
    expect(errors("SELECT name ORDER BY Nope ASC")).toEqual(["Card property 'Nope' does not exist!"]);
    expect(errors("Status = open AND Nope = 1 AND Iteration = 2")).toEqual([
      "Card property 'Nope' does not exist!",
    ]);
  });

  it("collects every semantic error, in source order, deduplicated", () => {
    expect(errors("Estimate = abc AND Nope = 1 AND Nope = 2")).toEqual([
      "Estimate is a number property, and value abc is not number.",
      "Card property 'Nope' does not exist!",
    ]);
  });

  it("literals must fit the property kind", () => {
    expect(errors("Estimate = abc")).toEqual(["Estimate is a number property, and value abc is not number."]);
    expect(errors("'Due date' = 2026-02-30")).toEqual([
      "Due date is a date property, and value 2026-02-30 is not date (use yyyy-mm-dd).",
    ]);
    expect(errors("'Due date' = tomorrow")).toEqual([
      "Due date is a date property, and value tomorrow is not date (use yyyy-mm-dd).",
    ]);
    expect(errors("Status = bogus")).toEqual([
      "Status is a managed text property, and value bogus is not one of its values.",
    ]);
    expect(errors("Type = Epic")).toEqual(["Card type Epic does not exist in this project."]);
    expect(errors("Owner = nobody")).toEqual([
      "Owner is a user property, and value nobody is not a team member's login.",
    ]);
    expect(errors("Effort = soon")).toEqual([
      "Effort is a formula property, and value soon is neither number nor date.",
    ]);
  });

  it("quoted TODAY / CURRENT USER get legacy's hint (MqlValidations)", () => {
    expect(errors("Owner = 'current user'")).toEqual([
      "Owner is a user property, and value current user is not user. To use CURRENT USER do not enclose in any quotes or parenthesis.",
    ]);
    expect(errors("'Due date' = 'today'")).toEqual([
      "Due date is a date property, and value today is not date. To use TODAY do not enclose in any quotes or parenthesis.",
    ]);
  });

  it("TODAY and CURRENT USER are confined to date and user properties", () => {
    expect(errors("Estimate = TODAY")).toEqual([
      "Estimate is a number property; TODAY can only be compared with date properties.",
    ]);
    expect(errors("Status = CURRENT USER")).toEqual([
      "Status is a enumerated property; CURRENT USER can only be compared with user properties.",
    ]);
  });

  it("ordinal operators are not supported for user properties or Type", () => {
    expect(errors("Owner > dev")).toEqual(["Operators > and < are not supported for user property Owner."]);
    expect(errors("Type < Story")).toEqual(["Operators > and < are not supported for the Type property."]);
  });

  it("property-to-property comparisons must be the same family", () => {
    expect(errors("'Due date' > PROPERTY Estimate")).toEqual([
      "Due date (date) and Estimate (number) are not the same type and cannot be compared.",
    ]);
    expect(errors("Owner = THIS CARD.Estimate")).toEqual([
      "Owner (user) and Estimate (number) are not the same type and cannot be compared.",
    ]);
  });

  it("aggregate functions must be recognized; * only with count", () => {
    expect(errors("SELECT foo(Estimate)")).toEqual(["foo is not a recognized aggregate function."]);
    expect(errors("SELECT sum(*)")).toEqual(["* can only be used with the count aggregate function."]);
  });

  it("Project may only appear in SELECT", () => {
    expect(errors("Project = card_wall")).toEqual([
      "Project can only be used in MQL SELECT statements, not in WHERE.",
    ]);
    expect(errors("SELECT name ORDER BY Project")).toEqual([
      "Project can only be used in MQL SELECT statements, not in ORDER BY.",
    ]);
  });

  it("a nested IN query selects exactly one plain property", () => {
    expect(errors("Iteration IN (SELECT Iteration, Estimate)")).toEqual([
      "A nested IN query must select exactly one property.",
    ]);
    expect(errors("Iteration IN (SELECT count(*))")).toEqual([
      "A nested IN query must select exactly one property.",
    ]);
  });

  it("project variables must exist and match the property's type", () => {
    expect(errors("Estimate = (Nope)")).toEqual(["The project variable (Nope) does not exist"]);
    expect(errors("Status = (Target)")).toEqual([
      "Project variable (Target) is a numeric variable and cannot be compared with Status (enumerated).",
    ]);
  });

  it("AS OF requires a real date", () => {
    expect(errors("SELECT name AS OF yesterday")).toEqual([
      "AS OF requires a date in yyyy-mm-dd format; 'yesterday' is not one.",
    ]);
  });

  it("card-number and THIS CARD comparisons need relationship properties (none exist yet)", () => {
    expect(errors("SELECT number, COUNT(*) WHERE type = NUMBER 9")).toEqual([
      "only card relationship properties or tree relationship properties can be used in 'Type = NUMBER ...' clause",
    ]);
    expect(errors("Iteration = NUMBER '9nine'")).toEqual([
      "9nine is not a valid value for Iteration. Only numbers can be used as values in a 'column = NUMBER ...' clause",
      "only card relationship properties or tree relationship properties can be used in 'Iteration = NUMBER ...' clause",
    ]);
    expect(errors("SELECT number, COUNT(*) WHERE type = THIS CARD")).toEqual([
      "only card relationship properties or tree relationship properties can be used in 'Type = THIS CARD' clause",
    ]);
    expect(errors("Iteration NUMBERS IN (71, 72)")).toEqual([
      "only card relationship properties or tree relationship properties can be used in 'Iteration NUMBERS IN (...)' clause",
    ]);
  });

  it("constructs without a backing model are rejected by name, not silently dropped", () => {
    expect(errors("tagged with 'bug'")).toEqual([
      "TAGGED WITH is not supported yet: this Mingle has no card tags.",
    ]);
    expect(errors("SELECT number, name WHERE TAGGED WITH 'bug' AND tagged with 'open'")).toEqual([
      "TAGGED WITH is not supported yet: this Mingle has no card tags.",
    ]);
    expect(errors("IN PLAN 'Release 1'")).toEqual([
      "IN PLAN is not supported: program plans are not available in this Mingle.",
    ]);
    expect(errors("SELECT name, number FROM TREE 'Planning' WHERE Type = Story")).toEqual([
      "Tree with name 'Planning' does not exist",
    ]);
    expect(errors("FROM TREE 'A', 'B'")).toEqual([
      "You cannot select more than one tree using the FROM TREE syntax.",
      "Tree with name 'A' does not exist",
      "Tree with name 'B' does not exist",
    ]);
  });
});
