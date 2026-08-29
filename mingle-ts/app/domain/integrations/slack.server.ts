/**
 * Slack notifier — a project's history posted to a Slack incoming
 * webhook (Phase 32).
 *
 * Purpose: the outbound half of the External Integrations context.
 * Legacy's Slack integration was a SaaS-only application (an AWS
 * service mapped channels to projects); a self-hosted install gets the
 * portable equivalent: one incoming-webhook URL per project, and every
 * history entry — the same projection the feed and the email notifier
 * use — becomes one Slack message. Delivery runs under the job queue
 * (ADR-0018) from the same `scheduleHistoryNotification` outbox call
 * every history-producing command already makes.
 *
 * Delivery is at-least-once: the cursor moves only after Slack accepted
 * the post, so an outage mid-batch resends nothing that was accepted
 * and everything that was not.
 *
 * Commands → events:
 *   ConfigureSlackIntegration → SlackIntegrationConfigured
 *   RemoveSlackIntegration    → SlackIntegrationRemoved
 *   DeliverSlackNotifications → SlackNotificationsDelivered
 *
 * Public interface: `SlackPoster`, `SlackMessage`,
 * `configureSlackIntegration`, `removeSlackIntegration`,
 * `slackMessageFor`, `deliverSlackNotifications`.
 *
 * Owner context: External Integrations. Takes the Drizzle handle, the
 * sealer, and a `SlackPoster` as parameters — no module-level
 * infrastructure imports. The webhook URL (it embeds Slack's token) is
 * stored sealed and never appears in an event, view, or error.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { slackIntegrations, type SlackIntegrationRow } from "~/db/schema/integrations";
import { murmurs } from "~/db/schema/murmurs";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { historyCursor, historyEntriesAfter, type HistoryCursor, type HistoryEntry } from "~/domain/history/read.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import type { Sealer } from "~/domain/identity/sealer.server";

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

/** How many entries one delivery run posts before yielding to the next. */
const BATCH_LIMIT = 50;

// --------------------------------------------------------------- commands

export interface ConfigureSlackIntegrationInput {
  projectId: number;
  /** The incoming-webhook URL; blank keeps the stored one when updating. */
  webhookUrl?: string | null;
  channelLabel?: string | null;
  enabled: boolean;
  actorUserId: number;
}

/**
 * ConfigureSlackIntegration — creates or updates the project's notifier.
 *
 * DOES: upserts the `slack_integrations` row with the sealed webhook
 * URL (a blank URL keeps the stored one), the label, and the enabled
 * flag; a NEW row's cursor starts at the current end of every trail
 * (history from before the integration is never replayed); appends
 * SlackIntegrationConfigured carrying only the enabled flag and label,
 * in one transaction.
 * REJECTS: unknown project; actor below project administrator; no URL
 * on first configuration; a URL that is not http(s). (Any http(s) URL
 * is accepted, not only hooks.slack.com: Mattermost and other
 * self-hosted chat servers speak Slack's incoming-webhook format.)
 *
 * @returns the stored row, or field errors
 */
export function configureSlackIntegration(
  db: BetterSQLite3Database,
  sealer: Sealer,
  input: ConfigureSlackIntegrationInput,
): CommandResult<SlackIntegrationRow> {
  if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get())
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const existing = db.select().from(slackIntegrations).where(eq(slackIntegrations.projectId, input.projectId)).get();
  const url = input.webhookUrl?.trim() || "";
  if (!url && !existing) return reject("webhookUrl", "can't be blank");
  if (url && !/^https?:\/\/\S+$/.test(url))
    return reject("webhookUrl", "must be an http(s) incoming-webhook URL");
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
      payload: { enabled: row.enabled, channelLabel: row.channelLabel },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<SlackIntegrationRow>;
  });
}

export interface RemoveSlackIntegrationInput {
  projectId: number;
  actorUserId: number;
}

/**
 * RemoveSlackIntegration — deletes the project's notifier.
 *
 * DOES: deletes the `slack_integrations` row and appends
 * SlackIntegrationRemoved, in one transaction.
 * REJECTS: actor below project administrator; no notifier configured.
 */
export function removeSlackIntegration(
  db: BetterSQLite3Database,
  input: RemoveSlackIntegrationInput,
): CommandResult<SlackIntegrationRow> {
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const existing = db.select().from(slackIntegrations).where(eq(slackIntegrations.projectId, input.projectId)).get();
  if (!existing) return reject("slack", "is not configured for this project");
  return db.transaction((tx) => {
    tx.delete(slackIntegrations).where(eq(slackIntegrations.id, existing.id)).run();
    emitEvent(tx, {
      type: "SlackIntegrationRemoved",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { channelLabel: existing.channelLabel },
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
  /** Messages Slack accepted this run. */
  posted: number;
  /** Entries left after the batch limit; the next run continues. */
  remaining: number;
}

/**
 * DeliverSlackNotifications — posts every history entry the project's
 * notifier has not yet posted.
 *
 * DOES: for an enabled notifier, reads the entries after its cursor
 * (the feed's own projection, oldest first, at most 50 per run), posts
 * each through `post`, and after EACH accepted post advances the
 * cursor for that entry's trail in the row — so a failure mid-batch
 * loses nothing and repeats nothing accepted. The murmur half of a
 * card comment is skipped (the card-version half carries it; the
 * email notifier makes the same choice). On completion stamps
 * `last_delivered_at`, clears `last_error`, and appends
 * SlackNotificationsDelivered with the count when anything was posted.
 * On a rejected post records the message in `last_error` and rethrows,
 * so the job retries with backoff.
 * WHEN: the project has an enabled notifier; otherwise a no-op.
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
  const integration = db.select().from(slackIntegrations).where(eq(slackIntegrations.projectId, options.projectId)).get();
  const project = db.select().from(projects).where(eq(projects.id, options.projectId)).get();
  if (!integration || !integration.enabled || !project) return { posted: 0, remaining: 0 };

  const cursor = JSON.parse(integration.cursor) as HistoryCursor;
  const entries = historyEntriesAfter(db, project, cursor, BATCH_LIMIT + 1);
  const remaining = Math.max(0, entries.length - BATCH_LIMIT);
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

  const webhookUrl = sealer.open(integration.webhookUrlSealed);
  let posted = 0;
  for (const entry of batch) {
    if (!(entry.kind === "murmur" && cardCommentMurmurs.has(entry.sourceId))) {
      try {
        await post(webhookUrl, slackMessageFor(entry, project, options.siteUrl));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.update(slackIntegrations).set({ lastError: message, updatedAt: new Date() }).where(eq(slackIntegrations.id, integration.id)).run();
        throw error instanceof Error ? error : new Error(message);
      }
      posted += 1;
    }
    const field = CURSOR_FIELD[entry.kind];
    cursor[field] = Math.max(cursor[field], entry.sourceId);
    db.update(slackIntegrations).set({ cursor: JSON.stringify(cursor) }).where(eq(slackIntegrations.id, integration.id)).run();
  }

  if (posted > 0) {
    db.transaction((tx) => {
      tx.update(slackIntegrations)
        .set({ lastDeliveredAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(slackIntegrations.id, integration.id))
        .run();
      emitEvent(tx, {
        type: "SlackNotificationsDelivered",
        aggregateType: "Project",
        aggregateId: project.id,
        payload: { posted },
        actorUserId: null,
      });
    });
  }
  return { posted, remaining };
}
