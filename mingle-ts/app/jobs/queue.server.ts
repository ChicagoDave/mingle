/**
 * Job queue — enqueueing and draining the `jobs` table (ADR-0002).
 *
 * Purpose: the single writer of `jobs`. Domain code enqueues a job on
 * the connection (or transaction) it is already using, so the job is
 * committed with the change that needs it; the worker drains claimable
 * jobs one at a time and records each outcome. There is no broker and
 * no second process — one SQLite table, one Node process, which is the
 * right shape for a single-node install.
 *
 * Delivery is AT-LEAST-ONCE: a handler that throws is retried with a
 * growing delay until `max_attempts`, and a process that dies mid-job
 * leaves the row `running` until `recoverStaleJobs` returns it to
 * `pending` at the next start. Handlers must therefore tolerate being
 * run again for the same input.
 *
 * Public interface: `enqueueJob`, `runPendingJobs`, `recoverStaleJobs`,
 * `JobHandler`, `JobHandlers`, `JobRunReport`.
 *
 * Owner context: infrastructure (job queue). Domain code depends on
 * this module; it depends on nothing in the domain.
 */
import { and, asc, eq, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { jobs, type JobRow } from "~/db/schema/jobs";

/** A handler runs one job's payload. Throwing marks the attempt failed. */
export type JobHandler = (
  db: BetterSQLite3Database,
  payload: Record<string, unknown>,
) => void | Promise<void>;

/** Handlers by job type — the registry the worker dispatches through. */
export type JobHandlers = Record<string, JobHandler>;

export interface EnqueueJobInput {
  /** The handler's key in the registry. */
  type: string;
  /** JSON-serializable input for the handler. Never secrets. */
  payload: Record<string, unknown>;
  /**
   * When set, a second enqueue with the same key while the first is
   * still pending is collapsed into it (returns null).
   */
  dedupeKey?: string;
  /** Do not run before this instant; defaults to now. */
  runAt?: Date;
  /** Attempts before the job is failed for good; defaults to 5. */
  maxAttempts?: number;
}

/**
 * Appends a job. Call with the transaction the surrounding command is
 * using so the job commits with the change that needs it.
 *
 * @param db - the Drizzle handle (or transaction)
 * @param input - the job's type, payload and scheduling
 * @returns the inserted row, or null when a pending job with the same
 *   dedupe key already exists and absorbed this request
 */
export function enqueueJob(
  db: BetterSQLite3Database,
  input: EnqueueJobInput,
): JobRow | null {
  const row = db
    .insert(jobs)
    .values({
      type: input.type,
      payload: JSON.stringify(input.payload),
      dedupeKey: input.dedupeKey ?? null,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  return row ?? null;
}

/**
 * Returns every `running` job to `pending`. For worker start-up only:
 * a row can be `running` at start only because a previous process died
 * holding it, and its attempt count already records that try.
 *
 * @returns how many jobs were recovered
 */
export function recoverStaleJobs(db: BetterSQLite3Database): number {
  return db
    .update(jobs)
    .set({ status: "pending", lockedAt: null })
    .where(eq(jobs.status, "running"))
    .returning({ id: jobs.id })
    .all().length;
}

/**
 * Claims the oldest claimable job, marking it running. The read and
 * the update share one transaction, which under SQLite's single
 * writer is what makes a claim exclusive.
 */
function claimNextJob(db: BetterSQLite3Database, now: Date): JobRow | null {
  return db.transaction((tx) => {
    const job = tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)))
      .orderBy(asc(jobs.runAt), asc(jobs.id))
      .get();
    if (!job) return null;
    return tx
      .update(jobs)
      .set({ status: "running", lockedAt: now, attempts: job.attempts + 1 })
      .where(eq(jobs.id, job.id))
      .returning()
      .get()!;
  });
}

/**
 * How long a failed attempt waits before the next: 30s, 2m, 4.5m, 8m…
 * (quadratic in the attempt number). Short enough that a transient
 * SMTP outage clears within the hour, long enough not to hammer it.
 */
function retryDelayMs(attempt: number): number {
  return 30_000 * attempt * attempt;
}

/** What one drain did. */
export interface JobRunReport {
  /** Jobs claimed this drain. */
  ran: number;
  succeeded: number;
  /** Attempts that failed and were rescheduled. */
  retried: number;
  /** Jobs that reached their attempt limit (or had no handler) and were failed for good. */
  failed: number;
}

export interface RunPendingJobsOptions {
  /** The instant "now" — jobs scheduled after it are not claimed. */
  now?: Date;
  /** Upper bound on jobs run in this drain; defaults to 100. */
  limit?: number;
}

/**
 * Drains claimable jobs, one at a time, dispatching each to its handler.
 *
 * DOES: for each claimed job, runs the handler and sets the row to
 * `done`; on a thrown error sets it back to `pending` with `run_at`
 * pushed out by the retry delay and `last_error` recorded, or to
 * `failed` once `attempts` reaches `max_attempts`. A job whose type has
 * no handler is failed immediately — retrying cannot make a handler
 * appear.
 * WHEN: called by the worker tick, or directly by a caller that wants
 * the queue drained now (tests, a CLI).
 * BECAUSE: the outcome of every attempt must be on the row — a job
 * that silently vanished would be indistinguishable from one that ran.
 *
 * @param db - the Drizzle handle
 * @param handlers - the registry to dispatch through
 * @param options - the instant to treat as now, and a run limit
 * @returns counts of what happened; never throws for a handler error
 */
export async function runPendingJobs(
  db: BetterSQLite3Database,
  handlers: JobHandlers,
  options: RunPendingJobsOptions = {},
): Promise<JobRunReport> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const report: JobRunReport = { ran: 0, succeeded: 0, retried: 0, failed: 0 };

  for (let i = 0; i < limit; i++) {
    const job = claimNextJob(db, now);
    if (!job) break;
    report.ran++;
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
      await handler(db, JSON.parse(job.payload) as Record<string, unknown>);
      db.update(jobs)
        .set({ status: "done", finishedAt: new Date(), lastError: null })
        .where(eq(jobs.id, job.id))
        .run();
      report.succeeded++;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      const permanent = !handler || job.attempts >= job.maxAttempts;
      if (permanent) {
        db.update(jobs)
          .set({ status: "failed", finishedAt: new Date(), lastError })
          .where(eq(jobs.id, job.id))
          .run();
        report.failed++;
      } else {
        db.update(jobs)
          .set({
            status: "pending",
            lockedAt: null,
            runAt: new Date(now.getTime() + retryDelayMs(job.attempts)),
            lastError,
          })
          .where(eq(jobs.id, job.id))
          .run();
        report.retried++;
      }
    }
  }
  return report;
}
