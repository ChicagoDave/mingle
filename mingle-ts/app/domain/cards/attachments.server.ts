/**
 * Card Management command handlers — card attachments (Phase 6).
 *
 * Purpose: the only write path for attachment ROWS. File BYTES are the
 * storage adapter's business (app/files/attachment-storage.server.ts):
 * routes save bytes first, then run the command, and delete the bytes
 * again if the command rejects — this module never touches the
 * filesystem. Display names are unique per project: a collision gets a
 * short random suffix rather than a rejection or a replace (legacy
 * AttachmentNameUniqueness parity). Attaching records the card's
 * current version but does not bump it (deferred to the history
 * phases; see card-content schema header).
 *
 * Commands → events:
 *   AddCardAttachment    → CardAttachmentAdded
 *   RemoveCardAttachment → CardAttachmentRemoved
 *
 * Public interface: `addCardAttachment`, `removeCardAttachment`.
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, type CardRow } from "~/db/schema/cards";
import { attachments, type AttachmentRow } from "~/db/schema/card-content";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

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

/** True when a display name is already used in the project (CI). */
function fileNameTaken(
  db: BetterSQLite3Database,
  projectId: number,
  fileName: string,
): boolean {
  return Boolean(
    db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.projectId, projectId),
          sql`lower(${attachments.fileName}) = ${fileName.toLowerCase()}`,
        ),
      )
      .get(),
  );
}

/**
 * Appends a short random suffix to a colliding display name, keeping
 * the extension (".tar.gz" treated as one extension — legacy
 * AttachmentNameUniqueness parity).
 *
 * @param fileName - the sanitized display name
 * @param suffix - six random hex chars supplied by the caller
 */
function suffixedFileName(fileName: string, suffix: string): string {
  const lower = fileName.toLowerCase();
  const ext = lower.endsWith(".tar.gz")
    ? fileName.slice(-7)
    : fileName.includes(".")
      ? fileName.slice(fileName.lastIndexOf("."))
      : "";
  const base = fileName.slice(0, fileName.length - ext.length);
  return `${base}-${suffix}${ext}`;
}

export interface AddCardAttachmentInput {
  projectId: number;
  cardNumber: number;
  /** Sanitized display name (attachment-storage sanitizeFileName). */
  fileName: string;
  /** Storage key of the already-saved bytes. */
  fileKey: string;
  contentType: string;
  size: number;
  /** Six hex chars for name collisions, supplied so the command stays deterministic in tests. */
  uniqueSuffix: string;
  actorUserId: number;
}

/**
 * AddCardAttachment — records an uploaded file against a card.
 *
 * DOES: inserts an `attachments` row (display name suffixed when taken
 * in the project, card's current version recorded) and appends a
 * CardAttachmentAdded event.
 * REJECTS: unknown project or card, actor below full team member
 * (legacy: attaching is card editing), or a blank file name. The
 * caller must delete the stored bytes when this rejects.
 *
 * @returns the created attachment row, or field errors
 */
export function addCardAttachment(
  db: BetterSQLite3Database,
  input: AddCardAttachmentInput,
): CommandResult<AttachmentRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const card = findCard(db, input.projectId, input.cardNumber);
  if (!card) return reject("card", "does not exist");
  if (!input.fileName.trim()) return reject("file", "can't be blank");

  const fileName = fileNameTaken(db, input.projectId, input.fileName)
    ? suffixedFileName(input.fileName, input.uniqueSuffix)
    : input.fileName;

  return db.transaction((tx) => {
    const row = tx
      .insert(attachments)
      .values({
        projectId: input.projectId,
        cardId: card.id,
        cardVersion: card.version,
        fileName,
        fileKey: input.fileKey,
        contentType: input.contentType,
        size: input.size,
        uploadedByUserId: input.actorUserId,
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "CardAttachmentAdded",
      aggregateType: "Card",
      aggregateId: card.id,
      payload: {
        projectId: input.projectId,
        number: card.number,
        fileName: row.fileName,
        size: row.size,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<AttachmentRow>;
  });
}

export interface RemoveCardAttachmentInput {
  projectId: number;
  cardNumber: number;
  attachmentId: number;
  actorUserId: number;
}

/**
 * RemoveCardAttachment — detaches a file from a card.
 *
 * DOES: deletes the `attachments` row and appends a
 * CardAttachmentRemoved event. Byte cleanup is the caller's job (the
 * returned row carries the fileKey).
 * REJECTS: unknown project or card, actor below full team member, or
 * an attachment not belonging to that card.
 *
 * @returns the removed attachment row, or field errors
 */
export function removeCardAttachment(
  db: BetterSQLite3Database,
  input: RemoveCardAttachmentInput,
): CommandResult<AttachmentRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const card = findCard(db, input.projectId, input.cardNumber);
  if (!card) return reject("card", "does not exist");
  const attachment = db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.id, input.attachmentId), eq(attachments.cardId, card.id)),
    )
    .get();
  if (!attachment) return reject("attachment", "does not exist");

  return db.transaction((tx) => {
    tx.delete(attachments).where(eq(attachments.id, attachment.id)).run();
    emitEvent(tx, {
      type: "CardAttachmentRemoved",
      aggregateType: "Card",
      aggregateId: card.id,
      payload: {
        projectId: input.projectId,
        number: card.number,
        fileName: attachment.fileName,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: attachment } as CommandResult<AttachmentRow>;
  });
}
