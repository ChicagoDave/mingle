/**
 * Database client — the server-side SQLite/Drizzle entry point (ADR-0002).
 *
 * Purpose: owns the process-wide better-sqlite3 connection and the
 * Drizzle instance built on it, and applies pending migrations at
 * startup (single-container installs have no separate migrate step).
 * Server code (loaders, actions, jobs) imports `db` (query building)
 * or `sqlite` (raw statements such as health probes) from here;
 * nothing else opens the database file.
 *
 * Public interface: `db`, `sqlite`.
 *
 * Owner context: infrastructure (persistence adapter). Domain code
 * depends on this module, never the reverse.
 *
 * The `.server.ts` suffix makes the bundler enforce that this module
 * (and the Node-only native driver) never reaches the client.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/**
 * Storage invariant: exactly one database file, location controlled by
 * DATABASE_FILE (container default /data/mingle.db via compose; local
 * dev falls back to ./data/mingle.db). The parent directory is created
 * on first boot so a fresh volume works without manual setup.
 */
const databaseFile = resolve(process.env.DATABASE_FILE ?? "data/mingle.db");
mkdirSync(dirname(databaseFile), { recursive: true });

/** Process-wide connection. One per process; never construct another. */
export const sqlite = new Database(databaseFile);
// WAL keeps readers unblocked during writes — required for a multi-user
// single-writer deployment (ADR-0002).
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

/** Drizzle ORM instance over the shared connection. */
export const db = drizzle(sqlite);

// Apply pending migrations at startup (idempotent). Booting without the
// migrations folder would mean serving requests against a schema-less
// database — fail loudly instead (invariant: schema is always current).
const migrationsFolder = resolve("drizzle");
if (!existsSync(migrationsFolder)) {
  throw new Error(
    `Migrations folder not found at ${migrationsFolder} — the deployment is missing the drizzle/ directory.`,
  );
}
migrate(db, { migrationsFolder });
