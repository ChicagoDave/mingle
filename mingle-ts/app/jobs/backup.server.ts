/**
 * Backups — a restorable archive of the database and attachments
 * (ADR-0023 Decision 5).
 *
 * Purpose: the handler behind the "backup" schedule. An archive is a
 * directory `<BACKUPS_DIR>/<UTC timestamp>/` holding `mingle.db`,
 * written with SQLite's online backup API (never a file copy — a copy
 * of a WAL-mode database mid-write is not a database), and
 * `attachments/`, a copy of the attachments root. Restoring is putting
 * those two back where `DATABASE_FILE` and `ATTACHMENTS_DIR` point and
 * starting the app, which applies any newer migrations on boot.
 * Retention is keep-last-N (`BACKUP_KEEP`, default 7), applied only
 * after a successful write, so a failed backup can never delete an old
 * one.
 *
 * Public interface: `runBackup`, `backupsDirFromEnv`, `backupKeepFromEnv`,
 * `BACKUP_JOB`, `BackupReport`.
 *
 * Owner context: infrastructure (job queue handler). Takes the raw
 * better-sqlite3 handle because the backup API lives on it.
 */
import type { Database } from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The job type the backup schedule enqueues. */
export const BACKUP_JOB = "backup";

/** Archive directory names: the run's UTC instant, filesystem-safe. */
const ARCHIVE_NAME = /^\d{8}T\d{6}Z$/;

/** `BACKUPS_DIR`, else `backups/` beside the database file (the container's `/data/backups`). */
export function backupsDirFromEnv(): string {
  if (process.env.BACKUPS_DIR) return resolve(process.env.BACKUPS_DIR);
  const databaseFile = resolve(process.env.DATABASE_FILE ?? "data/mingle.db");
  return join(dirname(databaseFile), "backups");
}

/** `BACKUP_KEEP`, a positive integer, default 7. */
export function backupKeepFromEnv(): number {
  const raw = process.env.BACKUP_KEEP;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 7;
}

export interface BackupOptions {
  /** Where archives go. */
  backupsDir: string;
  /** The attachments root to copy; skipped when it does not exist. */
  attachmentsDir: string;
  /** How many newest archives to keep after this one is written. */
  keep: number;
  /** The run's instant; defaults to now (tests pin it). */
  now?: Date;
}

export interface BackupReport {
  /** The archive directory written. */
  archiveDir: string;
  /** Archives removed by retention. */
  removed: string[];
}

function archiveName(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Writes one archive and applies retention.
 *
 * DOES: creates `<backupsDir>/<timestamp>/`, writes `mingle.db` there
 * through SQLite's online backup (consistent, while the app runs),
 * copies the attachments root to `attachments/`, then removes the
 * oldest archives beyond `keep`. A write that fails leaves any partial
 * directory removed and every older archive untouched — retention
 * runs only after success.
 *
 * @param sqlite - the live database handle (better-sqlite3)
 * @param options - locations, retention, and the run's instant
 * @returns the archive written and what retention removed
 * @throws whatever the backup or copy raised, after cleaning the partial archive
 */
export async function runBackup(sqlite: Database, options: BackupOptions): Promise<BackupReport> {
  const now = options.now ?? new Date();
  const archiveDir = join(options.backupsDir, archiveName(now));
  mkdirSync(archiveDir, { recursive: true });
  try {
    await sqlite.backup(join(archiveDir, "mingle.db"));
    if (existsSync(options.attachmentsDir)) cpSync(options.attachmentsDir, join(archiveDir, "attachments"), { recursive: true });
  } catch (error) {
    rmSync(archiveDir, { recursive: true, force: true });
    throw error;
  }
  const archives = readdirSync(options.backupsDir)
    .filter((name) => ARCHIVE_NAME.test(name) && statSync(join(options.backupsDir, name)).isDirectory())
    .sort()
    .reverse();
  const removed: string[] = [];
  for (const name of archives.slice(Math.max(1, options.keep))) {
    rmSync(join(options.backupsDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return { archiveDir, removed };
}
