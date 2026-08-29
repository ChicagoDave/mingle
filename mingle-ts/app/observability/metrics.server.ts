/**
 * Metrics — the process's request counters and latency histogram, and
 * the Prometheus exposition of them plus the queue's depth (P-15).
 *
 * Purpose: one in-process registry the root middleware records every
 * request into, and one function that renders it in Prometheus text
 * exposition format (version 0.0.4) together with gauges read from the
 * database at scrape time — outbox/queue depth by status, and the
 * schedules that are enabled. No metrics library: the format is four
 * line shapes and the registry is two maps.
 *
 * Series:
 *   mingle_http_requests_total{method,status}     counter
 *   mingle_http_request_duration_seconds          histogram (per method)
 *   mingle_jobs{status}                           gauge, from the jobs table
 *   mingle_jobs_oldest_pending_age_seconds        gauge
 *   mingle_schedules_enabled                      gauge
 *   mingle_process_uptime_seconds                 gauge
 *
 * Invariant: the registry only ever grows by label set; it is reset
 * only by `resetMetrics` (tests) or a process restart — counters are
 * monotonic within a process, which is what a scraper assumes.
 *
 * Public interface: `recordRequest`, `renderMetrics`, `resetMetrics`,
 * `METRICS_CONTENT_TYPE`.
 *
 * Owner context: Observability (infrastructure).
 */
import { asc, count, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { jobs } from "~/db/schema/jobs";
import { schedules } from "~/db/schema/schedules";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Histogram bucket upper bounds, in seconds. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const requestsTotal = new Map<string, number>();
const durations = new Map<string, Histogram>();
const startedAt = Date.now();

/**
 * Records one finished request.
 *
 * @param method - the HTTP method, upper-cased
 * @param status - the response status
 * @param durationMs - wall time from receipt to response
 */
export function recordRequest(method: string, status: number, durationMs: number): void {
  const m = method.toUpperCase();
  const key = `${m}|${status}`;
  requestsTotal.set(key, (requestsTotal.get(key) ?? 0) + 1);
  let histogram = durations.get(m);
  if (!histogram) {
    histogram = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    durations.set(m, histogram);
  }
  const seconds = durationMs / 1000;
  BUCKETS.forEach((bound, index) => {
    if (seconds <= bound) histogram!.buckets[index] += 1;
  });
  histogram.sum += seconds;
  histogram.count += 1;
}

/** Clears the in-process registry (tests). */
export function resetMetrics(): void {
  requestsTotal.clear();
  durations.clear();
}

/** Prometheus label escaping. */
function label(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Renders every series in exposition format.
 *
 * @param db - the Drizzle handle, for the queue and schedule gauges
 * @param now - the scrape instant; defaults to now (tests pin it)
 */
export function renderMetrics(db: BetterSQLite3Database, now: Date = new Date()): string {
  const lines: string[] = [];

  lines.push("# HELP mingle_http_requests_total Requests handled, by method and status.", "# TYPE mingle_http_requests_total counter");
  for (const [key, value] of [...requestsTotal.entries()].sort()) {
    const [method, status] = key.split("|");
    lines.push(`mingle_http_requests_total{method=${label(method)},status=${label(status)}} ${value}`);
  }

  lines.push(
    "# HELP mingle_http_request_duration_seconds Request wall time from receipt to response.",
    "# TYPE mingle_http_request_duration_seconds histogram",
  );
  for (const [method, histogram] of [...durations.entries()].sort()) {
    BUCKETS.forEach((bound, index) => {
      lines.push(`mingle_http_request_duration_seconds_bucket{method=${label(method)},le=${label(String(bound))}} ${histogram.buckets[index]}`);
    });
    lines.push(`mingle_http_request_duration_seconds_bucket{method=${label(method)},le="+Inf"} ${histogram.count}`);
    lines.push(`mingle_http_request_duration_seconds_sum{method=${label(method)}} ${histogram.sum}`);
    lines.push(`mingle_http_request_duration_seconds_count{method=${label(method)}} ${histogram.count}`);
  }

  lines.push("# HELP mingle_jobs Outbox jobs by status (ADR-0018).", "# TYPE mingle_jobs gauge");
  const byStatus = new Map<string, number>([["pending", 0], ["running", 0], ["done", 0], ["failed", 0]]);
  for (const row of db.select({ status: jobs.status, total: count() }).from(jobs).groupBy(jobs.status).all()) byStatus.set(row.status, row.total);
  for (const [status, total] of [...byStatus.entries()].sort()) lines.push(`mingle_jobs{status=${label(status)}} ${total}`);

  lines.push(
    "# HELP mingle_jobs_oldest_pending_age_seconds Age of the oldest job still waiting to run; 0 when none.",
    "# TYPE mingle_jobs_oldest_pending_age_seconds gauge",
  );
  const oldest = db.select({ runAt: jobs.runAt }).from(jobs).where(eq(jobs.status, "pending")).orderBy(asc(jobs.runAt)).limit(1).get();
  lines.push(`mingle_jobs_oldest_pending_age_seconds ${oldest ? Math.max(0, (now.getTime() - oldest.runAt.getTime()) / 1000) : 0}`);

  lines.push("# HELP mingle_schedules_enabled Schedules currently enabled (ADR-0023).", "# TYPE mingle_schedules_enabled gauge");
  const enabled = db.select({ total: count() }).from(schedules).where(sql`${schedules.enabled} = 1`).get();
  lines.push(`mingle_schedules_enabled ${enabled?.total ?? 0}`);

  lines.push("# HELP mingle_process_uptime_seconds Seconds since this process started.", "# TYPE mingle_process_uptime_seconds gauge");
  lines.push(`mingle_process_uptime_seconds ${Math.max(0, (now.getTime() - startedAt) / 1000)}`);

  return `${lines.join("\n")}\n`;
}
