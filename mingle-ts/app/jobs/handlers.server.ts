/**
 * Job registry — which handler runs which job type.
 *
 * Purpose: the one table the worker dispatches through. Adding a
 * background job means adding a row here; nothing else in the app
 * decides what a job type means. Handlers are thin: they resolve the
 * infrastructure a domain function needs (the mailer, the site URL)
 * from the environment and call it.
 *
 * Public interface: `jobHandlers`.
 *
 * Owner context: infrastructure (job queue) — the composition point
 * where domain delivery meets environment-configured adapters.
 */
import { HISTORY_NOTIFICATIONS_JOB } from "~/domain/notifications.server";
import { deliverHistoryNotifications } from "~/domain/subscriptions/notify.server";
import type { JobHandlers } from "~/jobs/queue.server";
import { type Mailer, smtpConfigFromEnv, smtpMailer } from "~/mail/mailer.server";

let mailer: Mailer | null = null;

/**
 * The process's SMTP mailer, built on first use.
 *
 * @throws Error when SMTP_HOST is unset — a job that needs mail cannot
 *   run, and the queue records that on the job rather than dropping it
 */
function notificationMailer(): Mailer {
  if (mailer) return mailer;
  const config = smtpConfigFromEnv();
  if (!config) {
    throw new Error(
      "SMTP_HOST is not set — history notifications cannot be delivered until SMTP is configured",
    );
  }
  mailer = smtpMailer(config);
  return mailer;
}

/** The absolute site root for links in outbound mail. */
function siteUrlFromEnv(): string {
  return process.env.SITE_URL?.trim() || `http://localhost:${process.env.PORT ?? "3000"}`;
}

export const jobHandlers: JobHandlers = {
  [HISTORY_NOTIFICATIONS_JOB]: async (db, payload) => {
    const projectId = Number(payload.projectId);
    if (!Number.isSafeInteger(projectId)) {
      throw new Error(`history_notifications job carries no project id (${JSON.stringify(payload)})`);
    }
    await deliverHistoryNotifications(db, notificationMailer(), {
      projectId,
      siteUrl: siteUrlFromEnv(),
    });
  },
};
