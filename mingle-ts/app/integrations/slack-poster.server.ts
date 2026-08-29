/**
 * Slack webhook poster — the `SlackPoster` port over HTTP (Phase 32).
 *
 * Purpose: delivers one message to a Slack incoming-webhook URL with
 * `fetch`. Slack answers 200 "ok" on acceptance; anything else is an
 * Error carrying the status and body so the job records it.
 *
 * Public interface: `postToSlackWebhook`.
 *
 * Owner context: infrastructure (HTTP adapter) for External
 * Integrations.
 */
import type { SlackPoster } from "~/domain/integrations/slack.server";

/** POSTs the message as JSON; rejects unless Slack answers 2xx. */
export const postToSlackWebhook: SlackPoster = async (webhookUrl, message) => {
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (error) {
    throw new Error(`Slack webhook unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Slack webhook answered ${res.status}${body ? `: ${body}` : ""}`);
  }
};
