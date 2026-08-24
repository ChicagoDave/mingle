/**
 * Drizzle Kit configuration — migration generation settings (ADR-0002).
 *
 * Purpose: points drizzle-kit at the schema modules and the SQLite
 * database file for generating SQL migrations (applied at app startup
 * by app/db/client.server.ts, not by the CLI).
 * Public interface: the default export consumed by the drizzle-kit CLI.
 * Owner context: infrastructure (persistence tooling).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./app/db/schema",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? "data/mingle.db",
  },
});
