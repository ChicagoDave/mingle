/**
 * Card Trees command handlers — defining a tree and placing cards in it
 * (Phase 23).
 *
 * Purpose: the write path for card trees (legacy `TreeConfiguration`
 * and `CardTreesController`). A tree is an ordered chain of card types;
 * every type but the last owns a relationship property that cards
 * lower in the chain carry, holding the NUMBER of their ancestor of
 * that type. Placing a card under a parent writes the whole ancestry
 * at once — the parent's own ancestors are inherited, the levels below
 * the parent are cleared — and revises every descendant already under
 * the card, so a card's relationship values always agree with its
 * parent's (legacy `revise_tree_structure` + `move_cards`).
 *
 * Every relationship write goes through `appendPropertyValueChanges`
 * (Phase 7's single version-append path), so a placement is one card
 * version per affected card and appears in history like any other
 * property change.
 *
 * Commands → events:
 *   DefineTree         → TreeDefined
 *   AddCardToTree      → CardAddedToTree (+ card versions)
 *   RemoveCardFromTree → CardRemovedFromTree (+ card versions)
 *   ReconfigureTree    → TreeReconfigured (+ card versions for cards of removed types)
 *
 * Public interface: `defineTree`, `addCardToTree`, `removeCardFromTree`,
 * `reconfigureTree`.
 *
 * Owner context: Card Trees. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardTypes, type CardRow } from "~/db/schema/cards";
import { projects } from "~/db/schema/projects";
import { cardPropertyValues, propertyDefinitions } from "~/db/schema/properties";
import { treeBelongings, treeCardTypes, treeConfigurations, type TreeConfigurationRow } from "~/db/schema/trees";
import { appendPropertyValueChanges, propertyNameError, type PropertyValueChange } from "~/domain/cards/properties.server";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { loadTree, relationshipValues, treeMembers, type TreeShape } from "~/domain/trees/read.server";

/** Legacy VALID_NAME_PATTERN for tree names. */
const INVALID_TREE_NAME_CHARS = /[&=#[\]]/;

function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get());
}

function findCard(db: BetterSQLite3Database, projectId: number, number: number): CardRow | undefined {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .get();
}

/** True when a property with this name exists in the project (case-insensitive). */
function propertyNameTaken(db: BetterSQLite3Database, projectId: number, name: string): boolean {
  return Boolean(
    db
      .select({ id: propertyDefinitions.id })
      .from(propertyDefinitions)
      .where(
        and(
          eq(propertyDefinitions.projectId, projectId),
          sql`lower(${propertyDefinitions.name}) = ${name.toLowerCase()}`,
        ),
      )
      .get(),
  );
}

export interface TreeLevelInput {
  cardTypeId: number;
  /** The relationship property name; required for every level but the last, ignored on the last. */
  relationshipName?: string | null;
}

export interface DefineTreeInput {
  projectId: number;
  name: string;
  description?: string | null;
  /** Top level first. */
  levels: TreeLevelInput[];
  actorUserId: number;
}

/**
 * DefineTree — configures a new card tree.
 *
 * DOES: inserts a `tree_configurations` row, one `tree_card_types` row
 * per level in order, and one `property_definitions` row of kind
 * `tree_relationship` per non-leaf level (named as given, pointing at
 * the tree and at the level's card type as `valid_card_type_id`,
 * positioned after the project's existing properties); appends a
 * TreeDefined event — all in one transaction.
 * WHEN: the project exists, the actor is a project admin, the name is
 * valid and unused (by a tree or a property), there are at least two
 * distinct levels all of the project's card types, and every non-leaf
 * level has a valid relationship name unused by any property and
 * distinct from the other levels'.
 * BECAUSE: the relationship properties are what make a tree usable —
 * they are the columns MQL filters on and the values a card carries —
 * so a tree without them, or with names that collide, would be a
 * configuration nothing could read.
 * REJECTS WHEN: the project does not exist; the actor is below project
 * admin; the name is blank, over 255 chars, contains & = # [ ], is
 * "none", is taken by another tree (case-insensitive) or by a property;
 * fewer than two levels, a repeated card type, or a card type not in
 * the project; a non-leaf level with a blank or invalid relationship
 * name, one taken by an existing property, or one repeated within the
 * tree (case-insensitive).
 *
 * @returns the persisted tree row, or field errors
 */
export function defineTree(
  db: BetterSQLite3Database,
  input: DefineTreeInput,
): CommandResult<TreeConfigurationRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;

  const name = input.name.trim();
  if (!name) return reject("name", "can't be blank");
  if (name.length > 255) return reject("name", "is too long (maximum is 255 characters)");
  if (INVALID_TREE_NAME_CHARS.test(name))
    return reject("name", "should not contain '&', '=', '#', '[' and ']' characters");
  if (/^\s*none\s*$/i.test(name)) return reject("name", `cannot be ${name}`);
  const taken = db
    .select({ id: treeConfigurations.id })
    .from(treeConfigurations)
    .where(
      and(
        eq(treeConfigurations.projectId, input.projectId),
        sql`lower(${treeConfigurations.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
  if (taken) return reject("name", "has already been taken");
  if (propertyNameTaken(db, input.projectId, name))
    return reject("name", "has already been taken by a property");

  if (input.levels.length < 2) return reject("levels", "a tree needs at least two card types");
  const typeIds = input.levels.map((l) => l.cardTypeId);
  if (new Set(typeIds).size !== typeIds.length)
    return reject("levels", "a card type can appear only once in a tree");
  const projectTypes = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, input.projectId), inArray(cardTypes.id, typeIds)))
    .all();
  if (projectTypes.length !== typeIds.length)
    return reject("levels", "every card type must belong to this project");

  const relationshipNames: string[] = [];
  for (const level of input.levels.slice(0, -1)) {
    const relationshipName = (level.relationshipName ?? "").trim();
    if (!relationshipName) return reject("relationships", "names cannot be blank");
    const nameError = propertyNameError(relationshipName);
    if (nameError) return reject("relationships", `${relationshipName} ${nameError}`);
    if (propertyNameTaken(db, input.projectId, relationshipName))
      return reject("relationships", `${relationshipName} has already been taken by a property`);
    if (relationshipNames.some((n) => n.toLowerCase() === relationshipName.toLowerCase()))
      return reject("relationships", `name ${relationshipName} is not unique`);
    relationshipNames.push(relationshipName);
  }

  return db.transaction((tx) => {
    const tree = tx
      .insert(treeConfigurations)
      .values({ projectId: input.projectId, name, description: input.description?.trim() || null })
      .returning()
      .get();
    const nextPosition =
      (tx
        .select({ max: sql<number>`coalesce(max(${propertyDefinitions.position}), 0)` })
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.projectId, input.projectId))
        .get()?.max ?? 0) + 1;
    input.levels.forEach((level, position) => {
      tx.insert(treeCardTypes)
        .values({ treeConfigurationId: tree.id, cardTypeId: level.cardTypeId, position })
        .run();
      if (position < input.levels.length - 1) {
        tx.insert(propertyDefinitions)
          .values({
            projectId: input.projectId,
            name: relationshipNames[position],
            kind: "tree_relationship",
            treeConfigurationId: tree.id,
            validCardTypeId: level.cardTypeId,
            position: nextPosition + position,
          })
          .run();
      }
    });
    emitEvent(tx, {
      type: "TreeDefined",
      aggregateType: "TreeConfiguration",
      aggregateId: tree.id,
      payload: { projectId: input.projectId, name, cardTypeIds: typeIds, relationshipNames },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: tree } as CommandResult<TreeConfigurationRow>;
  });
}

/** The level position of a card's type in the tree, or -1 when the type is not in it. */
function levelOf(shape: TreeShape, cardTypeId: number): number {
  return shape.levels.find((l) => l.cardTypeId === cardTypeId)?.position ?? -1;
}

function isMember(db: BetterSQLite3Database, treeId: number, cardId: number): boolean {
  return Boolean(
    db
      .select({ id: treeBelongings.id })
      .from(treeBelongings)
      .where(and(eq(treeBelongings.treeConfigurationId, treeId), eq(treeBelongings.cardId, cardId)))
      .get(),
  );
}

/**
 * The member cards under a card: every member whose relationship for
 * the card's level names the card. Every descendant carries that
 * value whatever its depth, so one select finds the whole subtree.
 */
function descendantsOf(
  db: BetterSQLite3Database,
  shape: TreeShape,
  card: CardRow,
  level: number,
): CardRow[] {
  const relationship = shape.levels[level]?.relationship;
  if (!relationship) return [];
  return db
    .select({ card: cards })
    .from(cards)
    .innerJoin(treeBelongings, and(eq(treeBelongings.cardId, cards.id), eq(treeBelongings.treeConfigurationId, shape.tree.id)))
    .where(
      sql`exists (select 1 from card_property_values v where v.card_id = ${cards.id} and v.property_definition_id = ${relationship.id} and v.value = ${String(card.number)})`,
    )
    .orderBy(asc(cards.number))
    .all()
    .map((row) => row.card);
}

/**
 * The changes that set a card's relationships for levels below
 * `fromLevel` (exclusive) to the given ancestry — one change per
 * relationship whose stored value differs.
 */
function ancestryChanges(
  shape: TreeShape,
  current: Map<number, number>,
  wanted: Map<number, number>,
  belowLevel: number,
): PropertyValueChange[] {
  const changes: PropertyValueChange[] = [];
  for (const level of shape.levels) {
    if (level.position >= belowLevel || !level.relationship) continue;
    const next = wanted.get(level.position) ?? null;
    const now = current.get(level.position) ?? null;
    if (next !== now) {
      changes.push({ definition: level.relationship, value: next === null ? null : String(next) });
    }
  }
  return changes;
}

export interface AddCardToTreeInput {
  projectId: number;
  treeId: number;
  cardNumber: number;
  /** The parent card's number, or null to place the card at the tree's root. */
  parentCardNumber: number | null;
  actorUserId: number;
}

/**
 * AddCardToTree — places a card in a tree, under a parent or at the root.
 *
 * DOES: writes the card's relationship values so that the level of
 * the parent's type names the parent, the levels above it copy the
 * parent's own ancestry, and the levels below it are cleared (all
 * unset at the root) — as one card version through
 * `appendPropertyValueChanges`; inserts the `tree_belongings` row if
 * absent; revises every member card already under this card so its
 * ancestry above this card's level matches the new placement (one
 * version per changed descendant); appends a CardAddedToTree event —
 * all in one transaction.
 * WHEN: the tree and card exist in the project, the actor is at least
 * a full team member, the card's type is in the tree, and the parent
 * (when given) is a member whose type precedes the card's type.
 * BECAUSE: a card's relationship values are read as its position —
 * by the hierarchy view, by MQL, by Phase 24's aggregates — so the
 * ancestry must be written whole and its descendants kept consistent,
 * or two readers would place the same card differently.
 * REJECTS WHEN: unknown project, tree, card, or parent; actor below
 * full team member; the card's type is not in the tree ("Card tree X
 * cannot contain Y cards."); the parent is not a member ("is not in
 * the tree"); the parent's type does not precede the card's ("type X
 * cannot contain type Y"); the card is its own parent; the card is
 * already exactly there ("is already in that position").
 *
 * @returns the card row after placement, or field errors
 */
export function addCardToTree(
  db: BetterSQLite3Database,
  input: AddCardToTreeInput,
): CommandResult<CardRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const shape = loadTree(db, input.projectId, input.treeId);
  if (!shape) return reject("tree", "does not exist");
  const card = findCard(db, input.projectId, input.cardNumber);
  if (!card) return reject("card", "does not exist");
  const cardLevel = levelOf(shape, card.cardTypeId);
  if (cardLevel < 0) {
    const typeName = db.select({ name: cardTypes.name }).from(cardTypes).where(eq(cardTypes.id, card.cardTypeId)).get()?.name;
    return reject("card", `Card tree ${shape.tree.name} cannot contain ${typeName ?? "these"} cards.`);
  }

  const wanted = new Map<number, number>();
  let parent: CardRow | null = null;
  if (input.parentCardNumber !== null) {
    if (input.parentCardNumber === card.number) return reject("parent", "cannot be the card itself");
    parent = findCard(db, input.projectId, input.parentCardNumber) ?? null;
    if (!parent) return reject("parent", "does not exist");
    const parentLevel = levelOf(shape, parent.cardTypeId);
    if (parentLevel < 0 || parentLevel >= cardLevel) {
      const parentType = shape.levels[parentLevel]?.cardTypeName ?? "that";
      return reject("parent", `type ${parentType} cannot contain type ${shape.levels[cardLevel].cardTypeName}`);
    }
    if (!isMember(db, shape.tree.id, parent.id)) return reject("parent", "is not in the tree");
    const parentAncestry = relationshipValues(db, shape, [parent.id]).get(parent.id) ?? new Map<number, number>();
    for (const [position, number] of parentAncestry) if (position < parentLevel) wanted.set(position, number);
    wanted.set(parentLevel, parent.number);
  }

  const current = relationshipValues(db, shape, [card.id]).get(card.id) ?? new Map<number, number>();
  const changes = ancestryChanges(shape, current, wanted, cardLevel);
  const alreadyMember = isMember(db, shape.tree.id, card.id);
  if (alreadyMember && changes.length === 0) return reject("card", "is already in that position");

  return db.transaction((tx) => {
    const placed = changes.length > 0
      ? appendPropertyValueChanges(tx, input.projectId, card, changes, input.actorUserId)
      : card;
    if (!alreadyMember) {
      tx.insert(treeBelongings).values({ treeConfigurationId: shape.tree.id, cardId: card.id }).run();
    }
    // Descendants keep this card as their ancestor at its level and
    // take its new ancestry above it (legacy move_cards).
    if (alreadyMember) {
      const descendants = descendantsOf(tx, shape, card, cardLevel);
      const ancestry = relationshipValues(tx, shape, descendants.map((d) => d.id));
      for (const descendant of descendants) {
        const dChanges = ancestryChanges(shape, ancestry.get(descendant.id) ?? new Map(), wanted, cardLevel);
        if (dChanges.length > 0) appendPropertyValueChanges(tx, input.projectId, descendant, dChanges, input.actorUserId);
      }
    }
    emitEvent(tx, {
      type: "CardAddedToTree",
      aggregateType: "TreeConfiguration",
      aggregateId: shape.tree.id,
      payload: { projectId: input.projectId, cardNumber: card.number, parentCardNumber: parent?.number ?? null },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: placed } as CommandResult<CardRow>;
  });
}

/**
 * Takes a member card out of the tree inside the caller's transaction:
 * clears its relationships and deletes its belonging; with
 * `withChildren` its whole subtree goes too, otherwise its children are
 * detached to its parent by clearing only the relationship naming it.
 *
 * @returns the numbers of every card whose relationships changed, the card first
 */
function detachMember(
  tx: BetterSQLite3Database,
  shape: TreeShape,
  card: CardRow,
  withChildren: boolean,
  actorUserId: number,
): number[] {
  const projectId = shape.tree.projectId;
  const cardLevel = levelOf(shape, card.cardTypeId);
  const touched: number[] = [card.number];
  const descendants = descendantsOf(tx, shape, card, cardLevel);
  const ancestry = relationshipValues(tx, shape, [card.id, ...descendants.map((d) => d.id)]);
  const clearAll = (member: CardRow, belowLevel: number) => {
    const changes = ancestryChanges(shape, ancestry.get(member.id) ?? new Map(), new Map(), belowLevel);
    if (changes.length > 0) appendPropertyValueChanges(tx, projectId, member, changes, actorUserId);
  };
  for (const descendant of descendants) {
    if (withChildren) {
      clearAll(descendant, levelOf(shape, descendant.cardTypeId));
      tx.delete(treeBelongings)
        .where(and(eq(treeBelongings.treeConfigurationId, shape.tree.id), eq(treeBelongings.cardId, descendant.id)))
        .run();
    } else {
      const relationship = shape.levels[cardLevel].relationship!;
      appendPropertyValueChanges(tx, projectId, descendant, [{ definition: relationship, value: null }], actorUserId);
    }
    touched.push(descendant.number);
  }
  clearAll(card, cardLevel);
  tx.delete(treeBelongings)
    .where(and(eq(treeBelongings.treeConfigurationId, shape.tree.id), eq(treeBelongings.cardId, card.id)))
    .run();
  return touched;
}

export interface RemoveCardFromTreeInput {
  projectId: number;
  treeId: number;
  cardNumber: number;
  /** True removes the card's whole subtree; false detaches its children to the card's parent. */
  withChildren: boolean;
  actorUserId: number;
}

/**
 * RemoveCardFromTree — takes a card (and optionally its subtree) out of a tree.
 *
 * DOES: clears every relationship value on the card and deletes its
 * `tree_belongings` row; when `withChildren` is false, clears only the
 * relationship naming this card on each member below it, so they
 * attach to this card's parent (legacy `roll_up_containings` —
 * children detached, never deleted); when true, clears every
 * relationship on each member below it and deletes their belongings
 * too (legacy `remove_card_and_its_children`). Each affected card
 * gets one version; appends a CardRemovedFromTree event — all in one
 * transaction.
 * WHEN: the tree and card exist in the project, the actor is at least
 * a full team member, and the card is a member of the tree.
 * BECAUSE: a card leaving a tree must leave no dangling reference —
 * a descendant still naming it would render under a card that is not
 * there — and the cards themselves are never touched: a tree is a
 * view over cards, not their owner.
 * REJECTS WHEN: unknown project, tree, or card; actor below full team
 * member; the card is not in the tree ("is not in the tree").
 *
 * @returns the numbers of every card whose relationships changed
 *   (the card first), or field errors
 */
export function removeCardFromTree(
  db: BetterSQLite3Database,
  input: RemoveCardFromTreeInput,
): CommandResult<number[]> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const shape = loadTree(db, input.projectId, input.treeId);
  if (!shape) return reject("tree", "does not exist");
  const card = findCard(db, input.projectId, input.cardNumber);
  if (!card) return reject("card", "does not exist");
  if (!isMember(db, shape.tree.id, card.id)) return reject("card", "is not in the tree");

  return db.transaction((tx) => {
    const touched = detachMember(tx, shape, card, input.withChildren, input.actorUserId);
    emitEvent(tx, {
      type: "CardRemovedFromTree",
      aggregateType: "TreeConfiguration",
      aggregateId: shape.tree.id,
      payload: { projectId: input.projectId, cardNumber: card.number, withChildren: input.withChildren, touched },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: touched } as CommandResult<number[]>;
  });
}

export interface ReconfigureTreeInput {
  projectId: number;
  treeId: number;
  name: string;
  description?: string | null;
  /** The complete new chain, top level first. */
  levels: TreeLevelInput[];
  actorUserId: number;
}

/**
 * ReconfigureTree — changes a tree's name, description, or card types
 * (legacy `TreeConfiguration#update_card_types`).
 *
 * DOES: for every card type dropped from the chain, takes each of its
 * member cards out of the tree with its children detached to their
 * grandparent (one version per affected card) and deletes the type's
 * relationship property with any values left on it; for every type
 * added, inserts its level and — unless it is the new leaf — a new
 * relationship property; renames surviving relationships whose names
 * changed, and deletes the relationship of a type that became the
 * leaf; rewrites `tree_card_types` in the new order; updates the
 * tree's name, description and updated_at; appends a TreeReconfigured
 * event — all in one transaction.
 * WHEN: the tree exists in the project, the actor is a project admin,
 * the name and levels pass DefineTree's rules (a relationship name may
 * be one of this tree's own), and — when the tree has member cards —
 * the surviving types keep their relative order.
 * BECAUSE: a relationship property's values are read as tree position;
 * dropping a type must first move its cards out through the same path
 * a removal takes, or their descendants would name an ancestor no
 * level defines.
 * REJECTS WHEN: unknown project or tree; actor below project admin;
 * any DefineTree name/level/relationship rejection; the surviving
 * types' order changed while the tree has members ("cannot reorder the
 * card types of a tree that has cards").
 *
 * @returns the updated tree row, or field errors
 */
export function reconfigureTree(
  db: BetterSQLite3Database,
  input: ReconfigureTreeInput,
): CommandResult<TreeConfigurationRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const shape = loadTree(db, input.projectId, input.treeId);
  if (!shape) return reject("tree", "does not exist");

  const name = input.name.trim();
  if (!name) return reject("name", "can't be blank");
  if (name.length > 255) return reject("name", "is too long (maximum is 255 characters)");
  if (INVALID_TREE_NAME_CHARS.test(name))
    return reject("name", "should not contain '&', '=', '#', '[' and ']' characters");
  if (/^\s*none\s*$/i.test(name)) return reject("name", `cannot be ${name}`);
  if (name.toLowerCase() !== shape.tree.name.toLowerCase()) {
    const taken = db
      .select({ id: treeConfigurations.id })
      .from(treeConfigurations)
      .where(
        and(
          eq(treeConfigurations.projectId, input.projectId),
          sql`lower(${treeConfigurations.name}) = ${name.toLowerCase()}`,
        ),
      )
      .get();
    if (taken) return reject("name", "has already been taken");
    if (propertyNameTaken(db, input.projectId, name))
      return reject("name", "has already been taken by a property");
  }

  if (input.levels.length < 2) return reject("levels", "a tree needs at least two card types");
  const typeIds = input.levels.map((l) => l.cardTypeId);
  if (new Set(typeIds).size !== typeIds.length)
    return reject("levels", "a card type can appear only once in a tree");
  const projectTypes = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, input.projectId), inArray(cardTypes.id, typeIds)))
    .all();
  if (projectTypes.length !== typeIds.length)
    return reject("levels", "every card type must belong to this project");

  const ownRelationshipIds = new Set(shape.levels.flatMap((l) => (l.relationship ? [l.relationship.id] : [])));
  const relationshipNames: string[] = [];
  for (const level of input.levels.slice(0, -1)) {
    const relationshipName = (level.relationshipName ?? "").trim();
    if (!relationshipName) return reject("relationships", "names cannot be blank");
    const nameError = propertyNameError(relationshipName);
    if (nameError) return reject("relationships", `${relationshipName} ${nameError}`);
    const holder = db
      .select({ id: propertyDefinitions.id })
      .from(propertyDefinitions)
      .where(
        and(
          eq(propertyDefinitions.projectId, input.projectId),
          sql`lower(${propertyDefinitions.name}) = ${relationshipName.toLowerCase()}`,
        ),
      )
      .get();
    if (holder && !ownRelationshipIds.has(holder.id))
      return reject("relationships", `${relationshipName} has already been taken by a property`);
    if (relationshipNames.some((n) => n.toLowerCase() === relationshipName.toLowerCase()))
      return reject("relationships", `name ${relationshipName} is not unique`);
    relationshipNames.push(relationshipName);
  }

  const oldTypeIds = shape.levels.map((l) => l.cardTypeId);
  const surviving = oldTypeIds.filter((id) => typeIds.includes(id));
  const survivingInNewOrder = typeIds.filter((id) => oldTypeIds.includes(id));
  const members = treeMembers(db, shape.tree.id);
  if (members.length > 0 && surviving.some((id, i) => id !== survivingInNewOrder[i]))
    return reject("levels", "cannot reorder the card types of a tree that has cards");

  return db.transaction((tx) => {
    // Cards of dropped types leave the tree the way a removal takes them.
    const removedTypeIds = oldTypeIds.filter((id) => !typeIds.includes(id));
    const removedCardNumbers: number[] = [];
    for (const member of members) {
      if (!removedTypeIds.includes(member.cardTypeId)) continue;
      const row = tx.select().from(cards).where(eq(cards.id, member.id)).get()!;
      if (!isMember(tx, shape.tree.id, row.id)) continue; // already detached as a descendant
      removedCardNumbers.push(...detachMember(tx, shape, row, false, input.actorUserId));
    }

    // Relationships: one per non-leaf level of the NEW chain.
    const nonLeafTypeIds = typeIds.slice(0, -1);
    for (const level of shape.levels) {
      if (!level.relationship) continue;
      if (nonLeafTypeIds.includes(level.cardTypeId)) continue;
      // The type left the chain or became the leaf: no card may still
      // carry a value for it, but any that does is cleared with the definition.
      tx.delete(cardPropertyValues).where(eq(cardPropertyValues.propertyDefinitionId, level.relationship.id)).run();
      tx.delete(propertyDefinitions).where(eq(propertyDefinitions.id, level.relationship.id)).run();
    }
    let nextPosition =
      (tx
        .select({ max: sql<number>`coalesce(max(${propertyDefinitions.position}), 0)` })
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.projectId, input.projectId))
        .get()?.max ?? 0) + 1;
    nonLeafTypeIds.forEach((cardTypeId, index) => {
      const existing = shape.levels.find((l) => l.cardTypeId === cardTypeId)?.relationship ?? null;
      if (existing) {
        if (existing.name !== relationshipNames[index]) {
          tx.update(propertyDefinitions)
            .set({ name: relationshipNames[index], updatedAt: new Date() })
            .where(eq(propertyDefinitions.id, existing.id))
            .run();
        }
      } else {
        tx.insert(propertyDefinitions)
          .values({
            projectId: input.projectId,
            name: relationshipNames[index],
            kind: "tree_relationship",
            treeConfigurationId: shape.tree.id,
            validCardTypeId: cardTypeId,
            position: nextPosition++,
          })
          .run();
      }
    });

    tx.delete(treeCardTypes).where(eq(treeCardTypes.treeConfigurationId, shape.tree.id)).run();
    typeIds.forEach((cardTypeId, position) => {
      tx.insert(treeCardTypes).values({ treeConfigurationId: shape.tree.id, cardTypeId, position }).run();
    });
    const tree = tx
      .update(treeConfigurations)
      .set({ name, description: input.description?.trim() || null, updatedAt: new Date() })
      .where(eq(treeConfigurations.id, shape.tree.id))
      .returning()
      .get()!;
    emitEvent(tx, {
      type: "TreeReconfigured",
      aggregateType: "TreeConfiguration",
      aggregateId: tree.id,
      payload: { projectId: input.projectId, name, cardTypeIds: typeIds, relationshipNames, removedCardNumbers },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: tree } as CommandResult<TreeConfigurationRow>;
  });
}
