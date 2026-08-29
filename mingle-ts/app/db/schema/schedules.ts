/**
 * Scheduler schema — the `schedules` table (ADR-0023).
 *
 * Purpose: time-triggered work as rows, not code. Each row names a job
 * type, a cron expression interpreted in UTC, and the next occurrence
 * to enqueue; the scheduler's tick reads it, the `/admin/schedules`
 * page is the only writer of the expression and the enabled flag, and
 * the job's handler writes the last outcome back.
 *
 * Public interface: `schedules`, `ScheduleRow`.
 *
 * Owner context: infrastructure (job queue).
 */
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Stable identifier the dedupe key is built from, e.g. "backup". */
    key: text("key").notNull(),
    /** Display name on the admin page. */
    name: text("name").notNull(),
    /** The job type the tick enqueues — a key of the job registry. */
    jobType: text("job_type").notNull(),
    /** Five-field cron expression, interpreted in UTC. Validity enforced in the domain layer. */
    cron: text("cron").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** The next occurrence to enqueue, as a UTC instant; null while disabled. */
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    /** When the last occurrence was enqueued. */
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    /** "ok" or "failed" from the last completed run; null before any. */
    lastOutcome: text("last_outcome"),
    /** The last failure's message, for the admin page. */
    lastError: text("last_error"),
    /** When the last run finished (either way). */
    lastFinishedAt: integer("last_finished_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("schedules_key_unique").on(t.key)],
);

export type ScheduleRow = typeof schedules.$inferSelect;
