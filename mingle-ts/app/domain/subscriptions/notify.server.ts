/**
 * Collaboration — history notification delivery (Phase 22).
 *
 * Purpose: the job body behind `scheduleHistoryNotification`. For each
 * project with subscriptions it reads every history entry written
 * after the subscriptions' cursors — the SAME projection the feed
 * shows, via `historyEntriesAfter`, so a subscriber is told about
 * exactly what the feed would show them — decides per subscription
 * which entries match, sends one email per (subscriber, entry), and
 * advances the cursors.
 *
 * Delivery is at-least-once, by design of the queue it runs under: a
 * cursor moves only after its email was accepted by the relay, so a
 * relay outage mid-batch resends nothing that was accepted and
 * everything that was not. A duplicate is the cheaper failure — a
 * silently lost notification is the one a subscriber cannot detect.
 *
 * A card comment appears in the trails twice — as the card version it
 * was stored on and as the murmur it was posted as (Phase 20 wrote
 * both halves, as legacy did). The feed shows both; a subscriber
 * should hear about it once, so the murmur half of a card comment is
 * not delivered, only the version half, which carries the card's name
 * and number the email needs anyway.
 *
 * Public interface: `deliverHistoryNotifications`, `DeliveryOptions`,
 * `DeliveryReport`.
 *
 * Owner context: Collaboration. Takes the Drizzle handle and a
 * `Mailer` as parameters — no module-level infrastructure imports.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import { murmurs } from "~/db/schema/murmurs";
import { projects } from "~/db/schema/projects";
import { historySubscriptions, type HistorySubscriptionRow } from "~/db/schema/subscriptions";
import { mqlCondition, todayIso } from "~/domain/cards/mql-evaluator.server";
import { emitEvent } from "~/domain/events.server";
import {
  type HistoryCursor,
  type HistoryEntry,
  historyEntriesAfter,
} from "~/domain/history/read.server";
import {
  describeFilter,
  filterOf,
  parseMqlFilter,
} from "~/domain/subscriptions/filter.server";
import {
  projectSubscriptions,
  projectsWithSubscriptions,
} from "~/domain/subscriptions/read.server";
import type { MailMessage, Mailer } from "~/mail/mailer.server";

export interface DeliveryOptions {
  /** Deliver for this project only; defaults to every project with subscriptions. */
  projectId?: number;
  /** Absolute site root for links in the email, e.g. http://localhost:3000. */
  siteUrl?: string;
  /** The instant TODAY binds to in MQL filters; defaults to now. */
  now?: Date;
}

/** What one delivery run did. */
export interface DeliveryReport {
  /** Subscriptions considered. */
  subscriptions: number;
  /** Fresh history entries read across projects. */
  entries: number;
  /** Emails accepted by the relay. */
  sent: number;
}

type ProjectRef = { id: number; identifier: string; name: string };

/** The subscription's cursor for an entry's trail. */
function cursorFor(sub: HistorySubscriptionRow, kind: HistoryEntry["kind"]): number {
  if (kind === "card") return sub.lastCardVersionId;
  if (kind === "page") return sub.lastPageVersionId;
  return sub.lastMurmurId;
}

/**
 * Moves subscriptions' cursors forward to the given positions —
 * never backward, so a re-run over an older batch cannot regress one.
 */
function advanceCursors(
  db: BetterSQLite3Database,
  subscriptionIds: number[],
  to: Partial<HistoryCursor>,
): void {
  if (subscriptionIds.length === 0) return;
  const set: Record<string, unknown> = {};
  if (to.cardVersionId !== undefined)
    set.lastCardVersionId = sql`max(${historySubscriptions.lastCardVersionId}, ${to.cardVersionId})`;
  if (to.pageVersionId !== undefined)
    set.lastPageVersionId = sql`max(${historySubscriptions.lastPageVersionId}, ${to.pageVersionId})`;
  if (to.murmurId !== undefined)
    set.lastMurmurId = sql`max(${historySubscriptions.lastMurmurId}, ${to.murmurId})`;
  if (Object.keys(set).length === 0) return;
  db.update(historySubscriptions)
    .set(set)
    .where(inArray(historySubscriptions.id, subscriptionIds))
    .run();
}

/** Records (or clears) why a subscription could not be evaluated. */
function setError(db: BetterSQLite3Database, subscriptionIds: number[], message: string | null): void {
  if (subscriptionIds.length === 0) return;
  db.update(historySubscriptions)
    .set({ lastError: message })
    .where(inArray(historySubscriptions.id, subscriptionIds))
    .run();
}

/** The highest source id per trail in a batch, for the final advance. */
function batchMaxima(entries: HistoryEntry[]): HistoryCursor {
  const max: HistoryCursor = { cardVersionId: 0, pageVersionId: 0, murmurId: 0 };
  for (const entry of entries) {
    if (entry.kind === "card") max.cardVersionId = Math.max(max.cardVersionId, entry.sourceId);
    else if (entry.kind === "page") max.pageVersionId = Math.max(max.pageVersionId, entry.sourceId);
    else max.murmurId = Math.max(max.murmurId, entry.sourceId);
  }
  return max;
}

/** Drops the murmur half of every card comment (see module header). */
function withoutCardCommentMurmurs(db: BetterSQLite3Database, entries: HistoryEntry[]): HistoryEntry[] {
  const murmurIds = entries.filter((e) => e.kind === "murmur").map((e) => e.sourceId);
  if (murmurIds.length === 0) return entries;
  const comments = new Set(
    db
      .select({ id: murmurs.id })
      .from(murmurs)
      .where(and(inArray(murmurs.id, murmurIds), eq(murmurs.originType, "card")))
      .all()
      .map((row) => row.id),
  );
  return entries.filter((e) => !(e.kind === "murmur" && comments.has(e.sourceId)));
}

type Matcher = (entry: HistoryEntry) => boolean;

/**
 * Builds the predicate a subscription applies to entries, or the
 * reason it cannot be evaluated. An MQL filter is evaluated against
 * the card as it stands NOW, with CURRENT USER bound to the
 * subscriber; a card that no longer exists (a deletion entry) cannot
 * match an MQL filter, which is the documented cost of not evaluating
 * over the version snapshot.
 */
function matcherFor(
  db: BetterSQLite3Database,
  projectId: number,
  sub: HistorySubscriptionRow,
  now: Date,
): Matcher | { error: string } {
  const filter = filterOf(sub);
  switch (filter.kind) {
    case "project":
      return () => true;
    case "card":
      return (entry) => entry.kind === "card" && entry.cardNumber === filter.cardNumber;
    case "page": {
      const wanted = filter.pageIdentifier.toLowerCase();
      return (entry) => entry.kind === "page" && entry.pageIdentifier?.toLowerCase() === wanted;
    }
    case "mql": {
      const parsed = parseMqlFilter(db, projectId, filter.mql);
      if (!parsed.ok) return { error: parsed.errors.join(" ") };
      if (parsed.condition === null) return (entry) => entry.kind === "card";
      const predicate = mqlCondition(db, projectId, parsed.condition, {
        currentUserId: sub.userId,
        today: todayIso(now),
      });
      return (entry) =>
        entry.kind === "card" &&
        entry.cardNumber !== null &&
        Boolean(
          db
            .select({ id: cards.id })
            .from(cards)
            .where(
              and(eq(cards.projectId, projectId), eq(cards.number, entry.cardNumber), predicate),
            )
            .get(),
        );
    }
  }
}

/** The email for one entry, to one subscriber, on behalf of their matching subscriptions. */
function composeNotification(
  entry: HistoryEntry,
  project: ProjectRef,
  to: string,
  descriptions: string[],
  siteUrl: string,
): MailMessage {
  const detail =
    entry.text === null
      ? ""
      : `${entry.kind === "murmur" ? "Murmur" : "Comment"}:\n${entry.text}\n\n`;
  const text =
    `${entry.authorName} ${entry.action} ${entry.title} in ${project.name} ` +
    `at ${entry.occurredAt.toISOString()}.\n\n` +
    detail +
    `View it: ${siteUrl}${entry.href}\n\n` +
    `You are receiving this because you subscribed to:\n` +
    descriptions.map((d) => `  - ${d}`).join("\n") +
    `\n\nManage your subscriptions: ${siteUrl}/projects/${project.identifier}/subscriptions\n`;
  return {
    to,
    // Legacy: "#{short_description} #{created_or_changed} #{modified_by.name}".
    subject: `${entry.title} ${entry.action} by ${entry.authorName}`,
    text,
  };
}

async function deliverForProject(
  db: BetterSQLite3Database,
  mailer: Mailer,
  project: ProjectRef,
  siteUrl: string,
  now: Date,
  report: DeliveryReport,
): Promise<void> {
  const subs = projectSubscriptions(db, project.id);
  if (subs.length === 0) return;
  report.subscriptions += subs.length;

  const floor: HistoryCursor = {
    cardVersionId: Math.min(...subs.map((s) => s.lastCardVersionId)),
    pageVersionId: Math.min(...subs.map((s) => s.lastPageVersionId)),
    murmurId: Math.min(...subs.map((s) => s.lastMurmurId)),
  };
  const allFresh = historyEntriesAfter(db, project, floor);
  if (allFresh.length === 0) return;
  const maxima = batchMaxima(allFresh);
  const fresh = withoutCardCommentMurmurs(db, allFresh);
  report.entries += fresh.length;

  const emailByUserId = new Map(
    db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, [...new Set(subs.map((s) => s.userId))]))
      .all()
      .map((row) => [row.id, row.email] as const),
  );
  const byUser = new Map<number, HistorySubscriptionRow[]>();
  for (const sub of subs) byUser.set(sub.userId, [...(byUser.get(sub.userId) ?? []), sub]);

  for (const [userId, userSubs] of byUser) {
    const email = emailByUserId.get(userId);
    if (!email) {
      setError(db, userSubs.map((s) => s.id), "subscriber has no email address");
      advanceCursors(db, userSubs.map((s) => s.id), maxima);
      continue;
    }

    // Entries this user hears about, in feed order, with every one of
    // their subscriptions that matched — one email per entry, however
    // many subscriptions agree.
    const matched = new Map<string, { entry: HistoryEntry; subs: HistorySubscriptionRow[] }>();
    for (const sub of userSubs) {
      const matcher = matcherFor(db, project.id, sub, now);
      if (typeof matcher !== "function") {
        setError(db, [sub.id], matcher.error);
        continue;
      }
      if (sub.lastError !== null) setError(db, [sub.id], null);
      for (const entry of fresh) {
        if (entry.sourceId <= cursorFor(sub, entry.kind)) continue;
        if (!matcher(entry)) continue;
        const hit = matched.get(entry.id) ?? { entry, subs: [] };
        hit.subs.push(sub);
        matched.set(entry.id, hit);
      }
    }

    for (const { entry, subs: matchedSubs } of matched.values()) {
      const descriptions = matchedSubs.map((s) => describeFilter(filterOf(s), project.name));
      await mailer.send(composeNotification(entry, project, email, descriptions, siteUrl));
      const ids = matchedSubs.map((s) => s.id);
      advanceCursors(db, ids, {
        cardVersionId: entry.kind === "card" ? entry.sourceId : undefined,
        pageVersionId: entry.kind === "page" ? entry.sourceId : undefined,
        murmurId: entry.kind === "murmur" ? entry.sourceId : undefined,
      });
      emitEvent(db, {
        type: "HistoryNotificationSent",
        aggregateType: "HistorySubscription",
        aggregateId: ids[0],
        payload: { projectId: project.id, userId, entryId: entry.id, subscriptionIds: ids, to: email },
        actorUserId: null,
      });
      report.sent++;
    }
    advanceCursors(db, userSubs.map((s) => s.id), maxima);
  }
}

/**
 * DeliverHistoryNotifications — the delivery run.
 *
 * DOES: for every subscription in scope, sends one email per fresh
 * matching history entry through the mailer, advances the
 * subscription's cursor for that entry's trail once the relay
 * accepted it, appends a HistoryNotificationSent event per email,
 * and finally advances every cursor to the end of the batch (past
 * the entries that matched nothing); records `last_error` on a
 * subscription whose filter no longer parses or whose subscriber has
 * no address, and clears it once it evaluates again.
 * WHEN: run by the `history_notifications` job for one project, or
 * with no project for a sweep of every project with subscriptions.
 * BECAUSE: a subscription is a promise that matching history reaches
 * the subscriber; the cursor is what makes the promise "each entry
 * once, in order" rather than "whatever happened to be new".
 * REJECTS WHEN: the mailer rejects — the error propagates with the
 * cursors already advanced for every email that was accepted, so the
 * job's retry resends only what was not.
 *
 * @param db - the Drizzle handle
 * @param mailer - where emails go
 * @param options - project scope, site URL for links, and "now"
 * @returns counts of subscriptions considered, entries read, emails sent
 */
export async function deliverHistoryNotifications(
  db: BetterSQLite3Database,
  mailer: Mailer,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const siteUrl = (options.siteUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const now = options.now ?? new Date();
  const report: DeliveryReport = { subscriptions: 0, entries: 0, sent: 0 };

  const scope: ProjectRef[] =
    options.projectId === undefined
      ? projectsWithSubscriptions(db)
      : db
          .select({ id: projects.id, identifier: projects.identifier, name: projects.name })
          .from(projects)
          .where(eq(projects.id, options.projectId))
          .all();

  for (const project of scope) {
    await deliverForProject(db, mailer, project, siteUrl, now, report);
  }
  return report;
}
