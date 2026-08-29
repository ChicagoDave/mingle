# Session Summary: 2026-08-29 - main (project templates)

## Goals
- Ship the Kanban project template end to end: the two missing engine features it needs (card defaults, WIP limits), the widened bundle format that carries pages/favorites/cardDefaults/cards, the shipped `mingle-ts/templates/kanban.json` file, and the New Project template picker that exposes it.
- Origin: the user's observation that legacy Mingle was a Scrum/Kanban PM system by virtue of its shipped templates (`mingle/templates/specs/*.yml`), and the port was "an empty shell without the Scrum."

## Phase Context
- **Plan**: `docs/work/archive/project-templates/plan.md` (archived — Plan Status DONE, all 5 phases complete). Proposal `docs/proposals/project-templates.md`, Status DONE 5/5, items P-1..P-5 all ACCEPTED and DONE.
- **Phase executed**: all five phases of the plan, run sequentially on the user's "phase N" commands.
- **Tool calls used**: 819 total for session ba5848 (shared with the earlier post-parity-deferrals portion; no separate per-plan counter).
- **Phase outcome**: Completed on budget for every phase; plan is DONE and archived.

## Completed

### Proposal, review, and ADR-0024
- `/devarch:proposal` produced `docs/proposals/project-templates.md`, Kanban only, columns Proposed/Ready/Backlog/In Progress/In Test/Completed; Scrum/Agile explicitly out of scope for a future proposal.
- `proposal-review` flagged P-1 as DECISION-IN-DISGUISE (an unrecorded bundle-format decision); extracted to `docs/adrs/0024-project-templates-are-versioned-bundles-carrying-optional-content-sections.md`, ACCEPTED, no open questions. All five items then accepted.
- `session-planner` wrote `docs/work/project-templates/plan.md`; `plan-review` reported tensions only (no contradictions).

### Phase 1 — Card defaults engine (implements P-2)
- New schema `app/db/schema/card-defaults.ts` + `drizzle/0026_card_defaults.sql`.
- `app/domain/cards/card-defaults.server.ts`: `setCardDefaults` (emits `CardDefaultsSet`), `cardDefaultsFor`, `listCardDefaults`, `defaultPropertyChanges`.
- `properties.server.ts` gained `insertInitialPropertyValues` so it stays the sole `card_property_values` writer (ADR-0019); `createCard` applies defaults into **version 1** of the card (decision: not version 1+N) and names them in `CardCreated.defaultedProperties`.
- `deleteCardType` clears defaults; settings page gained "Edit '\<type\>' defaults" forms; wire-types `CURRENT_USER_MARKER`, `DEFAULTABLE_PROPERTY_KINDS`, `CardDefaultsView`.
- `test/card-defaults.behavior.test.ts` (7 tests). Mutation-verification: clean.

### Phase 2 — WIP limits on grid lanes (implements P-3)
- `favorites` schema gained `wip_limits` + `drizzle/0027_wip_limits.sql`.
- `favorites.server.ts`: `setLaneWipLimit` (emits `FavoriteWipLimitSet`), `wipLimitsOf`, `wipLimitsFor`; `saveFavorite` drops limits when the lane property or style changes.
- `app/components/lane-header.tsx` (new component — rendered via `createRoutesStub` in tests since `Form` needs a data router): `n / limit`, over-limit class, inline set form.
- `projects.cards.grid.tsx` loader/action gained a `wip` intent; `card-grid.css` updated.
- `test/wip-limits.behavior.test.tsx` (5 tests). Mutation-verification: clean after two advisory gaps were closed.

### Phase 3 — Bundle v2 format and content import (implements P-1)
- `bundle.server.ts`: `BUNDLE_VERSION = 2`, `SUPPORTED_BUNDLE_VERSIONS = [1, 2]`; four new sections (`cardDefaults`, `favorites`, `cards`, `pages`); `(current user)` is the only identity marker, resolved at import; `expandTemplateTokens` handles `{{template:today±N}}`.
- `export.server.ts`: `includeContent` flag → `contentSections`, with identity drop rules (personal favorites, concrete-user defaults, user-kind values, WIP limits on user-lane favorites excluded).
- `import.server.ts`: applies content in order favorites → seed cards (via `importCards`, `card-import.server.ts` gained an optional `table?` to accept a pre-built `DelimitedTable`) → card defaults → pages last (tokens expanded before storage). Actor joins the team when the bundle names `(current user)` (legacy `ProjectCreator#add_member`).
- `projects.export.ts` gained `?content=1`; settings page gained "Export with content" link.
- `test/bundle-content.behavior.test.ts` (7 tests); import-export test counts updated. Mutation-verification: one warning (user-lane WIP drop rule untested) fixed.

### Phase 4 — Shipped Kanban template (implements P-4)
- `mingle-ts/templates/kanban.json` — a version-2 bundle harvested from `mingle/templates/specs/kanban_template.yml` (colors and `color_by` dropped — no color column in the port's schema).
- `test/templates.behavior.test.ts` (3 tests). No source function changed — data file only, rule 15 did not fire.

### Phase 5 — Template picker on New Project (implements P-5)
- `app/files/templates.server.ts` (`listTemplates`/`loadTemplate`, `TEMPLATES_DIR`).
- `projects.new.tsx` picker: radio cards per template plus Blank; a template choice calls `importProject`, otherwise `createProject`; redirects to `/projects/<id>/wiki/Overview_Page`.
- `app/styles/project-new.css`; Dockerfile now copies `templates/` into the image; README gained a "Project templates" section.
- Fixed in-phase: site-context Overview tab now links to `/wiki/Overview_Page` (legacy `Project::OVERVIEW_PAGE_IDENTIFIER`) instead of `/wiki/Overview` — a P-16 parity slip from an earlier session that would have hidden the template's page; site-chrome test expectations updated to match.
- `test/project-templates-picker.behavior.test.ts` (5 tests). Mutation-verification: clean. `session-checkpoint`: no drift, blockers, or orphaned artifacts.

### Final gate
- `cd mingle-ts && npm run verify` green — 59 test files, 1194 tests, typecheck and build clean (re-run by this agent at 2026-08-29T19:28:58Z, after every edit in this portion of the session).

## Key Decisions

### 1. ADR-0024 — project templates are versioned bundles carrying optional content sections
No second template artifact; widen the existing `mingle-project-template` bundle to v2 with four optional sections, default-empty so v1 documents still parse. `(current user)` is the only identity marker; `{{template:today±N}}` is the one substitution, expanded once at import before storage; imported content goes through the existing writers (`importCards`, `favorites.server`, `createCard`'s own property writer) — never a second `card_property_values` writer.

### 2. In-phase decisions (recorded in the archived plan's per-phase Status lines)
Card defaults land in version 1 of a new card (not a post-creation version); a default on a transition-only property is honored at creation (no drag gesture exists to trip ADR-0009's guard); `(current user)` resolves at creation regardless of team membership, then joins the actor to the team on import; WIP limits are count-only (legacy's sum-of-property variant not carried) and survive a favorite re-save only when the lane property/style is unchanged; bundle content applies favorites → seed cards → card defaults → pages, so seed cards hold exactly the template's authored values before defaults or macros touch them.

## Next Phase
Plan complete — all phases done. Proposal DONE 5/5.

## Open Items

### Short Term
- Commit and push the whole session's working tree (this plan plus the earlier post-parity-deferrals plan) — standing instruction this session was "no commit," so everything above is uncommitted.
- The post-parity-deferrals summary's own open items still stand: tag `v1.0.0` to exercise the publish workflow; confirm `/metrics` bearer-gating.

### Long Term
- Scrum and Agile-hybrid templates were explicitly scoped out of this proposal; consider a follow-up proposal.
- Not carried from legacy (recorded in the plan, by design): enumeration-value colors, `color_by`, the hide-WIP toggle, sum-type WIP limits, default description/checklist items.

## Files Modified

**Schema/migrations** (4 files):
- `app/db/schema/card-defaults.ts`, `drizzle/0026_card_defaults.sql` - card defaults table
- `favorites` schema + `drizzle/0027_wip_limits.sql` - WIP limits column

**Domain** (7 files):
- `app/domain/cards/card-defaults.server.ts` - new: setCardDefaults, cardDefaultsFor, listCardDefaults, defaultPropertyChanges
- `app/domain/cards/commands.server.ts`, `app/domain/cards/properties.server.ts` - createCard applies defaults via insertInitialPropertyValues
- `app/domain/cards/favorites.server.ts` - setLaneWipLimit, wipLimitsOf/For
- `app/domain/import-export/bundle.server.ts`, `export.server.ts`, `import.server.ts` - bundle v2

**Routes/UI** (6 files):
- `app/components/lane-header.tsx` - new
- `app/routes/projects.cards.grid.tsx`, `app/routes/projects.new.tsx`, `app/routes/projects.settings.tsx`, `app/routes/projects.export.ts`
- `app/shell/site-context.server.ts` - Overview tab path fix

**Infra/content** (4 files):
- `app/files/templates.server.ts` - new
- `mingle-ts/templates/kanban.json` - new
- `Dockerfile`, `README.md`

**Tests** (5 new files):
- `test/card-defaults.behavior.test.ts` (7), `test/wip-limits.behavior.test.tsx` (5), `test/bundle-content.behavior.test.ts` (7), `test/templates.behavior.test.ts` (3), `test/project-templates-picker.behavior.test.ts` (5)

**Docs** (4 files):
- `docs/proposals/project-templates.md`, `docs/adrs/0024-...md`, `docs/work/project-templates/plan.md` (now archived to `docs/work/archive/project-templates/plan.md`)

## Notes

**Session duration**: this portion ran roughly from proposal intake through Phase 5 completion within session ba5848 (shared clock with the earlier post-parity-deferrals portion; no separate timer).

**Approach**: proposal → review → ADR extraction → plan → phase-by-phase execution on explicit "phase N" commands, each phase closing with mutation-verification and the standing `npm run verify` gate.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert (all changes uncommitted in the working tree; standing instruction this session was "no commit")

## Dependency/Prerequisite Check

- **Prerequisites met**: Phases 1–2 (card defaults, WIP limits) had to land before Phase 3 (bundle v2) could carry them; Phase 3 had to land before Phase 4 (the template file, itself a v2 bundle); Phase 4 had to land before Phase 5 (the picker that imports it). All satisfied in order.
- **Prerequisites discovered**: None.

## Architectural Decisions

- ADR-0024 (project templates are versioned bundles carrying optional content sections): written this session from a DECISION-IN-DISGUISE finding on proposal item P-1, ACCEPTED same day, no open questions.
- Pattern applied: card creation writes property values through `properties.server.ts`'s own writer (`insertInitialPropertyValues`), never through `applyCardPropertyValue`, per ADR-0008 and ADR-0019.
- Pattern applied: entities in the bundle format are named by NAME, never id, consistent with ADR-0012's reference rule and the existing v1 bundle convention.

## Mutation Audit

- Files with state-changing logic modified: `card-defaults.server.ts`, `commands.server.ts`, `properties.server.ts`, `favorites.server.ts`, `bundle.server.ts`, `export.server.ts`, `import.server.ts`, `card-import.server.ts`, `templates.server.ts`.
- Tests verify actual state mutations (not just events): YES (evidence: `mutation-verification` agent runs recorded in `docs/context/.devarch-events-ba5848.jsonl` at 2026-08-29T18:59:47Z/18:59:54Z "2 passed 34 passed", 19:14:33Z–19:16:05Z build-passed rows for `bundle-content.behavior.test.ts`, and 19:24:23Z "2 passed 14 passed" for the Phase 5 picker suite — each timestamped after the edits it covers).
- If NO: N/A.

## Recurrence Check

- Similar to past issue? YES — the Phase 5 Overview-tab path fix (`/wiki/Overview` vs. `/wiki/Overview_Page`) is the same class of legacy-constant parity slip flagged as P-16 in an earlier session; this session fixed the instance it hit rather than auditing every legacy identifier constant for the same drift.
- If YES: Consider a one-time audit of routes/links that hardcode a legacy page/tab identifier instead of reading it from the `Project::*_IDENTIFIER`-equivalent constant.

## Test Coverage Delta

- Tests added: 27 across 5 new files (card-defaults 7, wip-limits 5, bundle-content 7, templates 3, project-templates-picker 5).
- Tests passing before: 59 files / 1194 tests is the count **after** this portion — the entry count for Phase 1 (from the archived plan's Phase 1 exit line) was 44 files / 1086 tests → after Phase 5: **59 files / 1194 tests**, typecheck and build clean (evidence: `npm run verify` run by this agent directly, `Test Files 59 passed (59)` / `Tests 1194 passed (1194)`, run 2026-08-29T19:28:58Z, after every edit in this portion of the session).
- Known untested areas: Scrum/Agile template content (out of scope this proposal); the CI publish workflow itself has not yet run on a GitHub runner (blocked on the owner's `v1.0.0` tag, carried from the earlier portion of this session).

---

**Progressive update**: Session completed 2026-08-29 19:28 CDT
