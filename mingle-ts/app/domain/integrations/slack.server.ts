/**
 * Slack notifier — a project's history posted to Slack incoming
 * webhooks (Phase 32; per-event routing and several webhooks since
 * P-10).
 *
 * Purpose: the outbound half of the External Integrations context.
 * Legacy's Slack integration was a SaaS-only application (an AWS
 * service mapped channels to projects); a self-hosted install gets the
 * portable equivalent: incoming-webhook URLs per project, and every
 * history entry — the same projection the feed and the email notifier
 * use — becomes one Slack message. An incoming webhook is bound to its
 * channel when Slack creates it, so routing an event type to a channel
 * is routing it to a URL: a project holds any number of webhooks, one
 * of them the default; each history event type either goes to the
 * default, is routed to one specific webhook, or is suppressed.
 * Delivery runs under the job queue (ADR-0018) from the same
 * `scheduleHistoryNotification` outbox call every history-producing
 * command already makes.
 *
 * Every webhook keeps its own delivery cursor, and delivery is
 * at-least-once per webhook: a cursor moves only after Slack accepted
 * the post, so an outage mid-batch resends nothing that was accepted
 * and everything that was not, and one failing webhook never holds
 * another back.
 *
 * Commands → events:
 *   ConfigureSlackIntegration → SlackIntegrationConfigured
 *   AddSlackWebhook           → SlackIntegrationConfigured
 *   SetDefaultSlackWebhook    → SlackDefaultWebhookChanged
 *   RouteSlackEvents          → SlackEventsRouted
 *   RemoveSlackIntegration    → SlackIntegrationRemoved
 *   DeliverSlackNotifications → SlackNotificationsDelivered
 *
 * Public interface: `SlackPoster`, `SlackMessage`,
 * `configureSlackIntegration`, `addSlackWebhook`,
 * `setDefaultSlackWebhook`, `routeSlackEvents`,
 * `removeSlackIntegration`, `slackEventTypeOf`, `slackMessageFor`,
 * `deliverSlackNotifications`.
 *
 * Owner context: External Integrations. Takes the Drizzle handle, the
 * sealer, and a `SlackPoster` as parameters — no module-level
 * infrastructure imports. A webhook URL (it embeds Slack's token) is
 * stored sealed and never appears in an event, view, or error.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { slackEventRoutes, slackIntegrations, type SlackIntegrationRow } from "~/db/schema/integrations";
import { murmurs } from "~/db/schema/murmurs";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { historyCursor, historyEntriesAfter, type HistoryCursor, type HistoryEntry } from "~/domain/history/read.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import type { Sealer } from "~/domain/identity/sealer.server";
import { SLACK_EVENT_TYPES, type SlackEventType, type SlackRouteTarget } from "~/shared/wire-types";

/** What one Slack post carries (incoming-webhook payload, mrkdwn text). */
export interface SlackMessage {
  text: string;
}

/**
 * Posts one message to a webhook URL. Resolves when Slack accepted it;
 * rejects with a descriptive Error otherwise (the job records it).
 */
export type SlackPoster = (webhookUrl: string, message: SlackMessage) => Promise<void>;

/**
 * Which cursor field each trail advances. An exhaustive Record: adding
 * a fifth `HistoryEntryKind` fails to compile here until it is mapped,
 * which is the omission the dependency trail once suffered elsewhere.
 */
const CURSOR_FIELD: Record<HistoryEntry["kind"], keyof HistoryCursor> = {
  card: "cardVersionId",
  page: "pageVersionId",
  murmur: "murmurId",
  dependency: "dependencyVersionId",
};

/** How many entries one delivery run posts per webhook before yielding to the next. */
const BATCH_LIMIT = 50;

// ---------------------------------------------------------------- lookups

function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get());
}

/** The project's webhooks, default first. */
function webhooksOf(db: BetterSQLite3Database, projectId: number): SlackIntegrationRow[] {
  return db
    .select()
    .from(slackIntegrations)
    .where(eq(slackIntegrations.projectId, projectId))
    .all()
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id);
}

function validUrl(url: string): boolean {
  return /^https?:\/\/\S+$/.test(url);
}

// --------------------------------------------------------------- commands

export interface ConfigureSlackIntegrationInput {
  projectId: number;
  /** The webhook to update; absent means the project's default webhook (created when there is none). */
  integrationId?: number | null;
  /** The incoming-webhook URL; blank keeps the stored one when updating. */
  webhookUrl?: string | null;
  channelLabel?: string | null;
  enabled: boolean;
  actorUserId: number;
}

/**
 * ConfigureSlackIntegration — creates the project's default webhook or
 * updates one of its webhooks.
 *
 * DOES: with `integrationId` (or, without one, the project's default
 * webhook when it has any) updates that `slack_integrations` row's
 * sealed URL (a blank URL keeps the stored one), label, and enabled
 * flag; otherwise inserts the project's first webhook as its default,
 * with the cursor at the current end of every trail (history from
 * before the integration is never replayed). Appends
 * SlackIntegrationConfigured carrying the webhook id, the enabled flag
 * and the label, in one transaction.
 * REJECTS: unknown project or webhook; actor below project
 * administrator; no URL on creation; a URL that is not http(s). (Any
 * http(s) URL is accepted, not only hooks.slack.com: Mattermost and
 * other self-hosted chat servers speak Slack's incoming-webhook format.)
 *
 * @returns the stored row, or field errors
 */
export function configureSlackIntegration(
  db: BetterSQLite3Database,
  sealer: Sealer,
  input: ConfigureSlackIntegrationInput,
): CommandResult<SlackIntegrationRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const all = webhooksOf(db, input.projectId);
  const existing =
    input.integrationId === undefined || input.integrationId === null
      ? all.find((row) => row.isDefault)
      : all.find((row) => row.id === input.integrationId);
  if (input.integrationId !== undefined && input.integrationId !== null && !existing) return reject("slack", "webhook does not exist");
  const url = input.webhookUrl?.trim() || "";
  if (!url && !existing) return reject("webhookUrl", "can't be blank");
  if (url && !validUrl(url)) return reject("webhookUrl", "must be an http(s) incoming-webhook URL");
  const channelLabel = input.channelLabel?.trim() || "";
  return db.transaction((tx) => {
    let row: SlackIntegrationRow;
    if (existing) {
      row = tx
        .update(slackIntegrations)
        .set({
          webhookUrlSealed: url ? sealer.seal(url) : existing.webhookUrlSealed,
          channelLabel,
          enabled: input.enabled,
          updatedAt: new Date(),
        })
        .where(eq(slackIntegrations.id, existing.id))
        .returning()
        .get();
    } else {
      row = tx
        .insert(slackIntegrations)
        .values({
          projectId: input.projectId,
          webhookUrlSealed: sealer.seal(url),
          channelLabel,
          enabled: input.enabled,
          isDefault: true,
          cursor: JSON.stringify(historyCursor(tx, input.projectId)),
          createdByUserId: input.actorUserId,
        })
        .returning()
        .get();
    }
    emitEvent(tx, {
      type: "SlackIntegrationConfigured",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { integrationId: row.id, enabled: row.enabled, channelLabel: row.channelLabel, isDefault: row.isDefault },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<SlackIntegrationRow>;
  });
}

export interface AddSlackWebhookInput {
  projectId: number;
  webhookUrl: string;
  channelLabel?: string | null;
  enabled: boolean;
  actorUserId: number;
}

/**
 * AddSlackWebhook — registers one more incoming webhook for the
 * project (P-10).
 *
 * DOES: inserts a `slack_integrations` row — the project's default when
 * it had none, otherwise a non-default webhook that receives only the
 * event types routed to it — with the cursor at the current end of
 * every trail; appends SlackIntegrationConfigured, in one transaction.
 * REJECTS: unknown project; actor below project administrator; a blank
 * or non-http(s) URL.
 *
 * @returns the stored row, or field errors
 */
export function addSlackWebhook(db: BetterSQLite3Database, sealer: Sealer, input: AddSlackWebhookInput): CommandResult<SlackIntegrationRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const url = input.webhookUrl.trim();
  if (!url) return reject("webhookUrl", "can't be blank");
  if (!validUrl(url)) return reject("webhookUrl", "must be an http(s) incoming-webhook URL");
  const first = webhooksOf(db, input.projectId).length === 0;
  return db.transaction((tx) => {
    const row = tx
      .insert(slackIntegrations)
      .values({
        projectId: input.projectId,
        webhookUrlSealed: sealer.seal(url),
        channelLabel: input.channelLabel?.trim() || "",
        enabled: input.enabled,
        isDefault: first,
        cursor: JSON.stringify(historyCursor(tx, input.projectId)),
        createdByUserId: input.actorUserId,
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "SlackIntegrationConfigured",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { integrationId: row.id, enabled: row.enabled, channelLabel: row.channelLabel, isDefault: row.isDefault },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<SlackIntegrationRow>;
  });
}

export interface SlackWebhookInput {
  projectId: number;
  integrationId: number;
  actorUserId: number;
}

/**
 * SetDefaultSlackWebhook — makes one of the project's webhooks the
 * fall-through for every event type without a route of its own.
 *
 * DOES: clears `is_default` on the project's other webhooks and sets
 * it on the named one; appends SlackDefaultWebhookChanged, in one
 * transaction. A no-op (still an event) when it already is the default.
 * REJECTS: actor below project administrator; a webhook that is not
 * the project's.
 */
export function setDefaultSlackWebhook(db: BetterSQLite3Database, input: SlackWebhookInput): CommandResult<SlackIntegrationRow> {
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const target = webhooksOf(db, input.projectId).find((row) => row.id === input.integrationId);
  if (!target) return reject("slack", "webhook does not exist");
  return db.transaction((tx) => {
    tx.update(slackIntegrations).set({ isDefault: false, updatedAt: new Date() }).where(eq(slackIntegrations.projectId, input.projectId)).run();
    const row = tx
      .update(slackIntegrations)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(slackIntegrations.id, target.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: "SlackDefaultWebhookChanged",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { integrationId: row.id, channelLabel: row.channelLabel },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<SlackIntegrationRow>;
  });
}

export interface RouteSlackEventsInput {
  projectId: number;
  /** Every event type's target; an omitted type keeps its current route. */
  routes: Partial<Record<SlackEventType, SlackRouteTarget>>;
  actorUserId: number;
}

/**
 * RouteSlackEvents — maps history event types to webhooks, or
 * suppresses them.
 *
 * DOES: for each event type given — "default" deletes its
 * `slack_event_routes` row; "suppressed" upserts a row with a null
 * webhook; a webhook id upserts a row naming it; appends
 * SlackEventsRouted with the resulting map, in one transaction.
 * REJECTS: actor below project administrator; an unknown event type;
 * a webhook id that is not the project's.
 *
 * @returns the project's full routing after the change
 */
export function routeSlackEvents(db: BetterSQLite3Database, input: RouteSlackEventsInput): CommandResult<Record<SlackEventType, SlackRouteTarget>> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const webhookIds = new Set(webhooksOf(db, input.projectId).map((row) => row.id));
  for (const [type, target] of Object.entries(input.routes)) {
    if (!(SLACK_EVENT_TYPES as readonly string[]).includes(type)) return reject("routes", `'${type}' is not a history event type`);
    if (typeof target === "number" && !webhookIds.has(target)) return reject("routes", `webhook ${target} does not exist`);
    if (typeof target !== "number" && target !== "default" && target !== "suppressed") return reject("routes", `'${String(target)}' is not a route`);
  }
  return db.transaction((tx) => {
    for (const [type, target] of Object.entries(input.routes) as [SlackEventType, SlackRouteTarget][]) {
      tx.delete(slackEventRoutes).where(and(eq(slackEventRoutes.projectId, input.projectId), eq(slackEventRoutes.eventType, type))).run();
      if (target === "default") continue;
      tx.insert(slackEventRoutes)
        .values({ projectId: input.projectId, eventType: type, slackIntegrationId: target === "suppressed" ? null : target })
        .run();
    }
    const routes = Object.fromEntries(SLACK_EVENT_TYPES.map((type) => [type, "default"])) as Record<SlackEventType, SlackRouteTarget>;
    for (const row of tx.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, input.projectId)).all())
      routes[row.eventType as SlackEventType] = row.slackIntegrationId ?? "suppressed";
    emitEvent(tx, {
      type: "SlackEventsRouted",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { routes },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: routes } as CommandResult<Record<SlackEventType, SlackRouteTarget>>;
  });
}

export interface RemoveSlackIntegrationInput {
  projectId: number;
  /** The webhook to remove; absent means the project's default webhook. */
  integrationId?: number | null;
  actorUserId: number;
}

/**
 * RemoveSlackIntegration — deletes one of the project's webhooks.
 *
 * DOES: deletes the `slack_integrations` row, deletes the routes that
 * named it (their event types fall back to the default), promotes the
 * oldest remaining webhook to default when the default was removed,
 * and appends SlackIntegrationRemoved, in one transaction.
 * REJECTS: actor below project administrator; no such webhook (or no
 * default webhook when none is named).
 */
export function removeSlackIntegration(db: BetterSQLite3Database, input: RemoveSlackIntegrationInput): CommandResult<SlackIntegrationRow> {
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const all = webhooksOf(db, input.projectId);
  const existing =
    input.integrationId === undefined || input.integrationId === null
      ? all.find((row) => row.isDefault)
      : all.find((row) => row.id === input.integrationId);
  if (!existing) return reject("slack", "is not configured for this project");
  return db.transaction((tx) => {
    tx.delete(slackEventRoutes).where(eq(slackEventRoutes.slackIntegrationId, existing.id)).run();
    tx.delete(slackIntegrations).where(eq(slackIntegrations.id, existing.id)).run();
    if (existing.isDefault) {
      const successor = all.filter((row) => row.id !== existing.id).sort((a, b) => a.id - b.id)[0];
      if (successor) tx.update(slackIntegrations).set({ isDefault: true, updatedAt: new Date() }).where(eq(slackIntegrations.id, successor.id)).run();
    }
    emitEvent(tx, {
      type: "SlackIntegrationRemoved",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { integrationId: existing.id, channelLabel: existing.channelLabel },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: existing } as CommandResult<SlackIntegrationRow>;
  });
}

// --------------------------------------------------------------- messages

/** Escapes the three characters Slack's mrkdwn treats specially. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ACTION_VERBS: Record<HistoryEntry["action"], string> = {
  created: "created",
  changed: "changed",
  commented: "commented on",
  deleted: "deleted",
  murmured: "murmured in",
};

/** The event type a history entry is routed by: its kind and action. */
export function slackEventTypeOf(entry: HistoryEntry): SlackEventType {
  return `${entry.kind}.${entry.action}` as SlackEventType;
}

/**
 * The Slack message for one history entry: who did what to which
 * thing, linked into this site, with the comment or murmur text
 * quoted beneath when the entry carried one.
 *
 * @param entry - the history entry
 * @param project - the project's name, for the prefix
 * @param siteUrl - the absolute site root the link is made under
 */
export function slackMessageFor(entry: HistoryEntry, project: { name: string }, siteUrl: string): SlackMessage {
  const link = `<${siteUrl.replace(/\/$/, "")}${entry.href}|${escapeSlack(entry.title)}>`;
  const subject = entry.kind === "murmur" ? escapeSlack(project.name) : link;
  const lines = [`*${escapeSlack(project.name)}*: ${escapeSlack(entry.authorName)} ${ACTION_VERBS[entry.action]} ${subject}`];
  if (entry.text) lines.push(...entry.text.split(/\r?\n/).map((line) => `> ${escapeSlack(line)}`));
  return { text: lines.join("\n") };
}

// --------------------------------------------------------------- delivery

export interface SlackDeliveryOptions {
  projectId: number;
  /** Absolute site root for links, e.g. https://mingle.example.com. */
  siteUrl: string;
}

export interface SlackDeliveryReport {
  /** Messages Slack accepted this run, over every webhook. */
  posted: number;
  /** Entries left after the batch limit on any webhook; the next run continues. */
  remaining: number;
}

/**
 * DeliverSlackNotifications — posts every history entry each of the
 * project's enabled webhooks has not yet seen, where the routing sends
 * it there.
 *
 * DOES: for each enabled webhook, reads the entries after ITS cursor
 * (the feed's own projection, oldest first, at most 50 per run), and
 * for each entry decides by the project's routes: an event type routed
 * to this webhook, or to no webhook in particular ("default") when this
 * is the default webhook, is posted through `post`; a type routed
 * elsewhere or suppressed is skipped. After EACH entry — posted or
 * skipped — the webhook's cursor advances for that entry's trail, so a
 * failure mid-batch loses nothing and repeats nothing accepted. The
 * murmur half of a card comment is skipped (the card-version half
 * carries it; the email notifier makes the same choice). On completion
 * stamps each webhook that posted with `last_delivered_at`, clears its
 * `last_error`, and appends one SlackNotificationsDelivered with the
 * count when anything was posted. A rejected post records the message
 * in that webhook's `last_error`, moves on to the other webhooks, and
 * the first such error is rethrown at the end so the job retries with
 * backoff.
 * WHEN: the project has at least one enabled webhook; otherwise a no-op.
 *
 * @returns what was posted and what remains
 * @throws the poster's Error after recording it
 */
export async function deliverSlackNotifications(
  db: BetterSQLite3Database,
  sealer: Sealer,
  post: SlackPoster,
  options: SlackDeliveryOptions,
): Promise<SlackDeliveryReport> {
  const project = db.select().from(projects).where(eq(projects.id, options.projectId)).get();
  const webhooks = webhooksOf(db, options.projectId).filter((row) => row.enabled);
  if (!project || webhooks.length === 0) return { posted: 0, remaining: 0 };
  const routes = new Map<string, number | null>();
  for (const route of db.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, project.id)).all())
    routes.set(route.eventType, route.slackIntegrationId);

  let posted = 0;
  let remaining = 0;
  let firstError: Error | undefined;
  for (const webhook of webhooks) {
    const cursor = JSON.parse(webhook.cursor) as HistoryCursor;
    const entries = historyEntriesAfter(db, project, cursor, BATCH_LIMIT + 1);
    remaining += Math.max(0, entries.length - BATCH_LIMIT);
    const batch = entries.slice(0, BATCH_LIMIT);
    const murmurIds = batch.filter((entry) => entry.kind === "murmur").map((entry) => entry.sourceId);
    const cardCommentMurmurs = new Set(
      murmurIds.length === 0
        ? []
        : db
            .select({ id: murmurs.id })
            .from(murmurs)
            .where(and(inArray(murmurs.id, murmurIds), eq(murmurs.originType, "card")))
            .all()
            .map((row) => row.id),
    );
    const webhookUrl = sealer.open(webhook.webhookUrlSealed);
    let postedHere = 0;
    let failed = false;
    for (const entry of batch) {
      const route = routes.has(slackEventTypeOf(entry)) ? routes.get(slackEventTypeOf(entry)) : "default";
      const forThisWebhook = route === "default" ? webhook.isDefault : route === webhook.id;
      const carried = !(entry.kind === "murmur" && cardCommentMurmurs.has(entry.sourceId));
      if (forThisWebhook && carried) {
        try {
          await post(webhookUrl, slackMessageFor(entry, project, options.siteUrl));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          db.update(slackIntegrations).set({ lastError: message, updatedAt: new Date() }).where(eq(slackIntegrations.id, webhook.id)).run();
          firstError ??= error instanceof Error ? error : new Error(message);
          failed = true;
          break;
        }
        postedHere += 1;
      }
      const field = CURSOR_FIELD[entry.kind];
      cursor[field] = Math.max(cursor[field], entry.sourceId);
      db.update(slackIntegrations).set({ cursor: JSON.stringify(cursor) }).where(eq(slackIntegrations.id, webhook.id)).run();
    }
    if (postedHere > 0 && !failed)
      db.update(slackIntegrations)
        .set({ lastDeliveredAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(slackIntegrations.id, webhook.id))
        .run();
    posted += postedHere;
  }
  if (posted > 0) {
    db.transaction((tx) => {
      emitEvent(tx, {
        type: "SlackNotificationsDelivered",
        aggregateType: "Project",
        aggregateId: project.id,
        payload: { posted },
        actorUserId: null,
      });
    });
  }
  if (firstError) throw firstError;
  return { posted, remaining };
}
