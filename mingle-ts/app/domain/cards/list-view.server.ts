/**
 * Card list view — filter/column parsing, validation, and the card
 * list query (Phase 9).
 *
 * Purpose: the CardListView read model. Decodes the legacy-encoded
 * `filters[]` parameter (`[Property][operator][value]`, filters.rb
 * ENCODED_FORM), validates each filter against the project's actual
 * property definitions and the legacy per-kind operator vocabulary,
 * and turns the valid set into one SQL condition over `cards` ×
 * `card_property_values` with the legacy combination semantics:
 * filters are grouped per property (case-insensitively); within a
 * group, equality filters OR together and non-equality filters AND
 * together (the two halves ORed when both exist — filters.rb
 * FilterGroup#as_query); groups AND across properties. "(not set)"
 * is encoded as the empty value: `is` (not set) matches cards with no
 * value row, `is not X` matches unset cards too (legacy
 * `col <> v OR col IS NULL`), and ordinal operators reject (not set).
 * Ordinal comparisons follow the property kind: numeric for number
 * and number-valued formulas, ISO-lexical for dates and date-valued
 * formulas, defined-position order for enumerated values.
 *
 * Public interface: `parseFilterString`, `encodeFilterString`,
 * `buildCardListView`, `queryCardList`, and the `CardListFilter` /
 * `CardListColumn` / `CardListView` types. Read-only — this module
 * never writes; commands live in commands.server / properties.server.
 *
 * Owner context: Card Management (read model).
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { cards, cardTypes } from "~/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import {
  CARD_TYPE_COLUMN_NAME,
  FILTER_OPERATORS,
  filterOperatorsFor,
  type FilterOperator,
  type PropertyKind,
} from "~/shared/wire-types";
import { comparisonKind } from "./property-compare.server";
import type { MqlCondition } from "./mql.server";
import { parseProjectMql } from "./mql-schema.server";
import {
  conditionUsesThisCard,
  mqlCondition,
  type MqlEvaluationContext,
} from "./mql-evaluator.server";

// The card type pseudo-property's display name is a wire constant —
// the browser needs the same string this module filters on — so it is
// defined in wire-types and re-exported here for server-side callers.
export { CARD_TYPE_COLUMN_NAME };

/** Legacy filters.rb ENCODED_FORM: `[property][operator][value]`. */
const ENCODED_FORM = /^\[([^\]]*?)\]\[([^\]]*?)\]\[(.*?)\]$/;

/**
 * Operator aliases accepted when decoding (legacy Operator.parse):
 * symbols and the date display names map onto the canonical vocabulary.
 */
const OPERATOR_ALIASES: Record<string, FilterOperator> = {
  "=": "is",
  "!=": "is not",
  "<": "is less than",
  ">": "is greater than",
  "is before": "is less than",
  "is after": "is greater than",
};

/** A decoded (but not yet validated) `filters[]` entry. */
export interface ParsedFilter {
  propertyName: string;
  operator: string;
  value: string;
}

/** A validated filter, ready to become SQL. */
export interface CardListFilter {
  /** The property's canonical display name, or "Type". */
  propertyName: string;
  /** Lower-cased grouping key (legacy groups filters case-insensitively). */
  groupKey: string;
  operator: FilterOperator;
  /** Canonical value; "" means (not set). */
  value: string;
  /** The backing definition; undefined for the Type pseudo-property. */
  definition?: PropertyDefinitionRow;
}

/** One selectable/selected list column. */
export interface CardListColumn {
  /** "type" for the card type column, else the definition id as a string. */
  key: string;
  name: string;
  definition?: PropertyDefinitionRow;
}

/** The validated view state the loader renders from. */
export interface CardListView {
  /** Selected columns beyond the fixed # and Name, in request order. */
  columns: CardListColumn[];
  /** Filters that passed validation. */
  filters: CardListFilter[];
  /** Validation errors, legacy phrasing. Non-empty ⇒ do not run the query. */
  errors: string[];
  /** The advanced (MQL) filter text as given; "" when filtering simply. */
  mql: string;
  /**
   * The resolved MQL condition when `mql` is non-blank and valid; null
   * otherwise. When set, `filters` is empty — MQL replaces the simple
   * filters (legacy MqlFilters is an alternative to Filters, not an
   * addition).
   */
  mqlCondition: MqlCondition | null;
}

/** Legacy MqlFilters#validation_errors wording for non-condition MQL. */
const MQL_CONDITIONS_ONLY =
  "MQL filters accept conditions only — remove SELECT, GROUP BY, ORDER BY, and AS OF.";

/**
 * Decodes one legacy-encoded filter string.
 *
 * @param encoded - a `filters[]` value, e.g. `[Status][is][Open]`
 * @returns the decoded parts, or null when the shape doesn't match
 */
export function parseFilterString(encoded: string): ParsedFilter | null {
  const match = ENCODED_FORM.exec(encoded);
  if (!match) return null;
  return { propertyName: match[1], operator: match[2], value: match[3] };
}

/**
 * Encodes filter parts into the legacy `[property][operator][value]`
 * form (filters.rb Filter.encode) for URLs and form round-trips.
 *
 * @param propertyName - property display name or "Type"
 * @param operator - canonical operator name
 * @param value - the value; "" for (not set)
 * @returns the encoded `filters[]` entry
 */
export function encodeFilterString(
  propertyName: string,
  operator: string,
  value: string,
): string {
  return `[${propertyName}][${operator}][${value}]`;
}

/** True when the string is a syntactically valid number (Phase 7 rule). */
function isNumeric(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Number(value));
}

/** True when the string is a valid ISO yyyy-mm-dd date (Phase 7 rule). */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}


/**
 * Validates decoded filters and column names against the project's
 * property definitions and builds the CardListView.
 *
 * Validation mirrors legacy filters.rb: unknown property, unknown
 * operator, an operator a kind doesn't offer, "(not set)" under an
 * ordinal operator, per-kind value validation (numeric/date/ISO), and
 * unknown enumerated or card type values are all errors. Unknown
 * column names are silently dropped (the legacy selector never offers
 * them).
 *
 * @param db - Drizzle handle to read definitions/enumerations with
 * @param projectId - the project whose definitions govern validation
 * @param filterStrings - raw `filters[]` values from the URL
 * @param columnNames - requested column names from the URL
 * @param mql - the advanced filter (legacy `filters[mql]`); when non-blank
 *   it is parsed against the project (Phase 12) and replaces filterStrings
 * @returns the validated view; run the query only when errors is empty
 */
export function buildCardListView(
  db: BetterSQLite3Database,
  projectId: number,
  filterStrings: string[],
  columnNames: string[],
  mql = "",
): CardListView {
  if (mql.trim() !== "") {
    const view = buildCardListView(db, projectId, [], columnNames);
    view.mql = mql;
    const parsed = parseProjectMql(db, projectId, mql);
    if (!parsed.ok) {
      view.errors.push(...parsed.errors);
      return view;
    }
    const { query } = parsed;
    if (query.select || query.groupBy || query.orderBy || query.asOf !== null) {
      view.errors.push(MQL_CONDITIONS_ONLY);
      return view;
    }
    if (query.where && conditionUsesThisCard(query.where)) {
      view.errors.push("THIS CARD is not supported in MQL filters.");
      return view;
    }
    view.mqlCondition = query.where;
    return view;
  }
  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, projectId))
    .orderBy(asc(propertyDefinitions.position), asc(propertyDefinitions.id))
    .all();
  const byLowerName = new Map(definitions.map((d) => [d.name.toLowerCase(), d]));

  const errors: string[] = [];
  const filters: CardListFilter[] = [];

  for (const raw of filterStrings) {
    const parsed = parseFilterString(raw);
    if (!parsed) {
      errors.push(`${raw} is not a valid filter.`);
      continue;
    }
    // Blank property + blank/ignored value rows come from the empty
    // "add a filter" form row — skip them (legacy ignored? filters).
    if (parsed.propertyName === "") continue;

    const operatorToken = parsed.operator.toLowerCase();
    const operator =
      OPERATOR_ALIASES[operatorToken] ??
      FILTER_OPERATORS.find((o) => o === operatorToken);
    if (!operator) {
      errors.push(`'${parsed.operator}' is not a valid filter operator.`);
      continue;
    }

    const isTypeFilter =
      parsed.propertyName.toLowerCase() === CARD_TYPE_COLUMN_NAME.toLowerCase();
    const definition = byLowerName.get(parsed.propertyName.toLowerCase());
    if (!isTypeFilter && !definition) {
      errors.push(`Property ${parsed.propertyName} does not exist.`);
      continue;
    }
    const kind = isTypeFilter ? "type" : (definition!.kind as PropertyKind);
    const name = isTypeFilter ? CARD_TYPE_COLUMN_NAME : definition!.name;

    if (!filterOperatorsFor(kind).includes(operator)) {
      errors.push(`Property ${name} does not support operator '${operator}'.`);
      continue;
    }

    const ordinal = operator === "is less than" || operator === "is greater than";
    if (ordinal && parsed.value === "") {
      // Legacy: "(not set) is not a valid filter for operator ..."
      errors.push(`(not set) is not a valid filter for operator '${operator}'.`);
      continue;
    }

    if (parsed.value !== "" && definition) {
      const compare = comparisonKind(db, definition);
      if (compare === "number" && !isNumeric(parsed.value)) {
        errors.push(`${name}: '${parsed.value}' is an invalid numeric value`);
        continue;
      }
      if (compare === "date" && !isIsoDate(parsed.value)) {
        errors.push(
          `${name}: '${parsed.value}' is an invalid date. Enter dates in yyyy-mm-dd format`,
        );
        continue;
      }
      if (compare === "position") {
        const values = db
          .select()
          .from(enumerationValues)
          .where(eq(enumerationValues.propertyDefinitionId, definition.id))
          .all();
        const known = values.some(
          (v) => v.value.toLowerCase() === parsed.value.toLowerCase(),
        );
        if (!known) {
          errors.push(`Property ${name} contains invalid value ${parsed.value}`);
          continue;
        }
      }
    }
    if (parsed.value !== "" && isTypeFilter) {
      const type = db
        .select()
        .from(cardTypes)
        .where(
          and(
            eq(cardTypes.projectId, projectId),
            sql`lower(${cardTypes.name}) = lower(${parsed.value})`,
          ),
        )
        .get();
      if (!type) {
        errors.push(`Card Type ${CARD_TYPE_COLUMN_NAME} contains invalid value ${parsed.value}`);
        continue;
      }
    }

    filters.push({
      propertyName: name,
      groupKey: name.toLowerCase(),
      operator,
      value: parsed.value,
      definition,
    });
  }

  const columns: CardListColumn[] = [];
  for (const requested of columnNames) {
    const lower = requested.toLowerCase();
    if (lower === CARD_TYPE_COLUMN_NAME.toLowerCase()) {
      if (!columns.some((c) => c.key === "type")) {
        columns.push({ key: "type", name: CARD_TYPE_COLUMN_NAME });
      }
      continue;
    }
    const definition = byLowerName.get(lower);
    if (definition && !columns.some((c) => c.key === String(definition.id))) {
      columns.push({ key: String(definition.id), name: definition.name, definition });
    }
  }

  return { columns, filters, errors, mql: "", mqlCondition: null };
}

/** SQL for "a value row exists for this card × definition matching cmp". */
function valueExists(definitionId: number, cmp?: SQL): SQL {
  const conditions = [
    eq(cardPropertyValues.cardId, cards.id),
    eq(cardPropertyValues.propertyDefinitionId, definitionId),
    ...(cmp ? [cmp] : []),
  ];
  return sql`exists (select 1 from ${cardPropertyValues} where ${and(...conditions)})`;
}

/** Negation of valueExists. */
function valueNotExists(definitionId: number, cmp?: SQL): SQL {
  const conditions = [
    eq(cardPropertyValues.cardId, cards.id),
    eq(cardPropertyValues.propertyDefinitionId, definitionId),
    ...(cmp ? [cmp] : []),
  ];
  return sql`not exists (select 1 from ${cardPropertyValues} where ${and(...conditions)})`;
}

/** The per-row value comparison for one filter (equality or ordinal). */
function valueComparison(
  db: BetterSQLite3Database,
  filter: CardListFilter,
  ordinalDirection: "lt" | "gt" | "eq",
): SQL {
  const definition = filter.definition!;
  const compare = comparisonKind(db, definition);
  const column = cardPropertyValues.value;
  if (compare === "position") {
    const values = db
      .select()
      .from(enumerationValues)
      .where(eq(enumerationValues.propertyDefinitionId, definition.id))
      .orderBy(asc(enumerationValues.position))
      .all();
    if (ordinalDirection === "eq") {
      return sql`lower(${column}) = lower(${filter.value})`;
    }
    const target = values.find(
      (v) => v.value.toLowerCase() === filter.value.toLowerCase(),
    )!;
    const matching = values
      .filter((v) =>
        ordinalDirection === "lt"
          ? v.position < target.position
          : v.position > target.position,
      )
      .map((v) => v.value);
    if (matching.length === 0) return sql`1 = 0`;
    return sql`${column} in (${sql.join(
      matching.map((v) => sql`${v}`),
      sql`, `,
    )})`;
  }
  if (compare === "number") {
    const op =
      ordinalDirection === "eq" ? sql`=` : ordinalDirection === "lt" ? sql`<` : sql`>`;
    return sql`cast(${column} as real) ${op} cast(${filter.value} as real)`;
  }
  // date and text: text comparison; equality case-insensitive (legacy
  // lower_with_cast), ordinals lexical (ISO dates sort chronologically).
  if (ordinalDirection === "eq") {
    return sql`lower(${column}) = lower(${filter.value})`;
  }
  const op = ordinalDirection === "lt" ? sql`<` : sql`>`;
  return sql`${column} ${op} ${filter.value}`;
}

/** Builds the SQL condition for one validated filter. */
function filterCondition(db: BetterSQLite3Database, filter: CardListFilter): SQL {
  if (!filter.definition) {
    // Type pseudo-property: every card has a type, so no unset branch.
    const typeMatch = sql`${cards.cardTypeId} in (select ${cardTypes.id} from ${cardTypes} where ${cardTypes.projectId} = ${cards.projectId} and lower(${cardTypes.name}) = lower(${filter.value}))`;
    return filter.operator === "is" ? typeMatch : sql`not (${typeMatch})`;
  }
  const definitionId = filter.definition.id;
  switch (filter.operator) {
    case "is":
      return filter.value === ""
        ? valueNotExists(definitionId)
        : valueExists(definitionId, valueComparison(db, filter, "eq"));
    case "is not":
      // Legacy `col <> v OR col IS NULL`: no row with this value —
      // which includes cards with no row at all.
      return filter.value === ""
        ? valueExists(definitionId)
        : valueNotExists(definitionId, valueComparison(db, filter, "eq"));
    case "is less than":
      return valueExists(definitionId, valueComparison(db, filter, "lt"));
    case "is greater than":
      return valueExists(definitionId, valueComparison(db, filter, "gt"));
  }
}

/** A row of the card list query result. */
export interface CardListRow {
  id: number;
  number: number;
  name: string;
  cardTypeName: string;
}

/**
 * Runs the card list query: the project's cards matching every filter
 * group, newest number first.
 *
 * Combination semantics (legacy FilterGroup#as_query): within one
 * property's group, equality filters OR and the rest AND, the two
 * halves ORed when both exist; groups AND across properties.
 *
 * @param db - Drizzle handle
 * @param projectId - the project to list
 * @param filters - validated filters from buildCardListView
 * @param mql - the view's resolved MQL condition (if any) and the
 *   context CURRENT USER / TODAY bind to; ANDed with the simple filters
 * @returns matching cards ordered by number descending
 */
export function queryCardList(
  db: BetterSQLite3Database,
  projectId: number,
  filters: CardListFilter[],
  mql?: { condition: MqlCondition | null; context: MqlEvaluationContext },
): CardListRow[] {
  const groups = new Map<string, CardListFilter[]>();
  for (const filter of filters) {
    const group = groups.get(filter.groupKey) ?? [];
    group.push(filter);
    groups.set(filter.groupKey, group);
  }

  const groupConditions: SQL[] = [];
  for (const group of groups.values()) {
    const individual = group
      .filter((f) => f.operator === "is")
      .map((f) => filterCondition(db, f));
    const collective = group
      .filter((f) => f.operator !== "is")
      .map((f) => filterCondition(db, f));
    const individualOr = individual.length > 0 ? or(...individual)! : undefined;
    const collectiveAnd = collective.length > 0 ? and(...collective)! : undefined;
    const condition =
      individualOr && collectiveAnd
        ? or(individualOr, collectiveAnd)!
        : (individualOr ?? collectiveAnd)!;
    groupConditions.push(condition);
  }
  if (mql?.condition) {
    groupConditions.push(mqlCondition(db, projectId, mql.condition, mql.context));
  }

  return db
    .select({
      id: cards.id,
      number: cards.number,
      name: cards.name,
      cardTypeName: cardTypes.name,
    })
    .from(cards)
    .innerJoin(cardTypes, eq(cardTypes.id, cards.cardTypeId))
    .where(and(eq(cards.projectId, projectId), ...groupConditions))
    .orderBy(desc(cards.number))
    .all();
}
