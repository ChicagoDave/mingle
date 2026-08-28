/**
 * Collaboration schema — the `murmurs`, `murmur_mentions` and
 * `card_murmur_links` tables (Phase 20).
 *
 * Purpose: persistence shape for the Murmur aggregate — a short,
 * project-scoped message posted either to the project stream or as a
 * comment on a card. Legacy modelled the two as an STI hierarchy
 * (`DefaultMurmur` / `CardCommentMurmur` sharing a `type` column);
 * that collapses here to an `origin_type` discriminator, the same move
 * Phase 14 made for transition prerequisites.
 *
 * Two deliberate divergences from legacy, both in the direction of
 * making a derived fact a stored one:
 *
 *  - Legacy recomputed `@mention` resolution on every read
 *    (`MurmurUserMentions`), so "who was mentioned" answered
 *    differently as team membership changed underneath it, and could
 *    not be queried at all without loading every murmur body.
 *    `murmur_mentions` records the resolution reached when the murmur
 *    was posted: one row per (murmur, mentioned user), carrying how
 *    the mention was written.
 *  - Legacy built `card_murmur_links` asynchronously through a message
 *    queue (`CardMurmurLinkProcessor`), so a murmur was briefly linked
 *    to nothing. Here the links are written in the posting
 *    transaction — a murmur is never visible without them.
 *
 * Public interface: `murmurs`, `murmurMentions`, `cardMurmurLinks`
 * (Drizzle tables) and their row types. Enforcement of the write rules
 * lives in app/domain/murmurs — never insert into these tables from
 * route code directly.
 *
 * Owner context: Collaboration.
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * What a murmur was posted against. `project` is the open stream
 * (legacy DefaultMurmur); `card` is a card comment (legacy
 * CardCommentMurmur, whose polymorphic `origin` was only ever a Card).
 */
export const MURMUR_ORIGIN_TYPES = ["project", "card"] as const;
export type MurmurOriginType = (typeof MURMUR_ORIGIN_TYPES)[number];

export const murmurs = sqliteTable(
  "murmurs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /**
     * The message as typed. PLAIN TEXT, never markup: readers render
     * it into structured segments and escape it there, so a body can
     * never carry markup into a page (ADR-0011's generated-not-passed
     * -through rule, applied to a context that has no editor).
     * Non-blank and stripped at write (legacy `strip_murmur` +
     * validates_presence_of).
     */
    body: text("body").notNull(),
    authorUserId: integer("author_user_id").notNull(),
    /** See MURMUR_ORIGIN_TYPES. Validity enforced in the domain layer. */
    originType: text("origin_type").notNull(),
    /**
     * The card this murmur comments on when `origin_type` is 'card';
     * NULL for a project-stream murmur. The card row may later be
     * deleted — legacy rendered "deleted card" rather than removing
     * the murmur, so this is deliberately not a cascade.
     */
    originCardId: integer("origin_card_id"),
    /**
     * The card version this comment was stored on, when the murmur is
     * a card comment. Legacy wrote the comment text onto the version
     * AND created the murmur; this column is the join between the two
     * halves, so a comment can be read from the history trail or the
     * murmur stream and reach the same row.
     */
    originCardVersion: integer("origin_card_version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy's index_murmurs_on_project_id_and_created_at — the stream
    // is always read newest-first within one project.
    index("murmurs_project_created_idx").on(t.projectId, t.createdAt),
    index("murmurs_origin_card_idx").on(t.originCardId),
  ],
);

export type MurmurRow = typeof murmurs.$inferSelect;

/**
 * How a mention was written. Legacy's `MurmurUserMentions.detect`
 * recognised the same three forms: the literal `@team`, a group name,
 * or a user login.
 */
export const MENTION_KINDS = ["team", "group", "user"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const murmurMentions = sqliteTable(
  "murmur_mentions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    murmurId: integer("murmur_id").notNull(),
    projectId: integer("project_id").notNull(),
    /** See MENTION_KINDS. Validity enforced in the domain layer. */
    kind: text("kind").notNull(),
    /**
     * The resolved team member. A `@team` or group mention produces
     * one row per member it expanded to, which is what makes "murmurs
     * mentioning me" a single indexed query rather than a body scan.
     */
    userId: integer("user_id").notNull(),
    /** The group a `group` mention expanded through; NULL otherwise. */
    groupId: integer("group_id"),
    /**
     * The token as written, without the leading "@" — kept so the
     * rendered murmur can link the words the author actually typed
     * rather than a name reconstructed from the resolution.
     */
    mentionText: text("mention_text").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // One row per mentioned user per murmur: legacy's `users` list was
    // `.uniq`, so "@team @alice" mentions alice once, not twice. The
    // index makes that an invariant rather than a convention.
    uniqueIndex("murmur_mentions_user_unique").on(t.murmurId, t.userId),
    index("murmur_mentions_user_idx").on(t.userId),
    index("murmur_mentions_murmur_idx").on(t.murmurId),
  ],
);

export type MurmurMentionRow = typeof murmurMentions.$inferSelect;

export const cardMurmurLinks = sqliteTable(
  "card_murmur_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    cardId: integer("card_id").notNull(),
    murmurId: integer("murmur_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy validates_uniqueness_of :murmur_id, :scope => :card_id.
    uniqueIndex("card_murmur_links_unique").on(t.cardId, t.murmurId),
    // Legacy idx_cml_on_card_and_mur_id, for a card's discussion.
    index("card_murmur_links_card_idx").on(t.cardId),
  ],
);

export type CardMurmurLinkRow = typeof cardMurmurLinks.$inferSelect;
