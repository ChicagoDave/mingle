/**
 * Behavioral tests for scheduled backups (P-14, Phase 13 — ADR-0023
 * Decision 5, rule 13a: SQLite is an OWNED dependency and the backup
 * API is exercised for real).
 *
 * Derived from app/jobs/backup.server.ts and the backup handler in
 * app/jobs/handlers.server.ts: a run writes `<BACKUPS_DIR>/<timestamp>/`
 * with `mingle.db` through the online backup API and a copy of the
 * attachments root; retention keeps the newest N and runs only after
 * a successful write; a failed write removes its partial archive and
 * leaves the older ones; the handler records the outcome on the
 * schedule; and a restore into a fresh instance — the archived
 * database opened through the app's own client with the real
 * migrations — holds the same rows and the same attachment bytes as
 * the source.
 *
 * Owner context: infrastructure verification (job queue, packaging).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-backup-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "backup-suite-secret";
process.env.ATTACHMENTS_DIR = join(dir, "attachments");
process.env.BACKUPS_DIR = join(dir, "backups");
process.env.BACKUP_KEEP = "2";

const { db, sqlite } = await import("../app/db/client.server");
const { users } = await import("../app/db/schema/identity");
const { projects } = await import("../app/db/schema/projects");
const { cards } = await import("../app/db/schema/cards");
const { schedules } = await import("../app/db/schema/schedules");
const { jobs } = await import("../app/db/schema/jobs");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { saveAttachmentFile } = await import("../app/files/attachment-storage.server");
const { backupKeepFromEnv, backupsDirFromEnv, runBackup } = await import("../app/jobs/backup.server");
const { jobHandlers } = await import("../app/jobs/handlers.server");
const { runScheduleNow } = await import("../app/jobs/scheduler.server");
const { runPendingJobs } = await import("../app/jobs/queue.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

const backupsDir = join(dir, "backups");
const attachmentsDir = join(dir, "attachments");
const archives = () => (existsSync(backupsDir) ? readdirSync(backupsDir).sort() : []);
const at = (iso: string) => new Date(iso);

let adminId: number;
let projectId: number;
let fileKey = "";

beforeEach(() => {
  for (const table of [jobs, domainEvents, cards, projects, users]) db.delete(table).run();
  rmSync(backupsDir, { recursive: true, force: true });
  rmSync(attachmentsDir, { recursive: true, force: true });
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "backup-1!" }), "admin").id;
  projectId = mustOk(createProject(db, { name: "Backed Up", identifier: "backedup", actorUserId: adminId }), "project").id;
  const typeId = db.select().from(cards).limit(0).all().length; // placeholder to keep types honest
  void typeId;
  fileKey = saveAttachmentFile(new TextEncoder().encode("attachment bytes"), "notes.txt");
});

/** Opens an archived database as a fresh instance would: the app's migrations over the file. */
function openRestored(archiveDir: string) {
  const restoredFile = join(dir, `restored-${Date.now()}.db`);
  writeFileSync(restoredFile, readFileSync(join(archiveDir, "mingle.db")));
  const restoredSqlite = new Database(restoredFile);
  const restored = drizzle(restoredSqlite);
  migrate(restored, { migrationsFolder: "drizzle" });
  return { restored, restoredSqlite };
}

describe("runBackup", () => {
  it("writes mingle.db through the online backup API and copies the attachments; a fresh instance restored from it holds the same data", async () => {
    const typeId = sqlite.prepare("select id from card_types where project_id = ?").get(projectId) as { id: number };
    const card = mustOk(createCard(db, { projectId, name: "Keep me", cardTypeId: typeId.id, actorUserId: adminId }), "card");
    const report = await runBackup(sqlite, { backupsDir, attachmentsDir, keep: 2, now: at("2026-08-29T03:00:00Z") });
    expect(report.archiveDir).toBe(join(backupsDir, "20260829T030000Z"));
    expect(report.removed).toEqual([]);
    expect(archives()).toEqual(["20260829T030000Z"]);
    expect(existsSync(join(report.archiveDir, "mingle.db"))).toBe(true);
    expect(readFileSync(join(report.archiveDir, "attachments", fileKey), "utf8")).toBe("attachment bytes");

    // The source keeps working after the backup (the online API does not lock it).
    mustOk(createCard(db, { projectId, name: "After the backup", cardTypeId: typeId.id, actorUserId: adminId }), "later card");

    const { restored, restoredSqlite } = openRestored(report.archiveDir);
    try {
      expect(restored.select({ login: users.login }).from(users).all()).toEqual([{ login: "admin" }]);
      expect(restored.select({ identifier: projects.identifier, name: projects.name }).from(projects).all()).toEqual([{ identifier: "backedup", name: "Backed Up" }]);
      const restoredCards = restored.select({ number: cards.number, name: cards.name }).from(cards).where(eq(cards.projectId, projectId)).all();
      expect(restoredCards).toEqual([{ number: card.number, name: "Keep me" }]); // the later card is not in the archive
      expect((restoredSqlite.pragma("integrity_check") as { integrity_check: string }[])[0].integrity_check).toBe("ok");
    } finally {
      restoredSqlite.close();
    }
  });

  it("keeps the newest N archives after a successful run and never removes one on failure", async () => {
    for (const stamp of ["20260826T030000Z", "20260827T030000Z", "20260828T030000Z"]) {
      mkdirSync(join(backupsDir, stamp), { recursive: true });
      writeFileSync(join(backupsDir, stamp, "mingle.db"), "old");
    }
    mkdirSync(join(backupsDir, "not-an-archive"));
    const report = await runBackup(sqlite, { backupsDir, attachmentsDir, keep: 2, now: at("2026-08-29T03:00:00Z") });
    expect(report.removed).toEqual(["20260827T030000Z", "20260826T030000Z"]);
    expect(archives()).toEqual(["20260828T030000Z", "20260829T030000Z", "not-an-archive"]);

    // A failed write: the backups dir is replaced by a file, so nothing can be written there.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    await expect(runBackup(sqlite, { backupsDir: blocked, attachmentsDir, keep: 1, now: at("2026-08-30T03:00:00Z") })).rejects.toThrow();
    expect(archives()).toEqual(["20260828T030000Z", "20260829T030000Z", "not-an-archive"]);
    // A failure after the directory exists removes only the partial archive: a
    // directory squatting where mingle.db must be written makes the backup API fail.
    const partial = join(dir, "partial-backups");
    mkdirSync(partial);
    await expect(runBackup(sqlite, { backupsDir: partial, attachmentsDir: join(dir, "nope"), keep: 1, now: at("2026-08-30T03:00:00Z") })).resolves.toBeDefined();
    mkdirSync(join(partial, "20260831T030000Z", "mingle.db"), { recursive: true });
    await expect(runBackup(sqlite, { backupsDir: partial, attachmentsDir, keep: 5, now: at("2026-08-31T03:00:00Z") })).rejects.toThrow();
    expect(readdirSync(partial)).toEqual(["20260830T030000Z"]);
  });

  it("reads its locations from the environment with the documented defaults", () => {
    expect(backupsDirFromEnv()).toBe(backupsDir);
    expect(backupKeepFromEnv()).toBe(2);
    const savedDir = process.env.BACKUPS_DIR;
    const savedKeep = process.env.BACKUP_KEEP;
    delete process.env.BACKUPS_DIR;
    process.env.BACKUP_KEEP = "zero";
    expect(backupsDirFromEnv()).toBe(join(dir, "backups"));
    expect(backupKeepFromEnv()).toBe(7);
    process.env.BACKUPS_DIR = savedDir;
    process.env.BACKUP_KEEP = savedKeep;
  });
});

describe("the backup job through the queue", () => {
  it("runs from a run-now request, writes the archive, and records ok on the schedule; a failure records the error and retries", async () => {
    const backup = db.select().from(schedules).where(eq(schedules.key, "backup")).get()!;
    mustOk(runScheduleNow(db, { scheduleId: backup.id, actorUserId: adminId, now: at("2026-08-29T12:00:00Z") }), "run now");
    const report = await runPendingJobs(db, { backup: jobHandlers.backup });
    expect(report).toMatchObject({ ran: 1, succeeded: 1, failed: 0 });
    expect(archives()).toHaveLength(1);
    expect(existsSync(join(backupsDir, archives()[0], "attachments", fileKey))).toBe(true);
    const after = db.select().from(schedules).where(eq(schedules.id, backup.id)).get()!;
    expect(after).toMatchObject({ lastOutcome: "ok", lastError: null });
    expect(after.lastFinishedAt).not.toBeNull();

    // Now block the destination: the handler records the failure and the job is retried.
    rmSync(backupsDir, { recursive: true, force: true });
    writeFileSync(backupsDir, "blocked");
    mustOk(runScheduleNow(db, { scheduleId: backup.id, actorUserId: adminId, now: at("2026-08-29T12:30:00Z") }), "run now again");
    const failed = await runPendingJobs(db, { backup: jobHandlers.backup });
    expect(failed).toMatchObject({ ran: 1, succeeded: 0, retried: 1 });
    const afterFailure = db.select().from(schedules).where(eq(schedules.id, backup.id)).get()!;
    expect(afterFailure.lastOutcome).toBe("failed");
    expect(afterFailure.lastError).toBeTruthy();
    rmSync(backupsDir, { force: true });
  });
});
