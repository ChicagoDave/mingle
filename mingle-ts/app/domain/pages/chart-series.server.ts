/**
 * Series-chart data resolution — the `series:` parameter, the group-by
 * queries behind it, and the x axis they share (Phase 19).
 *
 * Purpose: both `stacked-bar-chart` and `data-series-chart` are the
 * same data problem wearing different marks. Each declares a list of
 * series; each series carries one MQL query of the shape
 *
 *   `data: SELECT <property>, <aggregate> [WHERE ...]`
 *
 * which projects a label column and a number, grouped by the label.
 * Every series is plotted against ONE shared x axis, so the two charts
 * must agree about what that axis contains and what order it runs in.
 * A second copy of that rule is the failure ADR-0015 was written about:
 * two renderings of the same cards that disagree, both looking correct.
 *
 * Ordering is not done in JavaScript. The axis query is executed with
 * an `orderBy` on the grouping property, so the evaluator's `orderExpr`
 * decides — which means an enumerated property orders by its DEFINED
 * POSITION, a number orders numerically rather than as text, and a date
 * orders chronologically, exactly as a card list would order them —
 * with the unset bucket leading, the same place a card grid puts its
 * `(not set)` lane. Sorting the returned label strings in JS would put
 * `10` before `9` and `Closed` before `Open`.
 *
 * Divergence from legacy, deliberate: legacy builds the axis from the
 * property DEFINITION, so an enumerated value no card currently has
 * still gets an empty column. This builds it from a `SELECT DISTINCT`
 * over the chart-level conditions, so the axis shows the values the
 * chart's own scope actually contains. `labels:` remains the explicit
 * override for an author who wants a fixed axis either way.
 *
 * Public interface: `resolveSeriesData`, `SeriesData`, `ResolvedSeries`,
 * `SeriesChartInput`.
 *
 * Owner context: Wiki & Content, reading from Query.
 */
import { queryMqlProjection } from "~/domain/cards/mql-projection.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import { parseProjectMql } from "~/domain/cards/mql-schema.server";
import type { Column, MqlQuery, PropertyRef } from "~/domain/cards/mql.server";
import { paletteColor, parseColor } from "~/domain/pages/chart-svg.server";
import {
  MacroError,
  type MacroContext,
  type MacroParams,
  type MacroParamValue,
} from "~/domain/pages/macros.server";

/** The text shown for a card that has no value for the x-axis property. */
export const NOT_SET = "(not set)";

/** One resolved series: how to draw it, and its value at each x position. */
export interface ResolvedSeries {
  label: string;
  color: string;
  /** `bar`, `line`, or `area` — how this series is drawn. */
  type: "bar" | "line" | "area";
  /**
   * Stacking role, honoured by the stacked-bar chart only. `plain` is
   * a series that named no `combine` at all — it stacks, but a `total`
   * series is NOT reduced by it, matching legacy's `normal_series`.
   */
  combine: "plain" | "overlay-bottom" | "overlay-top" | "total";
  /** One value per x-axis label, positionally aligned, zero where absent. */
  values: number[];
}

/** The x axis and the series plotted against it. */
export interface SeriesData {
  /** Axis labels, left to right. */
  labels: string[];
  series: ResolvedSeries[];
  /** The property the x axis is built from, for a default axis title. */
  xPropertyName: string;
  /** The first series' aggregate name, for a default y axis title. */
  yAggregateName: string;
}

/** What a series chart passes in to have its data resolved. */
export interface SeriesChartInput {
  params: MacroParams;
  context: MacroContext;
  /** The default `type` when a series does not name one. */
  defaultType: "bar" | "line" | "area";
  /** Whether this chart honours `combine`; the data-series chart does not. */
  allowCombine: boolean;
}

/** Reads a parameter as a scalar, refusing a nested block. */
function scalar(params: MacroParams, key: string): string | null {
  const value = params[key];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new MacroError(`Parameter ${key} must be a single value.`);
  }
  return value;
}

/**
 * Reads a boolean parameter written as `true` or `false`.
 *
 * @throws MacroError naming both accepted spellings, because a typo
 *   read as `false` is a silently different chart
 */
function boolean(params: MacroParams, key: string, fallback: boolean): boolean {
  const raw = scalar(params, key);
  if (raw === null || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new MacroError(`Parameter ${key} must be one of: true, false.`);
}

/** Parses MQL in the macro's project, raising the parser's own errors. */
function parse(context: MacroContext, mql: string): MqlQuery {
  const parsed = parseProjectMql(context.db, context.projectId, mql);
  if (!parsed.ok) throw new MacroError(parsed.errors.join(" "));
  return parsed.query;
}

/** Runs a resolved query through the production projection path. */
function project(context: MacroContext, query: MqlQuery) {
  try {
    return queryMqlProjection(context.db, context.projectId, query, {
      currentUserId: context.currentUserId,
      today: todayIso(),
    });
  } catch (error) {
    throw new MacroError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Checks a series query projects a label column and one aggregate, and
 * fills in the grouping and ordering legacy infers.
 *
 * Legacy's `order_and_group_by_first_column_if_necessary` does the same
 * thing: an author writes `SELECT status, COUNT(*)` and means grouped
 * by status. Without the injected `groupBy` the query would return one
 * row per card and the chart would plot one arbitrary card's value
 * while looking exactly like a total.
 *
 * @param query - the parsed series `data` query
 * @returns the query with grouping and ordering settled, and its x column
 * @throws MacroError when the projection is not a label plus an aggregate
 */
function asGroupedQuery(query: MqlQuery): { query: MqlQuery; column: Column<PropertyRef> } {
  const columns = query.select?.columns ?? [];
  if (columns.length !== 2) {
    throw new MacroError(
      `A series data query must select a property and an aggregate, not ${columns.length} columns.`,
    );
  }
  const [first, second] = columns;
  if (first.type !== "column") {
    throw new MacroError("A property name must be specified in the series data parameter.");
  }
  if (second.type !== "aggregate") {
    throw new MacroError("An aggregate must be specified in the series data parameter.");
  }
  const column: Column<PropertyRef> = first;
  return {
    query: {
      ...query,
      groupBy: query.groupBy?.length ? query.groupBy : [column],
      orderBy: query.orderBy?.length ? query.orderBy : [{ column, direction: "asc" }],
    },
    column,
  };
}

/** The aggregate's display name, for a default y axis title. */
function aggregateName(query: MqlQuery): string {
  const column = query.select?.columns[1];
  if (!column || column.type !== "aggregate") return "";
  const inner = column.column ? column.column.property.name : "*";
  return `${column.fn.toUpperCase()}(${inner})`;
}

/**
 * ANDs the chart-level `conditions` into a series query.
 *
 * The chart's conditions are parsed once, as a query of their own, and
 * the resulting condition tree is grafted on — rather than splicing MQL
 * text together, which would make `a = 1 or b = 2` bind wrongly against
 * the series' own WHERE.
 */
function restrict(query: MqlQuery, conditions: MqlQuery["where"]): MqlQuery {
  if (conditions === null) return query;
  if (query.where === null) return { ...query, where: conditions };
  return { ...query, where: { type: "and", left: conditions, right: query.where } };
}

/** Reads the `series` parameter as a list of parameter blocks. */
function seriesSpecs(params: MacroParams): MacroParams[] {
  const raw = params.series;
  if (raw === undefined || raw === "") {
    throw new MacroError("Need to specify series.");
  }
  const items: MacroParamValue[] = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => {
    if (typeof item !== "object" || Array.isArray(item)) {
      throw new MacroError("Each series must be a block with its own data query.");
    }
    return item;
  });
}

/** Reads a series' `type`, refusing a mark this chart cannot draw. */
function seriesType(spec: MacroParams, fallback: ResolvedSeries["type"]): ResolvedSeries["type"] {
  const raw = scalar(spec, "type");
  if (raw === null || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "bar" || value === "line" || value === "area") return value;
  throw new MacroError(`Parameter type must be one of: line, area, bar.`);
}

/** Reads a series' `combine`, refusing an unknown stacking role. */
function seriesCombine(spec: MacroParams, allowed: boolean): ResolvedSeries["combine"] {
  const raw = scalar(spec, "combine");
  if (raw === null || raw.trim() === "") return "plain";
  if (!allowed) {
    throw new MacroError("Parameter combine is not supported by this chart.");
  }
  const value = raw.trim().toLowerCase();
  if (value === "total" || value === "overlay-top" || value === "overlay-bottom") return value;
  throw new MacroError("Parameter combine must be one of: total, overlay-top, overlay-bottom.");
}

/** Turns a projection of (label, number) rows into a lookup. */
function valuesByLabel(rows: { cells: string[] }[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const row of rows) {
    const label = row.cells[0] === "" ? NOT_SET : row.cells[0];
    const value = Number(row.cells[1]);
    found.set(label, Number.isFinite(value) ? value : 0);
  }
  return found;
}

/**
 * Builds the shared x axis.
 *
 * With `labels:` the author's own query decides. Without it, a
 * `SELECT DISTINCT <x property>` over the chart-level conditions does,
 * so every series is plotted against the same scope it was restricted
 * to, ordered by the property rather than by its rendered text.
 */
function axisLabels(
  input: SeriesChartInput,
  column: Column<PropertyRef>,
  chartConditions: MqlQuery["where"],
): string[] {
  const declared = scalar(input.params, "labels");
  const query: MqlQuery = declared && declared.trim() !== ""
    ? restrict(parse(input.context, declared), chartConditions)
    : {
        select: { columns: [column], distinct: true },
        asOf: null,
        from: null,
        where: chartConditions,
        groupBy: null,
        orderBy: [{ column, direction: "asc" }],
      };

  const projection = project(input.context, query);
  if (projection.columns.length !== 1) {
    throw new MacroError(
      `The labels query must select exactly one property, not ${projection.columns.length} columns.`,
    );
  }

  const seen: string[] = [];
  for (const row of projection.rows) {
    const label = row.cells[0] === "" ? NOT_SET : row.cells[0];
    if (!seen.includes(label)) seen.push(label);
  }
  return seen;
}

/**
 * Turns each series' values into running totals across the x axis.
 *
 * Applied before `combine`, matching legacy's order: a `total` series
 * is reduced by its overlays AFTER both have been accumulated, so the
 * remainder it draws is a remainder of cumulative values.
 */
function cumulate(values: number[]): number[] {
  let running = 0;
  return values.map((value) => (running += value));
}

/**
 * Subtracts overlay series from the `total` series at each position.
 *
 * A total series names the whole bar, and its overlays are drawn inside
 * it, so what the total itself draws is the remainder. Legacy refuses
 * rather than clamping when the overlays exceed the total, and so does
 * this: a bar silently drawn at the overlay sum would misreport the
 * total the author asked for.
 *
 * @throws MacroError naming the x-axis label where the overlays exceed the total
 */
function applyCombine(series: ResolvedSeries[], labels: string[]): void {
  const total = series.find((s) => s.combine === "total");
  if (!total) return;
  // Only DECLARED overlays reduce the total. A series that named no
  // `combine` is `plain`: legacy stacks it but leaves the total alone,
  // so treating an undeclared series as an overlay here would shrink
  // the total bar by a series the author never said it contained.
  const overlays = series.filter(
    (s) => s.combine === "overlay-bottom" || s.combine === "overlay-top",
  );
  total.values = total.values.map((value, index) => {
    const covered = overlays.reduce((sum, s) => sum + s.values[index], 0);
    const remainder = value - covered;
    if (remainder < 0) {
      throw new MacroError(
        `The value of the total conditions is less than sum value of the overlay conditions for label ${labels[index]}.`,
      );
    }
    return remainder;
  });
}

/**
 * The plotting order legacy stacks in: plain series first, then bottom
 * overlays, then the total's remainder, then top overlays.
 */
function stackingOrder(series: ResolvedSeries[]): ResolvedSeries[] {
  const at = (role: ResolvedSeries["combine"]) => series.filter((s) => s.combine === role);
  return [...at("plain"), ...at("overlay-bottom"), ...at("total"), ...at("overlay-top")];
}

/**
 * Resolves a series chart's `series:` parameter into plottable numbers.
 *
 * @param input - the macro's parameters, project context, and defaults
 * @returns the shared x axis and one aligned value array per series
 * @throws MacroError when a series query is missing, unparseable, not a
 *   label-plus-aggregate projection, or when a `total` series is
 *   smaller than the overlays inside it
 */
export function resolveSeriesData(input: SeriesChartInput): SeriesData {
  const { params, context } = input;

  // Legacy allows a cross-project series; this Mingle has no
  // cross-project read path, so it is refused by name rather than
  // quietly charting the current project's cards under another
  // project's label.
  if (params.project !== undefined) {
    throw new MacroError("Project parameter is not supported.");
  }

  const conditionsText = scalar(params, "conditions");
  const chartConditions =
    conditionsText && conditionsText.trim() !== ""
      ? parse(context, `SELECT COUNT(*) WHERE ${conditionsText}`).where
      : null;

  const cumulative = boolean(params, "cumulative", false);
  const specs = seriesSpecs(params);

  // Every series query is parsed and validated BEFORE any of them run,
  // so a typo in the last series cannot surface after the first three
  // have already queried.
  const prepared = specs.map((spec, index) => {
    const dataText = scalar(spec, "data");
    if (!dataText || dataText.trim() === "") {
      throw new MacroError("Need to specify data.");
    }
    const grouped = asGroupedQuery(parse(context, dataText));
    let color: string;
    try {
      color = parseColor(scalar(spec, "color"), paletteColor(index));
    } catch (error) {
      throw new MacroError(error instanceof Error ? error.message : String(error));
    }
    return {
      spec,
      column: grouped.column,
      query: restrict(grouped.query, chartConditions),
      label: scalar(spec, "label") || `Series ${index + 1}`,
      color,
      type: seriesType(spec, input.defaultType),
      combine: seriesCombine(spec, input.allowCombine),
    };
  });

  const labels = axisLabels(input, prepared[0].column, chartConditions);

  // Every series runs before any values are laid out against the axis.
  // The axis can still grow here — a label a series produced that the
  // axis does not carry can only come from an author-supplied `labels:`
  // query that omits it, and appending keeps the value visible where
  // dropping it would silently lose cards the series counted. Laying
  // out afterwards is what keeps `cumulative` right: a running total
  // must carry across an appended column, not restart from zero.
  const found = prepared.map((entry) => valuesByLabel(project(context, entry.query).rows));
  for (const values of found) {
    for (const label of values.keys()) {
      if (!labels.includes(label)) labels.push(label);
    }
  }

  const series: ResolvedSeries[] = prepared.map((entry, index) => {
    const raw = labels.map((label) => found[index].get(label) ?? 0);
    return {
      label: entry.label,
      color: entry.color,
      type: entry.type,
      combine: entry.combine,
      values: cumulative ? cumulate(raw) : raw,
    };
  });

  const ordered = input.allowCombine ? stackingOrder(series) : series;
  if (input.allowCombine) applyCombine(ordered, labels);

  return {
    labels,
    series: ordered,
    xPropertyName: prepared[0].column.property.name,
    yAggregateName: aggregateName(prepared[0].query),
  };
}
