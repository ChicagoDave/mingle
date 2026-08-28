/**
 * Collaboration read models — the murmur stream, a card's discussion,
 * and a user's mentions (Phase 20).
 *
 * Purpose: the query side of the Murmur aggregate. Every view here is
 * built from the rows the posting transaction wrote — never by
 * re-scanning bodies — so a murmur's mentions and card links read the
 * same in every view, and "murmurs mentioning me" is an indexed lookup
 * rather than a table scan over text.
 *
 * Bodies are stored as plain text and reach callers as structured
 * segments, never as HTML: the route renders each segment as JSX,
 * which escapes it. That keeps ADR-0011's promise — output is
 * generated, never passed through — in a context that has no editor
 * and no sanitizer.
 *
 * Public interface: `MurmurView`, `renderMurmurBody`,
 * `listProjectMurmurs`, `cardDiscussion`, `murmursMentioning`,
 * `cardCommentCount`. The segment shape itself is a wire type and
 * lives in app/shared/wire-types.ts (rule 8b), re-exported here for
 * server-side callers.
 *
 * Owner context: Collaboration. Read-only — nothing here writes.
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardVersions } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import {
  cardMurmurLinks,
  murmurMentions,
  murmurs,
  type MurmurOriginType,
} from "~/db/schema/murmurs";
import { MENTION_TOKEN } from "~/domain/murmurs/mentions.server";
import { CARD_REFERENCE } from "~/domain/text-references.server";
import type { MurmurSegment } from "~/shared/wire-types";

export type { MurmurSegment };

/** A murmur prepared for display. */
export interface MurmurView {
  id: number;
  body: MurmurSegment[];
  authorUserId: number;
  authorName: string;
  originType: MurmurOriginType;
  /** The card number this murmur comments on, when it is a comment. */
  originCardNumber: number | null;
  originCardVersion: number | null;
  /**
   * True when this murmur comments on a card that has since been
   * deleted. The murmur outlives the card (legacy rendered "deleted
   * card" rather than dropping the comment), and its number is
   * recovered from the version trail, which deletion keeps.
   */
  originCardDeleted: boolean;
  createdAt: Date;
}

/** What `renderMurmurBody` needs to decide which words become links. */
export interface MurmurRenderContext {
  /**
   * The mention tokens this murmur actually resolved to when it was
   * posted, lowercased and without "@" — read from `murmur_mentions`,
   * so the rendered links and the stored facts cannot diverge.
   */
  mentionTokens: Set<string>;
  /** Whether a referenced card number names a card in this project. */
  cardExists: (number: number) => boolean;
}

/** Splits one run of text on `#123` references that name real cards. */
function splitCardReferences(
  text: string,
  ctx: MurmurRenderContext,
): MurmurSegment[] {
  const out: MurmurSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CARD_REFERENCE)) {
    const number = Number(match[2]);
    if (!ctx.cardExists(number)) continue;
    const at = match.index + match[1].length;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    last = at + match[0].length - match[1].length;
    out.push({ kind: "card", number });
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/**
 * Turns a stored murmur body into display segments: `@` tokens that
 * resolved to somebody become mention segments, `#123` references to
 * real cards become card segments, everything else stays text.
 *
 * A token written with a trailing period matches the bare form when
 * that is what resolved — "ask @bob." links `bob` and leaves the
 * period as text — mirroring the both-forms rule the parser applies
 * (see mentionTokensIn).
 *
 * @param body - the stored body, as typed
 * @param ctx - what resolved when the murmur was posted
 * @returns segments in body order; concatenating their text
 *   reproduces the body exactly
 */
export function renderMurmurBody(
  body: string,
  ctx: MurmurRenderContext,
): MurmurSegment[] {
  const out: MurmurSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const written = match[2];
    const lowered = written.toLowerCase();
    // Prefer the token as written; fall back to the bare form when a
    // trailing period was not part of what resolved.
    const token = ctx.mentionTokens.has(lowered)
      ? written
      : lowered.endsWith(".") &&
          lowered.length > 1 &&
          ctx.mentionTokens.has(lowered.slice(0, -1))
        ? written.slice(0, -1)
        : null;
    if (token === null) continue;

    const at = match.index + match[1].length;
    if (at > last)
      out.push(...splitCardReferences(body.slice(last, at), ctx));
    last = at + 1 + token.length;
    out.push({ kind: "mention", token });
  }
  if (last < body.length) out.push(...splitCardReferences(body.slice(last), ctx));
  return out;
}

/** The mention tokens each of the given murmurs resolved to. */
function mentionTokensByMurmur(
  db: BetterSQLite3Database,
  murmurIds: number[],
): Map<number, Set<string>> {
  const byMurmur = new Map<number, Set<string>>();
  if (murmurIds.length === 0) return byMurmur;
  const rows = db
    .select({
      murmurId: murmurMentions.murmurId,
      mentionText: murmurMentions.mentionText,
    })
    .from(murmurMentions)
    .where(inArray(murmurMentions.murmurId, murmurIds))
    .all();
  for (const row of rows) {
    const tokens = byMurmur.get(row.murmurId) ?? new Set<string>();
    tokens.add(row.mentionText);
    byMurmur.set(row.murmurId, tokens);
  }
  return byMurmur;
}

/** The card numbers that exist in a project, among those referenced. */
function existingCardNumbers(
  db: BetterSQLite3Database,
  projectId: number,
  numbers: number[],
): Set<number> {
  if (numbers.length === 0) return new Set();
  const rows = db
    .select({ number: cards.number })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), inArray(cards.number, numbers)))
    .all();
  return new Set(rows.map((row) => row.number));
}

/** The shape a murmur row plus its author name arrives in. */
interface MurmurWithAuthor {
  id: number;
  body: string;
  authorUserId: number;
  authorName: string | null;
  originType: string;
  originCardId: number | null;
  originCardVersion: number | null;
  createdAt: Date;
}

/**
 * Prepares raw murmur rows for display in ONE pass over the batch:
 * mention tokens and card existence are each resolved with a single
 * query for the whole page, not per murmur.
 */
function toViews(
  db: BetterSQLite3Database,
  projectId: number,
  rows: MurmurWithAuthor[],
): MurmurView[] {
  if (rows.length === 0) return [];
  const tokensByMurmur = mentionTokensByMurmur(
    db,
    rows.map((row) => row.id),
  );
  const referenced = new Set<number>();
  for (const row of rows)
    for (const match of row.body.matchAll(CARD_REFERENCE))
      referenced.add(Number(match[2]));
  const existing = existingCardNumbers(db, projectId, [...referenced]);

  const originCardIds = rows
    .map((row) => row.originCardId)
    .filter((id): id is number => id !== null);
  // A commented card may since have been deleted, which removes the
  // `cards` row but keeps the version trail — so the NUMBER comes from
  // `card_versions` (present either way) and only the still-alive check
  // reads `cards`.
  const numberByCardId = new Map<number, number>(
    originCardIds.length === 0
      ? []
      : db
          .selectDistinct({ id: cardVersions.cardId, number: cardVersions.number })
          .from(cardVersions)
          .where(inArray(cardVersions.cardId, originCardIds))
          .all()
          .map((row) => [row.id, row.number] as const),
  );
  const liveCardIds = new Set(
    originCardIds.length === 0
      ? []
      : db
          .select({ id: cards.id })
          .from(cards)
          .where(inArray(cards.id, originCardIds))
          .all()
          .map((row) => row.id),
  );

  return rows.map((row) => ({
    id: row.id,
    body: renderMurmurBody(row.body, {
      mentionTokens: tokensByMurmur.get(row.id) ?? new Set(),
      cardExists: (number) => existing.has(number),
    }),
    authorUserId: row.authorUserId,
    // A murmur outlives nothing here — users are never hard-deleted —
    // but the join is left-safe so a missing author cannot blank a page.
    authorName: row.authorName ?? "(unknown user)",
    originType: row.originType as MurmurOriginType,
    originCardNumber:
      row.originCardId === null
        ? null
        : (numberByCardId.get(row.originCardId) ?? null),
    originCardVersion: row.originCardVersion,
    originCardDeleted:
      row.originCardId !== null && !liveCardIds.has(row.originCardId),
    createdAt: row.createdAt,
  }));
}

/** The select list every murmur query shares. */
const murmurColumns = {
  id: murmurs.id,
  body: murmurs.body,
  authorUserId: murmurs.authorUserId,
  authorName: users.name,
  originType: murmurs.originType,
  originCardId: murmurs.originCardId,
  originCardVersion: murmurs.originCardVersion,
  createdAt: murmurs.createdAt,
};

/** How many murmurs one page of the stream holds. */
export const MURMURS_PER_PAGE = 25;

/**
 * A project's murmur stream, newest first (legacy `Murmur.query`
 * ordered by id DESC).
 *
 * @param db - the Drizzle handle
 * @param projectId - the project whose stream to read
 * @param options.beforeId - return only murmurs older than this id,
 *   the cursor legacy called `before_id`
 * @param options.limit - page size, defaulting to MURMURS_PER_PAGE
 */
export function listProjectMurmurs(
  db: BetterSQLite3Database,
  projectId: number,
  options: { beforeId?: number; limit?: number } = {},
): MurmurView[] {
  const rows = db
    .select(murmurColumns)
    .from(murmurs)
    .leftJoin(users, eq(users.id, murmurs.authorUserId))
    .where(
      options.beforeId === undefined
        ? eq(murmurs.projectId, projectId)
        : and(
            eq(murmurs.projectId, projectId),
            lt(murmurs.id, options.beforeId),
          ),
    )
    .orderBy(desc(murmurs.id))
    .limit(options.limit ?? MURMURS_PER_PAGE)
    .all();
  return toViews(db, projectId, rows);
}

/**
 * A card's discussion: the comments posted on it, plus every murmur
 * elsewhere that referenced it by number — legacy's `card.murmurs`
 * (through `card_murmur_links`) unioned with its `origined_murmurs`.
 *
 * @param db - the Drizzle handle
 * @param projectId - the card's project
 * @param cardId - the card's row id
 * @returns the discussion newest first
 */
export function cardDiscussion(
  db: BetterSQLite3Database,
  projectId: number,
  cardId: number,
): MurmurView[] {
  const linkedIds = db
    .select({ murmurId: cardMurmurLinks.murmurId })
    .from(cardMurmurLinks)
    .where(eq(cardMurmurLinks.cardId, cardId))
    .all()
    .map((row) => row.murmurId);

  const rows = db
    .select(murmurColumns)
    .from(murmurs)
    .leftJoin(users, eq(users.id, murmurs.authorUserId))
    .where(
      and(
        eq(murmurs.projectId, projectId),
        linkedIds.length === 0
          ? eq(murmurs.originCardId, cardId)
          : or(
              eq(murmurs.originCardId, cardId),
              inArray(murmurs.id, linkedIds),
            ),
      ),
    )
    .orderBy(desc(murmurs.id))
    .all();
  return toViews(db, projectId, rows);
}

/**
 * The murmurs that named a user, newest first — the query the stored
 * mention rows exist to make possible.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project to look within
 * @param userId - the mentioned user
 * @param limit - page size, defaulting to MURMURS_PER_PAGE
 */
export function murmursMentioning(
  db: BetterSQLite3Database,
  projectId: number,
  userId: number,
  limit: number = MURMURS_PER_PAGE,
): MurmurView[] {
  const rows = db
    .select(murmurColumns)
    .from(murmurMentions)
    .innerJoin(murmurs, eq(murmurs.id, murmurMentions.murmurId))
    .leftJoin(users, eq(users.id, murmurs.authorUserId))
    .where(
      and(
        eq(murmurMentions.projectId, projectId),
        eq(murmurMentions.userId, userId),
      ),
    )
    .orderBy(desc(murmurs.id))
    .limit(limit)
    .all();
  return toViews(db, projectId, rows);
}

/**
 * How many comments a card carries, for a count beside its discussion
 * without loading the bodies.
 *
 * @param db - the Drizzle handle
 * @param cardId - the card's row id
 */
export function cardCommentCount(
  db: BetterSQLite3Database,
  cardId: number,
): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(murmurs)
    .where(eq(murmurs.originCardId, cardId))
    .get();
  return row?.count ?? 0;
}
