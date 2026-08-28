/**
 * Collaboration command handlers — the Murmur aggregate (Phase 20).
 *
 * Purpose: the write path for murmurs. A murmur is a short plain-text
 * message posted either to a project's stream (legacy DefaultMurmur)
 * or as a comment on a card (legacy CardCommentMurmur). Posting one is
 * a single transaction that writes three facts together: the murmur
 * itself, the team members its `@` tokens resolved to, and the cards
 * its `#123` references name. Legacy wrote the last of those
 * asynchronously through a message queue, which left a window in which
 * a murmur existed but was linked to nothing; here the window does not
 * exist.
 *
 * A card comment additionally appends a card version carrying the
 * comment text, because that is where legacy stored it
 * (`Card::Comment#store_to` set `version.comment` and created the
 * murmur in the same breath). The two halves are joined by
 * `murmurs.origin_card_version`, so the history trail and the murmur
 * stream can never disagree about what was said.
 *
 * Commands → events:
 *   PostMurmur     → MurmurPosted
 *   AddCardComment → CardCommentAdded (+ next card version)
 *
 * Public interface: `postMurmur`, `addCardComment`.
 *
 * Owner context: Collaboration. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardTypes, cardVersions, type CardRow } from "~/db/schema/cards";
import {
  cardMurmurLinks,
  murmurMentions,
  murmurs,
  type MurmurRow,
} from "~/db/schema/murmurs";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { cardPropertySnapshot } from "~/domain/cards/properties.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";
import { resolveMentions } from "~/domain/murmurs/mentions.server";
import { cardNumbersInText } from "~/domain/text-references.server";

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

/**
 * The murmur body as stored: stripped of surrounding whitespace
 * (legacy `strip_murmur`) and required to be non-empty (legacy
 * validates_presence_of :murmur).
 */
function normalizeBody(body: string): string {
  return body.trim();
}

/**
 * Writes the mention rows for a murmur.
 *
 * @returns the user ids recorded as mentioned
 */
function recordMentions(
  tx: BetterSQLite3Database,
  murmurId: number,
  projectId: number,
  body: string,
): number[] {
  const resolved = resolveMentions(tx, projectId, body);
  for (const mention of resolved) {
    tx.insert(murmurMentions)
      .values({
        murmurId,
        projectId,
        kind: mention.kind,
        userId: mention.userId,
        groupId: mention.groupId,
        mentionText: mention.mentionText,
      })
      .run();
  }
  return resolved.map((mention) => mention.userId);
}

/**
 * Writes the card links for a murmur: every `#123` in the body that
 * names a card in this project, except the card the murmur is already
 * a comment on (legacy rejected `origin_id` — a comment is not "also
 * about" its own card).
 *
 * @returns the card ids linked
 */
function recordCardLinks(
  tx: BetterSQLite3Database,
  murmurId: number,
  projectId: number,
  body: string,
  originCardId: number | null,
): number[] {
  const numbers = cardNumbersInText(body);
  if (numbers.length === 0) return [];
  const linked = tx
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), inArray(cards.number, numbers)))
    .all()
    .map((row) => row.id)
    .filter((cardId) => cardId !== originCardId);
  for (const cardId of linked) {
    tx.insert(cardMurmurLinks).values({ projectId, cardId, murmurId }).run();
  }
  return linked;
}

export interface PostMurmurInput {
  projectId: number;
  body: string;
  actorUserId: number;
}

/**
 * PostMurmur — posts a message to a project's murmur stream.
 *
 * DOES: inserts a `murmurs` row with origin_type 'project' carrying
 * the stripped body and the author; inserts one `murmur_mentions` row
 * per distinct team member the body's `@` tokens resolved to; inserts
 * one `card_murmur_links` row per card in this project whose number
 * the body references with `#123`; and appends a MurmurPosted event —
 * all in one transaction.
 * WHEN: the project exists, the actor is at least a full team member,
 * and the body is non-blank after stripping.
 * BECAUSE: a murmur's mentions and card links are the facts other
 * views read (a card's discussion, "murmurs mentioning me"); deriving
 * them later would let the same body answer differently as membership
 * changed, and deriving them asynchronously would publish a murmur
 * that was briefly linked to nothing.
 * REJECTS WHEN: the project does not exist ("project does not exist");
 * the actor is below full team member (authorization rejection); the
 * body is blank or whitespace-only ("body can't be blank").
 *
 * @param db - the Drizzle handle
 * @param input - project, body as typed, and the posting actor
 * @returns the persisted murmur row, or field errors
 */
export function postMurmur(
  db: BetterSQLite3Database,
  input: PostMurmurInput,
): CommandResult<MurmurRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const body = normalizeBody(input.body);
  if (!body) return reject("body", "can't be blank");

  return db.transaction((tx) => {
    const row = tx
      .insert(murmurs)
      .values({
        projectId: input.projectId,
        body,
        authorUserId: input.actorUserId,
        originType: "project",
        originCardId: null,
        originCardVersion: null,
      })
      .returning()
      .get();
    const mentionedUserIds = recordMentions(tx, row.id, input.projectId, body);
    const linkedCardIds = recordCardLinks(
      tx,
      row.id,
      input.projectId,
      body,
      null,
    );
    emitEvent(tx, {
      type: "MurmurPosted",
      aggregateType: "Murmur",
      aggregateId: row.id,
      payload: {
        projectId: input.projectId,
        originType: "project",
        mentionedUserIds,
        linkedCardIds,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<MurmurRow>;
  });
}

export interface AddCardCommentInput {
  projectId: number;
  cardNumber: number;
  body: string;
  actorUserId: number;
}

/** What a card comment produced: the murmur and the version it rode on. */
export interface CardCommentResult {
  murmur: MurmurRow;
  card: CardRow;
}

/**
 * AddCardComment — comments on a card, which is a murmur tied to it.
 *
 * DOES: appends the card's next `card_versions` row carrying the
 * comment text (name, description, type and property snapshot
 * unchanged from the current card); advances the `cards` row's
 * version, modified-by and updated-at stamps; inserts a `murmurs` row
 * with origin_type 'card' pointing at the card and that new version;
 * inserts the mention and card-link rows for the body as PostMurmur
 * does, excluding a `#n` reference to the commented card itself; and
 * appends a CardCommentAdded event — all in one transaction.
 * WHEN: the project and card exist, the actor is at least a full team
 * member, and the body is non-blank after stripping.
 * BECAUSE: legacy stored a comment in two places at once — on the card
 * version, so it appears in history, and as a murmur, so it appears in
 * the stream — and any path that writes one without the other makes
 * the same comment visible in one view and missing from the other.
 * REJECTS WHEN: the project does not exist ("project does not exist");
 * the card number names no card ("card does not exist"); the actor is
 * below full team member (authorization rejection); the body is blank
 * or whitespace-only ("body can't be blank").
 *
 * @param db - the Drizzle handle
 * @param input - project, card number, body as typed, and the actor
 * @returns the murmur and the updated card row, or field errors
 */
export function addCardComment(
  db: BetterSQLite3Database,
  input: AddCardCommentInput,
): CommandResult<CardCommentResult> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const card = db
    .select()
    .from(cards)
    .where(
      and(eq(cards.projectId, input.projectId), eq(cards.number, input.cardNumber)),
    )
    .get();
  if (!card) return reject("card", "does not exist");

  const body = normalizeBody(input.body);
  if (!body) return reject("body", "can't be blank");

  const cardType = db
    .select({ name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.id, card.cardTypeId))
    .get();

  return db.transaction((tx) => {
    const nextVersion = card.version + 1;
    const updatedCard = tx
      .update(cards)
      .set({
        version: nextVersion,
        modifiedByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(cards.id, card.id))
      .returning()
      .get();
    tx.insert(cardVersions)
      .values({
        cardId: card.id,
        projectId: input.projectId,
        number: card.number,
        version: nextVersion,
        name: card.name,
        description: card.description,
        // The type's name at version time, as every other version
        // writer records it (historical fidelity, ADR-0004).
        cardTypeName: cardType?.name ?? "",
        propertyValues: JSON.stringify(cardPropertySnapshot(tx, card.id)),
        comment: body,
        createdByUserId: card.createdByUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();

    const row = tx
      .insert(murmurs)
      .values({
        projectId: input.projectId,
        body,
        authorUserId: input.actorUserId,
        originType: "card",
        originCardId: card.id,
        originCardVersion: nextVersion,
      })
      .returning()
      .get();
    const mentionedUserIds = recordMentions(tx, row.id, input.projectId, body);
    const linkedCardIds = recordCardLinks(
      tx,
      row.id,
      input.projectId,
      body,
      card.id,
    );
    emitEvent(tx, {
      type: "CardCommentAdded",
      aggregateType: "Murmur",
      aggregateId: row.id,
      payload: {
        projectId: input.projectId,
        originType: "card",
        cardNumber: card.number,
        cardVersion: nextVersion,
        mentionedUserIds,
        linkedCardIds,
      },
      actorUserId: input.actorUserId,
    });
    return {
      ok: true,
      value: { murmur: row, card: updatedCard },
    } as CommandResult<CardCommentResult>;
  });
}
