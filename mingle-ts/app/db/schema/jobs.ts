/**
 * Jobs schema — the `jobs` table behind the in-process job queue
 * (ADR-0002: a SQLite-backed jobs table drained by an in-process
 * worker, in place of the pg-boss ADR-0001 had planned).
 *
 * Purpose: durable background work. A job row is written on the same
 * connection as the domain change that needs it, so the change and its
 * follow-up work commit or roll back together — the transactional
 * outbox shape. The worker (app/jobs) claims rows, runs the handler
 * registered for `type`, and records the outcome on the row.
 *
 * Public interface: `jobs` (Drizzle table), `JOB_STATUSES`, `JobStatus`,
 * `JobRow`. Written only through app/jobs/queue.server.ts.
 *
 * Owner context: infrastructure (job queue).
 *
 * INVARIANT — at most one PENDING job per dedupe key: the partial
 * unique index makes "schedule this once, however many changes ask
 * for it" a database fact rather than a check-then-insert race. A job
 * that is already RUNNING does not block a new pending one, because
 * the running one may have read its inputs before the latest change.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * A job's lifecycle. `pending` is claimable once `run_at` has passed;
 * `running` is claimed by a worker; `done` and `failed` are terminal.
 */
export const JOB_STATUSES = ["pending", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Which handler runs this job (see app/jobs/handlers.server.ts). */
    type: text("type").notNull(),
    /** JSON — the handler's input, never secrets. */
    payload: text("payload").notNull(),
    /** See JOB_STATUSES. */
    status: text("status").notNull().default("pending"),
    /** Collapses repeat requests while one is still pending; NULL for none. */
    dedupeKey: text("dedupe_key"),
    /** How many times a worker has claimed this job. */
    attempts: integer("attempts").notNull().default(0),
    /** After this many failed attempts the job is marked failed for good. */
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Not claimable before this instant — the retry backoff lives here. */
    runAt: integer("run_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    /** When the current attempt was claimed; NULL while pending. */
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    /** The most recent attempt's error message, kept for operators. */
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    /** When the job reached a terminal status. */
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("jobs_pending_dedupe_unique")
      .on(t.dedupeKey)
      .where(sql`${t.status} = 'pending' AND ${t.dedupeKey} IS NOT NULL`),
    // The claim query: pending rows whose run_at has passed, oldest first.
    index("jobs_claim_idx").on(t.status, t.runAt),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
