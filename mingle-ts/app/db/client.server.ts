/**
 * Database client — the server-side Postgres/Drizzle entry point.
 *
 * Purpose: owns the process-wide pg connection pool and the Drizzle
 * instance built on it. Server code (loaders, actions, jobs) imports
 * `db` (query building) or `pool` (raw round-trips such as health
 * probes) from here; nothing else opens connections.
 *
 * Public interface: `db`, `pool`.
 *
 * Owner context: infrastructure (persistence adapter). Domain code
 * depends on this module, never the reverse.
 *
 * The `.server.ts` suffix makes the bundler enforce that this module
 * (and the Node-only `pg` runtime it drags in) never reaches the client.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const { Pool } = pg;

/**
 * Connection string invariant: DATABASE_URL must be set — there is no
 * baked-in default that could silently point at the wrong database.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Local dev: `docker compose up db` provides postgres://mingle:mingle@localhost:5432/mingle — see docker-compose.yml.",
  );
}

/** Process-wide connection pool. One per process; never construct another. */
export const pool = new Pool({ connectionString });

/** Drizzle ORM instance over the shared pool. Schema is attached in later phases. */
export const db = drizzle(pool);
