/**
 * History notification scheduling — the outbox call every
 * history-producing command makes (Phase 22).
 *
 * Purpose: lets a command in any bounded context say "something in
 * this project's history changed; deliver whatever subscriptions that
 * matches" without importing the Collaboration context that owns
 * subscriptions. Lives outside any single context for the same reason
 * `events.server.ts` does: three contexts write history (Cards, Wiki
 * & Content, Collaboration) and none of them should know who reads it.
 *
 * The job is deduplicated per project while pending, so a burst of
 * edits schedules one delivery, not one per edit. The delivery itself
 * reads the trails from each subscription's cursor, so it never
 * depends on which edit scheduled it.
 *
 * Since Phase 32 the same call also schedules the project's external
 * notifiers (Slack) as a second, independently retried job, so a mail
 * outage never blocks a chat post or vice versa.
 *
 * Public interface: `scheduleHistoryNotification`,
 * `HISTORY_NOTIFICATIONS_JOB`, `INTEGRATION_DELIVERIES_JOB`.
 *
 * Owner context: cross-context infrastructure (domain kernel).
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { enqueueJob } from "~/jobs/queue.server";

/** The job type app/jobs/handlers.server.ts routes to email delivery. */
export const HISTORY_NOTIFICATIONS_JOB = "history_notifications";
/** The job type app/jobs/handlers.server.ts routes to Slack delivery (Phase 32). */
export const INTEGRATION_DELIVERIES_JOB = "integration_deliveries";

/**
 * Enqueues one delivery run for the project, collapsing into a pending
 * one if it exists. Call inside the transaction that writes the
 * history row, so the job cannot outlive a rolled-back change.
 *
 * @param tx - the transaction the command is using
 * @param projectId - the project whose history changed
 */
export function scheduleHistoryNotification(
  tx: BetterSQLite3Database,
  projectId: number,
): void {
  enqueueJob(tx, {
    type: HISTORY_NOTIFICATIONS_JOB,
    payload: { projectId },
    dedupeKey: `${HISTORY_NOTIFICATIONS_JOB}:${projectId}`,
  });
  enqueueJob(tx, {
    type: INTEGRATION_DELIVERIES_JOB,
    payload: { projectId },
    dedupeKey: `${INTEGRATION_DELIVERIES_JOB}:${projectId}`,
  });
}
