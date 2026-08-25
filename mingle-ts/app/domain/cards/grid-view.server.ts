/**
 * Card grid ("card wall") view — lane building over a group-by
 * property (Phase 10).
 *
 * Purpose: the CardGridView read model behind the legacy card wall
 * (_card_grid_results.rhtml / _group_lanes.rhtml lane semantics).
 * Groups a project's cards into lanes by one finite-valued property:
 * enumerated (lanes are the defined values in position order) or user
 * (lanes are team members in name order), with a "(not set)" lane
 * first for cards carrying no value. Filters are the Phase 9 list-view
 * semantics, reused via buildCardListView/queryCardList — never
 * reimplemented here. Grouping by other kinds is rejected: number,
 * date, text, and formula properties have no finite lane set (legacy
 * only offers groupable properties), and grouping by card type is
 * deferred until card-type drops exist.
 *
 * Public interface: `buildGridView`, `GRID_GROUPABLE_KINDS`, and the
 * `CardGridView` / `GridLane` types. Read-only — the drop mutation is
 * SetCardPropertyValue (properties.server), not a grid concern.
 *
 * Owner context: Card Management (read model).
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import {
  buildCardListView,
  queryCardList,
  type CardListRow,
} from "./list-view.server";
import { type MqlEvaluationContext, todayIso } from "./mql-evaluator.server";

/** Property kinds a grid view can group by (finite lane sets). */
export const GRID_GROUPABLE_KINDS = ["enumerated", "user"] as const;

/** One lane of the wall. */
export interface GridLane {
  /** Canonical stored value dropped cards receive; "" = (not set). */
  value: string;
  /** Display title: the enum value, the user's name, or "(not set)". */
  title: string;
  cards: CardListRow[];
}

/** The lane projection the grid route renders from. */
export interface CardGridView {
  /** The group-by definition; undefined for an ungrouped wall. */
  groupBy?: { id: number; name: string; kind: string };
  /**
   * Lanes in display order — (not set) first, then defined position
   * order (enumerated) or member name order (user). An ungrouped wall
   * is a single untitled lane holding every matching card.
   */
  lanes: GridLane[];
  /** Validation errors (group-by plus Phase 9 filter validation). */
  errors: string[];
}

/**
 * Builds the wall: validates the group-by property and the filters,
 * queries the matching cards (Phase 9 semantics), and distributes them
 * into lanes by their stored value.
 *
 * @param db - Drizzle handle
 * @param projectId - the project to project
 * @param groupByName - the group-by property's name; "" for ungrouped
 * @param filterStrings - raw `filters[]` values (legacy encoded form)
 * @param mql - the advanced filter (legacy `filters[mql]`); replaces filterStrings
 * @param context - what CURRENT USER / TODAY bind to when the MQL uses them
 * @returns the lane projection; render only when errors is empty
 */
export function buildGridView(
  db: BetterSQLite3Database,
  projectId: number,
  groupByName: string,
  filterStrings: string[],
  mql = "",
  context: MqlEvaluationContext = { currentUserId: null, today: todayIso() },
): CardGridView {
  const listView = buildCardListView(db, projectId, filterStrings, [], mql);
  const errors = [...listView.errors];

  let groupBy: PropertyDefinitionRow | undefined;
  if (groupByName !== "") {
    groupBy = db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.projectId, projectId))
      .all()
      .find((d) => d.name.toLowerCase() === groupByName.toLowerCase());
    if (!groupBy) {
      errors.push(`Property ${groupByName} does not exist.`);
    } else if (!(GRID_GROUPABLE_KINDS as readonly string[]).includes(groupBy.kind)) {
      errors.push(`Property ${groupBy.name} cannot be used to group the grid.`);
      groupBy = undefined;
    }
  }
  if (errors.length > 0) return { lanes: [], errors };

  const cards = queryCardList(db, projectId, listView.filters, {
    condition: listView.mqlCondition,
    context,
  });

  if (!groupBy) {
    return { lanes: [{ value: "", title: "", cards }], errors: [] };
  }

  const lanes: GridLane[] = [{ value: "", title: "(not set)", cards: [] }];
  if (groupBy.kind === "enumerated") {
    const values = db
      .select()
      .from(enumerationValues)
      .where(eq(enumerationValues.propertyDefinitionId, groupBy.id))
      .orderBy(asc(enumerationValues.position))
      .all();
    for (const value of values) {
      lanes.push({ value: value.value, title: value.value, cards: [] });
    }
  } else {
    const members = db
      .select({ id: users.id, name: users.name })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .where(eq(teamMemberships.projectId, projectId))
      .orderBy(asc(users.name))
      .all();
    for (const member of members) {
      lanes.push({ value: String(member.id), title: member.name, cards: [] });
    }
  }

  const valueByCardId = new Map<number, string>(
    cards.length > 0
      ? db
          .select({
            cardId: cardPropertyValues.cardId,
            value: cardPropertyValues.value,
          })
          .from(cardPropertyValues)
          .where(
            and(
              eq(cardPropertyValues.propertyDefinitionId, groupBy.id),
              inArray(
                cardPropertyValues.cardId,
                cards.map((c) => c.id),
              ),
            ),
          )
          .all()
          .map((v) => [v.cardId, v.value] as const)
      : [],
  );

  const laneByValue = new Map(
    lanes.map((lane) => [lane.value.toLowerCase(), lane] as const),
  );
  for (const card of cards) {
    const value = valueByCardId.get(card.id) ?? "";
    const lane = laneByValue.get(value.toLowerCase()) ?? lanes[0];
    lane.cards.push(card);
  }
  return { groupBy: { id: groupBy.id, name: groupBy.name, kind: groupBy.kind }, lanes, errors: [] };
}
