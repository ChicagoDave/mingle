/**
 * Aggregate property engine — what an aggregate property is worth on a
 * holder card (Phase 24).
 *
 * Purpose: computes the value of an aggregate property definition
 * (legacy `AggregatePropertyDefinition` + `Aggregate#result_by_sql`)
 * for one card: SUM / AVG / MIN / MAX of a numeric target property, or
 * COUNT, over the card's member descendants in the definition's tree —
 * the descendants being every tree member whose relationship for the
 * holder's level names the holder, of the scope card type (or of every
 * type below the holder's level), and satisfying the optional MQL
 * condition. The whole aggregation is ONE SQL statement, so a
 * thousand-story release costs one query, not a thousand reads.
 *
 * Semantics pinned to legacy: COUNT of nothing is "0"; every other
 * function over no contributing value is unset; a condition that no
 * longer parses (a renamed property) makes the value unset rather than
 * failing the card edit that triggered the recomputation; numbers come
 * back in the canonical precision-2 form formula values use. A holder
 * that is not itself a member of the tree has no value — legacy
 * scoped `update_cards` to `tree_belongings` the same way.
 *
 * Read-only: this module never writes. Materializing the values into
 * `card_property_values` is properties.server.ts's job — that module
 * stays the single writer of property values (rule 8).
 *
 * Public interface: `aggregateValuesFor`, `aggregateConditionErrors`,
 * `treeAncestorCardIds`, `AggregateHolder`.
 *
 * Owner context: Card Management. Reads Card Trees' tables through
 * trees/read.server.ts (schema-only module — no cycle).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { cardPropertyValues, propertyDefinitions, type PropertyDefinitionRow } from "~/db/schema/properties";
import { treeBelongings } from "~/db/schema/trees";
import type { AggregateType } from "~/shared/wire-types";
import { formatNumber } from "~/domain/cards/formula.server";
import { mqlCondition, todayIso } from "~/domain/cards/mql-evaluator.server";
import type { MqlCondition, MqlQuery, MqlValue, PropertyRef } from "~/domain/cards/mql.server";
import { parseProjectMql } from "~/domain/cards/mql-schema.server";
import { loadTree, type TreeShape } from "~/domain/trees/read.server";

/** The card whose aggregate values are being computed. */
export interface AggregateHolder {
  id: number;
  number: number;
  cardTypeId: number;
}

/**
 * Validates a parsed MQL query as an aggregate condition (legacy
 * `CardQuery::AggregateConditionValidations`): conditions only, and
 * nothing that binds to a viewer or a moment — an aggregate is
 * computed once for everyone, so TODAY, CURRENT USER and THIS CARD
 * would make one stored value mean different things. A condition may
 * not read another aggregate property either: the recomputation order
 * across levels is not defined, so the value read could be stale.
 *
 * @param query - the resolved query for the condition text
 * @returns every violation found, empty when the condition is usable
 */
export function aggregateConditionErrors(query: MqlQuery): string[] {
  const errors: string[] = [];
  if (query.select || query.groupBy || query.orderBy || query.asOf !== null)
    errors.push("An aggregate condition is a condition only — no SELECT, GROUP BY, ORDER BY or AS OF.");
  if (query.from) errors.push("FROM TREE is not supported in aggregate condition");
  if (query.where) walkCondition(query.where, errors);
  return [...new Set(errors)];
}

function walkCondition(condition: MqlCondition, errors: string[]): void {
  switch (condition.type) {
    case "and":
    case "or":
      walkCondition(condition.left, errors);
      walkCondition(condition.right, errors);
      return;
    case "not":
      walkCondition(condition.operand, errors);
      return;
    case "comparison":
      checkProperty(condition.column.property, errors);
      checkValue(condition.value, errors);
      return;
    case "in":
      checkProperty(condition.column.property, errors);
      condition.values.forEach((value) => checkValue(value, errors));
      return;
    case "inQuery":
      checkProperty(condition.column.property, errors);
      if (condition.query.where) walkCondition(condition.query.where, errors);
      return;
    case "inPlan":
    case "taggedWith":
      return;
  }
}

function checkProperty(property: PropertyRef, errors: string[]): void {
  if (property.source === "defined" && property.kind === "aggregate")
    errors.push(`${property.name} is an aggregate property and cannot be used in an aggregate condition`);
}

function checkValue(value: MqlValue, errors: string[]): void {
  switch (value.type) {
    case "today":
      errors.push("TODAY is not supported in aggregate condition");
      return;
    case "currentUser":
      errors.push("CURRENT USER is not supported in aggregate condition");
      return;
    case "thisCard":
    case "thisCardProperty":
      errors.push("THIS CARD is not supported in aggregate condition");
      return;
    case "property":
      checkProperty(value.column.property, errors);
      return;
    default:
      return;
  }
}

/**
 * The ids of the cards a set of relationship values name — the
 * ancestors a card sits under, which are exactly the cards whose
 * aggregates that card contributes to.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project the numbers belong to
 * @param numbers - ancestor card numbers (relationship values)
 * @returns the matching card ids, unordered, missing numbers skipped
 */
export function treeAncestorCardIds(
  db: BetterSQLite3Database,
  projectId: number,
  numbers: number[],
): number[] {
  const wanted = [...new Set(numbers.filter((n) => Number.isSafeInteger(n)))];
  if (wanted.length === 0) return [];
  return db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), inArray(cards.number, wanted)))
    .all()
    .map((row) => row.id);
}

/**
 * Every aggregate definition of the project, with what the holder's
 * value of each should now be: computed when the holder is a member
 * of the definition's tree and of its holder card type, unset
 * otherwise (so a card that changed type or left the tree sheds the
 * values it can no longer carry).
 *
 * @param db - the Drizzle handle (or transaction)
 * @param projectId - the holder's project
 * @param holder - the card to compute for
 * @returns definition id → canonical value, or null for unset; empty
 *   when the project has no aggregate definitions
 */
export function aggregateValuesFor(
  db: BetterSQLite3Database,
  projectId: number,
  holder: AggregateHolder,
): Map<number, string | null> {
  const result = new Map<number, string | null>();
  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(and(eq(propertyDefinitions.projectId, projectId), eq(propertyDefinitions.kind, "aggregate")))
    .all();
  if (definitions.length === 0) return result;
  const shapes = new Map<number, TreeShape | null>();
  const memberships = new Map<number, boolean>();
  for (const definition of definitions) {
    const treeId = definition.treeConfigurationId;
    if (treeId === null || definition.aggregateCardTypeId !== holder.cardTypeId) {
      result.set(definition.id, null);
      continue;
    }
    if (!shapes.has(treeId)) shapes.set(treeId, loadTree(db, projectId, treeId));
    const shape = shapes.get(treeId);
    if (!shape) {
      result.set(definition.id, null);
      continue;
    }
    if (!memberships.has(treeId)) {
      memberships.set(
        treeId,
        Boolean(
          db
            .select({ id: treeBelongings.id })
            .from(treeBelongings)
            .where(and(eq(treeBelongings.treeConfigurationId, treeId), eq(treeBelongings.cardId, holder.id)))
            .get(),
        ),
      );
    }
    result.set(definition.id, memberships.get(treeId) ? computeAggregate(db, projectId, definition, holder, shape) : null);
  }
  return result;
}

/**
 * One aggregation as one SQL statement over the holder's member
 * descendants (see the header for the contributing-card rule).
 *
 * @returns the canonical value, or null when unset / unresolvable
 */
function computeAggregate(
  db: BetterSQLite3Database,
  projectId: number,
  definition: PropertyDefinitionRow,
  holder: AggregateHolder,
  shape: TreeShape,
): string | null {
  const level = shape.levels.find((l) => l.cardTypeId === definition.aggregateCardTypeId);
  const relationship = level?.relationship;
  if (!level || !relationship) return null;
  const scopeTypeIds =
    definition.aggregateScopeCardTypeId !== null
      ? [definition.aggregateScopeCardTypeId]
      : shape.levels.filter((l) => l.position > level.position).map((l) => l.cardTypeId);
  if (scopeTypeIds.length === 0) return null;

  const predicates: SQL[] = [
    eq(cards.projectId, projectId),
    inArray(cards.cardTypeId, scopeTypeIds),
    sql`exists (select 1 from ${treeBelongings} where ${treeBelongings.cardId} = ${cards.id} and ${treeBelongings.treeConfigurationId} = ${shape.tree.id})`,
    sql`exists (select 1 from ${cardPropertyValues} where ${cardPropertyValues.cardId} = ${cards.id} and ${cardPropertyValues.propertyDefinitionId} = ${relationship.id} and ${cardPropertyValues.value} = ${String(holder.number)})`,
  ];
  const conditionText = definition.aggregateCondition?.trim();
  if (conditionText) {
    // Re-parsed every time (like subscription filters): a renamed
    // property makes the value unset instead of failing the edit.
    const parsed = parseProjectMql(db, projectId, conditionText);
    if (!parsed.ok || aggregateConditionErrors(parsed.query).length > 0) return null;
    if (parsed.query.where) {
      predicates.push(mqlCondition(db, projectId, parsed.query.where, { currentUserId: null, today: todayIso() }));
    }
  }

  const aggregateType = definition.aggregateType as AggregateType;
  if (aggregateType === "count") {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(cards)
      .where(and(...predicates))
      .get();
    return String(row?.n ?? 0);
  }
  if (definition.aggregateTargetId === null) return null;
  const fn = { sum: sql`sum`, avg: sql`avg`, min: sql`min`, max: sql`max` }[aggregateType];
  if (!fn) return null;
  const target = sql`cast(${cardPropertyValues.value} as real)`;
  const row = db
    .select({
      n: sql<number>`count(${cardPropertyValues.value})`,
      value: sql<number | null>`${fn}(${target})`,
    })
    .from(cards)
    .innerJoin(
      cardPropertyValues,
      and(
        eq(cardPropertyValues.cardId, cards.id),
        eq(cardPropertyValues.propertyDefinitionId, definition.aggregateTargetId),
      ),
    )
    .where(and(...predicates))
    .get();
  if (!row || row.n === 0 || row.value === null) return null;
  return formatNumber(Number(row.value));
}
