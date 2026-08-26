/**
 * Wiki & Content schema — the `pages` and `page_versions` tables
 * (Phase 16).
 *
 * Purpose: persistence shape for the Page aggregate and its
 * append-only version history, modeled on the legacy `page_versions`
 * table and deliberately mirroring Phase 5's Card versioning
 * discipline: a current-state `pages` row plus a never-overwritten
 * version trail. Versions are kept when a page is deleted, and
 * deletion itself appends a final deletion version (legacy
 * acts_as_versioned_ext `keep_versions_on_destroy` +
 * `create_deletion_page_version`). A page is addressed by its
 * identifier — its name with spaces replaced by underscores (legacy
 * `Page.name2identifier`) — so names are unique case-insensitively
 * within a project.
 *
 * Public interface: `pages`, `pageVersions` (Drizzle tables),
 * `PageRow`, `PageVersionRow`. Enforcement of the write rules lives in
 * app/domain/pages — never insert into these tables from route code
 * directly, and never update or delete a `page_versions` row anywhere.
 *
 * Owner context: Wiki & Content.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /**
     * Display name; non-blank, at most 255 chars, no "/" (legacy
     * `Page.validate_page_name`), unique case-insensitively within the
     * project. The URL identifier is derived from it, never stored.
     */
    name: text("name").notNull(),
    /**
     * Rendered body as sanitized HTML — the storage form the legacy
     * `pages.content` column held once RedCloth conversion was done.
     * NULL for a page saved with an empty body.
     */
    content: text("content"),
    /** Current version number; the matching page_versions row is the latest. */
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
    // Legacy validates_uniqueness_of :name, :scope => 'project_id',
    // :case_sensitive => false — made an invariant rather than a
    // convention, matching card_types_name_ci_unique.
    uniqueIndex("pages_name_ci_unique").on(t.projectId, sql`lower(${t.name})`),
    index("pages_project_idx").on(t.projectId),
  ],
);

export type PageRow = typeof pages.$inferSelect;

export const pageVersions = sqliteTable(
  "page_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The page this version belongs to; the page row may no longer exist. */
    pageId: integer("page_id").notNull(),
    projectId: integer("project_id").notNull(),
    /** 1-based, dense per page; the deletion version is the last. */
    version: integer("version").notNull(),
    /** Snapshot of the page's name at version time (survives renames). */
    name: text("name").notNull(),
    /** Snapshot of the body; NULL on the deletion version (legacy parity). */
    content: text("content"),
    /** True only on the final version appended when the page is deleted. */
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
    uniqueIndex("page_versions_version_unique").on(t.pageId, t.version),
    index("page_versions_page_idx").on(t.pageId),
    index("page_versions_project_idx").on(t.projectId),
  ],
);

export type PageVersionRow = typeof pageVersions.$inferSelect;
