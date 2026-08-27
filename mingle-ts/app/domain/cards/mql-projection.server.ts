/**
 * MQL projection — executes a resolved query's SELECT columns, GROUP
 * BY, aggregates and DISTINCT, producing display-ready rows (Phase 17).
 *
 * Purpose: the half of MQL that Phase 13 deliberately left undone. The
 * evaluator translates conditions; this projects results. It builds
 * every expression through `mqlExpressions`, so the unset semantics a
 * filter applies and the ones a table macro applies are the same
 * translation rather than two that agree today. Those semantics are
 * Phase 13's, stated in the evaluator's header — ADR-0006 governs the
 * parse (one resolved AST for every consumer, chart macros named among
 * them), and sharing the builder extends that principle to SQL
 * translation rather than restating a decision ADR-0006 made.
 *
 * Values come back as display text, not stored text: a user property
 * stores a user id and shows a name, and an unset value shows as the
 * empty string rather than the word "null". Resolution happens in one
 * query per result set, not one per cell.
 *
 * `AS OF` is not special-cased here either: it selects a different
 * `CardSource` (evaluator), so every expression below is built the same
 * way over the cards as they stood at the end of that day (Phase 18).
 * `FROM TREE` is still rejected rather than silently ignored — no tree
 * model exists yet, and refusing it explicitly is what keeps a macro
 * from quietly answering a different question than the one asked.
 *
 * Public interface: `queryMqlProjection`, `MqlProjection`,
 * `MqlProjectionColumn`, `MqlProjectionRow`.
 *
 * Owner context: Query (read model). Read-only — never writes.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, inArray, sql, type SQL } from "drizzle-orm";
import { users } from "~/db/schema/identity";
import {
  cardSourceFor,
  mqlExpressions,
  type MqlEvaluationContext,
} from "~/domain/cards/mql-evaluator.server";
import type {
  MqlQuery,
  MqlSelectColumn,
  PropertyRef,
} from "~/domain/cards/mql.server";

/** One projected column: its header and the property behind it, if any. */
export interface MqlProjectionColumn {
  /** Header text, as legacy shows it — the property or function name. */
  label: string;
  /** The property projected, or null for an aggregate over rows. */
  property: PropertyRef | null;
  /** True when the column holds a number, so callers can align it right. */
  numeric: boolean;
}

/** One projected row. */
export interface MqlProjectionRow {
  /** Display text per column, positionally matching `columns`. */
  cells: string[];
  /**
   * The card this row came from, when the query projects plain columns
   * of single cards. Null under GROUP BY or aggregation, where a row is
   * not one card. Callers use it to link a row to its card.
   */
  cardNumber: number | null;
}

/** A projected result set. */
export interface MqlProjection {
  columns: MqlProjectionColumn[];
  rows: MqlProjectionRow[];
}

/** Aggregate functions, lower-cased, as the parser resolves them. */
const AGGREGATES = new Set(["avg", "count", "max", "min", "sum"]);

/** True when the column is an aggregate rather than a plain property. */
function isAggregate(column: MqlSelectColumn): boolean {
  return column.type === "aggregate";
}

/** The header legacy shows for a select column. */
function columnLabel(column: MqlSelectColumn): string {
  if (column.type === "column") return column.property.name;
  const inner = column.column ? column.column.property.name : "*";
  return `${column.fn.toUpperCase()}(${inner})`;
}

/** True when a projected column should read as a number. */
function columnIsNumeric(column: MqlSelectColumn): boolean {
  if (column.type === "aggregate") return true;
  const kind = column.property.kind;
  return kind === "number" || kind === "formula";
}

/**
 * Projects an MQL result set.
 *
 * @param db - Drizzle handle
 * @param projectId - the project whose cards are queried
 * @param query - a resolved query (from parseMql) carrying SELECT columns
 * @param context - what CURRENT USER and TODAY bind to
 * @returns the projected columns and their display-ready rows
 * @throws Error when the query has no SELECT clause, or uses `FROM
 *   TREE`, which this rewrite cannot answer yet
 */
export function queryMqlProjection(
  db: BetterSQLite3Database,
  projectId: number,
  query: MqlQuery,
  context: MqlEvaluationContext,
): MqlProjection {
  if (!query.select || query.select.columns.length === 0) {
    throw new Error(
      "This query needs SELECT columns, for example: SELECT number, name WHERE type = Story",
    );
  }
  if (query.from?.trees?.length) {
    throw new Error("FROM TREE is not supported yet.");
  }

  const expressions = mqlExpressions(db, projectId, context);
  const source = cardSourceFor(query);
  const selectColumns = query.select.columns;
  const aggregated =
    selectColumns.some(isAggregate) || (query.groupBy?.length ?? 0) > 0;

  const columns: MqlProjectionColumn[] = selectColumns.map((column) => ({
    label: columnLabel(column),
    property: column.type === "column" ? column.property : null,
    numeric: columnIsNumeric(column),
  }));

  // Build one selection expression per projected column. A row is one
  // card only when nothing aggregates or groups, which is the same
  // condition that decides whether `cardNumber` is meaningful.
  const selection: Record<string, SQL> = {};
  selectColumns.forEach((column, index) => {
    selection[`c${index}`] =
      column.type === "column"
        ? expressions.valueExpr(column.property, source)
        : aggregateExpr(column, expressions.valueExpr(
            column.column ? column.column.property : { source: "predefined", key: "number", name: "Number", kind: "number" },
            source,
          ));
  });
  if (!aggregated) selection.__number = sql<number>`${source.number}`;

  const where = query.where
    ? expressions.condition(query.where, source)
    : undefined;

  let statement = (
    query.select.distinct && !aggregated
      ? db.selectDistinct(selection)
      : db.select(selection)
  )
    .from(source.table)
    .where(and(source.scope(projectId), where))
    .$dynamic();

  if (query.groupBy?.length) {
    // Group by the same expression the column projects. Two calls to
    // `valueExpr` render identical SQL text, which is what lets SQLite
    // match the grouped expression to the projected one.
    //
    // Not an ordinal: SQLite honours `GROUP BY <n>` as a positional
    // reference only in ORDER BY. In GROUP BY an integer literal is a
    // constant, so `GROUP BY 1` collapses every row into ONE group
    // while still returning a plausible count — a wrong answer that
    // looks like a right one.
    statement = statement.groupBy(
      ...query.groupBy.map((column) =>
        expressions.valueExpr(column.property, source),
      ),
    );
  }
  if (query.orderBy?.length) {
    statement = statement.orderBy(
      ...query.orderBy.map((entry) => {
        const expr = expressions.orderExpr(entry.column.property, source);
        return entry.direction === "desc" ? desc(expr) : asc(expr);
      }),
    );
  } else if (!aggregated) {
    statement = statement.orderBy(asc(source.number));
  }

  const raw = statement.all() as Record<string, unknown>[];
  return {
    columns,
    rows: toDisplayRows(db, columns, selectColumns, raw, aggregated),
  };
}

/** Wraps a column expression in its aggregate function. */
function aggregateExpr(column: MqlSelectColumn, inner: SQL): SQL {
  if (column.type !== "aggregate") return inner;
  const fn = column.fn.toLowerCase();
  if (!AGGREGATES.has(fn)) {
    throw new Error(`Unsupported aggregate function: ${column.fn}`);
  }
  if (fn === "count") {
    return column.column ? sql`count(${inner})` : sql`count(*)`;
  }
  // Numeric aggregates cast through REAL for the same reason the
  // comparison path does: stored property values are text.
  const numeric = sql`cast(${inner} as real)`;
  switch (fn) {
    case "sum":
      return sql`sum(${numeric})`;
    case "avg":
      return sql`avg(${numeric})`;
    case "min":
      return sql`min(${numeric})`;
    default:
      return sql`max(${numeric})`;
  }
}

/**
 * Turns raw SQL rows into display text, resolving user ids to names in
 * one query rather than one per cell.
 */
function toDisplayRows(
  db: BetterSQLite3Database,
  columns: MqlProjectionColumn[],
  selectColumns: MqlSelectColumn[],
  raw: Record<string, unknown>[],
  aggregated: boolean,
): MqlProjectionRow[] {
  const userColumnIndexes = columns
    .map((column, index) => (column.property?.kind === "user" ? index : -1))
    .filter((index) => index >= 0);

  const userNames = new Map<number, string>();
  if (userColumnIndexes.length > 0) {
    const ids = new Set<number>();
    for (const row of raw) {
      for (const index of userColumnIndexes) {
        const value = row[`c${index}`];
        if (value !== null && value !== undefined && `${value}` !== "") {
          const id = Number(value);
          if (Number.isFinite(id)) ids.add(id);
        }
      }
    }
    if (ids.size > 0) {
      for (const user of db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, [...ids]))
        .all()) {
        userNames.set(user.id, user.name);
      }
    }
  }

  return raw.map((row) => ({
    cardNumber: aggregated ? null : Number(row.__number ?? 0) || null,
    cells: selectColumns.map((_column, index) => {
      const value = row[`c${index}`];
      if (value === null || value === undefined) return "";
      if (userColumnIndexes.includes(index)) {
        const id = Number(value);
        return userNames.get(id) ?? `${value}`;
      }
      return `${value}`;
    }),
  }));
}
