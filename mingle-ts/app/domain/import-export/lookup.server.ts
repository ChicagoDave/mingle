/**
 * Import/Export — project lookup for its HTTP adapters (Phase 28).
 *
 * Purpose: the one read the export and import routes need before
 * calling a command: a project by URL identifier. Kept here so the
 * routes import from this context only.
 *
 * Public interface: `findProjectByIdentifier`.
 *
 * Owner context: Import/Export.
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { projects, type ProjectRow } from "~/db/schema/projects";

/** The project with this URL identifier, if any. */
export function findProjectByIdentifier(db: BetterSQLite3Database, identifier: string): ProjectRow | undefined {
  return db.select().from(projects).where(eq(projects.identifier, identifier)).get();
}
