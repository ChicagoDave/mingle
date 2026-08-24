# ADR-0002: SQLite over Postgres

**Status**: ACCEPTED

## Context

ADR-0001 chose PostgreSQL + Drizzle and pg-boss for the mingle-ts rewrite. After Phase 1 shipped (compose stack: app + Postgres, real-path healthz test), the question was raised whether SQLite would serve the project's primary distribution goal — an easily installed, single-tenant, on-prem team tool — better than an external database server.

The parity target is the installed edition: one team, one node. Nothing in the roadmap requires multi-node database access, and the legacy product's own on-prem installer bundled everything into a single process for the same reason.

## Decision

Replace PostgreSQL with SQLite (via `better-sqlite3`, WAL mode) as the only supported database. Specifically:

- **Storage**: one SQLite database file on a mounted volume (`DATABASE_FILE`, default `/data/mingle.db` in the container). Backup is copying the file.
- **Deployment**: the docker-compose stack collapses to a single `app` service — no `db` container, no connection strings, no database credentials.
- **Background jobs**: pg-boss (Postgres-specific) is dropped. Jobs become a SQLite-backed jobs table drained by an in-process worker — the correct shape for a single-node deployment anyway.
- **Full-text search**: SQLite FTS5 replaces the planned Postgres full-text search when the search phases arrive.
- **No dual-dialect support**: Postgres is not kept as an option. Supporting two SQL dialects (types, FTS, queueing) is a permanent tax on every schema and query; a future hosted/scaled deployment would be a migration, not a config flag.

This supersedes ADR-0001's database and job-queue choices only; everything else in ADR-0001 stands.

## Consequences

- The install story reaches its ideal: `docker run` one image with one volume. This is the strongest possible alignment with the project's founding goal.
- Write concurrency is SQLite's single-writer model. WAL mode makes this a non-issue at the intended scale (one team on one node); it is a real ceiling if the deployment model ever changes.
- All schema work from Phase 2 onward is written against SQLite's type system (integer primary keys, text timestamps or unix epochs, no native enums) — chosen once, before any table exists.
- Phase 1's deliverables were reworked in place rather than re-planned: `client.server.ts` (better-sqlite3 + drizzle), `drizzle.config.ts` (sqlite dialect), healthz (real query against the file-backed DB), compose (single service), and the real-path test all swap with it.
- Migrations run in-process at app startup (drizzle migrator) — there is no separate migration step for operators, which suits a self-hosted audience.

## Session

43e4c4 — 2026-08-24. Decided at the start of Phase 2, before any domain schema existed.
