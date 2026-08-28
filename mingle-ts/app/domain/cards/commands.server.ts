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
 *   CreateCard     → CardCreated   (+ version 1)
 *   UpdateCard     → CardUpdated   (+ next version)
 *   DeleteCard     → CardDeleted   (+ deletion version)
 *
 * Public interface: `defineCardType`, `createCard`, `updateCard`,
 * `deleteCard`.
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
import { cardPropertySnapshot } from "~/domain/cards/properties.server";
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

export interface CreateCardInput {
  projectId: number;
  name: string;
  description?: string | null;
  cardTypeId: number;
  actorUserId: number;
}

/**
 * CreateCard — creates a card as version 1 of its history.
 *
 * DOES: inserts a `cards` row (number = the project's next, version 1)
 * plus its version-1 `card_versions` snapshot, and appends a
 * CardCreated event, all in one transaction.
 * REJECTS: unknown project, actor below full team member (legacy: card
 * create is FULL_TEAM_MEMBER — readonly members cannot), blank name,
 * name over 255 chars, or a card type not belonging to the project.
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

  return db.transaction((tx) => {
    const number = nextCardNumber(tx, input.projectId);
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
    tx.insert(cardVersions)
      .values({
        cardId: row.id,
        projectId: input.projectId,
        number,
        version: 1,
        name,
        description,
        cardTypeName: cardType.name,
        createdByUserId: input.actorUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    scheduleHistoryNotification(tx, input.projectId);
    emitEvent(tx, {
      type: "CardCreated",
      aggregateType: "Card",
      aggregateId: row.id,
      payload: { projectId: input.projectId, number, name, cardTypeName: cardType.name },
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
    const nextVersion = current.version + 1;
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
 * DOES: deletes the `cards` row along with the card's checklist items,
 * attachment rows, and property value rows (legacy dependent-destroy
 * parity; attachment BYTES are the caller's cleanup via the deleted
 * rows' fileKeys), keeps
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
