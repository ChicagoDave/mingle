/**
 * Shared SVG building blocks for the chart macros (Phase 18, extended
 * in Phase 19).
 *
 * Purpose: the node builders, the number formatting, and the categorical
 * palette every server-rendered chart uses. Extracted when the second
 * chart module appeared: a palette copied into two modules is two
 * palettes the moment one of them is edited, and rule 7's "one reason
 * to change" cuts the other way for a constant that must look the same
 * in a pie chart and a history chart on the same page.
 *
 * What this module deliberately does NOT own is the allowlist
 * declaration. Each chart module declares the SVG surface IT emits
 * through `registerMacroElements`, so the declaration stays next to the
 * code it describes and no module silently inherits permission to emit
 * an element it never uses (ADR-0014).
 *
 * Public interface: `element`, `text`, `round`, `PALETTE`, `paletteColor`,
 * `parseColor`, `niceMax`, `axisLabel`, `legendNodes`, `legendRows`.
 *
 * Owner context: Wiki & Content.
 */
import type { ContentNode } from "~/domain/pages/content.server";

/**
 * Categorical colours. Chosen for distinguishability rather than brand:
 * a chart whose categories are only separable by hue fails any reader
 * who cannot separate them, so the palette also varies in lightness.
 */
export const PALETTE = [
  "#2f6fb2", "#e08214", "#4a9c56", "#c0504d", "#7b62a3",
  "#3f9fa5", "#b5892a", "#8a6d9e", "#5f7a8c", "#96632e",
];

/**
 * The palette colour for a series or slice index, wrapping around.
 *
 * @param index - zero-based position of the series
 */
export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * Reads an author-supplied colour.
 *
 * Only `#rgb` and `#rrggbb` are accepted. The serializer escapes
 * attribute values, so a bad colour cannot inject markup — but SVG
 * silently ignores an unparseable `fill`, which would leave a series
 * invisible with no explanation. Refusing is the honest failure.
 *
 * @param raw - the parameter text, or null/empty when not given
 * @param fallback - the colour to use when none was given
 * @returns a usable colour
 * @throws Error when a value was given but is not a hex colour
 */
export function parseColor(raw: string | null, fallback: string): string {
  if (raw === null || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
    throw new Error(`'${value}' is not a colour; use #rgb or #rrggbb.`);
  }
  return value;
}

/**
 * Builds an element node.
 *
 * @param tag - element name; must be one the module declared
 * @param attrs - attribute values, escaped at serialization
 * @param children - child nodes
 */
export function element(
  tag: string,
  attrs: Record<string, string>,
  children: ContentNode[] = [],
): ContentNode {
  return { kind: "element", tag, attrs, children };
}

/** Builds a text node. */
export function text(value: string): ContentNode {
  return { kind: "text", text: value };
}

/**
 * Rounds a coordinate to two decimals so path data stays readable and
 * stable across runs.
 */
export function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * A round-ish axis maximum at or above the largest plotted value.
 *
 * Extracted from the daily history chart when the series charts needed
 * the same scale: two charts on one page whose axes rounded differently
 * would invite a reader to compare heights that are not comparable.
 *
 * @param max - the largest value to be plotted
 * @returns a 1/2/5-times-a-power-of-ten bound, never below `max`, never 0
 */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const fraction = max / magnitude;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Formats an axis value, keeping whole numbers whole. */
export function axisLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toString();
}

/** Where a legend sits and how it wraps. */
export interface LegendLayout {
  x: number;
  y: number;
  /** Entries per row before wrapping. */
  columns: number;
  /** Horizontal distance between entries in a row. */
  columnWidth: number;
  /** Vertical distance between wrapped rows. */
  rowHeight: number;
}

/**
 * Builds a swatch-and-label legend.
 *
 * @param items - one entry per series or slice, in plotted order
 * @param layout - origin, wrap width, and spacing
 * @returns the swatch and text nodes, positioned absolutely
 */
export function legendNodes(
  items: { label: string; color: string }[],
  layout: LegendLayout,
): ContentNode[] {
  const nodes: ContentNode[] = [];
  items.forEach((item, index) => {
    const x = layout.x + (index % layout.columns) * layout.columnWidth;
    const y = layout.y + Math.floor(index / layout.columns) * layout.rowHeight;
    nodes.push(
      element("rect", {
        x: round(x), y: round(y - 8), width: "12", height: "12", rx: "2", fill: item.color,
      }),
    );
    nodes.push(
      element(
        "text",
        {
          x: round(x + 18), y: round(y), "font-size": "12", fill: "#222222",
          "dominant-baseline": "middle",
        },
        [text(item.label)],
      ),
    );
  });
  return nodes;
}

/** How many rows `legendNodes` will occupy for `count` entries. */
export function legendRows(count: number, columns: number): number {
  return Math.ceil(count / columns);
}
