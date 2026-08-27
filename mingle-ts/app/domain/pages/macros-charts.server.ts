/**
 * Chart macros — `{{ pie-chart }}` (Phase 17).
 *
 * Purpose: renders an MQL result set as a chart. The chart is inline
 * SVG built on the server, for the same reason Phase 16's editor mounts
 * over a real `<textarea>`: the page must render correctly with
 * scripting off. That also keeps ADR-0011 Decision 7 satisfiable —
 * an SVG chart is nodes in the content tree, so it passes the same
 * allowlist pass everything else does, rather than being a script that
 * writes markup after serialization.
 *
 * `<svg>` sits in the sanitizer's DROP_SUBTREE, because a page body a
 * team member typed has no business carrying one. `registerMacroElements`
 * is what lifts that for macro output only (ADR-0011's consequence
 * section asked for exactly this seam before Phase 17 edited the
 * allowlist in place). The declaration below is the whole SVG surface
 * these charts may emit — no `foreignObject`, no event attributes, no
 * `href` of any kind, so an SVG cannot become a script or a navigation.
 *
 * The expected query shape is a label column and a numeric column:
 *   `data: SELECT status, COUNT(*) WHERE type = Story GROUP BY status`
 *
 * Public interface: `pieChartMacro` — registered by
 * macros-registry.server, not by this module.
 *
 * Owner context: Wiki & Content, reading from Query.
 */
import { queryMqlProjection } from "~/domain/cards/mql-projection.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import { parseProjectMql } from "~/domain/cards/mql-schema.server";
import {
  registerMacroElements,
  type ContentNode,
} from "~/domain/pages/content.server";
import {
  element,
  paletteColor,
  round,
  text,
} from "~/domain/pages/chart-svg.server";
import {
  MacroError,
  type MacroContext,
  type MacroDefinition,
  type MacroParams,
} from "~/domain/pages/macros.server";

// The complete set of SVG this module may emit. Declared at import
// time so the allowlist is extended by declaration, never in place.
registerMacroElements({
  svg: ["viewBox", "width", "height", "role", "aria-label", "xmlns"],
  g: ["transform"],
  path: ["d", "fill", "stroke", "stroke-width"],
  circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
  rect: ["x", "y", "width", "height", "fill", "rx"],
  text: ["x", "y", "fill", "font-size", "text-anchor", "dominant-baseline"],
  desc: [],
});

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

/** One labelled slice. */
interface Slice {
  label: string;
  value: number;
}

/**
 * Runs the chart's `data` query and reduces it to labelled numbers.
 *
 * @param params - the macro's parameters; `data` is required
 * @param context - project and viewer
 * @returns one slice per result row, zero and negative values dropped
 * @throws MacroError when the query is missing, unparseable, or does
 *   not project exactly a label column and a numeric column
 */
function slices(params: MacroParams, context: MacroContext): Slice[] {
  const query = scalar(params, "data");
  if (!query) throw new MacroError("Need to specify data.");

  const parsed = parseProjectMql(context.db, context.projectId, query);
  if (!parsed.ok) throw new MacroError(parsed.errors.join(" "));

  let projection;
  try {
    projection = queryMqlProjection(context.db, context.projectId, parsed.query, {
      currentUserId: context.currentUserId,
      today: todayIso(),
    });
  } catch (error) {
    throw new MacroError(error instanceof Error ? error.message : String(error));
  }

  if (projection.columns.length !== 2) {
    throw new MacroError(
      `A pie chart needs a query selecting a label and a number, not ${projection.columns.length} columns.`,
    );
  }

  const found: Slice[] = [];
  for (const row of projection.rows) {
    const value = Number(row.cells[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    found.push({ label: row.cells[0] === "" ? "(not set)" : row.cells[0], value });
  }
  return found;
}

/** A point on the chart circle, with the SVG y axis running downward. */
function point(cx: number, cy: number, r: number, fraction: number): [number, number] {
  const angle = fraction * 2 * Math.PI - Math.PI / 2;
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

/**
 * `{{ pie-chart data: SELECT status, COUNT(*) GROUP BY status }}`
 *
 * Renders the result as an SVG pie with a legend. A single slice is
 * drawn as a circle rather than a path, because an arc spanning the
 * full turn has identical start and end points and degenerates.
 */
export const pieChartMacro: MacroDefinition = {
  name: "pie-chart",
  expand(params, context) {
    const data = slices(params, context);
    const title = scalar(params, "chart-title") ?? "";
    const radius = integer(params, "radius", 100);

    if (data.length === 0) {
      return [
        element("div", { class: "macro chart empty" }, [
          text("No data matches this query."),
        ]),
      ];
    }

    const total = data.reduce((sum, slice) => sum + slice.value, 0);
    const cx = radius + 10;
    const cy = radius + 10;
    const height = radius * 2 + 20;
    const legendWidth = 180;
    const width = cx + radius + 10 + legendWidth;

    const shapes: ContentNode[] = [];
    let cursor = 0;
    data.forEach((slice, index) => {
      const fill = paletteColor(index);
      const fraction = slice.value / total;
      if (data.length === 1) {
        shapes.push(
          element("circle", {
            cx: round(cx), cy: round(cy), r: round(radius), fill,
          }),
        );
      } else {
        const [x1, y1] = point(cx, cy, radius, cursor);
        const [x2, y2] = point(cx, cy, radius, cursor + fraction);
        const largeArc = fraction > 0.5 ? "1" : "0";
        shapes.push(
          element("path", {
            d: `M ${round(cx)} ${round(cy)} L ${round(x1)} ${round(y1)} A ${round(radius)} ${round(radius)} 0 ${largeArc} 1 ${round(x2)} ${round(y2)} Z`,
            fill,
            stroke: "#ffffff",
            "stroke-width": "1",
          }),
        );
      }
      cursor += fraction;
    });

    const legend: ContentNode[] = [];
    data.forEach((slice, index) => {
      const y = 16 + index * 22;
      const percent = Math.round((slice.value / total) * 100);
      legend.push(
        element("rect", {
          x: "0", y: round(y - 10), width: "12", height: "12", rx: "2",
          fill: paletteColor(index),
        }),
      );
      legend.push(
        element(
          "text",
          {
            x: "18", y: round(y),
            "font-size": "13", fill: "#222222",
            "dominant-baseline": "middle",
          },
          [text(`${slice.label} — ${slice.value} (${percent}%)`)],
        ),
      );
    });

    const legendHeight = 16 + data.length * 22;
    const svgHeight = Math.max(height, legendHeight + 10);
    const label = title || "Pie chart";

    return [
      element("div", { class: "macro chart pie-chart" }, [
        element(
          "svg",
          {
            viewBox: `0 0 ${round(width)} ${round(svgHeight)}`,
            width: round(width),
            height: round(svgHeight),
            role: "img",
            "aria-label": `${label}: ${data
              .map((slice) => `${slice.label} ${slice.value}`)
              .join(", ")}`,
          },
          [
            element("desc", {}, [
              text(
                data
                  .map((slice) => `${slice.label}: ${slice.value}`)
                  .join("; "),
              ),
            ]),
            ...shapes,
            element(
              "g",
              { transform: `translate(${round(cx + radius + 20)}, 10)` },
              legend,
            ),
          ],
        ),
        ...(title
          ? [element("p", { class: "chart-title" }, [text(title)])]
          : []),
      ]),
    ];
  },
};
