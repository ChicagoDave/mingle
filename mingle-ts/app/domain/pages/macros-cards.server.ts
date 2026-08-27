/**
 * Card-query macros — `{{ table }}` and `{{ value }}` (Phase 17).
 *
 * Purpose: renders an MQL result set into page content. `table`
 * projects rows into an HTML table, linking each row to its card when
 * the query selects `Number`; `value` renders a single cell, which is
 * how legacy pages show a count or a sum inline in a sentence.
 *
 * Both are read models: they parse the macro's `query` parameter
 * against the project's real schema and run it through the shared
 * projection, so a macro and a card-list filter answer the same MQL the
 * same way. Neither writes anything.
 *
 * Failures are refusals, not empty output. An unparseable query, an
 * unsupported clause, or a `value` query that returns more than one
 * cell each raise `MacroError` with the reason, which the framework
 * renders in place of the macro.
 *
 * Public interface: `tableMacro`, `valueMacro` — registered by
 * macros-registry.server, not by this module.
 *
 * Owner context: Wiki & Content, reading from Query.
 */
import { queryMqlProjection } from "~/domain/cards/mql-projection.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import { parseProjectMql } from "~/domain/cards/mql-schema.server";
import type { ContentNode } from "~/domain/pages/content.server";
import {
  MacroError,
  type MacroContext,
  type MacroDefinition,
  type MacroParams,
} from "~/domain/pages/macros.server";

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
 * Parses and projects a macro's `query` parameter.
 *
 * @param params - the macro's parameters; `query` is required
 * @param context - project and viewer
 * @param key - which parameter holds the query (`query` or `data`)
 * @returns the projected result set
 * @throws MacroError when the parameter is missing, cross-project, the
 *   MQL does not parse, or the query uses a clause with no backing model
 */
function project(params: MacroParams, context: MacroContext, key = "query") {
  if (scalar(params, "project")) {
    throw new MacroError(
      "Cross-project macros are not supported yet — remove the project parameter.",
    );
  }
  if (scalar(params, "view")) {
    throw new MacroError(
      "The view parameter is not supported yet — use a query instead.",
    );
  }
  const text = scalar(params, key);
  if (!text) throw new MacroError(`Need to specify ${key}.`);

  const parsed = parseProjectMql(context.db, context.projectId, text);
  if (!parsed.ok) throw new MacroError(parsed.errors.join(" "));

  try {
    return queryMqlProjection(context.db, context.projectId, parsed.query, {
      currentUserId: context.currentUserId,
      today: todayIso(),
    });
  } catch (error) {
    throw new MacroError(error instanceof Error ? error.message : String(error));
  }
}

/** Builds an element node. */
function element(
  tag: string,
  attrs: Record<string, string>,
  children: ContentNode[],
): ContentNode {
  return { kind: "element", tag, attrs, children };
}

/** Builds a text node. */
function text(value: string): ContentNode {
  return { kind: "text", text: value };
}

/**
 * `{{ table query: SELECT number, name WHERE type = Story }}`
 *
 * Renders the projection as a table. When the query selects `Number`,
 * each of that column's cells becomes a link to the card, which is the
 * behaviour legacy's `card_url_for` gives the same column.
 */
export const tableMacro: MacroDefinition = {
  name: "table",
  expand(params, context) {
    const { columns, rows } = project(params, context);

    const header = element("tr", {}, columns.map((column) =>
      element("th", { scope: "col" }, [text(column.label)]),
    ));

    const numberColumn = columns.findIndex(
      (column) => column.property?.source === "predefined" &&
        column.property.key === "number",
    );

    const body = rows.map((row) =>
      element("tr", {}, row.cells.map((cell, index) => {
        const attrs: Record<string, string> = columns[index].numeric
          ? { class: "numeric" }
          : {};
        if (index === numberColumn && row.cardNumber !== null) {
          return element("td", attrs, [
            element(
              "a",
              {
                href: `/projects/${context.projectIdentifier}/cards/${row.cardNumber}`,
                class: "card-link",
              },
              [text(cell)],
            ),
          ]);
        }
        return element("td", attrs, [text(cell)]);
      })),
    );

    if (rows.length === 0) {
      return [
        element("table", { class: "macro table" }, [
          element("thead", {}, [header]),
          element("tbody", {}, [
            element("tr", {}, [
              element(
                "td",
                { class: "empty", colspan: String(Math.max(columns.length, 1)) },
                [text("No cards match this query.")],
              ),
            ]),
          ]),
        ]),
      ];
    }

    return [
      element("table", { class: "macro table" }, [
        element("thead", {}, [header]),
        element("tbody", {}, body),
      ]),
    ];
  },
};

/**
 * `{{ value query: SELECT COUNT(*) WHERE status = Open }}`
 *
 * Renders one cell inline. Legacy uses this to drop a count or a sum
 * into a sentence, so the output is a `<span>`, not a block.
 */
export const valueMacro: MacroDefinition = {
  name: "value",
  expand(params, context) {
    const { columns, rows } = project(params, context);
    if (columns.length !== 1) {
      throw new MacroError(
        `The value macro needs a query selecting exactly one column, not ${columns.length}.`,
      );
    }
    if (rows.length > 1) {
      throw new MacroError(
        `The value macro needs a query returning one row, not ${rows.length}.`,
      );
    }
    const value = rows.length === 0 ? "" : rows[0].cells[0];
    return [element("span", { class: "macro value" }, [text(value)])];
  },
};
