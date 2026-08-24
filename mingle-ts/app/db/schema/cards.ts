/**
 * Card Management schema — the `card_types`, `cards`, and
 * `card_versions` tables.
 *
 * Purpose: persistence shape for the Card aggregate, its CardType, and
 * its append-only version history (Phase 5), modeled on the legacy
 * `card_versions` table: a current-state `cards` row plus a
 * never-overwritten version trail. Versions are kept when a card is
 * deleted, and deletion itself appends a final deletion version
 * (legacy acts_as_versioned_ext `keep_versions_on_destroy` +
 * `create_card_deletion_version`). Card numbers are per-project and
 * never reused. Deliberate modernization: `cards` references its type
 * by id; `card_versions` snapshots the type *name* as text so history
 * reads as it did at the time.
 *
 * Public interface: `cardTypes`, `cards`, `cardVersions` (Drizzle
 * tables). Enforcement of the write rules lives in app/domain/cards —
 * never insert into these tables from route code directly, and never
 * update or delete a `card_versions` row anywhere.
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

export const cardTypes = sqliteTable(
  "card_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** Display name; unique case-insensitively within the project. */
    name: text("name").notNull(),
    /** Ordering position within the project (legacy card type ordering). */
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Per-project case-insensitive name uniqueness, matching the legacy
    // validates_uniqueness_of :name, :scope => 'project_id', :case_sensitive => false.
    uniqueIndex("card_types_name_ci_unique").on(
      t.projectId,
      sql`lower(${t.name})`,
    ),
    index("card_types_project_idx").on(t.projectId),
  ],
);

export type CardTypeRow = typeof cardTypes.$inferSelect;

export const cards = sqliteTable(
  "cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /**
     * Per-project card number, assigned by the domain layer from the
     * project's highest number across live cards AND versions of
     * deleted cards — numbers are never reused (legacy sequence parity).
     */
    number: integer("number").notNull(),
    /** Non-blank (legacy validates_presence_of :name). */
    name: text("name").notNull(),
    description: text("description"),
    cardTypeId: integer("card_type_id").notNull(),
    /** Current version number; the matching card_versions row is the latest. */
    version: integer("version").notNull(),
    createdByUserId: integer("created_by_user_id").notNull(),
    modifiedByUserId: integer("modified_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("cards_number_unique").on(t.projectId, t.number),
    index("cards_project_idx").on(t.projectId),
    index("cards_type_idx").on(t.cardTypeId),
  ],
);

export type CardRow = typeof cards.$inferSelect;

export const cardVersions = sqliteTable(
  "card_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The card this version belongs to; the card row may no longer exist. */
    cardId: integer("card_id").notNull(),
    projectId: integer("project_id").notNull(),
    /** The card's number, retained so deleted numbers stay reserved. */
    number: integer("number").notNull(),
    /** 1-based, dense per card; the deletion version is the last. */
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Snapshot of the type's name at version time (historical fidelity). */
    cardTypeName: text("card_type_name").notNull(),
    /**
     * JSON object snapshot of the card's managed property values at
     * version time, keyed by property definition ID (stringified) with
     * canonical stored values — id-keyed so snapshots stay immutable
     * through property renames (ADR-0004); readers join
     * property_definitions for the current name. "{}" when the card has
     * no property values set; the deletion version snapshots "{}"
     * (mirroring its emptied description).
     */
    propertyValues: text("property_values").notNull().default("{}"),
    /** True only on the final version appended when the card is deleted. */
    isDeletion: integer("is_deletion", { mode: "boolean" })
      .notNull()
      .default(false),
    createdByUserId: integer("created_by_user_id").notNull(),
    modifiedByUserId: integer("modified_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("card_versions_version_unique").on(t.cardId, t.version),
    index("card_versions_card_idx").on(t.cardId),
    index("card_versions_project_number_idx").on(t.projectId, t.number),
  ],
);

export type CardVersionRow = typeof cardVersions.$inferSelect;
