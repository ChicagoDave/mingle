/**
 * Card Management command handlers — Card aggregate, card types, and
 * versioned history (Phase 5).
 *
 * Purpose: the write path for cards and card types; together with its
 * sibling app/domain/cards modules (properties.server.ts appends
 * versions for property mutations) it is the only writer of the
 * append-only `card_versions` trail. Each handler authorizes the actor
 * through the Phase 4 checkpoint at the legacy privilege level (card
 * create/update: full team member; card deletion and card type
 * definition: project administrator), validates against the legacy
 * rules (card.rb, card_type.rb), mutates state, and emits a past-tense
 * domain event — or rejects (rule 10).
 *
 * Versioning invariant: `card_versions` rows are only ever INSERTED —
 * never updated, never deleted. Every card mutation appends the next
 * version; deleting a card keeps its trail and appends a final
 * deletion version (legacy keep_versions_on_destroy +
 * create_card_deletion_version). Card numbers are per-project and
 * never reused, even after deletion.
 *
 * Commands → events:
 *   DefineCardType → CardTypeDefined
 *   CreateCard     → CardCreated   (+ version 1, carrying the card
 *                    type's defaults — card-defaults.server.ts, P-2)
 *   UpdateCard     → CardUpdated   (+ next version)
 *   DeleteCard     → CardDeleted   (+ deletion version)
 *
 * Public interface: `defineCardType`, `deleteCardType`, `createCard`,
 * `updateCard`, `deleteCard`.
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  cards,
  cardTypes,
  cardVersions,
  type CardRow,
  type CardTypeRow,
} from "~/db/schema/cards";
import {
  attachments,
  cardChecklistItems,
} from "~/db/schema/card-content";
import { cardPropertyValues } from "~/db/schema/properties";
import { cardDefaults } from "~/db/schema/card-defaults";
import {
  aggregateHoldersOf,
  cardPropertySnapshot,
  insertInitialPropertyValues,
  recomputeAggregatesAround,
  recomputeAggregatesFor,
} from "~/domain/cards/properties.server";
import { defaultPropertyChanges } from "~/domain/cards/card-defaults.server";
import { removeDeletedCardFromTrees, reviseTreesForCardTypeChange } from "~/domain/trees/commands.server";
import { treeCardTypes } from "~/db/schema/trees";
import { transitionActions, transitionPrerequisites, transitions } from "~/db/schema/transitions";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { scheduleHistoryNotification } from "~/domain/notifications.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

const NAME_MAX_LENGTH = 255;

/** True when the project id names an existing project. */
function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get(),
  );
}

/** Looks a card up by its per-project number. */
function findCard(
  db: BetterSQLite3Database,
  projectId: number,
  number: number,
): CardRow | undefined {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .get();
}

/** Looks a card type up within a project. */
function findCardType(
  db: BetterSQLite3Database,
  projectId: number,
  cardTypeId: number,
): CardTypeRow | undefined {
  return db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.id, cardTypeId)))
    .get();
}

/**
 * The next card number for a project: one past the highest number ever
 * used, across live cards and the version trails of deleted ones —
 * numbers are never reused (legacy per-project sequence parity).
 */
function nextCardNumber(db: BetterSQLite3Database, projectId: number): number {
  const row = db.get<{ highest: number }>(sql`
    SELECT COALESCE(MAX(number), 0) AS highest FROM (
      SELECT number FROM ${cards} WHERE ${cards.projectId} = ${projectId}
      UNION ALL
      SELECT number FROM ${cardVersions} WHERE ${cardVersions.projectId} = ${projectId}
    )`);
  return (row?.highest ?? 0) + 1;
}

/** Whether a number has ever been used in the project — by a live card or one now deleted. */
function cardNumberUsed(db: BetterSQLite3Database, projectId: number, number: number): boolean {
  const row = db.get<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM (
      SELECT number FROM ${cards} WHERE ${cards.projectId} = ${projectId} AND number = ${number}
      UNION ALL
      SELECT number FROM ${cardVersions} WHERE ${cardVersions.projectId} = ${projectId} AND number = ${number}
    )`);
  return (row?.n ?? 0) > 0;
}

/** Shared name validation for create and update. */
function cardNameError(name: string): string | null {
  if (!name) return "can't be blank";
  if (name.length > NAME_MAX_LENGTH)
    return `is too long (maximum is ${NAME_MAX_LENGTH} characters)`;
  return null;
}

export interface DefineCardTypeInput {
  projectId: number;
  name: string;
  actorUserId: number;
}

/**
 * DefineCardType — adds a card type to a project.
 *
 * DOES: inserts a `card_types` row (position appended at the end) and
 * appends a CardTypeDefined event.
 * REJECTS: unknown project, actor below project administrator (legacy:
 * card type admin is PROJECT_ADMIN), blank name, or a name already
 * taken in the project (case-insensitively).
 *
 * @returns the created card type row, or field errors
 */
export function defineCardType(
  db: BetterSQLite3Database,
  input: DefineCardTypeInput,
): CommandResult<CardTypeRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const name = input.name.trim();
  if (!name) return reject("name", "can't be blank");
  const taken = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(
      and(
        eq(cardTypes.projectId, input.projectId),
        sql`lower(${cardTypes.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
  if (taken) return reject("name", "has already been taken");

  const last = db.get<{ highest: number }>(
    sql`SELECT COALESCE(MAX(position), 0) AS highest FROM ${cardTypes} WHERE ${cardTypes.projectId} = ${input.projectId}`,
  );
  return db.transaction((tx) => {
    const row = tx
      .insert(cardTypes)
      .values({
        projectId: input.projectId,
        name,
        position: (last?.highest ?? 0) + 1,
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "CardTypeDefined",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { name: row.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<CardTypeRow>;
  });
}

export interface DeleteCardTypeInput {
  projectId: number;
  cardTypeId: number;
  actorUserId: number;
}

/**
 * DeleteCardType — removes a card type nothing depends on.
 *
 * DOES: deletes the `card_types` row, the transitions restricted to
 * that type (with their prerequisite and action rows — legacy
 * `has_many :transitions, :dependent => :destroy`), and appends a
 * CardTypeDeleted event, all in one transaction.
 * REJECTS: unknown project or card type; actor below project
 * administrator; a type that is the project's last, that a live card
 * carries, or that a tree configuration includes — legacy
 * `CardType#can_be_destroy?`, with its message ("<name> cannot be
 * deleted because it is being used or is the last card type.").
 *
 * @returns the deleted card type row, or field errors
 */
export function deleteCardType(
  db: BetterSQLite3Database,
  input: DeleteCardTypeInput,
): CommandResult<CardTypeRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const cardType = db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, input.projectId), eq(cardTypes.id, input.cardTypeId)))
    .get();
  if (!cardType) return reject("cardType", "does not exist");

  const typeCount = db.get<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM ${cardTypes} WHERE ${cardTypes.projectId} = ${input.projectId}`,
  );
  const cardCount = db.get<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM ${cards} WHERE ${cards.cardTypeId} = ${cardType.id}`,
  );
  const treeCount = db.get<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM ${treeCardTypes} WHERE ${treeCardTypes.cardTypeId} = ${cardType.id}`,
  );
  if ((typeCount?.count ?? 0) <= 1 || (cardCount?.count ?? 0) > 0 || (treeCount?.count ?? 0) > 0)
    return reject(
      "cardType",
      `${cardType.name} cannot be deleted because it is being used or is the last card type.`,
    );

  return db.transaction((tx) => {
    const restricted = tx
      .select({ id: transitions.id })
      .from(transitions)
      .where(and(eq(transitions.projectId, input.projectId), eq(transitions.cardTypeId, cardType.id)))
      .all()
      .map((row) => row.id);
    for (const transitionId of restricted) {
      tx.delete(transitionPrerequisites).where(eq(transitionPrerequisites.transitionId, transitionId)).run();
      tx.delete(transitionActions).where(eq(transitionActions.transitionId, transitionId)).run();
      tx.delete(transitions).where(eq(transitions.id, transitionId)).run();
    }
    tx.delete(cardDefaults).where(eq(cardDefaults.cardTypeId, cardType.id)).run();
    tx.delete(cardTypes).where(eq(cardTypes.id, cardType.id)).run();
    emitEvent(tx, {
      type: "CardTypeDeleted",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { name: cardType.name, deletedTransitions: restricted.length },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: cardType } as CommandResult<CardTypeRow>;
  });
}

export interface CreateCardInput {
  projectId: number;
  name: string;
  description?: string | null;
  cardTypeId: number;
  /**
   * An explicit card number (Phase 29 card import keeps the numbers
   * in the file, as legacy did); absent means the project's next.
   * Must be a positive integer not used by any card, live or deleted.
   */
  number?: number | null;
  actorUserId: number;
}

/**
 * CreateCard — creates a card as version 1 of its history.
 *
 * DOES: inserts a `cards` row (number = the explicit number when given,
 * else the project's next; version 1), writes the card type's default
 * property values as the card's initial `card_property_values` rows
 * (P-2 — `(current user)` resolved to the actor; formulas recomputed),
 * inserts the version-1 `card_versions` snapshot carrying them, and
 * appends a CardCreated event naming the defaulted properties, all in
 * one transaction. A defaulted card is version 1, not 1+N; a value a
 * caller sets afterwards is its own version, as ever. The number
 * sequence continues past an explicit number (the next card takes one
 * past the highest ever used).
 * REJECTS: unknown project, actor below full team member (legacy: card
 * create is FULL_TEAM_MEMBER — readonly members cannot), blank name,
 * name over 255 chars, a card type not belonging to the project, an
 * explicit number that is not a positive integer or is already used
 * (live or deleted — numbers are never reused), or a stored default
 * the property no longer accepts ("Unable to set default for …").
 *
 * @returns the created card row, or field errors
 */
export function createCard(
  db: BetterSQLite3Database,
  input: CreateCardInput,
): CommandResult<CardRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const nameError = cardNameError(name);
  if (nameError) return reject("name", nameError);
  const cardType = findCardType(db, input.projectId, input.cardTypeId);
  if (!cardType) return reject("cardType", "must be selected");
  if (input.number !== undefined && input.number !== null) {
    if (!Number.isInteger(input.number) || input.number <= 0) return reject("number", "must be a positive whole number");
    if (cardNumberUsed(db, input.projectId, input.number)) return reject("number", "has already been taken");
  }
  // The card type's defaults, validated before the transaction opens so
  // a stale default rejects the creation rather than half of it.
  const defaults = defaultPropertyChanges(db, input.projectId, cardType, input.actorUserId);
  if (!defaults.ok) return defaults;

  return db.transaction((tx) => {
    const number = input.number ?? nextCardNumber(tx, input.projectId);
    const row = tx
      .insert(cards)
      .values({
        projectId: input.projectId,
        number,
        name,
        description,
        cardTypeId: cardType.id,
        version: 1,
        createdByUserId: input.actorUserId,
        modifiedByUserId: input.actorUserId,
      })
      .returning()
      .get();
    if (defaults.value.length > 0) insertInitialPropertyValues(tx, input.projectId, row.id, defaults.value);
    tx.insert(cardVersions)
      .values({
        cardId: row.id,
        projectId: input.projectId,
        number,
        version: 1,
        name,
        description,
        cardTypeName: cardType.name,
        propertyValues: JSON.stringify(cardPropertySnapshot(tx, row.id)),
        createdByUserId: input.actorUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    scheduleHistoryNotification(tx, input.projectId);
    emitEvent(tx, {
      type: "CardCreated",
      aggregateType: "Card",
      aggregateId: row.id,
      payload: {
        projectId: input.projectId,
        number,
        name,
        cardTypeName: cardType.name,
        defaultedProperties: defaults.value.map((change) => change.definition.name),
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<CardRow>;
  });
}

export interface UpdateCardInput {
  projectId: number;
  cardNumber: number;
  name: string;
  description?: string | null;
  cardTypeId: number;
  actorUserId: number;
}

/**
 * UpdateCard — changes a card's name, description, or type, appending
 * the next version.
 *
 * DOES: updates the `cards` row (version incremented, modified stamps
 * set), inserts the matching `card_versions` snapshot, and appends a
 * CardUpdated event naming the changed fields, all in one transaction.
 * When the type changes, first keeps the card's trees consistent
 * (Phase 24, legacy `handle_card_type_change`): it leaves any tree the
 * new type is not on — children detached to its parent — and in the
 * trees it stays on, cards that named it through its old type detach
 * and its own relationships at or below its new level clear (one
 * version per affected card, via the tree commands); then refreshes
 * the aggregate values it and its ancestors carry, since its type
 * decides which aggregates it holds and which it counts toward.
 * REJECTS: unknown project or card, actor below full team member,
 * blank or over-long name, a card type not belonging to the project,
 * or no actual change (a version records a change; legacy skipped
 * silently, rule 10 makes the refusal explicit).
 *
 * @returns the updated card row, or field errors
 */
export function updateCard(
  db: BetterSQLite3Database,
  input: UpdateCardInput,
): CommandResult<CardRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const current = findCard(db, input.projectId, input.cardNumber);
  if (!current) return reject("card", "does not exist");

  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const nameError = cardNameError(name);
  if (nameError) return reject("name", nameError);
  const cardType = findCardType(db, input.projectId, input.cardTypeId);
  if (!cardType) return reject("cardType", "must be selected");

  const changed = [
    ...(name !== current.name ? ["name"] : []),
    ...(description !== current.description ? ["description"] : []),
    ...(cardType.id !== current.cardTypeId ? ["cardType"] : []),
  ];
  if (changed.length === 0) return reject("card", "has no changes to save");

  return db.transaction((tx) => {
    const typeChanged = cardType.id !== current.cardTypeId;
    if (typeChanged) reviseTreesForCardTypeChange(tx, input.projectId, current, cardType.id, input.actorUserId);
    // The tree revision may have appended versions to this card.
    const latest = typeChanged ? (findCard(tx, input.projectId, current.number) ?? current) : current;
    const nextVersion = latest.version + 1;
    const row = tx
      .update(cards)
      .set({
        name,
        description,
        cardTypeId: cardType.id,
        version: nextVersion,
        modifiedByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(cards.id, current.id))
      .returning()
      .get();
    tx.insert(cardVersions)
      .values({
        cardId: current.id,
        projectId: input.projectId,
        number: current.number,
        version: nextVersion,
        name,
        description,
        cardTypeName: cardType.name,
        propertyValues: JSON.stringify(cardPropertySnapshot(tx, current.id)),
        createdByUserId: current.createdByUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    if (typeChanged) recomputeAggregatesAround(tx, input.projectId, current.id);
    scheduleHistoryNotification(tx, input.projectId);
    emitEvent(tx, {
      type: "CardUpdated",
      aggregateType: "Card",
      aggregateId: current.id,
      payload: { projectId: input.projectId, number: current.number, changed },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<CardRow>;
  });
}

export interface DeleteCardInput {
  projectId: number;
  cardNumber: number;
  actorUserId: number;
}

/**
 * DeleteCard — deletes a card, keeping its history.
 *
 * DOES: takes the card out of every tree it belongs to (Phase 24:
 * cards below it detach to its parent with one version each, its
 * belonging rows go), deletes the `cards` row along with the card's checklist items,
 * attachment rows, and property value rows (legacy dependent-destroy
 * parity; attachment BYTES are the caller's cleanup via the deleted
 * rows' fileKeys), refreshes the aggregate values of the ancestors it
 * counted toward, keeps
 * every existing `card_versions` row, appends a final deletion version
 * (next version number, name and type snapshot retained, description
 * empty — legacy create_card_deletion_version parity — isDeletion
 * flagged, stamped by the deleting user), and appends a CardDeleted
 * event, all in one transaction. The card's number stays reserved
 * forever.
 * REJECTS: unknown project or card, or actor below project
 * administrator (legacy: card destroy is PROJECT_ADMIN — full members
 * cannot).
 *
 * @returns the deleted card row, or field errors
 */
export function deleteCard(
  db: BetterSQLite3Database,
  input: DeleteCardInput,
): CommandResult<CardRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const current = findCard(db, input.projectId, input.cardNumber);
  if (!current) return reject("card", "does not exist");
  const cardType = findCardType(db, input.projectId, current.cardTypeId);

  return db.transaction((tx) => {
    const holders = aggregateHoldersOf(tx, input.projectId, current.id);
    removeDeletedCardFromTrees(tx, input.projectId, current, input.actorUserId);
    tx.insert(cardVersions)
      .values({
        cardId: current.id,
        projectId: input.projectId,
        number: current.number,
        version: current.version + 1,
        name: current.name,
        description: null,
        cardTypeName: cardType?.name ?? "",
        isDeletion: true,
        createdByUserId: current.createdByUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    tx.delete(cardChecklistItems)
      .where(eq(cardChecklistItems.cardId, current.id))
      .run();
    tx.delete(attachments).where(eq(attachments.cardId, current.id)).run();
    tx.delete(cardPropertyValues)
      .where(eq(cardPropertyValues.cardId, current.id))
      .run();
    tx.delete(cards).where(eq(cards.id, current.id)).run();
    recomputeAggregatesFor(tx, input.projectId, holders);
    scheduleHistoryNotification(tx, input.projectId);
    emitEvent(tx, {
      type: "CardDeleted",
      aggregateType: "Card",
      aggregateId: current.id,
      payload: { projectId: input.projectId, number: current.number, name: current.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: current } as CommandResult<CardRow>;
  });
}
