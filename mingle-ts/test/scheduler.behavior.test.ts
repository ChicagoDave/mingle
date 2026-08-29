/**
 * Behavioral tests for the scheduler (P-14, Phase 13 — ADR-0023).
 *
 * Derived from app/jobs/cron.server.ts (UTC next occurrence) and
 * app/jobs/scheduler.server.ts: a tick enqueues one job per due
 * schedule with the `<key>:<next_run_at>` dedupe key and advances the
 * schedule in the same transaction; a second tick, a restart, or an
 * overlapping tick enqueues nothing more; a window missed for days
 * runs once; UpdateSchedule validates the expression and recomputes
 * the next occurrence; RunScheduleNow enqueues with a manual key; the
 * handler's outcome is recorded on the row; the seeded backup schedule
 * exists disabled.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: infrastructure verification (job queue).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-scheduler-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "scheduler-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { schedules } = await import("../app/db/schema/schedules");
const { jobs } = await import("../app/db/schema/jobs");
const { users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { CronError, nextOccurrence, parseCron } = await import("../app/jobs/cron.server");
const { recordScheduleOutcome, runScheduleNow, tickScheduler, updateSchedule } = await import("../app/jobs/scheduler.server");
const { runPendingJobs } = await import("../app/jobs/queue.server");
const schedulesRoute = await import("../app/routes/admin.schedules");
const { createUserSession } = await import("../app/auth/session.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

const at = (iso: string) => new Date(iso);
const next = (cron: string, after: string) => nextOccurrence(parseCron(cron), at(after)).toISOString();

let adminId: number;
let devId: number;
let backupId: number;

beforeEach(() => {
  for (const table of [jobs, domainEvents, users]) db.delete(table).run();
  // The seeded row stays; reset it to its migration state.
  db.update(schedules).set({ cron: "0 3 * * *", enabled: false, nextRunAt: null, lastRunAt: null, lastOutcome: null, lastError: null, lastFinishedAt: null }).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "scheduler-1!" }), "admin").id;
  devId = mustOk(registerUser(db, { login: "dev", name: "Dev", password: "scheduler-1!" }), "dev").id;
  backupId = db.select({ id: schedules.id }).from(schedules).where(eq(schedules.key, "backup")).get()!.id;
  db.delete(domainEvents).run();
});

const backupRow = () => db.select().from(schedules).where(eq(schedules.id, backupId)).get()!;
const pendingJobs = () => db.select().from(jobs).where(eq(jobs.type, "backup")).all();
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

describe("cron expressions in UTC", () => {
  it("finds the next occurrence for daily, stepped, monthly, and weekday expressions", () => {
    expect(next("0 3 * * *", "2026-08-29T05:00:00Z")).toBe("2026-08-30T03:00:00.000Z");
    expect(next("0 3 * * *", "2026-08-29T02:59:30Z")).toBe("2026-08-29T03:00:00.000Z");
    expect(next("0 3 * * *", "2026-08-29T03:00:00Z")).toBe("2026-08-30T03:00:00.000Z"); // strictly after
    expect(next("*/15 * * * *", "2026-08-29T05:07:00Z")).toBe("2026-08-29T05:15:00.000Z");
    expect(next("30 2 1 * *", "2026-08-29T05:00:00Z")).toBe("2026-09-01T02:30:00.000Z");
    expect(next("0 9 * * 1", "2026-08-29T05:00:00Z")).toBe("2026-08-31T09:00:00.000Z"); // Saturday → Monday
    expect(next("0 9 * * 7", "2026-08-29T05:00:00Z")).toBe("2026-08-30T09:00:00.000Z"); // 7 = Sunday
    expect(next("0 0 15 * 1", "2026-08-01T00:00:00Z")).toBe("2026-08-03T00:00:00.000Z"); // dom OR dow: first Monday before the 15th
    expect(next("0 12 29 2 *", "2026-08-29T05:00:00Z")).toBe("2028-02-29T12:00:00.000Z"); // next leap day
  });

  it("rejects malformed expressions with the field named", () => {
    expect(() => parseCron("0 3 * *")).toThrow(CronError);
    expect(() => parseCron("60 3 * * *")).toThrow(/minute/);
    expect(() => parseCron("0 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("0 3 32 * *")).toThrow(/day-of-month/);
    expect(() => parseCron("0 3 * 13 *")).toThrow(/month/);
    expect(() => parseCron("0 3 * * 8")).toThrow(/day-of-week/);
    expect(() => parseCron("0 3 * * MON")).toThrow(CronError);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
    expect(() => nextOccurrence(parseCron("0 0 30 2 *"), at("2026-08-29T00:00:00Z"))).toThrow(/never fires/);
  });
});

describe("the scheduler tick", () => {
  it("enqueues one job for a due schedule with the <key>:<next_run_at> dedupe key and advances it in the same transaction", () => {
    mustOk(updateSchedule(db, { scheduleId: backupId, cron: "0 3 * * *", enabled: true, actorUserId: adminId, now: at("2026-08-29T01:00:00Z") }), "enable");
    expect(backupRow().nextRunAt?.toISOString()).toBe("2026-08-29T03:00:00.000Z");
    expect(tickScheduler(db, at("2026-08-29T02:59:00Z"))).toEqual({ enqueued: 0, deduplicated: 0 });
    expect(pendingJobs()).toEqual([]);

    expect(tickScheduler(db, at("2026-08-29T03:00:20Z"))).toEqual({ enqueued: 1, deduplicated: 0 });
    const [job] = pendingJobs();
    expect(job.dedupeKey).toBe("backup:2026-08-29T03:00:00.000Z");
    expect(JSON.parse(job.payload)).toEqual({ scheduleId: backupId, scheduledFor: "2026-08-29T03:00:00.000Z" });
    const row = backupRow();
    expect(row.nextRunAt?.toISOString()).toBe("2026-08-30T03:00:00.000Z");
    expect(row.lastRunAt?.toISOString()).toBe("2026-08-29T03:00:20.000Z");
    const [event] = events("ScheduleOccurrenceEnqueued");
    expect(JSON.parse(String(event.payload))).toMatchObject({ key: "backup", scheduledFor: "2026-08-29T03:00:00.000Z", jobId: job.id });
  });

  it("enqueues nothing more on an overlapping tick, a restart, or a re-run of the same occurrence while its job is pending", () => {
    mustOk(updateSchedule(db, { scheduleId: backupId, cron: "0 3 * * *", enabled: true, actorUserId: adminId, now: at("2026-08-29T01:00:00Z") }), "enable");
    tickScheduler(db, at("2026-08-29T03:00:10Z"));
    // Overlap / restart: the schedule already moved on, so the same instant is no longer due.
    expect(tickScheduler(db, at("2026-08-29T03:00:10Z"))).toEqual({ enqueued: 0, deduplicated: 0 });
    expect(tickScheduler(db, at("2026-08-29T03:01:00Z"))).toEqual({ enqueued: 0, deduplicated: 0 });
    expect(pendingJobs()).toHaveLength(1);
    // A clock jump backwards re-presents the occurrence: the pending job's dedupe key absorbs it.
    db.update(schedules).set({ nextRunAt: at("2026-08-29T03:00:00Z") }).where(eq(schedules.id, backupId)).run();
    expect(tickScheduler(db, at("2026-08-29T03:00:30Z"))).toEqual({ enqueued: 0, deduplicated: 1 });
    expect(pendingJobs()).toHaveLength(1);
    expect(events("ScheduleOccurrenceEnqueued")).toHaveLength(1);
  });

  it("runs a window missed for days once, then continues from the first future occurrence", () => {
    mustOk(updateSchedule(db, { scheduleId: backupId, cron: "0 3 * * *", enabled: true, actorUserId: adminId, now: at("2026-08-25T01:00:00Z") }), "enable");
    expect(backupRow().nextRunAt?.toISOString()).toBe("2026-08-25T03:00:00.000Z");
    // The app was down until the 29th.
    expect(tickScheduler(db, at("2026-08-29T10:00:00Z"))).toEqual({ enqueued: 1, deduplicated: 0 });
    expect(pendingJobs()).toHaveLength(1);
    expect(backupRow().nextRunAt?.toISOString()).toBe("2026-08-30T03:00:00.000Z");
    expect(tickScheduler(db, at("2026-08-29T11:00:00Z"))).toEqual({ enqueued: 0, deduplicated: 0 });
  });

  it("leaves a disabled schedule alone and disables one whose expression stopped parsing", () => {
    expect(backupRow().enabled).toBe(false);
    expect(tickScheduler(db, at("2030-01-01T00:00:00Z"))).toEqual({ enqueued: 0, deduplicated: 0 });
    db.update(schedules).set({ enabled: true, cron: "0 0 30 2 *", nextRunAt: at("2026-01-01T00:00:00Z") }).where(eq(schedules.id, backupId)).run();
    expect(tickScheduler(db, at("2026-08-29T00:00:00Z"))).toEqual({ enqueued: 0, deduplicated: 0 });
    expect(backupRow()).toMatchObject({ enabled: false, nextRunAt: null });
    expect(backupRow().lastError).toMatch(/^disabled: /);
    expect(pendingJobs()).toEqual([]);
  });
});

describe("UpdateSchedule and RunScheduleNow", () => {
  it("stores the expression, recomputes the next run, clears a disabling error, and refuses a bad expression or a non-admin", () => {
    db.update(schedules).set({ lastError: "disabled: the expression never fires within four years" }).where(eq(schedules.id, backupId)).run();
    const updated = mustOk(updateSchedule(db, { scheduleId: backupId, cron: " */30 * * * * ", enabled: true, actorUserId: adminId, now: at("2026-08-29T05:07:00Z") }), "update");
    expect(updated).toMatchObject({ cron: "*/30 * * * *", enabled: true, lastError: null });
    expect(updated.nextRunAt?.toISOString()).toBe("2026-08-29T05:30:00.000Z");
    expect(JSON.parse(String(events("ScheduleUpdated")[0].payload))).toEqual({ key: "backup", cron: "*/30 * * * *", enabled: true, nextRunAt: "2026-08-29T05:30:00.000Z" });

    const disabled = mustOk(updateSchedule(db, { scheduleId: backupId, cron: "*/30 * * * *", enabled: false, actorUserId: adminId }), "disable");
    expect(disabled.nextRunAt).toBeNull();

    const bad = updateSchedule(db, { scheduleId: backupId, cron: "every day", enabled: true, actorUserId: adminId });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.cron).toEqual(["a cron expression has five fields: minute hour day-of-month month day-of-week"]);
    const denied = updateSchedule(db, { scheduleId: backupId, cron: "0 3 * * *", enabled: true, actorUserId: devId });
    expect(denied.ok).toBe(false);
    expect(updateSchedule(db, { scheduleId: 999, cron: "0 3 * * *", enabled: true, actorUserId: adminId }).ok).toBe(false);
    expect(backupRow()).toMatchObject({ cron: "*/30 * * * *", enabled: false });
  });

  it("run-now enqueues with a manual key without touching the occurrences, dedupes an identical request, and records the handler's outcome", async () => {
    const before = backupRow();
    const first = mustOk(runScheduleNow(db, { scheduleId: backupId, actorUserId: adminId, now: at("2026-08-29T12:00:00Z") }), "run now");
    expect(first.jobId).not.toBeNull();
    const [job] = pendingJobs();
    expect(job.dedupeKey).toBe("backup:manual:2026-08-29T12:00:00.000Z");
    expect(JSON.parse(job.payload)).toEqual({ scheduleId: backupId, scheduledFor: "2026-08-29T12:00:00.000Z", manual: true });
    expect(backupRow().nextRunAt).toEqual(before.nextRunAt);
    expect(mustOk(runScheduleNow(db, { scheduleId: backupId, actorUserId: adminId, now: at("2026-08-29T12:00:00Z") }), "again").jobId).toBeNull();
    expect(pendingJobs()).toHaveLength(1);
    expect(runScheduleNow(db, { scheduleId: backupId, actorUserId: devId }).ok).toBe(false);
    expect(events("ScheduleRunRequested")).toHaveLength(2);

    // A handler standing in for the backup reports its outcome through the same call the real one makes.
    const report = await runPendingJobs(db, {
      backup: (jobDb, payload) => {
        recordScheduleOutcome(jobDb, Number(payload.scheduleId), { ok: false, error: "disk full" }, at("2026-08-29T12:00:05Z"));
        throw new Error("disk full");
      },
    });
    expect(report).toMatchObject({ ran: 1, failed: 0, retried: 1 });
    expect(backupRow()).toMatchObject({ lastOutcome: "failed", lastError: "disk full" });
    expect(backupRow().lastFinishedAt?.toISOString()).toBe("2026-08-29T12:00:05.000Z");
    recordScheduleOutcome(db, backupId, { ok: true }, at("2026-08-29T12:10:00Z"));
    expect(backupRow()).toMatchObject({ lastOutcome: "ok", lastError: null });
  });

  it("is edited from /admin/schedules by a site admin only, with times shown in the admin's zone", async () => {
    db.update(users).set({ timeZone: "America/Chicago" }).where(eq(users.id, adminId)).run();
    const cookieFor = async (userId: number) => (await createUserSession(userId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const post = async (userId: number, fields: Record<string, string>) => {
      const request = new Request("http://localhost/admin/schedules", {
        method: "POST",
        headers: { Cookie: await cookieFor(userId), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
      try {
        return { status: 200, data: (await schedulesRoute.action({ request, params: {}, context: {} } as never)) as Record<string, unknown> };
      } catch (thrown) {
        if (thrown instanceof Response) return { status: thrown.status, data: null };
        throw thrown;
      }
    };
    expect((await post(devId, { intent: "update", scheduleId: String(backupId), cron: "0 4 * * *", enabled: "on" })).status).toBe(403);
    const saved = await post(adminId, { intent: "update", scheduleId: String(backupId), cron: "0 4 * * *", enabled: "on" });
    expect(saved.data).toEqual({ saved: "update", scheduleId: backupId });
    expect(backupRow()).toMatchObject({ cron: "0 4 * * *", enabled: true });
    const invalid = await post(adminId, { intent: "update", scheduleId: String(backupId), cron: "nope", enabled: "on" });
    expect((invalid.data?.errors as Record<string, string[]>).cron).toBeDefined();
    const ran = await post(adminId, { intent: "run-now", scheduleId: String(backupId) });
    expect(ran.data).toMatchObject({ saved: "run-now", scheduleId: backupId });
    expect(pendingJobs()).toHaveLength(1);

    const loaded = (await schedulesRoute.loader({ request: new Request("http://localhost/admin/schedules", { headers: { Cookie: await cookieFor(adminId) } }), params: {}, context: {} } as never)) as {
      schedules: { key: string; cron: string; enabled: boolean; nextRunAt: string | null }[];
      timeZone: string;
    };
    expect(loaded.timeZone).toBe("America/Chicago");
    expect(loaded.schedules.map((s) => [s.key, s.cron, s.enabled])).toEqual([["backup", "0 4 * * *", true]]);
    expect(loaded.schedules[0].nextRunAt).toMatch(/T04:00:00\.000Z$/);
  });
});
