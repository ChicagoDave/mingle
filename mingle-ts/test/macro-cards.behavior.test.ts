/**
 * REAL-PATH behavioral tests for the card and chart macros (Phase 17).
 *
 * Every test here runs against a real, file-backed SQLite database
 * created with the real generated migrations, seeded through the real
 * domain commands — no stubbed database, no hand-built projection, no
 * fake MQL. The macros under test are the ones the registry installs,
 * reached through `renderPageContent` exactly as a route reaches them
 * (rule 13a: the system under test is the production path, not a
 * stand-in for it).
 *
 * The phase's exit criterion has its own test at the bottom: a stored
 * page containing a chart macro renders a chart reflecting seeded
 * cards, and changing one card's property and re-rendering changes the
 * chart — asserted against the SQLite file, end to end.
 *
 * Owner context: Wiki & Content / Query verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import { cardTypes } from "../app/db/schema/cards";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import { createPage, updatePage } from "../app/domain/pages/commands.server";
import { findPage, pageRenderContext } from "../app/domain/pages/read.server";
import { renderPageContent } from "../app/domain/pages/content.server";
import { pageMacroExpansion } from "../app/domain/pages/macros-registry.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-macros-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const IDENTIFIER = "macro_land";
let adminId: number;
let devId: number;
let qaId: number;
let projectId: number;
const propertyIds: Record<string, number> = {};
const cardNumbers: Record<string, number> = {};

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function register(login: string): number {
  return mustOk(
    registerUser(db, { login, name: login.toUpperCase(), password: "macro-pages-2010!" }),
    `register ${login}`,
  ).id;
}

/** Renders a body through the real macro path. */
function render(body: string): string {
  return renderPageContent(body, pageRenderContext(db, IDENTIFIER), pageMacroExpansion({
    projectIdentifier: IDENTIFIER,
    projectId,
    db,
    currentUserId: devId,
  }));
}

/** The text of a rendered table, row by row, tags removed. */
function rows(html: string): string[][] {
  return [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, "").trim(),
    ),
  );
}

beforeAll(() => {
  adminId = register("boss");
  devId = register("dev");
  qaId = register("qa");
  projectId = mustOk(
    createProject(db, { name: "Macro Land", identifier: IDENTIFIER, actorUserId: adminId }),
    "project",
  ).id;
  for (const [userId, role] of [
    [devId, "full_member"],
    [qaId, "full_member"],
  ] as const) {
    mustOk(addTeamMember(db, { projectId, userId, role, actorUserId: adminId }), "membership");
  }
  const defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;

  const define = (input: { name: string; kind: string; values?: string[] }) =>
    mustOk(
      definePropertyDefinition(db, { projectId, actorUserId: adminId, ...input }),
      input.name,
    ).id;
  propertyIds.status = define({
    name: "Status",
    kind: "enumerated",
    values: ["open", "in development", "closed"],
  });
  propertyIds.estimate = define({ name: "Estimate", kind: "number" });
  propertyIds.owner = define({ name: "Owner", kind: "user" });

  const seed: [string, Record<string, string>][] = [
    ["Login page", { status: "open", estimate: "2", owner: String(devId) }],
    ["Search", { status: "open", estimate: "5", owner: String(qaId) }],
    ["Checkout", { status: "closed", estimate: "8", owner: String(devId) }],
    ["Spike", { status: "in development", estimate: "3" }],
    ["Untriaged", {}],
  ];
  for (const [name, values] of seed) {
    const number = mustOk(
      createCard(db, { projectId, name, cardTypeId: defaultTypeId, actorUserId: devId }),
      name,
    ).number;
    cardNumbers[name] = number;
    for (const [key, value] of Object.entries(values)) {
      mustOk(
        setCardPropertyValue(db, {
          projectId,
          cardNumber: number,
          propertyDefinitionId: propertyIds[key],
          value,
          actorUserId: devId,
        }),
        `${name}.${key}`,
      );
    }
  }
});

describe("table macro", () => {
  it("renders a header per selected column and a row per matching card", () => {
    const out = render("{{ table query: SELECT number, name WHERE status = open }}");
    const table = rows(out);
    expect(table[0]).toEqual(["Number", "Name"]);
    expect(table.slice(1).map((row) => row[1]).sort()).toEqual(["Login page", "Search"]);
  });

  it("links the Number column to the card", () => {
    const out = render("{{ table query: SELECT number, name WHERE name = Checkout }}");
    expect(out).toContain(
      `href="/projects/${IDENTIFIER}/cards/${cardNumbers.Checkout}"`,
    );
  });

  it("resolves a user property to the user's name, not the stored id", () => {
    const out = render("{{ table query: SELECT name, owner WHERE name = Search }}");
    const table = rows(out);
    expect(table[1]).toEqual(["Search", "QA"]);
    expect(out).not.toContain(`>${qaId}<`);
  });

  it("shows an unset property as an empty cell", () => {
    const out = render("{{ table query: SELECT name, status WHERE name = Untriaged }}");
    expect(rows(out)[1]).toEqual(["Untriaged", ""]);
  });

  it("says so when nothing matches, rather than rendering an empty table", () => {
    const out = render("{{ table query: SELECT number, name WHERE status = closed AND estimate = 99 }}");
    expect(out).toContain("No cards match this query.");
  });

  it("orders by the query's ORDER BY", () => {
    const out = render(
      "{{ table query: SELECT name, estimate WHERE status = open ORDER BY estimate DESC }}",
    );
    expect(rows(out).slice(1).map((row) => row[0])).toEqual(["Search", "Login page"]);
  });

  it("refuses a query that does not parse, naming the reason", () => {
    const out = render("{{ table query: SELECT nosuchproperty }}");
    expect(out).toContain("error macro");
    expect(out).toContain("nosuchproperty");
  });

  it("refuses a query with no SELECT columns", () => {
    const out = render("{{ table query: status = open }}");
    expect(out).toContain("This query needs SELECT columns");
  });

  it("refuses when the query parameter is missing", () => {
    const out = render("{{ table }}");
    expect(out).toContain("Need to specify query.");
  });

  it("refuses AS OF rather than silently answering about today", () => {
    const out = render("{{ table query: SELECT number AS OF '2026-01-01' }}");
    expect(out).toContain("AS OF is not supported yet.");
  });

  it("refuses a cross-project macro instead of ignoring the parameter", () => {
    const out = render("{{ table query: SELECT number\n  project: elsewhere }}");
    expect(out).toContain("Cross-project macros are not supported yet");
  });
});

describe("value macro", () => {
  it("renders a count as one inline value", () => {
    const out = render("{{ value query: SELECT COUNT(*) WHERE status = open }}");
    expect(out).toContain('<span class="macro value">2</span>');
  });

  it("renders a sum over a number property", () => {
    const out = render("{{ value query: SELECT SUM(estimate) WHERE status = open }}");
    expect(out).toContain('<span class="macro value">7</span>');
  });

  it("refuses a query selecting more than one column", () => {
    const out = render("{{ value query: SELECT number, name WHERE name = Search }}");
    expect(out).toContain("exactly one column");
  });

  it("refuses a query returning more than one row", () => {
    const out = render("{{ value query: SELECT name WHERE status = open }}");
    expect(out).toContain("one row");
  });
});

describe("pie-chart macro", () => {
  it("draws one slice per group, labelled with its count", () => {
    const out = render(
      "{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status }}",
    );
    expect(out).toContain("<svg");
    expect(out).toContain("open — 2");
    expect(out).toContain("closed — 1");
    expect(out).toContain("in development — 1");
  });

  it("labels the unset group rather than showing a blank slice", () => {
    const out = render("{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status }}");
    expect(out).toContain("(not set) — 1");
  });

  it("draws a full circle, not a degenerate arc, for a single group", () => {
    const out = render(
      "{{ pie-chart data: SELECT status, COUNT(*) WHERE status = closed GROUP BY status }}",
    );
    expect(out).toContain("<circle");
    expect(out).not.toContain("<path");
  });

  it("draws arcs when there is more than one group", () => {
    const out = render("{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status }}");
    expect(out).toContain("<path");
  });

  it("carries a text description, so the chart is not only visual", () => {
    const out = render("{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status }}");
    expect(out).toContain("<desc>");
    expect(out).toContain('role="img"');
    expect(out).toContain("aria-label");
  });

  it("renders the chart title when given", () => {
    const out = render(
      "{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status\n  chart-title: Work by status }}",
    );
    expect(out).toContain("Work by status");
  });

  it("refuses a query that does not project exactly a label and a number", () => {
    const out = render("{{ pie-chart data: SELECT number, name, status }}");
    expect(out).toContain("needs a query selecting a label and a number");
  });

  it("refuses when the data parameter is missing", () => {
    const out = render("{{ pie-chart }}");
    expect(out).toContain("Need to specify data.");
  });

  it("says so when the query yields no slices", () => {
    const out = render(
      "{{ pie-chart data: SELECT status, COUNT(*) WHERE estimate = 999 GROUP BY status }}",
    );
    expect(out).toContain("No data matches this query.");
  });

  it("rejects a non-numeric radius", () => {
    const out = render(
      "{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status\n  radius: wide }}",
    );
    expect(out).toContain("radius must be a positive number");
  });
});

describe("phase exit criterion: a stored page's chart follows the real cards", () => {
  it("renders from the stored body and changes when a card's property changes", () => {
    const body =
      "<p>Status breakdown</p><p>{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status }}</p>";
    mustOk(
      createPage(db, { projectId, name: "Dashboard", content: body, actorUserId: devId }),
      "create page",
    );

    // Read the body back out of SQLite, not from the variable above.
    const stored = findPage(db, projectId, "Dashboard");
    expect(stored).not.toBeNull();
    const before = render(stored!.content ?? "");
    expect(before).toContain("open — 2");
    expect(before).toContain("closed — 1");

    // Move one open card to closed through the real command.
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: cardNumbers.Search,
        propertyDefinitionId: propertyIds.status,
        value: "closed",
        actorUserId: devId,
      }),
      "move Search to closed",
    );

    const after = render(findPage(db, projectId, "Dashboard")!.content ?? "");
    expect(after).toContain("open — 1");
    expect(after).toContain("closed — 2");
    expect(after).not.toBe(before);
  });

  it("keeps the authored text around the macro intact", () => {
    const out = render(findPage(db, projectId, "Dashboard")!.content ?? "");
    expect(out).toContain("Status breakdown");
  });

  it("re-renders an edited body with the macro the edit introduced", () => {
    mustOk(
      updatePage(db, {
        projectId,
        identifier: "dashboard",
        content: "<p>{{ value query: SELECT COUNT(*) WHERE status = closed }}</p>",
        actorUserId: devId,
      }),
      "edit page",
    );
    const out = render(findPage(db, projectId, "Dashboard")!.content ?? "");
    expect(out).toContain('<span class="macro value">2</span>');
  });
});
