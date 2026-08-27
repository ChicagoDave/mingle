/**
 * REAL-PATH behavioral tests for the stacked-bar and data-series chart
 * macros (Phase 19).
 *
 * Both macros are reached through `renderPageContent` exactly as the
 * wiki route reaches them, over a real file-backed SQLite database
 * created with the real generated migrations and seeded through the
 * real domain commands. No stubbed projections, no hand-built series,
 * no fake MQL — every plotted number comes back out of `cards` and
 * `card_property_values` through the production group-by projection
 * path (rule 13a).
 *
 * The phase's exit criterion is the first test in each describe block:
 * a seeded dataset produces segment/series values matching a
 * hand-computed aggregation, asserted on the numbers themselves rather
 * than on "an svg was produced".
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
import { createCard, defineCardType } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import { pageRenderContext } from "../app/domain/pages/read.server";
import { renderPageContent } from "../app/domain/pages/content.server";
import { pageMacroExpansion } from "../app/domain/pages/macros-registry.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-series-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const IDENTIFIER = "velocity";
let adminId: number;
let devId: number;
let projectId: number;
let storyTypeId: number;
let bugTypeId: number;
const propertyIds: Record<string, number> = {};

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function card(name: string, cardTypeId: number, values: Record<string, string>): void {
  const number = mustOk(
    createCard(db, { projectId, name, cardTypeId, actorUserId: devId }),
    name,
  ).number;
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

/** Renders a body through the real macro path. */
function render(body: string): string {
  return renderPageContent(body, pageRenderContext(db, IDENTIFIER), pageMacroExpansion({
    projectIdentifier: IDENTIFIER,
    projectId,
    db,
    currentUserId: devId,
  }));
}

/** The chart's `<desc>` text — every axis label and plotted number. */
function description(html: string): string {
  return /<desc>([\s\S]*?)<\/desc>/.exec(html)?.[1] ?? "";
}

/** The axis labels the chart plotted against, in drawn order. */
function axis(html: string): string[] {
  return description(html).split(" — ")[0].split(", ");
}

/** Every series as `label -> values`, read back out of the `<desc>`. */
function plotted(html: string): Record<string, number[]> {
  const [, summary] = description(html).split(" — ");
  const out: Record<string, number[]> = {};
  for (const part of (summary ?? "").split("; ")) {
    const at = part.indexOf(": ");
    if (at < 0) continue;
    out[part.slice(0, at)] = part
      .slice(at + 2)
      .split(", ")
      .map(Number);
  }
  return out;
}

/**
 * The bar rectangles, in drawn order. Legend swatches carry `rx` and
 * are excluded — the geometry tests are about bars, and a legend that
 * happened to move must not read as a stacking change.
 */
function bars(html: string): { x: number; y: number; w: number; h: number; fill: string }[] {
  const out: { x: number; y: number; w: number; h: number; fill: string }[] = [];
  for (const [tag] of html.matchAll(/<rect\b[^>]*>/g)) {
    if (tag.includes("rx=")) continue;
    const at = (name: string) =>
      Number(new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "NaN");
    out.push({
      x: at("x"), y: at("y"), w: at("width"), h: at("height"),
      fill: /fill="([^"]*)"/.exec(tag)?.[1] ?? "",
    });
  }
  return out;
}

/** The y-axis tick labels, largest first. */
function yTicks(html: string): number[] {
  return [...html.matchAll(/text-anchor="end"[^>]*>([^<]*)</g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
}

/** The inline error text when a macro refuses. */
function refusal(html: string): string {
  return /<div class="error macro">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
}

/** A macro invocation with the given parameter lines. */
function macro(name: string, ...lines: string[]): string {
  return `{{ ${name}\n     ${lines.join("\n     ")}\n}}`;
}

beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "boss", name: "BOSS", password: "series-charts-2010!" }),
    "admin",
  ).id;
  devId = mustOk(
    registerUser(db, { login: "dev", name: "DEV", password: "series-charts-2010!" }),
    "dev",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "Velocity", identifier: IDENTIFIER, actorUserId: adminId }),
    "project",
  ).id;
  mustOk(
    addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }),
    "membership",
  );
  storyTypeId = mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story").id;
  bugTypeId = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug").id;

  // Status is declared new -> open -> closed ON PURPOSE: that order is
  // neither alphabetical nor insertion-by-use, so an axis that comes
  // back in it can only have come from the enumeration's position.
  propertyIds.status = mustOk(
    definePropertyDefinition(db, {
      projectId,
      actorUserId: adminId,
      name: "Status",
      kind: "enumerated",
      values: ["new", "open", "closed"],
    }),
    "Status",
  ).id;
  propertyIds.estimate = mustOk(
    definePropertyDefinition(db, { projectId, actorUserId: adminId, name: "Estimate", kind: "number" }),
    "Estimate",
  ).id;

  // The seed every expectation below is hand-computed from:
  //
  //   Story  new    est 3        Story  open   est 5      Story  closed est 8
  //   Story  new    est 1        Story  open   est 2      Story  closed est 13
  //   Bug    open   est 2        Bug    closed est 1
  //   Story  (status unset, est 4)
  //
  //   COUNT by status:  Story -> new 2, open 2, closed 2, (not set) 1
  //                     Bug   -> open 1, closed 1
  //   SUM(Estimate):    Story -> new 4, open 7, closed 21, (not set) 4
  card("S-new-1", storyTypeId, { status: "new", estimate: "3" });
  card("S-new-2", storyTypeId, { status: "new", estimate: "1" });
  card("S-open-1", storyTypeId, { status: "open", estimate: "5" });
  card("S-open-2", storyTypeId, { status: "open", estimate: "2" });
  card("S-closed-1", storyTypeId, { status: "closed", estimate: "8" });
  card("S-closed-2", storyTypeId, { status: "closed", estimate: "13" });
  card("B-open", bugTypeId, { status: "open", estimate: "2" });
  card("B-closed", bugTypeId, { status: "closed", estimate: "1" });
  card("S-unset", storyTypeId, { estimate: "4" });
});

describe("stacked bar chart — segment values", () => {
  it("plots a hand-computed segment per series against a shared axis", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "conditions: type = Story",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
      ),
    );

    // The axis is the Story scope, so `(not set)` is on it and Bug-only
    // values are not; Bugs therefore contributes 0 to every column.
    // `(not set)` leads, exactly as an enumerated card-grid lane does
    // (card-grid.behavior.test asserts the same order) — the chart and
    // the grid read one ordering rule, which is the point of the seam.
    expect(axis(out)).toEqual(["(not set)", "new", "open", "closed"]);
    expect(plotted(out)).toEqual({
      Stories: [1, 2, 2, 2],
      Bugs: [0, 0, 0, 0],
    });
  });

  it("orders the axis by the enumeration's defined position, not alphabetically", () => {
    const out = render(
      macro("stacked-bar-chart", "series:", "       - data: SELECT Status, COUNT(*)"),
    );
    // Alphabetical would be closed, new, open. The discriminating
    // assertion is that `closed` is last and `new` first, which only
    // the enumeration's declared position produces.
    expect(axis(out)).toEqual(["(not set)", "new", "open", "closed"]);
  });

  it("stacks two series into one bar, each keeping its own value", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
      ),
    );
    expect(axis(out)).toEqual(["(not set)", "new", "open", "closed"]);
    expect(plotted(out)).toEqual({
      Stories: [1, 2, 2, 2],
      Bugs: [0, 0, 1, 1],
    });
    // One rect per non-zero segment: 4 Story columns + 2 Bug columns.
    expect([...out.matchAll(/<rect\b/g)].length).toBe(4 + 2 + 2); // + 2 legend swatches
  });

  it("stacks the second series directly on top of the first, sharing one column", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
      ),
    );
    // Axis is [(not set), new, open, closed]; both series are non-zero
    // at `open` and `closed`. Stories draws 4 bars, Bugs draws 2.
    const drawn = bars(out);
    expect(drawn).toHaveLength(6);
    const story = drawn.slice(0, 4);
    const bug = drawn.slice(4);

    // Same column means the same x and width — a grouped chart would
    // give the two series different x offsets within the band.
    expect(bug[0].x).toBe(story[2].x);
    expect(bug[0].w).toBe(story[2].w);
    // And the bug segment sits ON the story segment: its bottom edge is
    // the story segment's top edge, rather than both starting at the
    // baseline.
    expect(bug[0].y + bug[0].h).toBeCloseTo(story[2].y, 6);
    expect(bug[1].y + bug[1].h).toBeCloseTo(story[3].y, 6);
  });

  it("scales the y axis to the tallest stacked column, not the tallest series", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
      ),
    );
    // Column sums are 1, 2, 3, 3. The tallest SERIES peak is only 2, so
    // an axis topping out at 2 would push the tallest stack through the
    // top of the plot while still looking like a chart.
    expect(yTicks(out)[0]).toBe(5);
  });

  it("aggregates with SUM over a numeric property, not just COUNT", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "conditions: type = Story",
        "series:",
        "       - data: SELECT Status, SUM(Estimate)",
        "         label: Points",
      ),
    );
    expect(plotted(out)).toEqual({ Points: [4, 4, 7, 21] });
  });

  it("turns values into running totals when cumulative is true", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "conditions: type = Story",
        "cumulative: true",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         label: Stories",
      ),
    );
    // 1, 2, 2, 2 accumulated left to right.
    expect(plotted(out)).toEqual({ Stories: [1, 3, 5, 7] });
  });

  it("draws a total series as the remainder left by its overlays", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
        "         combine: overlay-bottom",
        "       - data: SELECT Status, COUNT(*)",
        "         label: All cards",
        "         combine: total",
      ),
    );
    // All = 1, 2, 3, 3. Bugs = 0, 0, 1, 1. The total draws the gap.
    expect(plotted(out)).toEqual({
      Bugs: [0, 0, 1, 1],
      "All cards": [1, 2, 2, 2],
    });
  });

  it("refuses a total series smaller than the overlays inside it", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         label: Everything",
        "         combine: overlay-bottom",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs only",
        "         combine: total",
      ),
    );
    expect(refusal(out)).toContain("less than sum value of the overlay conditions");
    // Named at the first column where it happens, not just "somewhere".
    expect(refusal(out)).toContain("(not set)");
  });

  it("leaves a total series untouched by a series that declared no combine", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
        "       - data: SELECT Status, COUNT(*)",
        "         label: All cards",
        "         combine: total",
      ),
    );
    // Bugs named no `combine`, so it is a plain series: legacy stacks
    // it but does NOT reduce the total by it, so the total still draws
    // its own full value rather than the gap above the bugs.
    expect(plotted(out)).toEqual({
      Bugs: [0, 0, 1, 1],
      "All cards": [1, 2, 3, 3],
    });
  });

  it("orders the stack plain, then overlay-bottom, then total, then overlay-top", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         label: Everything",
        "         combine: total",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
        "         combine: overlay-top",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "         combine: overlay-bottom",
      ),
    );
    expect(Object.keys(plotted(out))).toEqual(["Stories", "Everything", "Bugs"]);
  });

  it("honours an explicit labels query, and appends a value it omits", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "labels: SELECT DISTINCT Status WHERE Status = closed",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         label: All",
      ),
    );
    // The labels query names only `closed`; the series still counts the
    // rest, so those columns are appended rather than dropped.
    expect(axis(out)[0]).toBe("closed");
    expect(axis(out)).toContain("new");
    expect(plotted(out).All[0]).toBe(3);
    expect(plotted(out).All.reduce((a, b) => a + b, 0)).toBe(9);
  });
});

describe("data series chart — independent series", () => {
  it("plots each series independently against the shared axis", () => {
    const out = render(
      macro(
        "data-series-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
      ),
    );
    expect(axis(out)).toEqual(["(not set)", "new", "open", "closed"]);
    expect(plotted(out)).toEqual({
      Stories: [1, 2, 2, 2],
      Bugs: [0, 0, 1, 1],
    });
    // Line is the default mark: one polyline per series, no bars.
    expect([...out.matchAll(/<polyline\b/g)].length).toBe(2);
  });

  it("draws bars when chart-type is bar, and lines for a series that overrides it", () => {
    const out = render(
      macro(
        "data-series-chart",
        "chart-type: bar",
        "series:",
        "       - data: SELECT Status, COUNT(*) WHERE type = Story",
        "         label: Stories",
        "       - data: SELECT Status, COUNT(*) WHERE type = Bug",
        "         label: Bugs",
        "         type: line",
      ),
    );
    expect([...out.matchAll(/<polyline\b/g)].length).toBe(1);
    // Story bars for (not set)/new/open/closed, and nothing stacked on
    // them — the line series is drawn as a line, not as a segment.
    expect(bars(out)).toHaveLength(4);
    // Every bar starts from the baseline, which is what "independent
    // series" means here: heights are not offset by another series.
    const baseline = Math.max(...bars(out).map((b) => b.y + b.h));
    for (const bar of bars(out)) expect(bar.y + bar.h).toBeCloseTo(baseline, 6);
  });

  it("draws a filled polygon under an area series", () => {
    const out = render(
      macro(
        "data-series-chart",
        "chart-type: area",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         label: All",
        "         color: #1188cc",
      ),
    );
    expect(out).toContain("<polygon");
    expect(out).toContain('fill="#1188cc"');
  });

  it("refuses combine, which is the stacked chart's parameter", () => {
    const out = render(
      macro(
        "data-series-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         combine: total",
      ),
    );
    expect(refusal(out)).toContain("combine is not supported by this chart");
  });

  it("refuses a chart-type it cannot draw, naming the three it can", () => {
    const out = render(
      macro("data-series-chart", "chart-type: donut", "series:", "       - data: SELECT Status, COUNT(*)"),
    );
    expect(refusal(out)).toContain("line, area, bar");
  });
});

describe("series charts — refusals", () => {
  it("refuses a missing series list", () => {
    expect(refusal(render(macro("stacked-bar-chart", "conditions: type = Story")))).toContain(
      "Need to specify series",
    );
  });

  it("refuses a series value that is not a block", () => {
    // The parameter parser has no empty-sequence syntax — a sequence
    // exists only where a `- ` line does — so `series: []` reaches the
    // macro as the literal text, and is refused as a non-block rather
    // than treated as zero series.
    const out = render(macro("stacked-bar-chart", "series: []"));
    expect(refusal(out)).toContain("Each series must be a block");
  });

  it("refuses a series with no data query", () => {
    expect(
      refusal(render(macro("stacked-bar-chart", "series:", "       - label: Nameless"))),
    ).toContain("Need to specify data");
  });

  it("refuses a data query projecting only an aggregate", () => {
    const out = render(
      macro("stacked-bar-chart", "series:", "       - data: SELECT COUNT(*)"),
    );
    expect(refusal(out)).toContain("not 1 columns");
  });

  it("refuses a data query whose second column is not an aggregate", () => {
    const out = render(
      macro("stacked-bar-chart", "series:", "       - data: SELECT Status, Estimate"),
    );
    expect(refusal(out)).toContain("An aggregate must be specified");
  });

  it("refuses a data query whose first column is an aggregate", () => {
    const out = render(
      macro("stacked-bar-chart", "series:", "       - data: SELECT COUNT(*), Status"),
    );
    expect(refusal(out)).toContain("A property name must be specified");
  });

  it("refuses the project parameter by name", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "project: other",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
      ),
    );
    expect(refusal(out)).toContain("Project parameter is not supported");
  });

  it("refuses a colour that is not a hex colour", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
        "         color: rebeccapurple",
      ),
    );
    expect(refusal(out)).toContain("is not a colour");
  });

  it("refuses a cumulative value that is neither true nor false", () => {
    const out = render(
      macro(
        "stacked-bar-chart",
        "cumulative: yes",
        "series:",
        "       - data: SELECT Status, COUNT(*)",
      ),
    );
    expect(refusal(out)).toContain("must be one of: true, false");
  });

  it("refuses unparseable MQL with the parser's own message", () => {
    const out = render(
      macro("stacked-bar-chart", "series:", "       - data: SELECT Nonsuch, COUNT(*)"),
    );
    expect(refusal(out)).not.toBe("");
    expect(refusal(out).toLowerCase()).toContain("nonsuch");
  });
});
