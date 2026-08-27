/**
 * MQL evaluator — translates a resolved MQL AST into a Drizzle SQL
 * predicate over a relation of card states (Phase 13; generalized over
 * that relation in Phase 18).
 *
 * Purpose: the read side of MQL. Given a resolved `MqlCondition`
 * (ADR-0006: every column is a `PropertyRef`, every literal carries its
 * canonical stored form) it produces one SQL condition that a card
 * satisfies, with the same unset semantics as the simple filters
 * (list-view.server): a managed property's value is present or absent,
 * so `=`/ordinals require a present value, `!=` is the negation of
 * "present and equal" — unset cards match `!=` — and `= NULL` /
 * `!= NULL` are absent / present. Predefined properties compare
 * against the card's own columns (Created/Modified On as UTC dates of
 * the millisecond timestamps). Comparison casting follows
 * property-compare.server: numbers as REAL, dates/text as text (text
 * equality case-insensitive), enumerations by defined position.
 * `CURRENT USER` and `TODAY` bind from an explicit evaluation context.
 * Nested `IN (SELECT …)` becomes a correlated `IN (SELECT expr FROM
 * <same relation> AS sub …)` so the whole query stays one statement.
 *
 * WHERE a card's state is read from is the one dimension that varies
 * and it is a parameter, never a branch inside the condition walker: a
 * `CardSource` is either the live `cards` row (`currentCards`) or the
 * card's reconstructed state at the end of a given day, read from
 * `card_versions` (`cardsAsOf`, which is what `AS OF` compiles to).
 * Both sources implement the SAME unset rule; that identity is the
 * whole reason this module exists, so a second translation of it must
 * never be written elsewhere.
 *
 * Constructs the resolver rejects (trees, tags, plans, card numbers,
 * THIS CARD) can never reach here from parseMql; `THIS CARD.prop` does
 * resolve but has no context in a filter and is reported through
 * `conditionUsesThisCard` for callers to refuse up front.
 *
 * Public interface: `mqlCondition`, `queryCardsByMql`,
 * `conditionUsesThisCard`, `mqlExpressions`, `currentCards`,
 * `cardsAsOf`, `cardSourceFor`, `CardSource`, `MqlEvaluationContext`,
 * `todayIso`.
 *
 * Owner context: Query (read model). Read-only — never writes.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, getTableName, sql, type SQL } from "drizzle-orm";
import { alias, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { cards, cardTypes, cardVersions } from "~/db/schema/cards";
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

// ------------------------------------------------------- card sources

/**
 * A qualified `"relation"."column"` reference.
 *
 * Always qualified, never left to Drizzle. Drizzle qualifies columns
 * inside a `sql` template in WHERE position but NOT in SELECT position,
 * so an unqualified column inside a correlated subquery renders as a
 * bare name in a select list — which SQLite happily resolves against
 * the SUBQUERY's own table. The result is a legal query that silently
 * reads another row's value. Qualifying makes an expression mean the
 * same thing in either clause, which is what lets projection reuse the
 * filters' translation at all.
 */
function col(relation: string, column: { name: string }): SQL {
  return sql.raw(`"${relation}"."${column.name}"`);
}

/**
 * One relation of card states: the live cards, or the cards as they
 * stood at the end of some day.
 *
 * Implementations differ only in where a value comes from. They must
 * NOT differ in the unset semantics `withValue` encodes — a filter and
 * a history chart disagreeing about what `!=` means on an unset
 * property is exactly the drift this interface exists to prevent.
 */
export interface CardSource {
  /** The relation to select FROM, as a Drizzle table (possibly aliased). */
  readonly table: SQLiteTable;
  /** The same relation as a FROM fragment, for embedding in a template. */
  readonly fromSql: SQL;
  /** The id of the card behind a row (not the row's own id). */
  readonly cardId: SQL;
  /** The card's per-project number on this row. */
  readonly number: SQL;
  /** The card's name on this row. */
  readonly name: SQL;
  /** The card's type name on this row. */
  readonly cardTypeName: SQL;
  /** Confines the relation to one project — and, historically, to one day. */
  scope(projectId: number): SQL;
  /** The property's stored value on this row; NULL when unset. */
  value(ref: PropertyRef): SQL;
  /**
   * Wraps a per-value predicate in the unset-aware shape: a managed
   * property must have a value for the predicate to hold, and negating
   * therefore includes cards with no value at all.
   */
  withValue(
    ref: PropertyRef,
    negate: boolean,
    predicate: (value: SQL) => SQL,
  ): SQL;
  /** A distinct alias of the same relation, for a nested IN (SELECT …). */
  aliased(suffix: string): CardSource;
}

/** The `cards` table, or an alias of it inside a correlated sub-select. */
type CardsRelation =
  | typeof cards
  | ReturnType<typeof alias<typeof cards, string>>;

/** The `card_versions` table, or an alias of it. */
type VersionsRelation = ReturnType<typeof alias<typeof cardVersions, string>>;

/** The live `cards` row — what every query that is not `AS OF` reads. */
class CurrentCards implements CardSource {
  private readonly relationName: string;

  constructor(private readonly relation: CardsRelation = cards) {
    this.relationName = getTableName(relation);
  }

  get table(): SQLiteTable {
    return this.relation;
  }

  get fromSql(): SQL {
    return this.relationName === getTableName(cards)
      ? sql`${cards}`
      : sql`${cards} as ${this.relation}`;
  }

  get cardId(): SQL {
    return col(this.relationName, cards.id);
  }

  get number(): SQL {
    return col(this.relationName, cards.number);
  }

  get name(): SQL {
    return col(this.relationName, cards.name);
  }

  get cardTypeName(): SQL {
    return sql`(select ${cardTypes.name} from ${cardTypes} where ${cardTypes.id} = ${col(this.relationName, cards.cardTypeId)})`;
  }

  scope(projectId: number): SQL {
    return sql`${col(this.relationName, cards.projectId)} = ${projectId}`;
  }

  value(ref: PropertyRef): SQL {
    if (ref.source === "defined") {
      return sql`(select ${cardPropertyValues.value} from ${cardPropertyValues} where ${cardPropertyValues.cardId} = ${this.cardId} and ${cardPropertyValues.propertyDefinitionId} = ${ref.id})`;
    }
    switch (ref.key) {
      case "number":
        return this.number;
      case "name":
        return this.name;
      case "type":
        return this.cardTypeName;
      case "created_on":
        return sql`date(${col(this.relationName, cards.createdAt)} / 1000, 'unixepoch')`;
      case "modified_on":
        return sql`date(${col(this.relationName, cards.updatedAt)} / 1000, 'unixepoch')`;
      case "project":
        throw new Error("MQL evaluator: Project is not a comparable property");
    }
  }

  withValue(
    ref: PropertyRef,
    negate: boolean,
    predicate: (value: SQL) => SQL,
  ): SQL {
    if (ref.source === "defined") {
      const inner = sql`select 1 from ${cardPropertyValues} where ${cardPropertyValues.cardId} = ${this.cardId} and ${cardPropertyValues.propertyDefinitionId} = ${ref.id} and ${predicate(sql`${cardPropertyValues.value}`)}`;
      return negate ? sql`not exists (${inner})` : sql`exists (${inner})`;
    }
    const p = predicate(this.value(ref));
    return negate ? sql`not (${p})` : p;
  }

  aliased(suffix: string): CardSource {
    return new CurrentCards(alias(cards, suffix));
  }
}

/**
 * The card as it stood at the end of one day, reconstructed from
 * `card_versions`.
 *
 * The relation is each card's highest version created strictly before
 * the start of the following day (UTC), which is legacy's `AS OF` join
 * — `MAX(version) WHERE updated_at < beginning_of_tomorrow` — with one
 * deliberate divergence. Legacy inner-joins the live `cards` table
 * inside that subquery, so a card deleted *after* the as-of date
 * silently vanishes from its own history. This schema keeps versions on
 * delete and marks the final one `is_deletion` precisely so history can
 * be read without the current state; excluding the deletion version
 * puts a card in every day up to the day it was deleted and out of
 * every day after, which is the question the caller actually asked.
 */
class CardsAsOf implements CardSource {
  private readonly relationName: string;

  constructor(
    /** Exclusive upper bound in epoch milliseconds — the start of the next day. */
    private readonly cutoffMs: number,
    private readonly relation: VersionsRelation = alias(cardVersions, "mql_as_of"),
  ) {
    this.relationName = getTableName(relation);
  }

  get table(): SQLiteTable {
    return this.relation;
  }

  get fromSql(): SQL {
    return sql`${cardVersions} as ${this.relation}`;
  }

  get cardId(): SQL {
    return col(this.relationName, cardVersions.cardId);
  }

  get number(): SQL {
    return col(this.relationName, cardVersions.number);
  }

  get name(): SQL {
    return col(this.relationName, cardVersions.name);
  }

  get cardTypeName(): SQL {
    return col(this.relationName, cardVersions.cardTypeName);
  }

  scope(projectId: number): SQL {
    const latest = sql`(select max(${cardVersions.version}) from ${cardVersions} where ${cardVersions.cardId} = ${this.cardId} and ${cardVersions.createdAt} < ${this.cutoffMs})`;
    return sql`${col(this.relationName, cardVersions.projectId)} = ${projectId} and ${col(this.relationName, cardVersions.isDeletion)} = 0 and ${col(this.relationName, cardVersions.createdAt)} < ${this.cutoffMs} and ${col(this.relationName, cardVersions.version)} = ${latest}`;
  }

  value(ref: PropertyRef): SQL {
    if (ref.source === "defined") {
      // The snapshot is keyed by property definition id (ADR-0004) and
      // holds the same canonical stored text `card_property_values`
      // does, so every comparison below casts identically either way.
      return sql`json_extract(${col(this.relationName, cardVersions.propertyValues)}, ${`$."${ref.id}"`})`;
    }
    switch (ref.key) {
      case "number":
        return this.number;
      case "name":
        return this.name;
      case "type":
        return this.cardTypeName;
      case "created_on":
        // A version row's own timestamp is when THAT state began; the
        // card's creation is its first version.
        return sql`(select date(min(${cardVersions.createdAt}) / 1000, 'unixepoch') from ${cardVersions} where ${cardVersions.cardId} = ${this.cardId})`;
      case "modified_on":
        return sql`date(${col(this.relationName, cardVersions.createdAt)} / 1000, 'unixepoch')`;
      case "project":
        throw new Error("MQL evaluator: Project is not a comparable property");
    }
  }

  withValue(
    ref: PropertyRef,
    negate: boolean,
    predicate: (value: SQL) => SQL,
  ): SQL {
    if (ref.source === "defined") {
      // The same rule CurrentCards spells as EXISTS/NOT EXISTS: a
      // missing key is an unset property, so the predicate needs a
      // present value and negating it admits the absent ones.
      const value = this.value(ref);
      const present = sql`(${value} is not null and ${predicate(value)})`;
      return negate ? sql`not ${present}` : present;
    }
    const p = predicate(this.value(ref));
    return negate ? sql`not (${p})` : p;
  }

  aliased(suffix: string): CardSource {
    return new CardsAsOf(this.cutoffMs, alias(cardVersions, suffix));
  }
}

/** The live cards — the source every non-historical query reads. */
export function currentCards(): CardSource {
  return new CurrentCards();
}

/**
 * The cards as they stood at the end of the given day (UTC).
 *
 * @param date - ISO yyyy-mm-dd, as `AS OF` resolves it
 * @returns a source reading `card_versions`
 * @throws Error when the date is not a valid ISO calendar date
 */
export function cardsAsOf(date: string): CardSource {
  const cutoff = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(cutoff)) {
    throw new Error(`AS OF requires a date in yyyy-mm-dd format; '${date}' is not one.`);
  }
  // Exclusive upper bound: the start of the following day, so the whole
  // as-of day counts (legacy's `beginning_of_tomorrow`).
  return new CardsAsOf(cutoff + 24 * 60 * 60 * 1000);
}

/**
 * The source a resolved query reads from.
 *
 * @param query - a resolved query; only its `asOf` matters here
 * @returns the historical source when the query says AS OF, else the live one
 */
export function cardSourceFor(query: MqlQuery): CardSource {
  return query.asOf ? cardsAsOf(query.asOf) : currentCards();
}

// -------------------------------------------------------- translation

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

  /** A scalar SQL expression for the property's stored value (NULL when unset). */
  valueExpr(ref: PropertyRef, source: CardSource): SQL {
    return source.value(ref);
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

  /** The SQL for the right-hand side of a comparison, or null when it is unset/NULL. */
  private rightExpr(value: MqlValue, source: CardSource): SQL | null {
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
        return source.value(value.column.property);
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

  condition(cond: MqlCondition, source: CardSource): SQL {
    switch (cond.type) {
      case "and":
        return sql`(${this.condition(cond.left, source)} and ${this.condition(cond.right, source)})`;
      case "or":
        return sql`(${this.condition(cond.left, source)} or ${this.condition(cond.right, source)})`;
      case "not":
        return sql`not (${this.condition(cond.operand, source)})`;
      case "comparison":
        return this.comparison(cond.column.property, cond.operator, cond.value, source);
      case "in": {
        if (cond.byNumber) throw new Error("MQL evaluator: NUMBERS IN needs card relationship properties");
        const parts = cond.values.map((v) => this.comparison(cond.column.property, "=", v, source));
        return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` or `)})`;
      }
      case "inQuery":
        return this.inQuery(cond.column.property, cond.query, source);
      case "taggedWith":
        throw new Error("MQL evaluator: TAGGED WITH needs card tags");
      case "inPlan":
        throw new Error("MQL evaluator: IN PLAN needs program plans");
    }
  }

  private comparison(ref: PropertyRef, op: MqlOperator, value: MqlValue, source: CardSource): SQL {
    const right = this.rightExpr(value, source);
    const isNullTest = value.type === "null";
    if (right === null) {
      // NULL, an unset project variable, or CURRENT USER without a user:
      // legacy IS NULL semantics for =/!=; ordinals against NULL match nothing.
      if (op === "=") {
        return isNullTest || value.type === "projectVariable"
          ? source.withValue(ref, true, () => sql`1 = 1`)
          : sql`1 = 0`;
      }
      if (op === "!=") {
        return isNullTest || value.type === "projectVariable"
          ? source.withValue(ref, false, () => sql`1 = 1`)
          : sql`1 = 1`;
      }
      return sql`1 = 0`;
    }
    const kind = this.compareKind(ref);
    if (op === "!=") {
      return source.withValue(ref, true, (v) => this.compare(kind, v, "=", right, ref));
    }
    return source.withValue(ref, false, (v) => this.compare(kind, v, op, right, ref));
  }

  private inQuery(ref: PropertyRef, query: MqlQuery, outer: CardSource): SQL {
    const selected = query.select?.columns[0];
    if (!selected || selected.type !== "column") {
      throw new Error("MQL evaluator: a nested IN query must select exactly one property");
    }
    if (query.asOf) {
      // Legacy refuses this by name (card_query.rb). Two as-of dates in
      // one condition is not a question with an answer, and inheriting
      // the outer one instead would silently discard what was written.
      throw new Error("AS OF is not allowed in a nested IN clause.");
    }
    // The nested query reads the SAME relation as the outer one: under
    // AS OF, "in (select … )" must mean "as it stood that day" too, or
    // the two halves of one condition answer questions about different
    // points in time.
    const sub = outer.aliased(`mql_sub_${++this.aliasCounter}`);
    const kind = this.compareKind(ref);
    const subExpr = this.cast(sub.value(selected.property), kind, true);
    const where = query.where ? sql` and ${this.condition(query.where, sub)}` : sql``;
    const subquery = sql`select ${subExpr} from ${sub.fromSql} where ${sub.scope(this.projectId)}${where}`;
    return outer.withValue(ref, false, (v) => sql`${this.cast(v, kind, true)} in (${subquery})`);
  }

  /** ORDER BY expression for a property (numbers numeric, enumerations by position). */
  orderExpr(ref: PropertyRef, source: CardSource): SQL {
    const kind = this.compareKind(ref);
    const value = source.value(ref);
    if (kind === "number") return sql`cast(${value} as real)`;
    if (kind === "position" && ref.source === "defined") {
      return sql`(select ${enumerationValues.position} from ${enumerationValues} where ${enumerationValues.propertyDefinitionId} = ${ref.id} and lower(${enumerationValues.value}) = lower(${value}))`;
    }
    return value;
  }
}

/**
 * Builds the SQL predicate a live card row must satisfy for the condition.
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
  return new Evaluator(db, projectId, context).condition(condition, currentCards());
}

/** A row of an MQL card query result. */
export interface MqlCardRow {
  id: number;
  number: number;
  name: string;
  cardTypeName: string;
}

/**
 * Runs a resolved MQL query's WHERE, AS OF and ORDER BY against the
 * project's cards. SELECT columns and GROUP BY are not applied here —
 * mql-projection projects on top of this.
 *
 * @param db - Drizzle handle
 * @param projectId - the project to query
 * @param query - a resolved query (from parseMql)
 * @param context - what CURRENT USER and TODAY bind to
 * @returns matching cards; ORDER BY as given, else newest number first.
 *   Under AS OF, `id` is the card's id and the rest is that day's state.
 */
export function queryCardsByMql(
  db: BetterSQLite3Database,
  projectId: number,
  query: MqlQuery,
  context: MqlEvaluationContext,
): MqlCardRow[] {
  const evaluator = new Evaluator(db, projectId, context);
  const source = cardSourceFor(query);
  const where = query.where ? evaluator.condition(query.where, source) : undefined;
  const order = query.orderBy?.length
    ? query.orderBy.map((o) => {
        const expr = evaluator.orderExpr(o.column.property, source);
        return o.direction === "desc" ? desc(expr) : asc(expr);
      })
    : [desc(source.number)];
  return db
    .select({
      id: sql<number>`${source.cardId}`,
      number: sql<number>`${source.number}`,
      name: sql<string>`${source.name}`,
      cardTypeName: sql<string>`${source.cardTypeName}`,
    })
    .from(source.table)
    .where(and(source.scope(projectId), where))
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
 * the unset semantics — a managed property's value being present or
 * absent — because two translations of that rule drift, and a filter
 * and a table macro would then disagree about the same MQL. ADR-0006
 * settled the parse for every consumer on that reasoning; the builder
 * is shared to carry it into SQL translation too (ADR-0014). Phase 18
 * extends the same argument to time: `AS OF` changes the source the
 * expressions are built over, not the expressions.
 *
 * @param db - Drizzle handle
 * @param projectId - the project whose cards and definitions apply
 * @param context - what CURRENT USER and TODAY bind to
 * @returns `condition` (a WHERE predicate), `valueExpr` (a property's
 *   scalar expression) and `orderExpr` (its ORDER BY expression), all
 *   over the `CardSource` passed in
 */
export function mqlExpressions(
  db: BetterSQLite3Database,
  projectId: number,
  context: MqlEvaluationContext,
): {
  condition: (cond: MqlCondition, source: CardSource) => SQL;
  valueExpr: (ref: PropertyRef, source: CardSource) => SQL;
  orderExpr: (ref: PropertyRef, source: CardSource) => SQL;
} {
  const evaluator = new Evaluator(db, projectId, context);
  return {
    condition: (cond, source) => evaluator.condition(cond, source),
    valueExpr: (ref, source) => evaluator.valueExpr(ref, source),
    orderExpr: (ref, source) => evaluator.orderExpr(ref, source),
  };
}
