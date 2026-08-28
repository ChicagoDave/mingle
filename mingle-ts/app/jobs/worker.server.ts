/**
 * Job worker — the in-process loop that drains the jobs table
 * (ADR-0002).
 *
 * Purpose: turns `runPendingJobs` into a background activity of the
 * web process. There is deliberately no separate worker process: the
 * install story is one container with one volume, and a second
 * process would need its own supervision, its own connection, and a
 * reason to exist that a single-node deployment does not supply.
 *
 * Public interface: `ensureJobWorker`.
 *
 * Owner context: infrastructure (job queue).
 *
 * INVARIANT — one worker per process. Two loops draining the same
 * table would be correct (claims are exclusive) but would double the
 * polling for nothing, and under the dev server's module reloads the
 * entry module can be evaluated more than once, so the guard lives on
 * `globalThis` rather than in module state.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { type JobHandlers, recoverStaleJobs, runPendingJobs } from "~/jobs/queue.server";

/** How often the worker looks for claimable jobs when idle. */
const DEFAULT_INTERVAL_MS = 5_000;

const WORKER_KEY = Symbol.for("mingle.jobWorker");

interface WorkerHost {
  [WORKER_KEY]?: () => void;
}

/**
 * Starts the worker loop if this process does not already have one.
 *
 * DOES: returns stale `running` jobs to `pending`, drains the queue
 * once immediately, then drains it every `intervalMs` — never
 * overlapping two drains — until the returned stop function is called.
 * The timer is unref'd so an idle worker never keeps the process alive.
 * WHEN: called from the server entry module at boot.
 * BECAUSE: a job that is never drained is a change that was silently
 * dropped; the worker is what makes an enqueue a promise.
 *
 * @param db - the process-wide Drizzle handle
 * @param handlers - the job registry
 * @param intervalMs - idle polling interval; defaults to 5 seconds
 * @returns a function that stops the loop (idempotent)
 */
export function ensureJobWorker(
  db: BetterSQLite3Database,
  handlers: JobHandlers,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  const host = globalThis as WorkerHost;
  if (host[WORKER_KEY]) return host[WORKER_KEY];

  recoverStaleJobs(db);
  let draining = false;
  const tick = async () => {
    if (draining) return;
    draining = true;
    try {
      await runPendingJobs(db, handlers);
    } catch (error) {
      // runPendingJobs absorbs handler errors; anything reaching here is
      // the queue itself (a closed database, a broken table).
      console.error("[jobs] drain failed:", error);
    } finally {
      draining = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();

  const stop = () => {
    clearInterval(timer);
    delete host[WORKER_KEY];
  };
  host[WORKER_KEY] = stop;
  return stop;
}
