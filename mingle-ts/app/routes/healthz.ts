/**
 * GET /healthz — liveness/readiness probe (resource route, no UI).
 *
 * Purpose: answers whether the app process is up AND can complete a
 * real round-trip to Postgres. Used by docker-compose healthchecks,
 * the Phase 1 real-path test (rule 13a), and any future orchestrator.
 *
 * Public interface: `loader` (React Router resource route contract).
 * Response body: `HealthzResponse` from the shared wire-types module.
 *
 * Owner context: infrastructure (operational endpoint, no domain logic).
 */
import type { HealthzResponse } from "~/shared/wire-types";
import { pool } from "~/db/client.server";

/**
 * Probes the database with a genuine `SELECT 1` round-trip and reports
 * service health.
 *
 * Returns HTTP 200 with `status: "ok"` when the query succeeds, or
 * HTTP 503 with `status: "degraded", db: "unreachable"` when it fails.
 * Never throws — a broken database must yield a well-formed degraded
 * response, not a crash page.
 */
export async function loader(): Promise<Response> {
  let dbState: HealthzResponse["db"];
  try {
    await pool.query("SELECT 1");
    dbState = "connected";
  } catch {
    dbState = "unreachable";
  }

  const body: HealthzResponse = {
    status: dbState === "connected" ? "ok" : "degraded",
    db: dbState,
    checkedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: body.status === "ok" ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
}
