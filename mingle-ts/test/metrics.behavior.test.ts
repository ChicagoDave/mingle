/**
 * Behavioral tests for `/metrics` (P-15, Phase 14).
 *
 * Derived from app/observability/metrics.server.ts and app/routes/
 * metrics.ts: an unauthenticated scrape is 401 with the API's
 * challenge; an API-key scrape answers text exposition; the request
 * counter and latency histogram move when requests pass through the
 * root middleware (including refused ones); the queue gauges reflect
 * the jobs table and the enabled schedules at scrape time.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Observability verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-metrics-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "metrics-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const root = await import("../app/root");
const metricsRoute = await import("../app/routes/metrics");
const { jobs } = await import("../app/db/schema/jobs");
const { schedules } = await import("../app/db/schema/schedules");
const { apiKeys, users } = await import("../app/db/schema/identity");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { generateApiKey } = await import("../app/domain/identity/api-keys.server");
const { enqueueJob } = await import("../app/jobs/queue.server");
const { renderMetrics, resetMetrics } = await import("../app/observability/metrics.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let key = "";

beforeEach(() => {
  for (const table of [jobs, apiKeys, users]) db.delete(table).run();
  db.update(schedules).set({ enabled: false }).run();
  resetMetrics();
  const userId = mustOk(registerUser(db, { login: "ops", name: "Ops", password: "metrics-1!" }), "ops").id;
  key = mustOk(generateApiKey(db, sealer, { userId, actorUserId: userId }), "key").key;
});

/** Runs a request through the real root middleware with a stand-in page. */
async function through(method: string, path: string, answer: () => Response): Promise<Response> {
  const request = new Request(`http://localhost${path}`, { method });
  try {
    return (await root.middleware[0]({ request, params: {}, context: {} } as never, async () => answer())) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function scrape(headers: Record<string, string> = {}): Promise<Response> {
  try {
    return (await metricsRoute.loader({ request: new Request("http://localhost/metrics", { headers }), params: {}, context: {} } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

const value = (text: string, series: string): number => {
  const line = text.split("\n").find((l) => l.startsWith(series + " "));
  if (!line) throw new Error(`no series ${series} in:\n${text}`);
  return Number(line.slice(series.length + 1));
};

describe("/metrics", () => {
  it("refuses an unauthenticated scrape with 401 and the API's challenge, and a wrong key too", async () => {
    const anonymous = await scrape();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect((await scrape({ Authorization: "Bearer mgl_nope" })).status).toBe(401);
  });

  it("answers Prometheus text exposition to an API key, with the request counters and histogram moving as requests pass through", async () => {
    expect((await through("GET", "/projects", () => new Response("ok", { status: 200 }))).status).toBe(200);
    expect((await through("GET", "/projects", () => new Response("ok", { status: 200 }))).status).toBe(200);
    expect((await through("POST", "/projects/new", () => new Response("created", { status: 302 }))).status).toBe(302);
    // A page that throws a Response is observed with that status.
    expect((await through("GET", "/nowhere", () => { throw new Response("Not Found", { status: 404 }); })).status).toBe(404);

    const response = await scrape({ Authorization: `Bearer ${key}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("# TYPE mingle_http_requests_total counter");
    expect(value(text, 'mingle_http_requests_total{method="GET",status="200"}')).toBe(2);
    expect(value(text, 'mingle_http_requests_total{method="POST",status="302"}')).toBe(1);
    expect(value(text, 'mingle_http_requests_total{method="GET",status="404"}')).toBe(1);
    expect(value(text, 'mingle_http_request_duration_seconds_count{method="GET"}')).toBe(3);
    expect(value(text, 'mingle_http_request_duration_seconds_bucket{method="GET",le="+Inf"}')).toBe(3);
    expect(value(text, 'mingle_http_request_duration_seconds_count{method="POST"}')).toBe(1);
    expect(value(text, "mingle_process_uptime_seconds")).toBeGreaterThanOrEqual(0);

    // Another request, another scrape: the counter is monotonic within the process.
    await through("GET", "/projects", () => new Response("ok", { status: 200 }));
    const again = await (await scrape({ Authorization: `Bearer ${key}` })).text();
    expect(value(again, 'mingle_http_requests_total{method="GET",status="200"}')).toBe(3);
  });

  it("reports queue depth by status, the oldest pending job's age, and enabled schedules from the database at scrape time", () => {
    const now = new Date("2026-08-29T12:00:00Z");
    const empty = renderMetrics(db, now);
    expect(value(empty, 'mingle_jobs{status="pending"}')).toBe(0);
    expect(value(empty, "mingle_jobs_oldest_pending_age_seconds")).toBe(0);
    expect(value(empty, "mingle_schedules_enabled")).toBe(0);

    enqueueJob(db, { type: "backup", payload: {}, runAt: new Date("2026-08-29T11:59:00Z") });
    enqueueJob(db, { type: "backup", payload: {}, runAt: new Date("2026-08-29T11:59:30Z") });
    const failed = enqueueJob(db, { type: "backup", payload: {}, runAt: now })!;
    db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, failed.id)).run();
    db.update(schedules).set({ enabled: true }).run();

    const text = renderMetrics(db, now);
    expect(value(text, 'mingle_jobs{status="pending"}')).toBe(2);
    expect(value(text, 'mingle_jobs{status="failed"}')).toBe(1);
    expect(value(text, 'mingle_jobs{status="running"}')).toBe(0);
    expect(value(text, "mingle_jobs_oldest_pending_age_seconds")).toBe(60);
    expect(value(text, "mingle_schedules_enabled")).toBe(1);
  });
});
