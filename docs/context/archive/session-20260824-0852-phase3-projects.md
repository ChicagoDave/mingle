# Session Summary: 2026-08-24 - main

## Goals
- Implement Phase 3 ("Project lifecycle and project variables") of the mingle-ts full-parity plan, start to finish, on user go-ahead ("phase 3").

## Phase Context
- **Plan**: Full feature-parity rewrite of Mingle in TypeScript (`docs/work/mingle-ts-full-parity/plan.md`).
- **Phase executed**: Phase 3 — "Project lifecycle and project variables" (Medium tier, 200 tool-call budget).
- **Tool calls used**: at least 53/200 (last budget-tagged row in `docs/context/.devarch-events-19e1a7.jsonl` at 13:45:01Z); the state file (`docs/context/.session-state-19e1a7.json`) is present but empty, and later event rows stop carrying a budget value, so an exact final count isn't available.
- **Phase outcome**: Completed under budget (53+/200 recorded, well inside the 200-call budget).

## Completed

### Schema and migration
- `mingle-ts/app/db/schema/projects.ts` (new): `projects` table (name unique case-insensitively, identifier unique, description, `created_by_user_id`, timestamps) and `project_variables` table (name unique case-insensitively per project, `data_type` discriminator, text value).
- `mingle-ts/drizzle/0001_bouncy_vin_gonzales.sql` + `mingle-ts/drizzle/meta/0001_snapshot.json` (new), `mingle-ts/drizzle/meta/_journal.json` updated — generated migration for the above.

### Domain kernel extraction
- `mingle-ts/app/domain/command.server.ts` (new): lifted `CommandResult`/`reject` out of the Identity context into a shared cross-context domain kernel, so Card Management doesn't import Identity & Access (dependency-direction fix, rule 8).
- `mingle-ts/app/domain/identity/commands.server.ts` edited import-only to re-point at the kernel; the `mutation-verification` agent confirmed via git diff that the edit is behavior-free.

### Command handlers
- `mingle-ts/app/domain/projects/commands.server.ts` (new): `createProject` → `ProjectCreated`, `updateProjectSettings` → `ProjectSettingsUpdated` (payload lists exactly the changed fields), `defineProjectVariable` → `ProjectVariableDefined`; each wraps mutation + event emission in one transaction (rule 10).
- Legacy parity harvested from `mingle/app/models/{project,identifiable,project_variable}.rb`: identifier rules (lowercase `[0-9a-z_]`, ≤30 chars, no leading digit, no `mi_NNNNNN` internal prefix, unique), identifier generation from name (non-alphanumerics → `_`, lowercase, `project_` prefix when digit-leading, numeric suffix until unique), case-insensitive name uniqueness (≤255 chars), reserved variable names (`(not set)`, `(any)`, `(current user)`, `(today)`, `:ignore`, etc.), and per-type value rules: no parenthesis-wrapped values; `NumericType` numeric; `DateType` ISO date for now (legacy per-project date formats deferred to the phase that adds project date settings); `UserType` must reference an existing user until Phase 4 tightens this to team membership; `StringType`/`CardType` unvalidated per legacy.

### Wire types and routes
- `mingle-ts/app/shared/wire-types.ts`: added `PROJECT_VARIABLE_DATA_TYPES` const, `ProjectVariableDataType` type, `PROJECT_VARIABLE_DATA_TYPE_LABELS` (ports legacy `DATA_TYPE_DESCRIPTIONS`).
- Routes (auth-gated via `requireUserId`, minimal styling — UX harvesting is a later phase): `mingle-ts/app/routes/projects.tsx` (list, ordered `lower(name)`), `projects.new.tsx` (create, redirects to settings), `projects.settings.tsx` (settings + define-variable forms, intent-discriminated like `profile.tsx`; redirects when identifier changes). Registered in `mingle-ts/app/routes.ts`.

### Verification
- 61/61 vitest tests pass: `mingle-ts/test/projects.behavior.test.ts` (new, 37 behavioral tests against a real temp-file SQLite database with real migrations, reloading rows after each mutation) plus the existing 23 identity + 1 healthz real-path tests (evidence: `docs/context/.devarch-events-19e1a7.jsonl` test-row `"3 passed 61 passed"` at 2026-08-24T13:47:47Z, timestamped after the last edit to `test/projects.behavior.test.ts` at 13:47:31Z). `npx tsc --noEmit` clean [reported by session, unverified — no build/typecheck row appears in the event log].
- `mutation-verification` agent ran: mutation layer clean (real transactional writes, same-connection event appends, GREEN-grade tests). One finding — six `updateProjectSettings` rejection paths (blank name, over-long name, four invalid identifier forms) were only exercised via `createProject`. Closed same session with 3 new rejection tests asserting unchanged rows and zero new events, before Phase 3 was marked DONE (evidence: event log shows test counts rising from `"3 passed 58 passed"` at 13:44:36Z, through the agent's own `"1 passed 34 passed"` sub-run at 13:45:49Z, to `"3 passed 61 passed"` at 13:47:47Z after the rejection tests were added).
- End-to-end HTTP walk against the rebuilt container (`docker compose up -d --build`): register → create project → update settings → define variable → reserved-name rejection rendered; queried the in-container SQLite database directly to verify the persisted `projects`/`project_variables` rows and the exact event trail `[ProjectCreated, ProjectSettingsUpdated, ProjectVariableDefined]`. This also proved migration `0001` applies at container startup. The walk is scripted (`phase3-walk.sh` in the session scratchpad) but is not a standing automated test — same status as Phase 2's manual walk.

## Key Decisions

### 1. `CommandResult` lifted to a shared domain kernel
Rather than have Projects import from Identity & Access, `CommandResult`/`reject` moved to `app/domain/command.server.ts`, a cross-context kernel both contexts import — keeps dependency direction clean (rule 8) without duplicating the type. Not ADR-worthy: an application of the existing dependency-direction rule, not a new constraint.

### 2. `DateType` variable values validated as ISO dates for now
Legacy per-project date formats are deferred to the phase that introduces project date settings; validating ISO dates now is a placeholder consistent with the plan's phase ordering, not a permanent format decision.

### 3. `UserType` variable values validated against the `users` table until Phase 4
Team membership doesn't exist yet, so the tightest available validation is "the referenced user exists"; Phase 4 will narrow this to team membership.

## Next Phase
- **Phase 4**: "Team membership, groups, and permissions" — `TeamMembership`, `Group`, `Role` (admin | project admin | team member | readonly member) scoped per `Project`; `team_memberships`, `groups`, `group_memberships` schema; routes to add/remove team members, assign roles, and manage groups per project; establishes the authorization checkpoint every later phase reuses.
- **Tier**: Medium (250 tool-call budget)
- **Entry state**: Phase 3 projects exist; Phase 2 users exist.
- Not advanced to CURRENT this session — awaiting the user's go-ahead per rule 5.

## Open Items

### Short Term
- Commit and push this session's work — in progress at session end.
- Begin Phase 4 on user go-ahead.

### Long Term
- The register→profile (Phase 2) and create→settings→variable (Phase 3) HTTP walks are both scripted/manual, not standing automated tests.
- UX harvesting for the project routes deferred to the plan's later harvesting phases.
- Legacy-template harvest source still to be pinned when a UI-bearing phase begins.

## Files Modified

**Plan** (1 file):
- `docs/work/mingle-ts-full-parity/plan.md` - Phase 3 marked DONE (2026-08-24); Phase 4 left PENDING

**Domain kernel & Identity (2 files)**:
- `mingle-ts/app/domain/command.server.ts` - new: `CommandResult`/`reject` shared kernel
- `mingle-ts/app/domain/identity/commands.server.ts` - import-only re-point at the kernel (behavior-free, confirmed by mutation-verification)

**Projects — Phase 3 (new)**:
- `mingle-ts/app/db/schema/projects.ts` - `projects`, `project_variables` tables
- `mingle-ts/drizzle/0001_bouncy_vin_gonzales.sql`, `mingle-ts/drizzle/meta/0001_snapshot.json`, `mingle-ts/drizzle/meta/_journal.json` - migration 0001
- `mingle-ts/app/domain/projects/commands.server.ts` - createProject/updateProjectSettings/defineProjectVariable
- `mingle-ts/app/routes/projects.tsx`, `projects.new.tsx`, `projects.settings.tsx` - project routes
- `mingle-ts/app/routes.ts` - route registration
- `mingle-ts/app/shared/wire-types.ts` - + project variable data-type constants
- `mingle-ts/test/projects.behavior.test.ts` - 37 behavioral tests (new)

## Notes

**Session duration**: ~15 minutes per the event log (`docs/context/.devarch-events-19e1a7.jsonl`, session start 13:33:09Z to last recorded edit 13:48:00Z) — the session-state file for this id is present but empty, so this is reconstructed from event timestamps rather than a tracked duration field.

**Approach**: legacy-parity-first — Ruby model validation rules (`project.rb`, `identifiable.rb`, `project_variable.rb`) harvested and ported before writing tests, consistent with Phase 2's approach.

**Gap**: `docs/context/.session-state-19e1a7.json` exists but is empty (0 bytes), and the sessions-root `.active-session` pointer currently names a different, later session id (`44886a`) — both are noted here rather than silently worked around.

---

## Session Metadata

- **Status**: COMPLETE (unverified: `npx tsc --noEmit` clean; the container's persisted-row and event-trail correctness from the manual HTTP walk — neither has a corroborating event-log row, though the vitest pass counts do)
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert — nothing from this session has been pushed to origin; HEAD is `2151872` (Phase 2) and all of this session's changes are uncommitted in the working tree.

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 2's users table and cookie-session auth (`requireUserId`) were the entry state this phase's routes gate on.
- **Prerequisites discovered**: none.

## Architectural Decisions

- None this session (no ADR written or amended).
- Pattern applied: command handler wraps mutation + domain event emission in one transaction (rule 10), consistent with Phase 2's four handlers.
- Pattern applied: dependency-direction fix (rule 8) via a shared domain kernel rather than a cross-context import.

## Integration Reality Statement (rule 13a)

**SQLite migration 0001 (projects/project_variables)**
- OWNED: migration `mingle-ts/drizzle/0001_bouncy_vin_gonzales.sql`, run by the same startup migrator introduced in Phase 2.
- EXTERNAL: none.
- REAL-PATH TEST: `mingle-ts/test/projects.behavior.test.ts` — 37 tests run against a real temp-file SQLite database with the real migration applied, no stub or override (evidence: event log row `"3 passed 61 passed"` at 13:47:47Z, after the last edit to the test file). Additionally, the manual end-to-end HTTP walk against the rebuilt container queried the in-container SQLite database directly and confirmed migration `0001` had applied at container startup — reported by session, unverified as a standing automated check (same status as Phase 2's equivalent walk; no event-log row covers docker exec output), but it did exercise the real container boundary this turn.
- STUB JUSTIFICATION: none — all Phase 3 tests use a real database with real migrations, not a stub or fake.

## Mutation Audit

- Files with state-changing logic modified: `mingle-ts/app/domain/projects/commands.server.ts` (createProject, updateProjectSettings, defineProjectVariable).
- Tests verify actual state mutations (not just events): YES (evidence: `test/projects.behavior.test.ts` — 37 tests against a real temp-file SQLite database with real migrations, reloading rows after each mutation to assert on persisted state; event log row `"3 passed 61 passed"` at 2026-08-24T13:47:47Z, after the last edit to the test file at 13:47:31Z).
- If NO: N/A

## Recurrence Check

- Similar to past issue? YES — `session-20260824-0826-sqlite-and-phase2.md` (Phase 2) recorded the `mutation-verification` agent flagging three untested REJECTS WHEN paths, closed same-session before Phase 2 was marked DONE. This session the same agent flagged six REJECTS WHEN paths on `updateProjectSettings` (untested independently of `createProject`), again closed same-session before Phase 3 was marked DONE.
- Consider: a lightweight per-handler checklist ("test every REJECTS WHEN independently, not just via the sibling create handler") before writing the test suite, rather than relying on the mutation-verification agent to catch it after the fact each phase — this is now two-for-two.

## Test Coverage Delta

- Tests added: 37 (`test/projects.behavior.test.ts`, new, including 3 rejection tests added after the mutation-verification finding).
- Tests passing before: 24 (23 identity + 1 healthz) → after: 61 (24 + 37) (evidence: event log rows show `"3 passed 58 passed"` at 13:44:36Z rising to `"3 passed 61 passed"` at 13:47:47Z, the latter after the last edit to the test file).
- Known untested areas: Phase 4 onward (team membership, groups, permissions, cards, etc.) — not yet built.

---

**Progressive update**: Session completed 2026-08-24 08:52
