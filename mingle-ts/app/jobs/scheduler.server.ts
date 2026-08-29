/**
 * Scheduler — time-triggered enqueues onto the outbox (ADR-0023).
 *
 * Purpose: the second enqueue origin beside commands. On every tick
 * (one minute, UTC) each enabled schedule whose `next_run_at` has
 * passed gets ONE job enqueued through the same kernel function
 * commands use, in the same short transaction that advances the
 * schedule to its first future occurrence — so a restart, an
 * overlapping tick, or a clock jump can never enqueue an occurrence
 * twice (the dedupe key is `<key>:<next_run_at>`), and a window missed
 * while the app was down runs once, not once per missed tick. The
 * handler is an ordinary outbox handler; the scheduler never calls
 * domain code. Schedules are rows edited on `/admin/schedules`
 * (`updateSchedule`, `runScheduleNow`); the handler reports back with
 * `recordScheduleOutcome`.
 *
 * Commands → events:
 *   UpdateSchedule   → ScheduleUpdated
 *   RunScheduleNow   → ScheduleRunRequested
 *   (tick)           → ScheduleOccurrenceEnqueued
 *
 * Public interface: `tickScheduler`, `ensureScheduler`, `updateSchedule`,
 * `runScheduleNow`, `recordScheduleOutcome`, `listSchedules`,
 * `SCHEDULER_TICK_MS`.
 *
 * Owner context: infrastructure (job queue) with the site-admin
 * commands that own the rows.
 *
 * INVARIANT — one scheduler per process (the worker's guard, for the
 * same reason).
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schedules, type ScheduleRow } from "~/db/schema/schedules";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import { CronError, nextOccurrence, parseCron } from "~/jobs/cron.server";
import { enqueueJob } from "~/jobs/queue.server";

/** How often the scheduler looks for due schedules. */
export const SCHEDULER_TICK_MS = 60_000;

const SCHEDULER_KEY = Symbol.for("mingle.scheduler");

interface SchedulerHost {
  [SCHEDULER_KEY]?: () => void;
}

/** What one tick did. */
export interface SchedulerTickReport {
  /** Schedules whose occurrence was enqueued this tick. */
  enqueued: number;
  /** Due schedules whose occurrence a pending job already carried (dedupe). */
  deduplicated: number;
}

/**
 * Enqueues every due schedule's occurrence and advances it.
 *
 * DOES: for each enabled schedule with `next_run_at <= now`, in one
 * transaction: enqueues `{ type: job_type, payload: { scheduleId,
 * scheduledFor }, dedupeKey: "<key>:<next_run_at ISO>" }`, sets
 * `next_run_at` to the first occurrence after `now` (collapsing every
 * missed window into this one run), stamps `last_run_at`, and appends
 * ScheduleOccurrenceEnqueued. A schedule whose cron no longer parses
 * is disabled with the error recorded rather than left due forever.
 *
 * @param db - the Drizzle handle
 * @param now - the tick instant; defaults to now (tests pin it)
 */
export function tickScheduler(db: BetterSQLite3Database, now: Date = new Date()): SchedulerTickReport {
  const report: SchedulerTickReport = { enqueued: 0, deduplicated: 0 };
  const due = db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, now)))
    .orderBy(asc(schedules.id))
    .all();
  for (const schedule of due) {
    const scheduledFor = schedule.nextRunAt!;
    let next: Date;
    try {
      next = nextOccurrence(parseCron(schedule.cron), now);
    } catch (error) {
      db.update(schedules)
        .set({ enabled: false, nextRunAt: null, lastError: `disabled: ${error instanceof Error ? error.message : String(error)}`, updatedAt: now })
        .where(eq(schedules.id, schedule.id))
        .run();
      continue;
    }
    db.transaction((tx) => {
      const job = enqueueJob(tx, {
        type: schedule.jobType,
        payload: { scheduleId: schedule.id, scheduledFor: scheduledFor.toISOString() },
        dedupeKey: `${schedule.key}:${scheduledFor.toISOString()}`,
      });
      tx.update(schedules).set({ nextRunAt: next, lastRunAt: now, updatedAt: now }).where(eq(schedules.id, schedule.id)).run();
      if (job) {
        report.enqueued += 1;
        emitEvent(tx, {
          type: "ScheduleOccurrenceEnqueued",
          aggregateType: "Schedule",
          aggregateId: schedule.id,
          payload: { key: schedule.key, scheduledFor: scheduledFor.toISOString(), jobId: job.id, nextRunAt: next.toISOString() },
          actorUserId: null,
        });
      } else {
        report.deduplicated += 1;
      }
    });
  }
  return report;
}

/**
 * Starts the scheduler loop if this process does not already have one.
 *
 * DOES: ticks once immediately and then every `intervalMs`, never
 * overlapping; the timer is unref'd so an idle scheduler never keeps
 * the process alive.
 *
 * @returns a function that stops the loop (idempotent)
 */
export function ensureScheduler(db: BetterSQLite3Database, intervalMs = SCHEDULER_TICK_MS): () => void {
  const host = globalThis as SchedulerHost;
  if (host[SCHEDULER_KEY]) return host[SCHEDULER_KEY];
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    try {
      tickScheduler(db);
    } catch (error) {
      console.error("[scheduler] tick failed", error);
    } finally {
      ticking = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    delete host[SCHEDULER_KEY];
  };
  host[SCHEDULER_KEY] = stop;
  return stop;
}

// --------------------------------------------------------------- commands

export interface UpdateScheduleInput {
  scheduleId: number;
  cron: string;
  enabled: boolean;
  actorUserId: number;
  /** Defaults to now (tests pin it). */
  now?: Date;
}

/**
 * UpdateSchedule — a site admin changes a schedule's expression or
 * enables/disables it.
 *
 * DOES: stores the trimmed expression and the flag; recomputes
 * `next_run_at` as the first occurrence after now when enabled (null
 * when disabled); clears a "disabled:" error; appends ScheduleUpdated;
 * one transaction.
 * REJECTS: actor not a site admin; unknown schedule; an expression
 * that does not parse (`cron`, with the parser's message).
 */
export function updateSchedule(db: BetterSQLite3Database, input: UpdateScheduleInput): CommandResult<ScheduleRow> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;
  const schedule = db.select().from(schedules).where(eq(schedules.id, input.scheduleId)).get();
  if (!schedule) return reject("schedule", "does not exist");
  const cron = input.cron.trim();
  const now = input.now ?? new Date();
  let nextRunAt: Date | null = null;
  try {
    const parsed = parseCron(cron);
    if (input.enabled) nextRunAt = nextOccurrence(parsed, now);
  } catch (error) {
    if (error instanceof CronError) return reject("cron", error.message);
    throw error;
  }
  return db.transaction((tx) => {
    const row = tx
      .update(schedules)
      .set({ cron, enabled: input.enabled, nextRunAt, lastError: schedule.lastError?.startsWith("disabled:") ? null : schedule.lastError, updatedAt: now })
      .where(eq(schedules.id, schedule.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: "ScheduleUpdated",
      aggregateType: "Schedule",
      aggregateId: schedule.id,
      payload: { key: schedule.key, cron, enabled: input.enabled, nextRunAt: nextRunAt?.toISOString() ?? null },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<ScheduleRow>;
  });
}

export interface RunScheduleNowInput {
  scheduleId: number;
  actorUserId: number;
  now?: Date;
}

/**
 * RunScheduleNow — a site admin asks for one immediate run.
 *
 * DOES: enqueues the schedule's job with dedupe key
 * `<key>:manual:<now ISO>` and appends ScheduleRunRequested; the
 * schedule's own occurrences are untouched. Works for a disabled
 * schedule too — running it by hand is not enabling it.
 * REJECTS: actor not a site admin; unknown schedule.
 *
 * @returns the job row, or null when an identical manual request is still pending
 */
export function runScheduleNow(db: BetterSQLite3Database, input: RunScheduleNowInput): CommandResult<{ jobId: number | null }> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;
  const schedule = db.select().from(schedules).where(eq(schedules.id, input.scheduleId)).get();
  if (!schedule) return reject("schedule", "does not exist");
  const now = input.now ?? new Date();
  return db.transaction((tx) => {
    const job = enqueueJob(tx, {
      type: schedule.jobType,
      payload: { scheduleId: schedule.id, scheduledFor: now.toISOString(), manual: true },
      dedupeKey: `${schedule.key}:manual:${now.toISOString()}`,
    });
    emitEvent(tx, {
      type: "ScheduleRunRequested",
      aggregateType: "Schedule",
      aggregateId: schedule.id,
      payload: { key: schedule.key, jobId: job?.id ?? null },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { jobId: job?.id ?? null } } as CommandResult<{ jobId: number | null }>;
  });
}

/**
 * Records how a schedule's job ended — the handler's report back.
 *
 * @param db - the Drizzle handle
 * @param scheduleId - the schedule the job carried in its payload
 * @param outcome - ok, or the failure's message
 * @param finishedAt - defaults to now
 */
export function recordScheduleOutcome(
  db: BetterSQLite3Database,
  scheduleId: number,
  outcome: { ok: true } | { ok: false; error: string },
  finishedAt: Date = new Date(),
): void {
  db.update(schedules)
    .set({ lastOutcome: outcome.ok ? "ok" : "failed", lastError: outcome.ok ? null : outcome.error, lastFinishedAt: finishedAt, updatedAt: finishedAt })
    .where(eq(schedules.id, scheduleId))
    .run();
}

/** Every schedule, by id. */
export function listSchedules(db: BetterSQLite3Database): ScheduleRow[] {
  return db.select().from(schedules).orderBy(asc(schedules.id)).all();
}
