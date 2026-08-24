/**
 * Card Management schema — the `attachments` and `card_checklist_items`
 * tables (Phase 6).
 *
 * Purpose: persistence shape for card-owned content. An attachment row
 * records the served file name (unique per project — legacy appended a
 * short random suffix to collisions), the storage key of its bytes on
 * the local filesystem volume, and the card version current when it
 * was attached. Checklist items carry a completed flag and a position
 * within their completed/incomplete list (legacy CardChecklistItem).
 * Neither touches the append-only `card_versions` trail — the legacy
 * attach-creates-a-version behavior is deferred to the history phases.
 *
 * Public interface: `attachments`, `cardChecklistItems` (Drizzle
 * tables). Enforcement of the write rules lives in app/domain/cards —
 * never insert into these tables from route code directly. File BYTES
 * live outside the database (app/files/attachment-storage.server.ts).
 *
 * Owner context: Card Management.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    cardId: integer("card_id").notNull(),
    /** The card's version when the file was attached (plan: "linked to a card and card version"). */
    cardVersion: integer("card_version").notNull(),
    /** Served file name; unique per project case-insensitively (legacy suffixing). */
    fileName: text("file_name").notNull(),
    /** Storage key relative to the attachments root: "<random-dir>/<name>". */
    fileKey: text("file_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    /** Byte size as stored. */
    size: integer("size").notNull(),
    uploadedByUserId: integer("uploaded_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy ensured a filename appears once per project (suffixing new
    // collisions); the index makes that an invariant, not a convention.
    uniqueIndex("attachments_file_name_ci_unique").on(
      t.projectId,
      sql`lower(${t.fileName})`,
    ),
    index("attachments_card_idx").on(t.cardId),
    index("attachments_project_idx").on(t.projectId),
  ],
);

export type AttachmentRow = typeof attachments.$inferSelect;

export const cardChecklistItems = sqliteTable(
  "card_checklist_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    cardId: integer("card_id").notNull(),
    /** Non-blank, max 255 chars (legacy ChecklistItem validations). */
    text: text("text").notNull(),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    /** 0-based position within the item's completed/incomplete list. */
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("card_checklist_items_card_idx").on(t.cardId)],
);

export type CardChecklistItemRow = typeof cardChecklistItems.$inferSelect;
