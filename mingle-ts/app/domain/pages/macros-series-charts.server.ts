/**
 * Series chart macros — `{{ stacked-bar-chart }}` and
 * `{{ data-series-chart }}` (Phase 19).
 *
 * Purpose: plots one or more MQL group-by queries against a shared
 * categorical x axis. The two charts differ only in their default mark
 * and their stacking rule:
 *
 *   - `stacked-bar-chart` draws bars stacked at each x position, and
 *     honours `combine` (`total` / `overlay-bottom` / `overlay-top`),
 *     which is what lets one series name the whole bar and the rest sit
 *     inside it.
 *   - `data-series-chart` draws each series independently — line by
 *     default, or `area` or `bar` per series — and refuses `combine`
 *     by name, exactly as legacy drops that parameter from this chart's
 *     definitions rather than ignoring it.
 *
 * Everything about WHAT is plotted lives in chart-series.server; this
 * module only decides how it is drawn. The charts are server-rendered
 * inline SVG for the reason ADR-0014 records: a chart is nodes in the
 * content tree, so it renders with scripting off and passes the same
 * allowlist pass as everything else.
 *
 * Public interface: `stackedBarChartMacro`, `dataSeriesChartMacro` —
 * registered by macros-registry.server, not by this module.
 *
 * Owner context: Wiki & Content, reading from Query.
 */
import {
  registerMacroElements,
  type ContentNode,
} from "~/domain/pages/content.server";
import {
  axisLabel,
  element,
  legendNodes,
  legendRows,
  niceMax,
  round,
  text,
} from "~/domain/pages/chart-svg.server";
import {
  resolveSeriesData,
  type ResolvedSeries,
  type SeriesData,
} from "~/domain/pages/chart-series.server";
import {
  MacroError,
  type MacroDefinition,
  type MacroParams,
} from "~/domain/pages/macros.server";

// The complete set of SVG this module may emit, declared at import time
// so the allowlist is extended by declaration, never in place
// (ADR-0014). `polygon` is what an area series needs on top of the
// surface the earlier charts declared; no `foreignObject`, no event
// attributes, no `href` of any kind.
registerMacroElements({
  svg: ["viewBox", "width", "height", "role", "aria-label", "xmlns"],
  g: ["transform"],
  rect: ["x", "y", "width", "height", "fill", "rx"],
  polyline: ["points", "fill", "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap"],
  polygon: ["points", "fill", "stroke", "stroke-width"],
  line: ["x1", "y1", "x2", "y2", "stroke", "stroke-width", "stroke-dasharray"],
  circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
  text: ["x", "y", "fill", "font-size", "text-anchor", "dominant-baseline", "transform"],
  desc: [],
});

/** Legend geometry, shared by both charts so they line up on a page. */
const LEGEND_COLUMNS = 3;
const LEGEND_COLUMN_WIDTH = 180;
const LEGEND_ROW_HEIGHT = 18;

/** Reads a parameter as a scalar. */
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

/** The plot box, once padding is taken off the requested chart size. */
interface Plot {
  left: number;
  top: number;
  width: number;
  height: number;
  yMax: number;
  /** Centre of the band for x position `index`. */
  centreAt: (index: number) => number;
  /** Width of one x band, before any bar gap. */
  band: number;
  /** Vertical position of a value on the y axis. */
  yAt: (value: number) => number;
}

/**
 * Lays out the plot box for a categorical x axis.
 *
 * Bands are used rather than points because both charts place marks
 * BETWEEN axis divisions, not on them: a bar sits in its category's
 * band, and a line's vertex sits at that band's centre so it lines up
 * with the bar a reader may have swapped it for.
 */
function layout(params: MacroParams, count: number, highest: number): Plot {
  const width = integer(params, "chart-width", 680);
  const height = integer(params, "chart-height", 360);
  const left = 60;
  const top = 20;
  const plotWidth = Math.max(40, width - left - 20);
  const plotHeight = Math.max(40, height - top - 70);
  const band = plotWidth / Math.max(1, count);
  const yMax = niceMax(highest);
  return {
    left,
    top,
    width: plotWidth,
    height: plotHeight,
    yMax,
    band,
    centreAt: (index: number) => left + band * (index + 0.5),
    yAt: (value: number) => top + plotHeight - (value / yMax) * plotHeight,
  };
}

/** Horizontal grid lines with their value labels. */
function yAxis(plot: Plot): ContentNode[] {
  const TICKS = 4;
  const nodes: ContentNode[] = [];
  for (let tick = 0; tick <= TICKS; tick++) {
    const value = (plot.yMax * tick) / TICKS;
    const y = plot.yAt(value);
    nodes.push(
      element("line", {
        x1: round(plot.left), y1: round(y),
        x2: round(plot.left + plot.width), y2: round(y),
        stroke: tick === 0 ? "#888888" : "#e2e2e2", "stroke-width": "1",
      }),
    );
    nodes.push(
      element(
        "text",
        {
          x: round(plot.left - 8), y: round(y), "font-size": "12", fill: "#555555",
          "text-anchor": "end", "dominant-baseline": "middle",
        },
        [text(axisLabel(value))],
      ),
    );
  }
  return nodes;
}

/**
 * Category labels under the plot, plus the two axis titles.
 *
 * `x-labels-step` thins the labels when the categories would collide;
 * the last one is always drawn, so a reader can always see where the
 * axis ends.
 */
function xAxis(params: MacroParams, plot: Plot, data: SeriesData): ContentNode[] {
  const step = integer(
    params,
    "x-labels-step",
    Math.max(1, Math.ceil(data.labels.length / 12)),
  );
  const nodes: ContentNode[] = [];
  data.labels.forEach((label, index) => {
    if (index % step !== 0 && index !== data.labels.length - 1) return;
    nodes.push(
      element(
        "text",
        {
          x: round(plot.centreAt(index)), y: round(plot.top + plot.height + 16),
          "font-size": "11", fill: "#555555", "text-anchor": "middle",
        },
        [text(label)],
      ),
    );
  });

  const xTitle = scalar(params, "x-title") ?? data.xPropertyName;
  const yTitle = scalar(params, "y-title") ?? data.yAggregateName;
  if (xTitle) {
    nodes.push(
      element(
        "text",
        {
          x: round(plot.left + plot.width / 2), y: round(plot.top + plot.height + 36),
          "font-size": "12", fill: "#333333", "text-anchor": "middle",
        },
        [text(xTitle)],
      ),
    );
  }
  if (yTitle) {
    nodes.push(
      element(
        "text",
        {
          x: "0", y: "0", "font-size": "12", fill: "#333333", "text-anchor": "middle",
          transform: `translate(14, ${round(plot.top + plot.height / 2)}) rotate(-90)`,
        },
        [text(yTitle)],
      ),
    );
  }
  return nodes;
}

/**
 * Draws bar series stacked on top of each other.
 *
 * @param series - the bar series, in stacking order (bottom first)
 * @param base - running height already used at each x position, mutated
 *   so line and area series drawn afterwards sit above the stack
 */
function stackedBars(series: ResolvedSeries[], plot: Plot, base: number[]): ContentNode[] {
  const gap = plot.band * 0.15;
  const barWidth = Math.max(1, plot.band - gap * 2);
  const nodes: ContentNode[] = [];
  for (const s of series) {
    s.values.forEach((value, index) => {
      if (value <= 0) return;
      const bottom = plot.yAt(base[index]);
      const top = plot.yAt(base[index] + value);
      base[index] += value;
      nodes.push(
        element("rect", {
          x: round(plot.centreAt(index) - barWidth / 2),
          y: round(top),
          width: round(barWidth),
          height: round(Math.max(0, bottom - top)),
          fill: s.color,
        }),
      );
    });
  }
  return nodes;
}

/** Draws one series as an unstacked group of side-by-side bars. */
function groupedBars(series: ResolvedSeries[], plot: Plot): ContentNode[] {
  if (series.length === 0) return [];
  const gap = plot.band * 0.15;
  const slot = Math.max(1, (plot.band - gap * 2) / series.length);
  const nodes: ContentNode[] = [];
  series.forEach((s, order) => {
    s.values.forEach((value, index) => {
      if (value <= 0) return;
      const left = plot.centreAt(index) - (plot.band - gap * 2) / 2 + slot * order;
      const top = plot.yAt(value);
      nodes.push(
        element("rect", {
          x: round(left), y: round(top), width: round(slot),
          height: round(Math.max(0, plot.yAt(0) - top)),
          fill: s.color,
        }),
      );
    });
  });
  return nodes;
}

/** The `x,y` point list a line or area series runs through. */
function points(series: ResolvedSeries, plot: Plot): string {
  return series.values
    .map((value, index) => `${round(plot.centreAt(index))},${round(plot.yAt(value))}`)
    .join(" ");
}

/** Draws line and area series over whatever bars were already drawn. */
function linesAndAreas(series: ResolvedSeries[], plot: Plot): ContentNode[] {
  const nodes: ContentNode[] = [];
  const baseline = round(plot.yAt(0));
  for (const s of series) {
    if (s.values.length === 0) continue;
    if (s.type === "area") {
      const first = round(plot.centreAt(0));
      const last = round(plot.centreAt(s.values.length - 1));
      nodes.push(
        element("polygon", {
          points: `${first},${baseline} ${points(s, plot)} ${last},${baseline}`,
          fill: s.color,
          stroke: "none",
        }),
      );
    }
    nodes.push(
      element("polyline", {
        points: points(s, plot),
        fill: "none",
        stroke: s.color,
        "stroke-width": "2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );
    // Markers only where they would not crowd into a smear.
    if (s.values.length <= 31) {
      s.values.forEach((value, index) => {
        nodes.push(
          element("circle", {
            cx: round(plot.centreAt(index)), cy: round(plot.yAt(value)), r: "3", fill: s.color,
          }),
        );
      });
    }
  }
  return nodes;
}

/**
 * Assembles one series chart.
 *
 * @param params - the macro's parameters, for titles and sizing
 * @param data - the resolved axis and series
 * @param stack - true to stack bar series, false to group them
 * @param className - the chart-specific class on the wrapping div
 * @param fallbackTitle - the `aria-label` used when no title is given
 */
function render(
  params: MacroParams,
  data: SeriesData,
  stack: boolean,
  className: string,
  fallbackTitle: string,
): ContentNode {
  const title = scalar(params, "chart-title") ?? scalar(params, "title") ?? "";
  const bars = data.series.filter((s) => s.type === "bar");
  const overlays = data.series.filter((s) => s.type !== "bar");

  // The y axis must clear the tallest thing that will be DRAWN. Stacked
  // bars reach their column sum; grouped bars and line series reach
  // only their own peak, so scaling everything to the sum would flatten
  // an unstacked chart against the floor.
  const stackedPeak = stack
    ? data.labels.map((_, index) => bars.reduce((sum, s) => sum + Math.max(0, s.values[index]), 0))
    : bars.flatMap((s) => s.values);
  const highest = Math.max(0, ...stackedPeak, ...overlays.flatMap((s) => s.values));

  const plot = layout(params, data.labels.length, highest);
  const base = data.labels.map(() => 0);
  const marks = [
    ...(stack ? stackedBars(bars, plot, base) : groupedBars(bars, plot)),
    ...linesAndAreas(overlays, plot),
  ];

  const legend = legendNodes(
    data.series.map((s) => ({ label: s.label, color: s.color })),
    {
      x: plot.left,
      y: plot.top + plot.height + 52,
      columns: LEGEND_COLUMNS,
      columnWidth: LEGEND_COLUMN_WIDTH,
      rowHeight: LEGEND_ROW_HEIGHT,
    },
  );

  const width = plot.left + plot.width + 20;
  const svgHeight =
    plot.top + plot.height + 52 +
    legendRows(data.series.length, LEGEND_COLUMNS) * LEGEND_ROW_HEIGHT + 8;

  // Every plotted number as text, so the chart is readable without
  // seeing it — and so a test can assert on the values rather than on
  // the geometry that happens to express them.
  const summary = data.series
    .map((s) => `${s.label}: ${s.values.join(", ")}`)
    .join("; ");

  return element("div", { class: `macro chart ${className}` }, [
    element(
      "svg",
      {
        viewBox: `0 0 ${round(width)} ${round(svgHeight)}`,
        width: round(width),
        height: round(svgHeight),
        role: "img",
        "aria-label": title || fallbackTitle,
      },
      [
        element("desc", {}, [text(`${data.labels.join(", ")} — ${summary}`)]),
        ...yAxis(plot),
        ...xAxis(params, plot, data),
        ...marks,
        ...legend,
      ],
    ),
    ...(title ? [element("p", { class: "chart-title" }, [text(title)])] : []),
  ]);
}

/** The nodes shown when every series came back empty. */
function empty(className: string): ContentNode[] {
  return [
    element("div", { class: `macro chart ${className} empty` }, [
      text("No data matches this query."),
    ]),
  ];
}

/**
 * `{{ stacked-bar-chart series: [...] }}`
 *
 * Bars stacked per category, one segment per series.
 */
export const stackedBarChartMacro: MacroDefinition = {
  name: "stacked-bar-chart",
  expand(params, context) {
    const data = resolveSeriesData({
      params,
      context,
      defaultType: "bar",
      allowCombine: true,
    });
    if (data.labels.length === 0) return empty("stacked-bar-chart");
    return [render(params, data, true, "stacked-bar-chart", "Stacked bar chart")];
  },
};

/**
 * `{{ data-series-chart series: [...] }}`
 *
 * One independent line, area, or bar per series over a shared axis.
 * `combine` is refused: stacking is the other chart's job, and a
 * silently ignored `combine` here would draw a chart the author did not
 * ask for.
 */
export const dataSeriesChartMacro: MacroDefinition = {
  name: "data-series-chart",
  expand(params, context) {
    const defaultType = ((): "bar" | "line" | "area" => {
      const raw = scalar(params, "chart-type");
      if (raw === null || raw.trim() === "") return "line";
      const value = raw.trim().toLowerCase();
      if (value === "bar" || value === "line" || value === "area") return value;
      throw new MacroError("Parameter chart-type must be one of: line, area, bar.");
    })();

    const data = resolveSeriesData({
      params,
      context,
      defaultType,
      allowCombine: false,
    });
    if (data.labels.length === 0) return empty("data-series-chart");
    return [render(params, data, false, "data-series-chart", "Data series chart")];
  },
};
