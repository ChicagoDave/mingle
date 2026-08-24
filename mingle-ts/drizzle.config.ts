/**
 * Drizzle Kit configuration — migration generation and push settings.
 *
 * Purpose: points drizzle-kit at the schema modules and the target
 * database for generating/applying SQL migrations.
 * Public interface: the default export consumed by the drizzle-kit CLI.
 * Owner context: infrastructure (persistence tooling).
 *
 * Schema files land under app/db/schema/ starting in Phase 2; the glob
 * is registered now so migrations work the moment the first table exists.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./app/db/schema",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://mingle:mingle@localhost:5432/mingle",
  },
});
