/**
 * Card Trees read model — tree shapes and hierarchies (Phase 23).
 *
 * Purpose: the queries the tree pages and the tree commands read. A
 * `TreeShape` is a tree's configuration resolved into ordered levels,
 * each carrying its card type and (for every level but the last) its
 * relationship property; a `TreeNode` hierarchy is the tree's member
 * cards nested by their relationship values, the way legacy's
 * `_hierarchy_nodes.rhtml` rendered them.
 *
 * Public interface: `TreeLevel`, `TreeShape`, `TreeNode`, `loadTree`,
 * `listTrees`, `treeHierarchy`, `relationshipValues`, `treeMembers`.
 *
 * Owner context: Card Trees. Read-only — nothing here writes.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardTypes } from "~/db/schema/cards";
import { cardPropertyValues, propertyDefinitions, type PropertyDefinitionRow } from "~/db/schema/properties";
import { treeBelongings, treeCardTypes, treeConfigurations, type TreeConfigurationRow } from "~/db/schema/trees";

/** One level of a tree: its card type and the relationship cards below it carry. */
export interface TreeLevel {
  position: number;
  cardTypeId: number;
  cardTypeName: string;
  /** The relationship property whose value names a card of this level; null for the leaf level. */
  relationship: PropertyDefinitionRow | null;
}

/** A tree's configuration, top level first. */
export interface TreeShape {
  tree: TreeConfigurationRow;
  levels: TreeLevel[];
}

/** A card in a tree hierarchy with its nested children. */
export interface TreeNode {
  cardId: number;
  number: number;
  name: string;
  cardTypeName: string;
  /** The level's position in the tree (0 = top). */
  level: number;
  children: TreeNode[];
}

/**
 * Resolves a tree's configuration into ordered levels.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project the tree must belong to
 * @param treeId - the tree
 * @returns the shape, or null when no such tree exists in the project
 */
export function loadTree(
  db: BetterSQLite3Database,
  projectId: number,
  treeId: number,
): TreeShape | null {
  const tree = db
    .select()
    .from(treeConfigurations)
    .where(and(eq(treeConfigurations.id, treeId), eq(treeConfigurations.projectId, projectId)))
    .get();
  if (!tree) return null;
  const types = db
    .select({
      position: treeCardTypes.position,
      cardTypeId: treeCardTypes.cardTypeId,
      cardTypeName: cardTypes.name,
    })
    .from(treeCardTypes)
    .innerJoin(cardTypes, eq(cardTypes.id, treeCardTypes.cardTypeId))
    .where(eq(treeCardTypes.treeConfigurationId, tree.id))
    .orderBy(asc(treeCardTypes.position))
    .all();
  const relationships = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.treeConfigurationId, tree.id))
    .all();
  return {
    tree,
    levels: types.map((type) => ({
      ...type,
      relationship: relationships.find((r) => r.validCardTypeId === type.cardTypeId) ?? null,
    })),
  };
}

/** The trees of a project, by name, with their type chain for display. */
export function listTrees(
  db: BetterSQLite3Database,
  projectId: number,
): { id: number; name: string; description: string | null; cardTypeNames: string[] }[] {
  const trees = db
    .select()
    .from(treeConfigurations)
    .where(eq(treeConfigurations.projectId, projectId))
    .orderBy(asc(treeConfigurations.name))
    .all();
  if (trees.length === 0) return [];
  const types = db
    .select({
      treeId: treeCardTypes.treeConfigurationId,
      position: treeCardTypes.position,
      name: cardTypes.name,
    })
    .from(treeCardTypes)
    .innerJoin(cardTypes, eq(cardTypes.id, treeCardTypes.cardTypeId))
    .where(inArray(treeCardTypes.treeConfigurationId, trees.map((t) => t.id)))
    .orderBy(asc(treeCardTypes.position))
    .all();
  return trees.map((tree) => ({
    id: tree.id,
    name: tree.name,
    description: tree.description,
    cardTypeNames: types.filter((t) => t.treeId === tree.id).map((t) => t.name),
  }));
}

/** The member cards of a tree (those with a belonging row). */
export function treeMembers(
  db: BetterSQLite3Database,
  treeId: number,
): { id: number; number: number; name: string; cardTypeId: number }[] {
  return db
    .select({ id: cards.id, number: cards.number, name: cards.name, cardTypeId: cards.cardTypeId })
    .from(treeBelongings)
    .innerJoin(cards, eq(cards.id, treeBelongings.cardId))
    .where(eq(treeBelongings.treeConfigurationId, treeId))
    .orderBy(asc(cards.number))
    .all();
}

/**
 * The relationship values carried by a set of cards: card id → (level
 * position → ancestor card number). Levels with no value are absent.
 *
 * @param db - the Drizzle handle
 * @param shape - the tree whose relationships are read
 * @param cardIds - the cards to read
 */
export function relationshipValues(
  db: BetterSQLite3Database,
  shape: TreeShape,
  cardIds: number[],
): Map<number, Map<number, number>> {
  const result = new Map<number, Map<number, number>>();
  const definitionIds = shape.levels.flatMap((l) => (l.relationship ? [l.relationship.id] : []));
  if (cardIds.length === 0 || definitionIds.length === 0) return result;
  const positionByDefinition = new Map(
    shape.levels.flatMap((l) => (l.relationship ? [[l.relationship.id, l.position] as const] : [])),
  );
  const rows = db
    .select({
      cardId: cardPropertyValues.cardId,
      definitionId: cardPropertyValues.propertyDefinitionId,
      value: cardPropertyValues.value,
    })
    .from(cardPropertyValues)
    .where(
      and(
        inArray(cardPropertyValues.cardId, cardIds),
        inArray(cardPropertyValues.propertyDefinitionId, definitionIds),
      ),
    )
    .all();
  for (const row of rows) {
    const position = positionByDefinition.get(row.definitionId);
    if (position === undefined) continue;
    const perCard = result.get(row.cardId) ?? new Map<number, number>();
    perCard.set(position, Number(row.value));
    result.set(row.cardId, perCard);
  }
  return result;
}

/**
 * The tree's member cards nested by their relationships, children in
 * card-number order. A card's parent is its nearest set ancestor — a
 * Story under an Iteration sits under it; a Story whose Iteration is
 * unset but whose Release is set sits directly under the Release
 * (legacy `parent_card_ids.last`).
 *
 * @param db - the Drizzle handle
 * @param shape - the tree
 * @returns the root-level nodes, each with its subtree
 */
export function treeHierarchy(db: BetterSQLite3Database, shape: TreeShape): TreeNode[] {
  const members = treeMembers(db, shape.tree.id);
  const values = relationshipValues(db, shape, members.map((m) => m.id));
  const levelByType = new Map(shape.levels.map((l) => [l.cardTypeId, l.position]));
  const nodeByNumber = new Map<number, TreeNode>();
  for (const member of members) {
    const level = levelByType.get(member.cardTypeId) ?? -1;
    nodeByNumber.set(member.number, {
      cardId: member.id,
      number: member.number,
      name: member.name,
      cardTypeName: shape.levels.find((l) => l.cardTypeId === member.cardTypeId)?.cardTypeName ?? "",
      level,
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const member of members) {
    const node = nodeByNumber.get(member.number)!;
    const perCard = values.get(member.id) ?? new Map<number, number>();
    let parentNumber: number | null = null;
    for (let position = node.level - 1; position >= 0; position--) {
      const ancestor = perCard.get(position);
      if (ancestor !== undefined) {
        parentNumber = ancestor;
        break;
      }
    }
    const parent = parentNumber === null ? undefined : nodeByNumber.get(parentNumber);
    // An ancestor that has left the tree (or was never in it) makes the
    // card a root rather than an orphan hidden from the view.
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}
