/**
 * MQL evaluator — translates a resolved MQL AST into a Drizzle SQL
 * predicate over `cards` × `card_property_values` (Phase 13).
 *
 * Purpose: the read side of MQL. Given a resolved `MqlCondition`
 * (ADR-0006: every column is a `PropertyRef`, every literal carries its
 * canonical stored form) it produces one SQL condition that a card row
 * satisfies, with the same unset semantics as the simple filters
 * (list-view.server): a managed property's value lives in a
 * `card_property_values` row or in no row at all, so `=`/ordinals are
 * `EXISTS (row matching)`, `!=` is `NOT EXISTS (row equal)` — unset
 * cards match `!=` — and `= NULL` / `!= NULL` are no-row / any-row.
 * Predefined properties compare against the `cards` columns directly
 * (Type through `card_types`, Created/Modified On as UTC dates of the
 * millisecond timestamps). Comparison casting follows
 * property-compare.server: numbers as REAL, dates/text as text (text
 * equality case-insensitive), enumerations by defined position.
 * `CURRENT USER` and `TODAY` bind from an explicit evaluation context.
 * Nested `IN (SELECT …)` becomes a correlated `IN (SELECT expr FROM
 * cards AS sub …)` so the whole query stays one SQL statement.
 *
 * Constructs the resolver rejects (trees, tags, plans, card numbers,
 * THIS CARD) can never reach here from parseMql; `THIS CARD.prop` does
 * resolve but has no context in a filter and is reported through
 * `conditionUsesThisCard` for callers to refuse up front.
 *
 * Public interface: `mqlCondition`, `queryCardsByMql`,
 * `conditionUsesThisCard`, `mqlExpressions`, `MqlEvaluationContext`,
 * `todayIso`.
 *
 * Owner context: Query (read model). Read-only — never writes.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, getTableName, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { cards, cardTypes } from "~/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import type {
  MqlCondition,
  MqlOperator,
  MqlQuery,
  MqlValue,
  PropertyRef,
} from "./mql.server";
import { comparisonKind, type ComparisonKind } from "./property-compare.server";

/** What the symbolic MQL values bind to at evaluation time. */
export interface MqlEvaluationContext {
  /** The viewing user's id; null (anonymous) makes CURRENT USER match nothing. */
  currentUserId: number | null;
  /** TODAY as ISO yyyy-mm-dd. */
  today: string;
}

/** Today's date as ISO yyyy-mm-dd (UTC). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The cards table or a nested-query alias of it. */
/** The `cards` table, or an alias of it inside a correlated sub-select. */
export type CardsRef = typeof cards | ReturnType<typeof alias<typeof cards, string>>;

/** How a resolved property's values compare (predefined kinds folded in). */
type CompareKind = ComparisonKind | "user" | "type";

/**
 * True when the condition references `THIS CARD.<property>` anywhere,
 * including inside nested queries — callers without a context card
 * (the MQL filter) must refuse such conditions rather than evaluate
 * them against nothing.
 *
 * @param condition - a resolved condition
 */
export function conditionUsesThisCard(condition: MqlCondition): boolean {
  switch (condition.type) {
    case "and":
    case "or":
      return conditionUsesThisCard(condition.left) || conditionUsesThisCard(condition.right);
    case "not":
      return conditionUsesThisCard(condition.operand);
    case "comparison":
      return condition.value.type === "thisCardProperty" || condition.value.type === "thisCard";
    case "in":
      return condition.values.some((v) => v.type === "thisCardProperty");
    case "inQuery":
      return condition.query.where ? conditionUsesThisCard(condition.query.where) : false;
    default:
      return false;
  }
}

class Evaluator {
  private definitions: Map<number, PropertyDefinitionRow> | null = null;
  private aliasCounter = 0;

  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly projectId: number,
    private readonly context: MqlEvaluationContext,
  ) {}

  // -- lookups ----------------------------------------------------------

  private definition(id: number): PropertyDefinitionRow {
    if (!this.definitions) {
      this.definitions = new Map(
        this.db
          .select()
          .from(propertyDefinitions)
          .where(eq(propertyDefinitions.projectId, this.projectId))
          .all()
          .map((d) => [d.id, d]),
      );
    }
    const row = this.definitions.get(id);
    if (!row) throw new Error(`MQL evaluator: property definition ${id} is not in project ${this.projectId}`);
    return row;
  }

  private compareKind(ref: PropertyRef): CompareKind {
    if (ref.source === "predefined") {
      switch (ref.key) {
        case "type":
          return "type";
        case "number":
          return "number";
        case "created_on":
        case "modified_on":
          return "date";
        default:
          return "text";
      }
    }
    if (ref.kind === "user") return "user";
    return comparisonKind(this.db, this.definition(ref.id));
  }

  // -- expressions ------------------------------------------------------

  /**
   * A scalar SQL expression for the property's stored value on `c`
   * (NULL when unset).
   *
   * Every reference to the outer `cards` row is written table-qualified
   * rather than left to Drizzle. Drizzle qualifies columns inside a
   * `sql` template in WHERE position but NOT in SELECT position, so an
   * unqualified `${c.id}` inside a correlated subquery renders as a
   * bare `"id"` in a select list — which SQLite happily resolves
   * against the SUBQUERY's own table. The result is a legal query that
   * silently reads another row's value. Qualifying makes the
   * expression mean the same thing in either clause, which is what
   * lets projection reuse the filters' translation at all.
   */
  valueExpr(ref: PropertyRef, c: CardsRef): SQL {
    const own = (column: { name: string }): SQL =>
      sql.raw(`"${getTableName(c)}"."${column.name}"`);
    if (ref.source === "defined") {
      return sql`(select ${cardPropertyValues.value} from ${cardPropertyValues} where ${cardPropertyValues.cardId} = ${own(c.id)} and ${cardPropertyValues.propertyDefinitionId} = ${ref.id})`;
    }
    switch (ref.key) {
      case "number":
        return own(c.number);
      case "name":
        return own(c.name);
      case "type":
        return sql`(select ${cardTypes.name} from ${cardTypes} where ${cardTypes.id} = ${own(c.cardTypeId)})`;
      case "created_on":
        return sql`date(${own(c.createdAt)} / 1000, 'unixepoch')`;
      case "modified_on":
        return sql`date(${own(c.updatedAt)} / 1000, 'unixepoch')`;
      case "project":
        throw new Error("MQL evaluator: Project is not a comparable property");
    }
  }

  /** Casts an expression for comparison under the given kind. */
  private cast(expr: SQL, kind: CompareKind, forEquality: boolean): SQL {
    switch (kind) {
      case "number":
        return sql`cast(${expr} as real)`;
      case "text":
      case "type":
      case "position":
        return forEquality ? sql`lower(${expr})` : expr;
      default:
        return expr;
    }
  }

  private operatorSql(op: MqlOperator): SQL {
    switch (op) {
      case "=":
        return sql`=`;
      case "!=":
        return sql`!=`;
      case "<":
        return sql`<`;
      case ">":
        return sql`>`;
      case "<=":
        return sql`<=`;
      case ">=":
        return sql`>=`;
    }
  }

  /**
   * `left <op> right` with kind-appropriate casting; `!=` is handled
   * by callers as the negation of `=`, so only `=` and ordinals arrive.
   */
  private compare(kind: CompareKind, left: SQL, op: Exclude<MqlOperator, "!=">, right: SQL, ref: PropertyRef): SQL {
    if (kind === "position" && op !== "=" && ref.source === "defined") {
      // Ordinal on an enumeration: rank both sides by defined position.
      const rank = (e: SQL) =>
        sql`(select ${enumerationValues.position} from ${enumerationValues} where ${enumerationValues.propertyDefinitionId} = ${ref.id} and lower(${enumerationValues.value}) = lower(${e}))`;
      return sql`${rank(left)} ${this.operatorSql(op)} ${rank(right)}`;
    }
    const forEquality = op === "=";
    return sql`${this.cast(left, kind, forEquality)} ${this.operatorSql(op)} ${this.cast(right, kind, forEquality)}`;
  }

  /**
   * Wraps a per-value predicate in the unset-aware shape: for a managed
   * property, EXISTS over its value rows (negated → NOT EXISTS, which
   * includes unset cards); for a predefined column, the predicate itself.
   */
  private withValue(ref: PropertyRef, c: CardsRef, negate: boolean, predicate: (value: SQL) => SQL): SQL {
    if (ref.source === "defined") {
      const inner = sql`select 1 from ${cardPropertyValues} where ${cardPropertyValues.cardId} = ${c.id} and ${cardPropertyValues.propertyDefinitionId} = ${ref.id} and ${predicate(sql`${cardPropertyValues.value}`)}`;
      return negate ? sql`not exists (${inner})` : sql`exists (${inner})`;
    }
    const p = predicate(this.valueExpr(ref, c));
    return negate ? sql`not (${p})` : p;
  }

  /** The SQL for the right-hand side of a comparison, or null when it is unset/NULL. */
  private rightExpr(value: MqlValue, c: CardsRef): SQL | null {
    switch (value.type) {
      case "literal":
        return sql`${value.canonical}`;
      case "projectVariable":
        return value.value === null ? null : sql`${value.value}`;
      case "today":
        return sql`${this.context.today}`;
      case "currentUser":
        return this.context.currentUserId === null ? null : sql`${String(this.context.currentUserId)}`;
      case "property":
        return this.valueExpr(value.column.property, c);
      case "null":
        return null;
      case "thisCardProperty":
      case "thisCard":
        throw new Error("THIS CARD is not supported in MQL filters.");
      case "cardNumber":
        throw new Error("MQL evaluator: card relationship properties are not available");
    }
  }

  // -- conditions -------------------------------------------------------

  condition(cond: MqlCondition, c: CardsRef): SQL {
    switch (cond.type) {
      case "and":
        return sql`(${this.condition(cond.left, c)} and ${this.condition(cond.right, c)})`;
      case "or":
        return sql`(${this.condition(cond.left, c)} or ${this.condition(cond.right, c)})`;
      case "not":
        return sql`not (${this.condition(cond.operand, c)})`;
      case "comparison":
        return this.comparison(cond.column.property, cond.operator, cond.value, c);
      case "in": {
        if (cond.byNumber) throw new Error("MQL evaluator: NUMBERS IN needs card relationship properties");
        const parts = cond.values.map((v) => this.comparison(cond.column.property, "=", v, c));
        return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` or `)})`;
      }
      case "inQuery":
        return this.inQuery(cond.column.property, cond.query, c);
      case "taggedWith":
        throw new Error("MQL evaluator: TAGGED WITH needs card tags");
      case "inPlan":
        throw new Error("MQL evaluator: IN PLAN needs program plans");
    }
  }

  private comparison(ref: PropertyRef, op: MqlOperator, value: MqlValue, c: CardsRef): SQL {
    const right = this.rightExpr(value, c);
    const isNullTest = value.type === "null";
    if (right === null) {
      // NULL, an unset project variable, or CURRENT USER without a user:
      // legacy IS NULL semantics for =/!=; ordinals against NULL match nothing.
      if (op === "=") {
        return isNullTest || value.type === "projectVariable"
          ? this.withValue(ref, c, true, () => sql`1 = 1`)
          : sql`1 = 0`;
      }
      if (op === "!=") {
        return isNullTest || value.type === "projectVariable"
          ? this.withValue(ref, c, false, () => sql`1 = 1`)
          : sql`1 = 1`;
      }
      return sql`1 = 0`;
    }
    const kind = this.compareKind(ref);
    if (op === "!=") {
      return this.withValue(ref, c, true, (v) => this.compare(kind, v, "=", right, ref));
    }
    return this.withValue(ref, c, false, (v) => this.compare(kind, v, op, right, ref));
  }

  private inQuery(ref: PropertyRef, query: MqlQuery, outer: CardsRef): SQL {
    const selected = query.select?.columns[0];
    if (!selected || selected.type !== "column") {
      throw new Error("MQL evaluator: a nested IN query must select exactly one property");
    }
    const sub = alias(cards, `mql_sub_${++this.aliasCounter}`);
    const kind = this.compareKind(ref);
    const subExpr = this.cast(this.valueExpr(selected.property, sub), kind, true);
    const where = query.where ? sql` and ${this.condition(query.where, sub)}` : sql``;
    const subquery = sql`select ${subExpr} from ${cards} as ${sub} where ${sub.projectId} = ${this.projectId}${where}`;
    return this.withValue(ref, outer, false, (v) => sql`${this.cast(v, kind, true)} in (${subquery})`);
  }

  /** ORDER BY expression for a property (numbers numeric, enumerations by position). */
  orderExpr(ref: PropertyRef, c: CardsRef): SQL {
    const kind = this.compareKind(ref);
    const value = this.valueExpr(ref, c);
    if (kind === "number") return sql`cast(${value} as real)`;
    if (kind === "position" && ref.source === "defined") {
      return sql`(select ${enumerationValues.position} from ${enumerationValues} where ${enumerationValues.propertyDefinitionId} = ${ref.id} and lower(${enumerationValues.value}) = lower(${value}))`;
    }
    return value;
  }
}

/**
 * Builds the SQL predicate a card row must satisfy for the condition.
 *
 * @param db - Drizzle handle (definitions and enumerations are read lazily)
 * @param projectId - the project the cards belong to
 * @param condition - a resolved MQL condition (from parseMql)
 * @param context - what CURRENT USER and TODAY bind to
 * @returns a predicate over the `cards` table, to AND into a card query
 * @throws Error naming the construct when the condition needs a model
 *   this Mingle does not have (THIS CARD, tags, trees, plans)
 */
export function mqlCondition(
  db: BetterSQLite3Database,
  projectId: number,
  condition: MqlCondition,
  context: MqlEvaluationContext,
): SQL {
  return new Evaluator(db, projectId, context).condition(condition, cards);
}

/** A row of an MQL card query result. */
export interface MqlCardRow {
  id: number;
  number: number;
  name: string;
  cardTypeName: string;
}

/**
 * Runs a resolved MQL query's WHERE and ORDER BY against the project's
 * cards. SELECT columns, GROUP BY, and AS OF are not applied here — the
 * chart and history macros (later phases) project on top of this.
 *
 * @param db - Drizzle handle
 * @param projectId - the project to query
 * @param query - a resolved query (from parseMql)
 * @param context - what CURRENT USER and TODAY bind to
 * @returns matching cards; ORDER BY as given, else newest number first
 */
export function queryCardsByMql(
  db: BetterSQLite3Database,
  projectId: number,
  query: MqlQuery,
  context: MqlEvaluationContext,
): MqlCardRow[] {
  const evaluator = new Evaluator(db, projectId, context);
  const where = query.where ? evaluator.condition(query.where, cards) : undefined;
  const order = query.orderBy?.length
    ? query.orderBy.map((o) => {
        const expr = evaluator.orderExpr(o.column.property, cards);
        return o.direction === "desc" ? desc(expr) : asc(expr);
      })
    : [desc(cards.number)];
  return db
    .select({
      id: cards.id,
      number: cards.number,
      name: cards.name,
      cardTypeName: cardTypes.name,
    })
    .from(cards)
    .innerJoin(cardTypes, eq(cardTypes.id, cards.cardTypeId))
    .where(and(eq(cards.projectId, projectId), where))
    .orderBy(...order)
    .all();
}

/**
 * The expression builder behind the filters, exposed so projection can
 * reuse it.
 *
 * SELECT columns, GROUP BY and aggregates are deliberately not
 * implemented here (see this module's header): they belong on top of
 * this translation, not inside it. What they must NOT do is re-derive
 * the unset semantics — a managed property's value living in a row or
 * in no row at all — because two translations of that rule drift, and
 * a filter and a table macro would then disagree about the same MQL.
 * ADR-0006 settled the parse for every consumer on that reasoning; the
 * builder is shared to carry it into SQL translation too (ADR-0014).
 *
 * @param db - Drizzle handle
 * @param projectId - the project whose cards and definitions apply
 * @param context - what CURRENT USER and TODAY bind to
 * @returns `condition` (a WHERE predicate), `valueExpr` (a property's
 *   scalar expression) and `orderExpr` (its ORDER BY expression), all
 *   over the `cards` reference passed in
 */
export function mqlExpressions(
  db: BetterSQLite3Database,
  projectId: number,
  context: MqlEvaluationContext,
): {
  condition: (cond: MqlCondition, c: CardsRef) => SQL;
  valueExpr: (ref: PropertyRef, c: CardsRef) => SQL;
  orderExpr: (ref: PropertyRef, c: CardsRef) => SQL;
} {
  const evaluator = new Evaluator(db, projectId, context);
  return {
    condition: (cond, c) => evaluator.condition(cond, c),
    valueExpr: (ref, c) => evaluator.valueExpr(ref, c),
    orderExpr: (ref, c) => evaluator.orderExpr(ref, c),
  };
}
