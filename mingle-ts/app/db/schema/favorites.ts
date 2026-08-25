/**
 * Card Management schema — the `favorites` table (Phase 11).
 *
 * Purpose: persistence shape for saved card views. A favorite is a
 * named, reusable list/grid configuration — the legacy `Favorite` +
 * `CardListView` pair collapsed into one row (pages are not yet a
 * favoritable thing; `kind` is the discriminator a future page
 * favorite would extend). Scope is either the team (`user_id` NULL)
 * or one user (personal favorite). A team favorite may additionally
 * be promoted to a project tab (`tab_view`); personal favorites never
 * are — the domain layer enforces that invariant.
 *
 * View parameters are stored in their canonical legacy wire form so a
 * favorite reopens to exactly the URL it was saved from: `filters` is
 * a JSON array of legacy-encoded `[Property][operator][value]`
 * strings, `columns` a JSON array of column names, `group_by` the
 * lane property name (grid style only), `mql` the advanced-filter
 * text when the view filters by MQL instead (Phase 13).
 *
 * Public interface: `favorites` (Drizzle table), `FavoriteRow`.
 * Enforcement of the write rules lives in
 * app/domain/cards/favorites.server — never write this table from
 * route code directly.
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

export const favorites = sqliteTable(
  "favorites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** NULL = team favorite; otherwise the owning user's id (personal). */
    userId: integer("user_id"),
    /** What is favorited; "card_view" today, "page" once wiki pages exist. */
    kind: text("kind").notNull().default("card_view"),
    /** Display name; unique case-insensitively within project + scope. */
    name: text("name").notNull(),
    /** True when this team favorite is shown as a project tab. */
    tabView: integer("tab_view", { mode: "boolean" }).notNull().default(false),
    /** One of CARD_VIEW_STYLES (wire-types): list | grid. */
    style: text("style").notNull(),
    /** JSON array of legacy-encoded filters[] strings. */
    filters: text("filters").notNull().default("[]"),
    /** JSON array of column names (list style). */
    columns: text("columns").notNull().default("[]"),
    /** Lane property name (grid style); null when ungrouped or list. */
    groupBy: text("group_by"),
    /**
     * Advanced filter MQL text (legacy MqlFilters, `filters[mql]`);
     * null when the view filters simply. When set, `filters` is `[]`.
     */
    mql: text("mql"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy CardListView.uniqueness_conditions: name is unique
    // case-insensitively within the team scope, and within each user's
    // personal scope (a personal and a team favorite may share a name).
    // Two partial indexes rather than coalesce(): SQLite expression
    // indexes with commas do not survive drizzle-kit's SQL generation.
    uniqueIndex("favorites_team_name_ci_unique")
      .on(t.projectId, sql`lower(${t.name})`)
      .where(sql`${t.userId} IS NULL`),
    uniqueIndex("favorites_personal_name_ci_unique")
      .on(t.projectId, t.userId, sql`lower(${t.name})`)
      .where(sql`${t.userId} IS NOT NULL`),
    index("favorites_project_idx").on(t.projectId),
  ],
);

export type FavoriteRow = typeof favorites.$inferSelect;
