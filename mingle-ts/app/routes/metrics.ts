/**
 * GET /metrics — Prometheus scrape endpoint (resource route, P-15).
 *
 * Purpose: exposes the process's request counters and latency
 * histogram plus the outbox/queue depth and enabled schedules, in text
 * exposition format. Served only to a request bearing a valid API
 * credential through the existing `/api/v1` authenticator — a bearer
 * key or an HMAC signature (ADR-0020: no new credential kind); a
 * scrape without one is 401 with the same challenge the API sends.
 * Unlike `/healthz`, which is unauthenticated and answers only
 * up/down, this carries operational detail.
 *
 * Public interface: `loader`.
 * Owner context: Observability (HTTP adapter).
 */
import type { Route } from "./+types/metrics";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { METRICS_CONTENT_TYPE, renderMetrics } from "~/observability/metrics.server";

/** GET: the exposition, for an authenticated scraper. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireApiUser(request);
  return new Response(renderMetrics(db), { status: 200, headers: { "Content-Type": METRICS_CONTENT_TYPE, "Cache-Control": "no-store" } });
}
