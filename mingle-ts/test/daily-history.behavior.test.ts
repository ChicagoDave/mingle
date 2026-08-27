/**
 * REAL-PATH behavioral tests for the daily history chart macro
 * (Phase 18).
 *
 * The macro is reached through `renderPageContent` exactly as the wiki
 * route reaches it, over a real file-backed SQLite database created
 * with the real generated migrations and seeded through the real domain
 * commands. No stubbed history, no hand-built series, no fake MQL —
 * every plotted number comes back out of `card_versions` through the
 * production projection path (rule 13a).
 *
 * The phase's exit criterion is the first test: a seeded history with
 * known version timestamps and property changes produces a series
 * matching a hand-computed one across four distinct days.
 *
 * As in mql-as-of.behavior.test, the seed backdates the version rows a
 * command just wrote — there is no clock seam, and a multi-day history
 * cannot otherwise exist inside a test run.
 *
 * Owner context: Wiki & Content / Query verification.
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
import { createProject } from "../app/domain/projects/commands.server";
import {
  createCard,
  defineCardType,
  deleteCard,
} from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import { createPage } from "../app/domain/pages/commands.server";
import { findPage, pageRenderContext } from "../app/domain/pages/read.server";
import { renderPageContent } from "../app/domain/pages/content.server";
import { pageMacroExpansion } from "../app/domain/pages/macros-registry.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-history-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const IDENTIFIER = "burnup";
let adminId: number;
let devId: number;
let projectId: number;
let storyTypeId: number;
let bugTypeId: number;
const propertyIds: Record<string, number> = {};
const cardNumbers: Record<string, number> = {};

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/** Runs seed commands and backdates the versions they wrote to that day. */
function at(day: string, seed: () => void): void {
  const before = (
    sqlite.prepare("select coalesce(max(id), 0) as m from card_versions").get() as { m: number }
  ).m;
  seed();
  sqlite
    .prepare("update card_versions set created_at = ? where id > ?")
    .run(Date.parse(`${day}T12:00:00.000Z`), before);
}

function card(name: string, cardTypeId: number, values: Record<string, string>): void {
  const number = mustOk(
    createCard(db, { projectId, name, cardTypeId, actorUserId: devId }),
    name,
  ).number;
  cardNumbers[name] = number;
  for (const [key, value] of Object.entries(values)) set(name, key, value);
}

function set(name: string, key: string, value: string): void {
  mustOk(
    setCardPropertyValue(db, {
      projectId,
      cardNumber: cardNumbers[name],
      propertyDefinitionId: propertyIds[key],
      value,
      actorUserId: devId,
    }),
    `${name}.${key}`,
  );
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

/**
 * The chart's `<desc>` text — every plotted number, which is both what
 * a screen reader gets and what these tests assert on.
 */
function description(html: string): string {
  return /<desc>([\s\S]*?)<\/desc>/.exec(html)?.[1] ?? "";
}

/** How many series lines the chart drew. */
function polylines(html: string): number {
  return [...html.matchAll(/<polyline\b/g)].length;
}

/** A macro invocation with the given parameter lines. */
function chart(...lines: string[]): string {
  return `{{ daily-history-chart\n     ${lines.join("\n     ")}\n}}`;
}

beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "boss", name: "BOSS", password: "daily-history-2010!" }),
    "admin",
  ).id;
  devId = mustOk(
    registerUser(db, { login: "dev", name: "DEV", password: "daily-history-2010!" }),
    "dev",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "Burn Up", identifier: IDENTIFIER, actorUserId: adminId }),
    "project",
  ).id;
  mustOk(
    addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }),
    "membership",
  );
  storyTypeId = mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story").id;
  bugTypeId = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug").id;

  propertyIds.status = mustOk(
    definePropertyDefinition(db, {
      projectId,
      actorUserId: adminId,
      name: "Status",
      kind: "enumerated",
      values: ["open", "closed"],
    }),
    "Status",
  ).id;
  propertyIds.estimate = mustOk(
    definePropertyDefinition(db, { projectId, actorUserId: adminId, name: "Estimate", kind: "number" }),
    "Estimate",
  ).id;

  // Four days of history. Every expected series below is hand-computed
  // from this seed:
  //
  //            Login     Search    Reports   Crash(Bug)
  //   03-01    open/2    open/5    –         open/1
  //   03-02    closed    open      –         open
  //   03-03    closed    closed    open/8    open
  //   03-04    closed    closed    open      deleted
  at("2026-03-01", () => {
    card("Login", storyTypeId, { status: "open", estimate: "2" });
    card("Search", storyTypeId, { status: "open", estimate: "5" });
    card("Crash", bugTypeId, { status: "open", estimate: "1" });
  });
  at("2026-03-02", () => set("Login", "status", "closed"));
  at("2026-03-03", () => {
    set("Search", "status", "closed");
    card("Reports", storyTypeId, { status: "open", estimate: "8" });
  });
  at("2026-03-04", () => {
    mustOk(
      deleteCard(db, { projectId, cardNumber: cardNumbers.Crash, actorUserId: adminId }),
      "delete Crash",
    );
  });
});

describe("daily history chart — the reconstructed series", () => {
  it("plots a hand-computed series per day across four distinct days", () => {
    const out = render(
      chart(
        "start-date: 2026-03-01",
        "end-date: 2026-03-04",
        "chart-conditions: type = Story",
        "series:",
        "  - conditions: status = open",
        "    label: Open",
        "  - conditions: status = closed",
        "    label: Closed",
      ),
    );
    const desc = description(out);
    expect(desc).toContain("2026-03-01, 2026-03-02, 2026-03-03, 2026-03-04");
    // Open stories: Login+Search, Search, Reports, Reports.
    expect(desc).toContain("Open: 2, 1, 1, 1");
    // Closed stories: none, Login, Login+Search, Login+Search.
    expect(desc).toContain("Closed: 0, 1, 2, 2");
    expect(polylines(out)).toBe(2);
  });

  it("drops a deleted card from the days after its deletion only", () => {
    const out = render(
      chart(
        "start-date: 2026-03-02",
        "end-date: 2026-03-04",
        "series:",
        "  - conditions: type = Bug",
        "    label: Bugs",
      ),
    );
    expect(description(out)).toContain("Bugs: 1, 1, 0");
  });

  it("aggregates a numeric property instead of counting, when asked", () => {
    const out = render(
      chart(
        "start-date: 2026-03-01",
        "end-date: 2026-03-04",
        "aggregate: SUM(estimate)",
        "series:",
        "  - conditions: status = open",
        "    label: Remaining",
      ),
    );
    // Open estimates: 2+5+1, 5+1, 1+8, 8.
    expect(description(out)).toContain("Remaining: 8, 6, 9, 8");
  });

  it("counts every card when no conditions narrow the series", () => {
    const out = render(
      chart("start-date: 2026-03-01", "end-date: 2026-03-04", "series:", "  - label: All"),
    );
    expect(description(out)).toContain("All: 3, 3, 4, 3");
  });

  it("renders a single-day range as one plotted point, not as NaN", () => {
    const out = render(
      chart("start-date: 2026-03-03", "end-date: 2026-03-03", "series:", "  - conditions: status = open"),
    );
    expect(out).not.toContain("NaN");
    expect(description(out)).toContain(": 2");
    expect(polylines(out)).toBe(1);
  });
});

describe("daily history chart — what it draws", () => {
  const basic = () =>
    render(
      chart(
        "start-date: 2026-03-01",
        "end-date: 2026-03-04",
        "chart-title: Story flow",
        "y-title: Stories",
        "series:",
        "  - conditions: status = open",
        "    label: Open",
        "    color: '#ff0000'",
      ),
    );

  it("emits an svg that survived the macro allowlist", () => {
    const out = basic();
    expect(out).toContain('<div class="macro chart daily-history-chart">');
    expect(out).toContain("<svg");
    expect(out).toContain("<polyline");
  });

  it("uses the colour the series asked for", () => {
    expect(basic()).toContain('stroke="#ff0000"');
  });

  it("labels the axes and titles it was given", () => {
    const out = basic();
    expect(out).toContain("Story flow");
    expect(out).toContain("Stories");
    expect(out).toContain("2026-03-01");
  });

  it("falls back to the series conditions when no label is given", () => {
    const out = render(
      chart("start-date: 2026-03-03", "end-date: 2026-03-03", "series:", "  - conditions: status = closed"),
    );
    expect(description(out)).toContain("status = closed: 2");
  });

  it("renders from a stored page body, not just an inline string", () => {
    const body = `<p>Progress</p><p>${chart(
      "start-date: 2026-03-01",
      "end-date: 2026-03-04",
      "chart-conditions: type = Story",
      "series:",
      "  - conditions: status = closed",
      "    label: Closed",
    )}</p>`;
    mustOk(
      createPage(db, { projectId, name: "Flow", content: body, actorUserId: devId }),
      "create page",
    );
    const stored = findPage(db, projectId, "Flow");
    expect(stored).not.toBeNull();
    const out = render(stored!.content ?? "");
    expect(out).toContain("Progress");
    expect(description(out)).toContain("Closed: 0, 1, 2, 2");
  });
});

describe("daily history chart — refusals render in place", () => {
  const refusal = (out: string) => /<div class="error macro">([\s\S]*?)<\/div>/.exec(out)?.[1] ?? "";

  it("refuses a missing start-date", () => {
    expect(refusal(render(chart("end-date: 2026-03-04", "series:", "  - label: All")))).toContain(
      "Need to specify start-date.",
    );
  });

  it("refuses a date that is not yyyy-mm-dd", () => {
    const out = render(chart("start-date: 03/01/2026", "end-date: 2026-03-04", "series:", "  - label: All"));
    expect(refusal(out)).toContain("must be a date in yyyy-mm-dd format");
  });

  it("refuses a date the calendar does not have", () => {
    const out = render(chart("start-date: 2026-02-30", "end-date: 2026-03-04", "series:", "  - label: All"));
    expect(refusal(out)).toContain("must be a date in yyyy-mm-dd format");
  });

  it("refuses a start-date after the end-date", () => {
    const out = render(chart("start-date: 2026-03-04", "end-date: 2026-03-01", "series:", "  - label: All"));
    expect(refusal(out)).toContain("start-date must be on or before end-date.");
  });

  it("refuses a range wider than it will draw", () => {
    const out = render(chart("start-date: 2020-01-01", "end-date: 2026-03-04", "series:", "  - label: All"));
    expect(refusal(out)).toContain("this chart draws at most 366");
  });

  it("refuses a chart with no series", () => {
    const out = render(chart("start-date: 2026-03-01", "end-date: 2026-03-04"));
    expect(refusal(out)).toContain("Need to specify series.");
  });

  it("refuses MQL that does not resolve against the project", () => {
    const out = render(
      chart(
        "start-date: 2026-03-01",
        "end-date: 2026-03-04",
        "series:",
        "  - conditions: nonesuch = open",
      ),
    );
    expect(refusal(out)).toContain("nonesuch");
  });

  it("refuses an aggregate that is not an aggregate", () => {
    const out = render(
      chart("start-date: 2026-03-01", "end-date: 2026-03-04", "aggregate: name", "series:", "  - label: All"),
    );
    expect(refusal(out)).toContain("must be a single aggregate function");
  });

  it("refuses a colour that is not a colour, rather than drawing an invisible line", () => {
    const out = render(
      chart(
        "start-date: 2026-03-01",
        "end-date: 2026-03-04",
        "series:",
        "  - label: All",
        "    color: chartreuse",
      ),
    );
    expect(refusal(out)).toContain("is not a colour");
  });

  it("refuses a cross-project chart by name, as legacy does", () => {
    const out = render(
      chart("start-date: 2026-03-01", "end-date: 2026-03-04", "project: elsewhere", "series:", "  - label: All"),
    );
    expect(refusal(out)).toContain("Project parameter is not allowed for the daily history chart.");
  });
});
