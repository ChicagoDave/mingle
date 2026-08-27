# Session Summary: 2026-08-25 09:56 CDT - main

## Goals
- Implement Phase 14 "Transitions engine" of the mingle-ts-full-parity plan: a single-card transition execution engine replacing legacy Rails STI/polymorphic transitions.
- Write an ADR capturing the schema and single-version-execution decisions.

## Phase Context
- **Plan**: mingle-ts-full-parity — full TypeScript rewrite of Mingle to legacy parity.
- **Phase executed**: Phase 14 — "Transitions engine" (Large)
- **Tool calls used**: 82 / 350 (per event log; session-state snapshot read earlier showed 81)
- **Phase outcome**: Completed well under budget.

## Completed

### Transitions schema and migration
- New `mingle-ts/app/db/schema/transitions.ts`: `transitions`, `transition_prerequisites` (discriminator `kind`: `has_specific_value` | `has_set_value` | `is_user` | `in_group` — legacy STI collapsed to one column), `transition_actions` (`input_mode`: `fixed` | `user_input_required` | `user_input_optional`; the legacy polymorphic `executor_id/executor_type` dropped).
- Migration `mingle-ts/drizzle/0009_condemned_owl.sql` plus `meta/0009_snapshot.json` and `meta/_journal.json`.
- As part of this phase, completed the one-time audit of all drizzle-kit-generated SQL (migrations 0000-0009, carried forward from earlier sessions) — no mis-generated expression/partial indexes remain.

### Transition execution engine
- New `mingle-ts/app/domain/cards/transitions.server.ts`: `defineTransition` (PROJECT_ADMIN; legacy validations "Transition must set at least one property." and "Transition can't have both is user and in group prerequisites"), `deleteTransition`, `executeTransition` (FULL_TEAM_MEMBER; property prerequisites AND, user/group prerequisites OR-then-AND; every action applied as exactly one card version), `availableTransitions`, `loadTransitions`, `describePrerequisite`, `describeAction` (legacy "Has value of V for P" / "Sets P to V" read-model wording).
- Extracted `appendPropertyValueChanges` out of the existing `setCardPropertyValue` in `mingle-ts/app/domain/cards/properties.server.ts` (now exported, along with `canonicalPropertyValue` and `samePropertyValue`) so both the single-property command and the transition engine share one version-append code path — legacy "save if altered?" semantics (no version row when nothing changed).
- Rejection messages extend legacy's "is not applicable to Card #n." with every unmet requirement named ("requires Status to be Open; applies only to cards of type Bug; may only be used by …") — a deliberate deviation from legacy, which named only the first failing requirement. Formula properties are rejected both as prerequisites and as actions.
- Wire types added to `mingle-ts/app/shared/wire-types.ts`: `TRANSITION_PREREQUISITE_KINDS`, `TRANSITION_ACTION_INPUT_MODES`, `TRANSITION_SPECIAL_VALUES`.

### Routes and UI
- New `mingle-ts/app/routes/projects.transitions.tsx` — admin list + define form (per-property requires/sets selectors, Used-by all/members/groups), registered in `mingle-ts/app/routes.ts`.
- `mingle-ts/app/routes/projects.cards.card.tsx` loader now offers `availableTransitions`; a `transition` intent and a Transitions section render on the card page.
- Nav links added in `mingle-ts/app/routes/projects.cards.tsx` and `mingle-ts/app/routes/projects.settings.tsx`.

### Tests and verification
- New `mingle-ts/test/transitions.behavior.test.ts` — 41 behavioral tests.
- `npx vitest run` (re-run to write this summary): 14 files, 389/389 passing (was 348 at Phase 13 close). Event log corroborates: `{"ts":"2026-08-25T15:34:26Z","kind":"test","msg":"Tests passed","detail":"14 passed 389 passed"}`, timestamped after the last source edit this session (ADR write at 15:32:40Z; code edits earlier).
- `npx tsc --noEmit` — clean (re-run to write this summary, no output).
- `mutation-verification` agent: clean (event log also shows an earlier in-flight subset run, "3 passed 84 passed", from the agent's own pass).
- HTTP walk `phase14-walk.sh` (scratchpad, not a standing test) against a fresh-DB dev server: 19/20 passing, with the 20th confirmed directly in the SQLite DB (the apparent failure was a grep artifact of encoded loader data, not a real defect).

## Key Decisions

### 1. ADR-0007 — Transitions as discriminated rows, executing as one card version
`docs/adrs/0007-transitions-as-discriminated-rows-executing-as-one-card-version.md` (ACCEPTED, no open questions). Collapses legacy's four-class STI prerequisite hierarchy and polymorphic action executor into single discriminated tables, and mandates that a transition's actions apply through the same single-version-append path as `setCardPropertyValue` so a transition produces exactly one `card_versions` row (or none, if nothing changed) regardless of how many properties it touches.

### 2. Rejection messages name every unmet requirement, not just the first
A deliberate deviation from legacy Rails, which stopped at the first failing prerequisite. Chosen for better UX in the rewrite; flagged here so a future session doesn't "fix" it back toward legacy by mistake.

## Next Phase
- **Phase 15**: "Bulk transitions and transition workflows" (Medium, budget 250) — bulk execution of a transition across a Phase 9 list-view card selection, plus `TransitionWorkflow` auto-transitions triggered by a property change. Not started; not advanced to CURRENT per this project's per-phase go-ahead convention — awaiting explicit user go-ahead next session.
- **Entry state**: Phase 14 transitions exist (satisfied).

## Open Items

### Short Term
- Phase 15 awaits go-ahead: bulk transitions + transition workflows.
- Deferred from Phase 14: `require_comment` (belongs to Phase 20 comments), project-variable bindings on prerequisites/actions, tree actions (Phase 23), transition edit (currently delete+recreate only), transition usage checks on card-type change or property-value rename.

### Long Term
- Carried-forward open items, still outstanding: attachments don't bump card version; a property rename must rewrite formula/MQL texts that reference the old name; the formula-recomputation ADR flagged pending since the Phase 8 summary was never written and would now be ADR-0008 or later (ADR-0007 was used by this session's transitions decision instead); `devarch activate team` capability suggestion (raised by a prior `capability-sniffer` run) still pending; the Behavior Statement loop-fan-out prompt recommendation from the Phase 8 recurrence check is still not acted on.

## Files Modified

**New** (7 files):
- `mingle-ts/app/db/schema/transitions.ts` - transitions/prerequisites/actions schema
- `mingle-ts/drizzle/0009_condemned_owl.sql` (+ `meta/0009_snapshot.json`) - migration
- `mingle-ts/app/domain/cards/transitions.server.ts` - transition engine
- `mingle-ts/app/routes/projects.transitions.tsx` - admin transitions route
- `mingle-ts/test/transitions.behavior.test.ts` - 41 behavioral tests
- `docs/adrs/0007-transitions-as-discriminated-rows-executing-as-one-card-version.md` - ADR

**Modified** (7 files):
- `mingle-ts/app/domain/cards/properties.server.ts` - extracted/exported `appendPropertyValueChanges`, `canonicalPropertyValue`, `samePropertyValue`
- `mingle-ts/app/shared/wire-types.ts` - transition prerequisite/action/special-value constants
- `mingle-ts/app/routes.ts` - registered transitions route
- `mingle-ts/app/routes/projects.cards.card.tsx` - transition intent + UI section
- `mingle-ts/app/routes/projects.cards.tsx`, `mingle-ts/app/routes/projects.settings.tsx` - nav links
- `docs/work/mingle-ts-full-parity/plan.md` - Phase 14 marked DONE

## Notes

**Session duration**: ~5.5 hours (started 09:56 CDT).

**Approach**: Schema and migration first, then the shared version-append extraction from `properties.server.ts` before building the transition engine on top of it, then routes/UI, then the 41-test behavioral suite, then the HTTP walk against a fresh-DB dev server, then the ADR.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert (all new files plus additive schema migration; no destructive changes to existing tables)

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 7 properties (`setCardPropertyValue`, `canonicalPropertyValue`) and Phase 4 permissions (role checks for who may execute a transition) — both existed and were used directly.
- **Prerequisites discovered**: None beyond what the plan already listed.

## Architectural Decisions

- ADR-0007: transitions as discriminated rows, executing as one card version — see Key Decisions above.
- Pattern applied: single mutation path shared between `setCardPropertyValue` and `executeTransition` via extracted `appendPropertyValueChanges`, avoiding a second, divergent version-append implementation.

## Mutation Audit

- Files with state-changing logic modified: `mingle-ts/app/domain/cards/transitions.server.ts` (new — `defineTransition`, `deleteTransition`, `executeTransition`), `mingle-ts/app/domain/cards/properties.server.ts` (extracted `appendPropertyValueChanges`).
- Tests verify actual state mutations (not just events): YES (evidence: `mutation-verification` agent run this session reported clean, corroborated by event-log row `{"ts":"2026-08-25T15:21:45Z","kind":"test","msg":"Tests passed","detail":"3 passed 84 passed","agent":{"type":"mutation-verification"}}`; the transitions behavioral suite queries `card_versions` and property-value rows directly after `executeTransition` rather than asserting on return values alone).
- If NO: N/A.

## Recurrence Check

- Similar to past issue? NO — no blockers this session, and `mutation-verification` reported clean on first pass (unlike Phases 2, 3, 6, and 8, which each surfaced a new mutation-verification finding per the Phase 8 summary's recurrence note). The Phase 8 recommendation to have the Behavior Statement template explicitly prompt for loop/collection fan-out remains an open, unacted-on item (see Open Items) but did not recur as a defect this session.

## Test Coverage Delta

- Tests added: 41 (`transitions.behavior.test.ts`).
- Tests passing before: 348 (Phase 13 close) → after: 389 (evidence: `npx vitest run`, 14 files/389 passed, re-run directly to write this summary; corroborated by event-log row timestamped 2026-08-25T15:34:26Z, after the last source edit).
- Known untested areas: bulk transitions and transition workflows (Phase 15, not yet built); transition edit-in-place (currently delete+recreate, no dedicated test needed since no new code path exists); tree actions and project-variable bindings (deferred, no code exists yet).

---

**Progressive update**: Session completed 2026-08-25 15:34
