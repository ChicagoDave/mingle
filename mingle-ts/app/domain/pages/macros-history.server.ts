/**
 * Daily history chart macro — `{{ daily-history-chart }}` (Phase 18).
 *
 * Purpose: plots how an aggregate over cards matching an MQL condition
 * moved day by day across a date range. The number for a past day is
 * not derivable from the `cards` table — only `card_versions` holds
 * what a card looked like then — so each point is one MQL query with
 * `AS OF` set to that day.
 *
 * This module computes NO history of its own. It composes MQL text,
 * parses it once per series, and then re-runs the same resolved query
 * with a different `asOf` per day through the production projection
 * path. Reconstruction lives in the evaluator's `cardsAsOf` source,
 * which is the same translation the card filters use; a chart that
 * disagreed with a filter about what `Status != Open` means on an
 * unset property would be a wrong answer that looks like a right one.
 *
 * Cost is one query per (day x series), each carrying a correlated
 * `max(version)` lookup. Legacy solved that with an asynchronous cache
 * (`DailyHistoryChartProcessor`); this renders synchronously, so the
 * range is capped at `MAX_DAYS` and refuses beyond it by name rather
 * than quietly rendering a page that takes a minute to load.
 *
 * The chart is inline SVG built on the server for the reason ADR-0014
 * records: it is nodes in the content tree, so it renders with
 * scripting off and passes the same allowlist pass as everything else.
 *
 * Public interface: `dailyHistoryChartMacro` — registered by
 * macros-registry.server, not by this module.
 *
 * Owner context: Wiki & Content, reading from Query.
 */
import { queryMqlProjection } from "~/domain/cards/mql-projection.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import { parseProjectMql } from "~/domain/cards/mql-schema.server";
import type { MqlQuery } from "~/domain/cards/mql.server";
import {
  registerMacroElements,
  type ContentNode,
} from "~/domain/pages/content.server";
import {
  element,
  paletteColor,
  parseColor,
  round,
  text,
} from "~/domain/pages/chart-svg.server";
import {
  MacroError,
  type MacroContext,
  type MacroDefinition,
  type MacroParams,
  type MacroParamValue,
} from "~/domain/pages/macros.server";

// The complete set of SVG this module may emit, declared at import
// time so the allowlist is extended by declaration, never in place
// (ADR-0014). `polyline` and `line` are what a time series needs on
// top of the pie chart's surface; no `foreignObject`, no event
// attributes, no `href` of any kind.
registerMacroElements({
  svg: ["viewBox", "width", "height", "role", "aria-label", "xmlns"],
  g: ["transform"],
  polyline: ["points", "fill", "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap"],
  line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width", "stroke-dasharray"],
  circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
  rect: ["x", "y", "width", "height", "fill", "rx"],
  text: ["x", "y", "fill", "font-size", "text-anchor", "dominant-baseline", "transform"],
  desc: [],
});

/**
 * The widest range this chart will draw. Each day costs one query per
 * series, and a wiki page render is synchronous — a year of dailies is
 * already generous, and refusing past it is honest where a spinner is
 * not.
 */
const MAX_DAYS = 366;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a parameter as a scalar, refusing a nested block. */
function scalar(params: MacroParams, key: string): string | null {
  const value = params[key];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new MacroError(`Parameter ${key} must be a single value.`);
  }
  return value;
}

/** Reads a positive integer parameter, falling back to a default. */
function integer(params: MacroParams, key: string, fallback: number): number {
  const raw = scalar(params, key);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new MacroError(`Parameter ${key} must be a positive number.`);
  }
  return Math.floor(value);
}

/**
 * Reads a required ISO date parameter.
 *
 * @throws MacroError when absent, malformed, or not a real calendar date
 */
function isoDate(params: MacroParams, key: string): string {
  const raw = scalar(params, key);
  if (raw === null || raw === "") {
    throw new MacroError(`Need to specify ${key}.`);
  }
  const value = raw.trim();
  if (!ISO_DATE.test(value) || !isRealDate(value)) {
    throw new MacroError(`Parameter ${key} must be a date in yyyy-mm-dd format; '${raw}' is not one.`);
  }
  return value;
}

/** True when the ISO text names a date the calendar actually has. */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Every day from start to end inclusive, as ISO yyyy-mm-dd. */
function daysBetween(start: string, end: string): string[] {
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  const out: string[] = [];
  for (let t = from; t <= to; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** One declared series: its label, colour, and the query behind it. */
interface Series {
  label: string;
  color: string;
  query: MqlQuery;
  values: number[];
}

/**
 * Composes the MQL one series runs, ANDing the chart-wide conditions
 * with the series' own.
 *
 * Each fragment is parenthesized because MQL's `and` binds looser than
 * a bare comparison chain: `a = 1 or b = 2` ANDed unparenthesized with
 * `c = 3` would silently mean something else.
 */
function seriesMql(aggregate: string, chartConditions: string | null, conditions: string | null): string {
  const parts = [chartConditions, conditions]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .map((part) => `(${part})`);
  const where = parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
  return `SELECT ${aggregate}${where}`;
}

/**
 * Parses one series' composed MQL and checks it projects a single
 * aggregate.
 *
 * A non-aggregate SELECT would return one row per card, and taking the
 * first cell of that would plot one arbitrary card's value while
 * looking exactly like a total.
 *
 * @throws MacroError when the MQL does not parse or is not a single aggregate
 */
function parseSeriesQuery(context: MacroContext, mql: string): MqlQuery {
  const parsed = parseProjectMql(context.db, context.projectId, mql);
  if (!parsed.ok) throw new MacroError(parsed.errors.join(" "));
  const columns = parsed.query.select?.columns ?? [];
  if (columns.length !== 1 || columns[0].type !== "aggregate") {
    throw new MacroError(
      "aggregate must be a single aggregate function, for example COUNT(*) or SUM('story points').",
    );
  }
  return parsed.query;
}

/** Reads the `series` parameter as a list of mappings. */
function seriesSpecs(params: MacroParams): MacroParams[] {
  const raw = params.series;
  if (raw === undefined || raw === "") {
    throw new MacroError("Need to specify series.");
  }
  const items: MacroParamValue[] = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => {
    if (typeof item !== "object" || Array.isArray(item)) {
      throw new MacroError("Each series must be a block with its own conditions.");
    }
    return item;
  });
}

/**
 * Runs one series across the range.
 *
 * The query is parsed ONCE and re-run with a different `asOf` per day:
 * re-composing and re-parsing text per day would make a parse error on
 * day 40 possible after 39 successful points.
 */
function seriesValues(context: MacroContext, query: MqlQuery, days: string[]): number[] {
  const evaluation = { currentUserId: context.currentUserId, today: todayIso() };
  return days.map((day) => {
    let projection;
    try {
      projection = queryMqlProjection(context.db, context.projectId, { ...query, asOf: day }, evaluation);
    } catch (error) {
      throw new MacroError(error instanceof Error ? error.message : String(error));
    }
    const cell = projection.rows[0]?.cells[0] ?? "";
    const value = Number(cell);
    return Number.isFinite(value) ? value : 0;
  });
}

/** A round-ish axis maximum at or above the largest plotted value. */
function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const fraction = max / magnitude;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Formats an axis value, keeping whole numbers whole. */
function axisLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toString();
}

/**
 * `{{ daily-history-chart start-date: … end-date: … series: … }}`
 *
 * Draws one line per series over a dated x axis, each point being the
 * aggregate as of that day's end.
 */
export const dailyHistoryChartMacro: MacroDefinition = {
  name: "daily-history-chart",
  expand(params, context) {
    // Legacy refuses this by name on this chart specifically
    // (DailyHistorySeries#validate!), because a cross-project history
    // would need the other project's versions and time zone.
    if (params.project !== undefined) {
      throw new MacroError("Project parameter is not allowed for the daily history chart.");
    }

    const start = isoDate(params, "start-date");
    const end = isoDate(params, "end-date");
    if (Date.parse(`${start}T00:00:00Z`) > Date.parse(`${end}T00:00:00Z`)) {
      throw new MacroError("start-date must be on or before end-date.");
    }
    const days = daysBetween(start, end);
    if (days.length > MAX_DAYS) {
      throw new MacroError(
        `start-date and end-date are ${days.length} days apart; this chart draws at most ${MAX_DAYS}.`,
      );
    }

    const aggregate = (scalar(params, "aggregate") ?? "COUNT(*)").trim() || "COUNT(*)";
    const chartConditions = scalar(params, "chart-conditions");
    const specs = seriesSpecs(params);

    const series: Series[] = specs.map((spec, index) => {
      const conditions = scalar(spec, "conditions");
      const query = parseSeriesQuery(context, seriesMql(aggregate, chartConditions, conditions));
      let color: string;
      try {
        color = parseColor(scalar(spec, "color"), paletteColor(index));
      } catch (error) {
        throw new MacroError(error instanceof Error ? error.message : String(error));
      }
      return {
        label: scalar(spec, "label") || conditions || "All",
        color,
        query,
        values: seriesValues(context, query, days),
      };
    });

    return [render(params, days, series)];
  },
};

/** Builds the chart's nodes from the computed series. */
function render(params: MacroParams, days: string[], series: Series[]): ContentNode {
  const title = scalar(params, "chart-title") ?? "";
  const xTitle = scalar(params, "x-title") ?? "Date";
  const yTitle = scalar(params, "y-title") ?? "";
  const width = integer(params, "chart-width", 680);
  const height = integer(params, "chart-height", 360);

  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 70;
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = Math.max(40, height - padTop - padBottom);

  const highest = Math.max(0, ...series.flatMap((s) => s.values));
  const yMax = niceMax(highest);
  const TICKS = 4;

  // A single day has no interval to spread across, so its point sits
  // in the middle of the plot rather than at x = NaN.
  const xAt = (index: number): number =>
    days.length === 1 ? padLeft + plotW / 2 : padLeft + (index * plotW) / (days.length - 1);
  const yAt = (value: number): number => padTop + plotH - (value / yMax) * plotH;

  const axes: ContentNode[] = [];
  for (let tick = 0; tick <= TICKS; tick++) {
    const value = (yMax * tick) / TICKS;
    const y = yAt(value);
    axes.push(
      element("line", {
        x1: round(padLeft), y1: round(y), x2: round(padLeft + plotW), y2: round(y),
        stroke: tick === 0 ? "#888888" : "#e2e2e2", "stroke-width": "1",
      }),
    );
    axes.push(
      element(
        "text",
        {
          x: round(padLeft - 8), y: round(y), "font-size": "12", fill: "#555555",
          "text-anchor": "end", "dominant-baseline": "middle",
        },
        [text(axisLabel(value))],
      ),
    );
  }

  const labelStep = integer(params, "x-labels-step", Math.max(1, Math.ceil(days.length / 8)));
  days.forEach((day, index) => {
    if (index % labelStep !== 0 && index !== days.length - 1) return;
    axes.push(
      element(
        "text",
        {
          x: round(xAt(index)), y: round(padTop + plotH + 16), "font-size": "11", fill: "#555555",
          "text-anchor": "middle",
        },
        [text(day)],
      ),
    );
  });

  axes.push(
    element(
      "text",
      {
        x: round(padLeft + plotW / 2), y: round(padTop + plotH + 36), "font-size": "12", fill: "#333333",
        "text-anchor": "middle",
      },
      [text(xTitle)],
    ),
  );
  if (yTitle) {
    axes.push(
      element(
        "text",
        {
          x: "0", y: "0", "font-size": "12", fill: "#333333", "text-anchor": "middle",
          transform: `translate(14, ${round(padTop + plotH / 2)}) rotate(-90)`,
        },
        [text(yTitle)],
      ),
    );
  }

  const lines: ContentNode[] = [];
  for (const s of series) {
    lines.push(
      element("polyline", {
        points: s.values.map((value, index) => `${round(xAt(index))},${round(yAt(value))}`).join(" "),
        fill: "none",
        stroke: s.color,
        "stroke-width": "2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
    // Point markers only when they would not crowd into a smear.
    if (days.length <= 31) {
      s.values.forEach((value, index) => {
        lines.push(
          element("circle", {
            cx: round(xAt(index)), cy: round(yAt(value)), r: "3", fill: s.color,
          }),
        );
      });
    }
  }

  const legend: ContentNode[] = [];
  series.forEach((s, index) => {
    const y = padTop + plotH + 52 + Math.floor(index / 3) * 18;
    const x = padLeft + (index % 3) * 180;
    legend.push(
      element("rect", { x: round(x), y: round(y - 8), width: "12", height: "12", rx: "2", fill: s.color }),
    );
    legend.push(
      element(
        "text",
        { x: round(x + 18), y: round(y), "font-size": "12", fill: "#222222", "dominant-baseline": "middle" },
        [text(s.label)],
      ),
    );
  });

  const legendRows = Math.ceil(series.length / 3);
  const svgHeight = padTop + plotH + 52 + legendRows * 18 + 8;
  const summary = series
    .map((s) => `${s.label}: ${s.values.join(", ")}`)
    .join("; ");

  return element("div", { class: "macro chart daily-history-chart" }, [
    element(
      "svg",
      {
        viewBox: `0 0 ${round(width)} ${round(svgHeight)}`,
        width: round(width),
        height: round(svgHeight),
        role: "img",
        "aria-label": `${title || "Daily history chart"}, ${days[0]} to ${days[days.length - 1]}`,
      },
      [
        // Every plotted number as text, so the chart is readable
        // without seeing it.
        element("desc", {}, [text(`${days.join(", ")} — ${summary}`)]),
        ...axes,
        ...lines,
        ...legend,
      ],
    ),
    ...(title ? [element("p", { class: "chart-title" }, [text(title)])] : []),
  ]);
}
