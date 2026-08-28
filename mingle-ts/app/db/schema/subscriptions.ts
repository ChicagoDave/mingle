/**
 * Collaboration schema — the `history_subscriptions` table (Phase 22).
 *
 * Purpose: persistence shape for a user's standing request to be
 * emailed about project history — everything in a project, one card,
 * one page, or the cards an MQL condition selects (legacy
 * `HistorySubscription`, whose serialized `filter_params` collapse to
 * a `kind` discriminator plus the one field that kind needs).
 *
 * Delivery position is stored per trail, as legacy stored
 * `last_max_card_version_id` / `last_max_page_version_id`: the three
 * history sources have independent id spaces (see
 * app/domain/history/read.server.ts), so a single cursor could not
 * say "everything after here" for all of them. Each cursor is the
 * highest source id already considered for this subscription; a fresh
 * entry is one whose id is above the cursor for its trail.
 *
 * Public interface: `historySubscriptions` (Drizzle table),
 * `HistorySubscriptionRow`. Written only through
 * app/domain/subscriptions — never insert from route code.
 *
 * Owner context: Collaboration.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const historySubscriptions = sqliteTable(
  "history_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** The subscriber — also the recipient; the address is read at send time. */
    userId: integer("user_id").notNull(),
    /** See SUBSCRIPTION_KINDS in app/shared/wire-types.ts. */
    kind: text("kind").notNull(),
    /** The card's number when `kind` is 'card'; NULL otherwise. */
    cardNumber: integer("card_number"),
    /** The page's URL identifier when `kind` is 'page'; NULL otherwise. */
    pageIdentifier: text("page_identifier"),
    /** The MQL condition when `kind` is 'mql'; NULL otherwise. */
    mql: text("mql"),
    /**
     * The filter in one comparable string (legacy `hashed_filter_params`):
     * the unique index below cannot span nullable columns, since SQLite
     * treats every NULL as distinct.
     */
    filterKey: text("filter_key").notNull(),
    /** Highest `card_versions.id` already considered. */
    lastCardVersionId: integer("last_card_version_id").notNull().default(0),
    /** Highest `page_versions.id` already considered. */
    lastPageVersionId: integer("last_page_version_id").notNull().default(0),
    /** Highest `murmurs.id` already considered. */
    lastMurmurId: integer("last_murmur_id").notNull().default(0),
    /**
     * Why the last delivery could not evaluate this subscription (an
     * MQL filter that no longer parses, a subscriber with no address);
     * NULL when healthy. Legacy `error_message`.
     */
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // One subscription per user per filter per project — subscribing
    // twice to the same thing is a rejection, not a second row.
    uniqueIndex("history_subscriptions_unique").on(t.userId, t.projectId, t.filterKey),
    // Delivery walks a project's subscriptions; the list page walks a user's.
    index("history_subscriptions_project_idx").on(t.projectId),
    index("history_subscriptions_user_idx").on(t.userId),
  ],
);

export type HistorySubscriptionRow = typeof historySubscriptions.$inferSelect;
