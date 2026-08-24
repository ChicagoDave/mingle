# Session Summary: 2026-08-24 - main

## Goals
- Decide whether SQLite should replace Postgres for the single-tenant, on-prem distribution model, before any domain schema existed.
- Rework Phase 1's deliverables onto the accepted decision and re-verify the real-path test.
- Implement Phase 2 (Identity & Access) end-to-end on SQLite.

## Phase Context
- **Plan**: Full feature-parity rewrite of Mingle in TypeScript (`docs/work/mingle-ts-full-parity/plan.md`).
- **Phase executed**: Phase 2 — "Identity & Access — users, authentication, profile" (Medium tier); also reworked Phase 1's already-DONE deliverables in place under ADR-0002.
- **Tool calls used**: not tracked for this write-up — the session-state file for this session (`43e4c4`) had already been retired by an earlier finalize cleanup before this summary was written; no `.session-state-43e4c4.json` exists to read.
- **Phase outcome**: Completed (Phase 2 budget 250; exact count unavailable per above).

## Completed

### ADR-0002: SQLite over Postgres (ACCEPTED)
- Wrote `docs/adrs/0002-sqlite-over-postgres.md`: `better-sqlite3` (WAL) as the sole database, `pg-boss` dropped for a future SQLite-backed jobs table drained by an in-process worker, FTS5 planned for search, no dual-dialect support, migrations run in-process at app startup.
- Stamped ADR-0001's Status line: `ACCEPTED (superseded in part by ADR-0002: SQLite replaces PostgreSQL, and pg-boss is dropped for a SQLite-backed job table)`.
- Updated `plan.md` in four places: the Overall Scope line, Phase 1's Status note (rework under ADR-0002), Phase 2's Status note (built on SQLite), the email-notifications phase's job-queue reference, and the packaging phase's deliverable (single-container SQLite install).

### SQLite swap (Phase 1 rework)
- Rewrote `mingle-ts/app/db/client.server.ts`: `better-sqlite3` + drizzle, runs the drizzle migrator at startup, throws (fails loudly) if the `drizzle/` migrations folder is missing rather than booting against an unmigrated database.
- `mingle-ts/drizzle.config.ts` switched to the sqlite dialect.
- `mingle-ts/docker-compose.yml` collapsed to a single `app` service with a `mingle-data` named volume — no `db` service, no connection string, no credentials.
- `mingle-ts/Dockerfile`: added `python3`/`make`/`g++` to the npm ci stages (native build deps `better-sqlite3` needs — no prebuilt binary for musl/arm64), and the runtime stage now copies `drizzle/` so migrations exist in the shipped image.
- `mingle-ts/app/routes/healthz.ts` re-pointed at a file-backed `SELECT 1`.
- Re-verified the Phase 1 real-path test against the reworked stack: compose up, healthz 200, 1/1 passing.

### Phase 2 — Identity & Access (DONE)
- Schema (`mingle-ts/app/db/schema/`): `users` and `domain_events` tables; first migration (`drizzle/0000`) generated.
- `mingle-ts/app/domain/`: scrypt-based password module; command handlers `registerUser`, `authenticateUser`, `updateUserProfile`, `changePassword`, each wrapped in one transaction that persists the mutation and emits a domain event (rule 10) together.
- Validation mirrors legacy parity: login format/uniqueness, optional case-insensitive-unique email, password 5–40 chars with at least one digit and one symbol.
- First registered user becomes admin (install parity with legacy Mingle).
- `mingle-ts/app/auth/session.server.ts`: cookie sessions with a persistent secret generated once and stored beside the DB file — zero-config, no env var required.
- Routes: `register.tsx`, `login.tsx`, `logout.ts`, `profile.tsx` (minimal styling — UX harvesting is a later phase).
- `wire-types.ts` gained `FieldErrors` (`Record<string, string[]>`) for form-action validation payloads.

### Verification
- 24/24 vitest tests pass — `test/identity.behavior.test.ts` (23 behavioral tests against a real temp-file SQLite database with real migrations) and `test/healthz.real.test.ts` (1 real-path test). Reran this turn, fresh, against the current tree: `npx vitest run` → "Test Files 2 passed (2), Tests 24 passed (24)".
- `npx tsc --noEmit` — reran this turn, exit code 0, same basis.
- The `mutation-verification` agent ran against the Phase 2 changes: the mutation layer itself was clean; it flagged three rejection-coverage gaps (untested REJECTS WHEN paths), all closed in the same session before Phase 2 was marked DONE.
- A manual end-to-end HTTP walk (register → profile) against the rebuilt container caught a real deployment bug: the runtime image's npm stage didn't carry `drizzle/`, so the container booted against an unmigrated DB and returned 500 "no such table: users" on first write. Fixed by shipping `drizzle/` in the runtime stage and making the startup migrator fail loudly instead of booting silently unmigrated. This manual walk was not captured as an automated test — reported by session, unverified as a repeatable check.

## Key Decisions

### 1. SQLite over Postgres for the single-tenant on-prem product (ADR-0002)
The parity target is a one-team, one-node install with no roadmap requirement for multi-node database access; collapsing to a single-file database gets the install story to `docker run` one image with one volume, matching the legacy on-prem installer's own reasoning for bundling everything into one process.

### 2. No dual-dialect support
Postgres was not kept as a config option — supporting two SQL dialects across schema, FTS, and job-queueing would be a permanent tax on every future migration; a future hosted/scaled deployment is treated as a real migration, not a flag flip.

### 3. Fail loudly on missing migrations
`client.server.ts` throws at startup if `drizzle/` is absent rather than booting against an unmigrated DB — this decision is what surfaced the runtime deployment bug during end-to-end verification instead of letting it fail silently later.

## Next Phase
- **Phase 3**: "Project lifecycle and project variables" — `projects` and `project_variables` schema/migrations; command handlers `CreateProject`, `UpdateProjectSettings`, `DefineProjectVariable` each producing `ProjectCreated`/`ProjectSettingsUpdated`/`ProjectVariableDefined` or rejecting.
- **Tier**: Medium (200 tool-call budget)
- **Entry state**: Phase 2 auth exists; an authenticated user can act.
- Marked `CURRENT (since 2026-08-24)` in `plan.md` as part of this summary's plan-integration step; implementation has not started — awaiting the user's go-ahead per rule 5.

## Open Items

### Short Term
- Commit and push this session's work (ADR-0002, SQLite swap, Phase 2) — in progress at session end.
- Begin Phase 3 on user go-ahead.

### Long Term
- Phase 31 (SSO/LDAP/OAuth/HMAC auth) deferred by design, not dropped — noted in Phase 2's domain focus.
- UX harvesting for the auth routes (register/login/profile styling) deferred to the plan's later harvesting phases.

## Files Modified

**ADRs & plan** (3 files):
- `docs/adrs/0002-sqlite-over-postgres.md` - new, ACCEPTED
- `docs/adrs/0001-rewrite-in-typescript-preserving-ux.md` - Status stamped "superseded in part by ADR-0002"
- `docs/work/mingle-ts-full-parity/plan.md` - scope/Phase 1/Phase 2/email-notifications/packaging updated; Phase 2 DONE, Phase 3 advanced to CURRENT

**Infra — SQLite swap** (5 files):
- `mingle-ts/app/db/client.server.ts` - better-sqlite3 + drizzle + startup migrator, fails loudly if `drizzle/` missing
- `mingle-ts/drizzle.config.ts` - sqlite dialect
- `mingle-ts/docker-compose.yml` - single `app` service + `mingle-data` volume
- `mingle-ts/Dockerfile` - python3/make/g++ build deps, ships `drizzle/` in the runtime stage
- `mingle-ts/app/routes/healthz.ts` - file-backed `SELECT 1`

**Identity & Access — Phase 2 (new)**:
- `mingle-ts/app/db/schema/` - `users`, `domain_events` tables + `drizzle/` first migration
- `mingle-ts/app/domain/` - password module, command handlers (registerUser/authenticateUser/updateUserProfile/changePassword)
- `mingle-ts/app/auth/session.server.ts` - cookie sessions, persistent secret beside the DB file
- `mingle-ts/app/routes/{register,login,profile}.tsx`, `logout.ts` - auth routes
- `mingle-ts/app/routes.ts` - route registration
- `mingle-ts/app/shared/wire-types.ts` - + `FieldErrors`
- `mingle-ts/test/identity.behavior.test.ts` - 23 behavioral tests (new)
- `mingle-ts/test/healthz.real.test.ts` - updated for SQLite

**Other**:
- `docs/context/project-profile.md` - Test command field updated to the working vitest suite (was "NONE" — the legacy apps have never had a runnable suite in this checkout)
- `mingle-ts/package.json` / `package-lock.json` - `better-sqlite3` dependency swap

## Notes

**Session duration**: Not tracked — the session-state file (`docs/context/.session-state-43e4c4.json`) had already been retired by the prior finalize's cleanup step before this summary was written; sequencing is reconstructed from git history (`bbd233b` Phase 1 commit → this session's uncommitted work) and the ADR/plan dates.

**Approach**: Decision before code — SQLite was decided and written up in ADR-0002 before any Phase 2 schema existed, so all of Phase 2 was built on the new dialect from the start rather than migrated after the fact.

**Gap**: exact tool-call count and session start/end times are unavailable for this summary (state file already gone); the Phase Context tool-calls line reflects that gap rather than a number.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert — nothing from this session has been pushed to origin; HEAD is `bbd233b` (Phase 1) and all of this session's changes are uncommitted in the working tree.

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 1's compose stack and scaffold (commit `bbd233b`) were the entry state for Phase 2's auth work.
- **Prerequisites discovered**: `better-sqlite3` needed native build tooling (`python3`/`make`/`g++`) in the Docker npm-ci stages that Phase 1's Dockerfile didn't carry — added this session.

## Architectural Decisions

- **ADR-0002**: SQLite over Postgres (ACCEPTED) — `better-sqlite3`/WAL, single-container install, pg-boss dropped for a future SQLite jobs table, FTS5 planned for search, no dual-dialect support, startup-time migrations.
- **ADR-0001**: Status amended to "superseded in part by ADR-0002" — the TypeScript/React-Router/framework-mode decision stands; only the database and job-queue choice changed.
- Pattern applied: command handler wraps mutation + domain event emission in one transaction (rule 10), consistent across all four Phase 2 handlers.

## Integration Reality Statement (rule 13a)

**SQLite database + container migrations**
- OWNED: the SQLite database file this repo creates and migrates (`better-sqlite3` + drizzle startup migrator); the app Docker image/container this repo builds and runs (single-service `docker-compose`).
- EXTERNAL: none — no third-party API or network service is part of this phase.
- REAL-PATH TEST: `mingle-ts/test/healthz.real.test.ts` — drives the live compose stack (real container rebuilt via `docker compose up -d --build`, real file-backed SQLite, real startup migrator) with no stub or override; re-run this session, 1/1 passing. The manual end-to-end register→profile HTTP walk against the same rebuilt container additionally exercised the migration path and is what caught the missing-`drizzle/`-folder bug, but it is not an automated, repeatable test — reported by session, unverified as a standing check.
- STUB JUSTIFICATION: `test/identity.behavior.test.ts` uses a real temp-file SQLite database with real migrations (not a stub or fake), so the identity domain's 23 behavioral tests are real-path-equivalent for the domain logic even though they don't exercise the container boundary — that boundary is covered by the healthz real-path test above.

## Mutation Audit

- Files with state-changing logic modified: `mingle-ts/app/domain/` (registerUser, authenticateUser, updateUserProfile, changePassword), `mingle-ts/app/db/client.server.ts` (startup migrator).
- Tests verify actual state mutations (not just events): YES (evidence: `test/identity.behavior.test.ts` — 23 tests against a real temp-file SQLite database with real migrations, reloading rows after each mutation to assert on persisted state; rerun this turn, "Tests 24 passed (24)").
- If NO: N/A

## Recurrence Check

- Similar to past issue? NO — the runtime-image-missing-migrations bug is new this session; neither `session-20260821-1254-mingle-ts-planning.md` nor `session-20260824-0756-mingle-ts-phase1.md` describes a comparable deployment gap.

## Test Coverage Delta

- Tests added: 23 (`test/identity.behavior.test.ts`, new); `test/healthz.real.test.ts` updated in place (still 1 test).
- Tests passing before: 1 (Phase 1's real-path test only) → after: 24 (evidence: `npx vitest run`, "Test Files 2 passed (2), Tests 24 passed (24)", run this turn against the current tree).
- Known untested areas: Phase 3 onward (projects, teams, cards, etc.) — not yet built.

---

**Progressive update**: Session completed 2026-08-24 08:26
