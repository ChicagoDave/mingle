# Session Summary: 2026-08-25 - main (00:18 CDT start)

## Goals
- Execute Phase 11 of the mingle-ts full-parity plan on explicit user go-ahead: favorites, tabs, and saved views.

## Phase Context
- **Plan**: Full feature-parity rewrite of Mingle in TypeScript (`docs/work/mingle-ts-full-parity/plan.md`, Plan Status: ACTIVE).
- **Phase executed**: Phase 11 — "Favorites, tabs, and saved views" (Medium).
- **Tool calls used**: 66 / 200 (per `.session-state-9463f0.json`).
- **Phase outcome**: Completed under budget.

## Completed

### Favorites schema and domain
- New `mingle-ts/app/db/schema/favorites.ts` and migration `mingle-ts/drizzle/0007_moaning_tyrannus.sql` (+ `meta/0007_snapshot.json`, `_journal.json` updated): a `favorites` table collapsing the legacy `Favorite` + `CardListView` pair into one row — team (`user_id` NULL) or personal scope, `tab_view` flag, `style` (list|grid), stored legacy-wire params (`filters` JSON, `columns` JSON, `group_by`), and a `kind` discriminator reserved for a future page-favorites addition. Two partial unique indexes (team scope; per-user scope, case-insensitive name) were used instead of a single `coalesce()`-based expression index because drizzle-kit generated broken SQL for a comma-bearing expression index on first attempt — that generation was deleted and regenerated as two indexes.
- New `mingle-ts/app/domain/cards/favorites.server.ts`: commands `SaveFavorite` → `FavoriteSaved` (create-or-replace by same-scope name, params validated through the Phase 9/10 read models before storing so a favorite never reopens to a filter error), `MakeFavoriteTab` → `FavoritePromotedToTab`, `RemoveFavoriteTab` → `FavoriteDemotedFromTab`, `DeleteFavorite` → `FavoriteDeleted`; plus `listFavorites`/`favoriteHref`/`serializeFavorite` read helpers. Privilege ladder follows the legacy `favorites_controller`: full member saves/removes team favorites, project admin promotes/demotes tabs, owner deletes personal favorites, admin deletes tabs.

### UI and routes
- New `mingle-ts/app/components/favorites.tsx` (`ViewTabs`, `FavoritesPanel`), `mingle-ts/app/styles/favorites.css`, routes `mingle-ts/app/routes/projects.favorites.tsx` (manage page + save/make-tab/remove-tab/delete intents) and `projects.favorites.show.ts` (legacy `favorites#show` redirect).
- Modified `mingle-ts/app/routes/projects.cards.tsx` and `projects.cards.grid.tsx` to carry the legacy tab bar and favorites sidebar, honor `?view=<name>` redirects, and expose `favorite_id`; `mingle-ts/app/routes.ts` registers the new routes.
- `mingle-ts/app/shared/wire-types.ts` gained `CARD_VIEW_STYLES`, `CardViewStyle`, `FavoriteSummary` (rule 8b — single shared import point, no runtime-specific types).

### Tests and verification
- `mingle-ts/test/favorites.behavior.test.ts`: 28 behavioral tests. Suite-wide: 253 → 281 passing across 11 files (evidence: `npx vitest run` executed directly this turn, 2026-08-25 ~08:24 UTC — "Test Files 11 passed (11)", "Tests 281 passed (281)" — post-dates every source edit in the event log, last at 08:02:07Z). `npx tsc --noEmit` run the same turn produced no output (clean).
- `mutation-verification` ran against the changed files and flagged one gap (unknown-project rejection untested on the tab/delete commands); closed in-session by adding 2 tests, bringing the favorites suite from 26 to 28.
- HTTP walk (`phase11-walk.sh`, scratchpad script, not a standing test) against a fresh DB on the dev server: 33/33 — exact-panel save → redirect → reopen → `?view=` → `/favorites/:id` → make-tab visible in the tab bar → demote → delete → 404.

## Key Decisions

### 1. Favorites collapse `Favorite` + `CardListView` into one row
A `kind` discriminator is reserved on the row so a later page-favorites addition (Wiki phase) adds `kind` + `page_id` rather than a polymorphic join. **This was posed to the user as an ADR-worthy question and was unanswered at session end** — no ADR has been written; the schema shipped on this design pending confirmation.

### 2. View params validated before storage
Saved filter/column/group-by params are round-tripped through the Phase 9/10 read models before being persisted, so a favorite can never reopen to a filter error introduced by drift between the save-time and reopen-time schema.

### 3. Two partial unique indexes instead of one coalesce() index
drizzle-kit mangled the SQL for a single comma-bearing expression index; two partial unique indexes (team scope, per-user scope) were generated instead after the broken first attempt was deleted.

### 4. Legacy privilege ladder preserved exactly
Full member saves/removes team favorites; project admin promotes/demotes tabs and deletes tabs; owner deletes personal favorites — matching `favorites_controller`/`cards#create_view` rather than introducing a simplified permission model.

## Next Phase
- **Phase 12**: "MQL parser" — Large tier, 350 tool-call budget. Deliverable: a parser producing a typed AST from an MQL string, validated against a project's real property definitions.
- **Entry state**: Phase 7 managed properties exist (satisfied).
- Left **PENDING** in the plan — per this project's per-phase go-ahead convention, not started or advanced to CURRENT this session.

## Open Items

### Short Term
- Unanswered ADR ask: whether to formalize the favorites `kind`-discriminator schema decision as an ADR before Phase 12 begins.
- Phase 12 (MQL parser) awaiting explicit user go-ahead.
- `devarch activate team` capability suggestion carried from a prior session, still pending a decision.

### Long Term
- Deferred from Phase 11: favorite rename (legacy `favorites#rename`), tab reorder/rename (`ordered_tab_identifiers`), a personal-favorite "update saved view" shortcut, and page favorites (Wiki phase).
- ADR-0005 formula recomputation decision still pending.
- HTTP walks (Phase 3 onward) remain scratchpad scripts, not standing tests.
- Carried defects: attachments don't bump card version; property rename must rewrite formula texts.

## Files Modified

**New — schema/migration** (3 files):
- `mingle-ts/app/db/schema/favorites.ts` - favorites table definition
- `mingle-ts/drizzle/0007_moaning_tyrannus.sql` - migration (+ `meta/0007_snapshot.json`)
- `mingle-ts/drizzle/meta/_journal.json` - modified, migration journal entry

**New — domain/UI** (5 files):
- `mingle-ts/app/domain/cards/favorites.server.ts` - commands, events, read helpers
- `mingle-ts/app/components/favorites.tsx` - `ViewTabs`, `FavoritesPanel`
- `mingle-ts/app/routes/projects.favorites.tsx` - manage page + intents
- `mingle-ts/app/routes/projects.favorites.show.ts` - legacy `favorites#show` redirect
- `mingle-ts/app/styles/favorites.css` - tab bar and panel styling

**Modified — existing routes/wire types** (3 files):
- `mingle-ts/app/routes.ts` - registers new favorites routes
- `mingle-ts/app/routes/projects.cards.tsx` - tab bar, favorites panel, `?view=` redirect
- `mingle-ts/app/routes/projects.cards.grid.tsx` - tab bar, favorites panel
- `mingle-ts/app/shared/wire-types.ts` - `CARD_VIEW_STYLES`, `CardViewStyle`, `FavoriteSummary` (rule 8b)

**Tests** (1 file, new):
- `mingle-ts/test/favorites.behavior.test.ts` - 28 behavioral tests

**Plan** (1 file):
- `docs/work/mingle-ts-full-parity/plan.md` - Phase 11 marked DONE with closure note (written in-session at phase close, prior to this summary)

## Notes

**Session duration**: ~40 minutes of active tool-call activity (07:54–08:02 UTC per the event log), preceded by a pre-session audit at 05:19 UTC with a multi-hour gap before implementation began.

**Approach**: Single plan phase executed on explicit go-ahead, closed with an in-session Boundary Statement (rule 8a, `favorites.server.ts`), Behavior Statements (rule 12, 4 commands), and an Integration Reality Statement (rule 13a — no OWNED-dependency stubs) before being marked DONE.

**Verification anomaly**: the session event log (`docs/context/.devarch-events-9463f0.jsonl`) carries a `work-summary-writer` agent-completed row timestamped 08:22:49Z — before this summary was written. No prior summary file for this session date existed on disk at write time; treated as a stale/duplicate log artifact rather than evidence of an earlier summary, consistent with a similar anomaly noted in the prior session's summary.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert — no commits made this session; working tree uncommitted on top of `7d560d4`.

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 9/10 card list/grid read models existed and were reused to validate saved-view params before storage.
- **Prerequisites discovered**: None.

## Architectural Decisions

- None formally written this session. One ADR-worthy question was posed to the user (favorites schema collapsing `Favorite` + `CardListView` with a `kind` discriminator reserved for page favorites) and left unanswered at session end — per rule 11, no ADR is written without user confirmation.
- Pattern applied: existing `CommandResult`/domain-event conventions (Phases 2–10) reused unchanged for the four new favorites commands; wire types shared via direct import per rule 8b.

## Mutation Audit

- Files with state-changing logic modified: `mingle-ts/app/domain/cards/favorites.server.ts` (new — `SaveFavorite`, `MakeFavoriteTab`, `RemoveFavoriteTab`, `DeleteFavorite`).
- Tests verify actual state mutations (not just events): YES (evidence: `npx vitest run` executed this turn — "Test Files 11 passed (11)", "Tests 281 passed (281)" — timestamped after the last edit to `favorites.server.ts` and `favorites.behavior.test.ts` at 08:02:07Z per the event log; `mutation-verification` agent ran against the changed files, flagged one gap (unknown-project rejection on tab/delete commands), closed in-session with 2 added tests).
- If NO: N/A.

## Recurrence Check

- Similar to past issue? YES — drizzle-kit mis-generating SQL for a comma-bearing expression index is a new instance of the "generated tooling output must be verified, not trusted" pattern also seen with migration/schema issues in earlier phases (e.g. Phase 1's missing `drizzle/` folder in the runtime image). Consider a one-time audit of all drizzle-kit-generated index/migration SQL for similarly mangled expressions before Phase 12.

## Test Coverage Delta

- Tests added: 28 (`favorites.behavior.test.ts`, including 2 added post-`mutation-verification` for unknown-project rejection coverage).
- Tests passing before: 253 (carried from the Phase 9/10 close) → after: 281 (evidence: `npx vitest run` executed this turn, 2026-08-25 ~08:24 UTC, "Tests 281 passed (281)", post-dating all source edits).
- Known untested areas: MQL (Phase 12+), transitions, favorite rename/tab reorder (deferred), page favorites; the browser-side favorites-panel form submission is exercised only via HTTP walk (scratchpad), not a standing test.

---

**Progressive update**: Session completed 2026-08-25 08:24 UTC
