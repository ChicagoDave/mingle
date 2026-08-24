/**
 * Card Management command handlers — card checklist items (Phase 6).
 *
 * Purpose: the only write path for `card_checklist_items`. Ports the
 * legacy CardChecklistItem rules: text non-blank and at most 255
 * chars; items hold a 0-based position within their completed or
 * incomplete list, and completing/reopening moves the item to the end
 * of the list it enters (legacy mark_complete / mark_incomplete).
 * Checklist items are not versioned (legacy parity).
 *
 * Commands → events:
 *   AddChecklistItem    → ChecklistItemAdded
 *   MarkChecklistItem   → ChecklistItemCompleted | ChecklistItemReopened
 *   RemoveChecklistItem → ChecklistItemRemoved
 *
 * Public interface: `addChecklistItem`, `markChecklistItem`,
 * `removeChecklistItem`.
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, type CardRow } from "~/db/schema/cards";
import {
  cardChecklistItems,
  type CardChecklistItemRow,
} from "~/db/schema/card-content";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

const TEXT_MAX_LENGTH = 255;

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

/** Counts the card's items in one of the two lists (for end-of-list positions). */
function listLength(
  db: BetterSQLite3Database,
  cardId: number,
  completed: boolean,
): number {
  return db
    .select({ id: cardChecklistItems.id })
    .from(cardChecklistItems)
    .where(
      and(
        eq(cardChecklistItems.cardId, cardId),
        eq(cardChecklistItems.completed, completed),
      ),
    )
    .all().length;
}

/** Shared lookup + guards for the three commands; null result means a rejection. */
function checklistContext(
  db: BetterSQLite3Database,
  projectId: number,
  cardNumber: number,
  actorUserId: number,
): { card: CardRow } | CommandResult<never> {
  if (!projectExists(db, projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    actorUserId,
    projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;
  const card = findCard(db, projectId, cardNumber);
  if (!card) return reject("card", "does not exist");
  return { card };
}

export interface AddChecklistItemInput {
  projectId: number;
  cardNumber: number;
  text: string;
  actorUserId: number;
}

/**
 * AddChecklistItem — adds an incomplete item at the end of the card's
 * incomplete list.
 *
 * DOES: inserts a `card_checklist_items` row (completed false,
 * position = incomplete-list length) and appends a ChecklistItemAdded
 * event.
 * REJECTS: unknown project or card, actor below full team member,
 * blank text, or text over 255 chars.
 *
 * @returns the created item row, or field errors
 */
export function addChecklistItem(
  db: BetterSQLite3Database,
  input: AddChecklistItemInput,
): CommandResult<CardChecklistItemRow> {
  const context = checklistContext(
    db,
    input.projectId,
    input.cardNumber,
    input.actorUserId,
  );
  if (!("card" in context)) return context;

  const text = input.text.trim();
  if (!text) return reject("text", "can't be blank");
  if (text.length > TEXT_MAX_LENGTH)
    return reject("text", `is too long (maximum is ${TEXT_MAX_LENGTH} characters)`);

  return db.transaction((tx) => {
    const row = tx
      .insert(cardChecklistItems)
      .values({
        projectId: input.projectId,
        cardId: context.card.id,
        text,
        completed: false,
        position: listLength(tx, context.card.id, false),
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "ChecklistItemAdded",
      aggregateType: "Card",
      aggregateId: context.card.id,
      payload: { projectId: input.projectId, number: context.card.number, text },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<CardChecklistItemRow>;
  });
}

export interface MarkChecklistItemInput {
  projectId: number;
  cardNumber: number;
  itemId: number;
  completed: boolean;
  actorUserId: number;
}

/**
 * MarkChecklistItem — completes or reopens an item, moving it to the
 * end of the list it enters (legacy mark_complete / mark_incomplete).
 *
 * DOES: updates the row's completed flag and position (updated_at
 * stamped) and appends ChecklistItemCompleted or ChecklistItemReopened.
 * REJECTS: unknown project, card, or item (or an item of another
 * card), actor below full team member, or the item already being in
 * the requested state.
 *
 * @returns the updated item row, or field errors
 */
export function markChecklistItem(
  db: BetterSQLite3Database,
  input: MarkChecklistItemInput,
): CommandResult<CardChecklistItemRow> {
  const context = checklistContext(
    db,
    input.projectId,
    input.cardNumber,
    input.actorUserId,
  );
  if (!("card" in context)) return context;

  const item = db
    .select()
    .from(cardChecklistItems)
    .where(
      and(
        eq(cardChecklistItems.id, input.itemId),
        eq(cardChecklistItems.cardId, context.card.id),
      ),
    )
    .get();
  if (!item) return reject("item", "does not exist");
  if (item.completed === input.completed)
    return reject(
      "item",
      input.completed ? "is already completed" : "is not completed",
    );

  return db.transaction((tx) => {
    const row = tx
      .update(cardChecklistItems)
      .set({
        completed: input.completed,
        position: listLength(tx, context.card.id, input.completed),
        updatedAt: new Date(),
      })
      .where(eq(cardChecklistItems.id, item.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: input.completed ? "ChecklistItemCompleted" : "ChecklistItemReopened",
      aggregateType: "Card",
      aggregateId: context.card.id,
      payload: {
        projectId: input.projectId,
        number: context.card.number,
        text: item.text,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<CardChecklistItemRow>;
  });
}

export interface RemoveChecklistItemInput {
  projectId: number;
  cardNumber: number;
  itemId: number;
  actorUserId: number;
}

/**
 * RemoveChecklistItem — deletes an item from a card's checklist.
 *
 * DOES: deletes the `card_checklist_items` row and appends a
 * ChecklistItemRemoved event.
 * REJECTS: unknown project, card, or item (or an item of another
 * card), or actor below full team member.
 *
 * @returns the removed item row, or field errors
 */
export function removeChecklistItem(
  db: BetterSQLite3Database,
  input: RemoveChecklistItemInput,
): CommandResult<CardChecklistItemRow> {
  const context = checklistContext(
    db,
    input.projectId,
    input.cardNumber,
    input.actorUserId,
  );
  if (!("card" in context)) return context;

  const item = db
    .select()
    .from(cardChecklistItems)
    .where(
      and(
        eq(cardChecklistItems.id, input.itemId),
        eq(cardChecklistItems.cardId, context.card.id),
      ),
    )
    .get();
  if (!item) return reject("item", "does not exist");

  return db.transaction((tx) => {
    tx.delete(cardChecklistItems).where(eq(cardChecklistItems.id, item.id)).run();
    emitEvent(tx, {
      type: "ChecklistItemRemoved",
      aggregateType: "Card",
      aggregateId: context.card.id,
      payload: {
        projectId: input.projectId,
        number: context.card.number,
        text: item.text,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: item } as CommandResult<CardChecklistItemRow>;
  });
}
