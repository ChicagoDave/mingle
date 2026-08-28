/**
 * Collaboration command handlers — history subscriptions (Phase 22).
 *
 * Purpose: the write path for a user's standing request to be emailed
 * about project history (legacy `HistorySubscriptionsController` /
 * `HistorySubscription`). A subscription starts at the CURRENT end of
 * every trail: history that predates it is never delivered, which is
 * what legacy's `last_max_*` columns, set at creation, guaranteed.
 *
 * Commands → events:
 *   Subscribe   → HistorySubscribed
 *   Unsubscribe → HistoryUnsubscribed
 *
 * Public interface: `subscribe`, `unsubscribe`.
 *
 * Owner context: Collaboration. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import { projects } from "~/db/schema/projects";
import { historySubscriptions, type HistorySubscriptionRow } from "~/db/schema/subscriptions";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { historyCursor } from "~/domain/history/read.server";
import {
  authorizeProjectAction,
  privilegeLevelFor,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";
import { findPage } from "~/domain/pages/read.server";
import {
  filterKeyOf,
  parseMqlFilter,
  type SubscriptionFilter,
} from "~/domain/subscriptions/filter.server";

/** True when the project id names an existing project. */
function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(
    db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get(),
  );
}

/**
 * Checks the filter names something that exists, returning it in
 * stored form (MQL trimmed; page identifier as given).
 */
function validateFilter(
  db: BetterSQLite3Database,
  projectId: number,
  filter: SubscriptionFilter,
): CommandResult<SubscriptionFilter> {
  switch (filter.kind) {
    case "project":
      return { ok: true, value: filter };
    case "card": {
      const card = db
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.projectId, projectId), eq(cards.number, filter.cardNumber)))
        .get();
      if (!card) return reject("card", "does not exist");
      return { ok: true, value: filter };
    }
    case "page": {
      if (!findPage(db, projectId, filter.pageIdentifier))
        return reject("page", "does not exist");
      return { ok: true, value: filter };
    }
    case "mql": {
      const mql = filter.mql.trim();
      if (!mql) return reject("mql", "can't be blank");
      const parsed = parseMqlFilter(db, projectId, mql);
      if (!parsed.ok) return { ok: false, errors: { mql: parsed.errors } };
      return { ok: true, value: { kind: "mql", mql } };
    }
  }
}

export interface SubscribeInput {
  projectId: number;
  filter: SubscriptionFilter;
  actorUserId: number;
}

/**
 * Subscribe — asks to be emailed about matching project history.
 *
 * DOES: inserts a `history_subscriptions` row for the actor carrying
 * the filter, its comparable key, and cursors set to the project's
 * CURRENT end of each trail (so nothing that already happened is
 * delivered); appends a HistorySubscribed event — in one transaction.
 * WHEN: the project exists; the actor is at least a read-only team
 * member; the actor has an email address; the filter names an
 * existing card or page, or is MQL that parses as a condition; and the
 * actor holds no subscription with the same key in this project.
 * BECAUSE: a subscription is a delivery promise, and a promise to a
 * user with no address, or about a card that does not exist, cannot
 * be kept — refusing at write time is the only moment the user is
 * there to hear it.
 * REJECTS WHEN: the project does not exist ("project does not exist");
 * the actor is below read-only team member (authorization rejection);
 * the actor has no email ("email must be set on your profile before
 * subscribing"); the card or page does not exist ("card/page does not
 * exist"); the MQL is blank ("mql can't be blank") or does not parse
 * as a condition (the parser's messages); a subscription with the same
 * key exists ("subscription already exists").
 *
 * @param db - the Drizzle handle
 * @param input - project, filter, and the subscribing actor
 * @returns the persisted subscription row, or field errors
 */
export function subscribe(
  db: BetterSQLite3Database,
  input: SubscribeInput,
): CommandResult<HistorySubscriptionRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.READONLY_TEAM_MEMBER,
  );
  if (denied) return denied;

  const actor = db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .get();
  if (!actor?.email) return reject("email", "must be set on your profile before subscribing");

  const validated = validateFilter(db, input.projectId, input.filter);
  if (!validated.ok) return validated;
  const filter = validated.value;
  const filterKey = filterKeyOf(filter);

  const existing = db
    .select({ id: historySubscriptions.id })
    .from(historySubscriptions)
    .where(
      and(
        eq(historySubscriptions.userId, input.actorUserId),
        eq(historySubscriptions.projectId, input.projectId),
        eq(historySubscriptions.filterKey, filterKey),
      ),
    )
    .get();
  if (existing) return reject("subscription", "already exists");

  return db.transaction((tx) => {
    const cursor = historyCursor(tx, input.projectId);
    const row = tx
      .insert(historySubscriptions)
      .values({
        projectId: input.projectId,
        userId: input.actorUserId,
        kind: filter.kind,
        cardNumber: filter.kind === "card" ? filter.cardNumber : null,
        pageIdentifier: filter.kind === "page" ? filter.pageIdentifier : null,
        mql: filter.kind === "mql" ? filter.mql : null,
        filterKey,
        lastCardVersionId: cursor.cardVersionId,
        lastPageVersionId: cursor.pageVersionId,
        lastMurmurId: cursor.murmurId,
        lastDependencyVersionId: cursor.dependencyVersionId,
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "HistorySubscribed",
      aggregateType: "HistorySubscription",
      aggregateId: row.id,
      payload: { projectId: input.projectId, userId: input.actorUserId, filter },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<HistorySubscriptionRow>;
  });
}

export interface UnsubscribeInput {
  projectId: number;
  subscriptionId: number;
  actorUserId: number;
}

/**
 * Unsubscribe — withdraws a subscription.
 *
 * DOES: deletes the `history_subscriptions` row and appends a
 * HistoryUnsubscribed event, in one transaction.
 * WHEN: the subscription exists in the project, and the actor is its
 * owner or at least a project admin.
 * BECAUSE: a subscription belongs to the user who made it; another
 * member silencing someone else's notifications is a project-admin
 * act (legacy let admins manage team subscriptions), not a peer one.
 * REJECTS WHEN: no such subscription in this project ("subscription
 * does not exist"); the actor is neither owner nor project admin
 * (authorization rejection).
 *
 * @param db - the Drizzle handle
 * @param input - project, subscription id, and the acting user
 * @returns the removed row, or field errors
 */
export function unsubscribe(
  db: BetterSQLite3Database,
  input: UnsubscribeInput,
): CommandResult<HistorySubscriptionRow> {
  const row = db
    .select()
    .from(historySubscriptions)
    .where(
      and(
        eq(historySubscriptions.id, input.subscriptionId),
        eq(historySubscriptions.projectId, input.projectId),
      ),
    )
    .get();
  if (!row) return reject("subscription", "does not exist");
  if (
    row.userId !== input.actorUserId &&
    privilegeLevelFor(db, input.actorUserId, input.projectId) < PrivilegeLevel.PROJECT_ADMIN
  ) {
    return reject("authorization", "only the subscriber or a project admin can remove this subscription");
  }

  return db.transaction((tx) => {
    tx.delete(historySubscriptions).where(eq(historySubscriptions.id, row.id)).run();
    emitEvent(tx, {
      type: "HistoryUnsubscribed",
      aggregateType: "HistorySubscription",
      aggregateId: row.id,
      payload: { projectId: input.projectId, userId: row.userId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<HistorySubscriptionRow>;
  });
}
