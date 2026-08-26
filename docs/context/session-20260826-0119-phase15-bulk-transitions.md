# Session Summary: 2026-08-26 01:19 CDT - main

## Goals
- Implement Phase 15 "Bulk transitions and transition workflows" of the mingle-ts-full-parity plan: atomic multi-card transition execution plus TransitionWorkflow auto-transitions triggered by a property change.

## Phase Context
- **Plan**: mingle-ts-full-parity — full TypeScript rewrite of Mingle to legacy parity.
- **Phase executed**: Phase 15 — "Bulk transitions and transition workflows" (Medium)
- **Tool calls used**: 162 / 250 (session-state snapshot; event log shows 156 at last logged test pass)
- **Phase outcome**: Completed under budget.

## Completed

### Bulk transitions
- `executeBulkTransition` (`mingle-ts/app/domain/cards/transitions.server.ts`): wraps a loop over the existing `executeTransition` in one transaction so each changed card gets exactly one `card_versions` row and any single card's rejection rolls the whole selection back; legacy's " All work was cancelled." appended to each message. Emits one `BulkTransitionExecuted` plus the per-card `TransitionExecuted` events — the transaction-around-a-loop shape ADR-0007's Consequences already prescribed, not a new write path.
- `commonTransitions`: intersection of `availableTransitions` across the selection (legacy `bulk_transitions.js` `Array.findIntersection`), so the UI offers only transitions that can succeed on every selected card.
- `availableTransitionDetails` extracted from `availableTransitions` so auto-transition matching can inspect action rows without `unmetRequirements` leaking out of the module.
- `has_specific_value` prerequisites now accept a null value meaning "the property must be UNSET" (legacy nil-valued `HasSpecificValue`); blank strings are still rejected.

### Transition workflows and auto-transitions
- New `mingle-ts/app/domain/cards/transition-workflows.server.ts`. `previewTransitionWorkflow` (read model) and `generateTransitionWorkflow` (command) build the whole "Move `<Type>` to `<Value>`" chain for a card type + managed-list property in one transaction — one transition per value, each requiring the previous value, the first requiring the property unset. Calls `defineTransition` per step so generated transitions pass the same validation as hand-written ones. Legacy `TransitionWorkflow::Names` uniquifying (" 1", " 2") and 255-char name truncation reproduced. Emits `TransitionWorkflowGenerated`.
- `applyCardPropertyValue` (command): the new property-change entry point for the card page and card wall (legacy `AutoTransition::Model` / `::Transitions`). An ordinary property writes exactly as before; a transition-only property routes to the available transition whose fixed action produces the requested value and fires it — reporting `unchanged`, `require_user_input`, `multi_transitions_matched`, or `no_transition_matched` without writing anything when it cannot resolve exactly one unattended transition.

### Schema
- Migration `mingle-ts/drizzle/0010_salty_drax.sql` adds `property_definitions.transition_only` boolean (legacy migration 059) — plain ALTER, SQL-audited.
- `setPropertyTransitionOnly` command in `properties.server.ts` (admins flip the flag on an existing property; emits `PropertyDefinitionTransitionOnlySet`).
- `definePropertyDefinition` accepts and persists `transitionOnly`, rejecting it on the formula kind.
- `setCardPropertyValue` now rejects a real change to a transition-only property by anyone below project admin, with legacy's exact message "`<name>`: is a transition only property." (project admins bypass, matching legacy `transition_only_for_updating_card?`).

### Routes and UI
- `projects.cards.tsx`: row-selection checkboxes (bound via `form="card-selection"` since the thead already holds the column-selector form and forms cannot nest), legacy comma-joined `selected_cards` param, a no-JS bulk-transition action panel offering only common transitions, and an `intent=bulk-transition` action. Selection is filtered to visible rows so a stale URL selection cannot transition a card no longer visible.
- `projects.cards.card.tsx` and `projects.cards.grid.tsx`: property-set and card-wall drop now go through `applyCardPropertyValue`; the grid refuses (rather than silently accepting) a drop that cannot resolve to one unattended transition.
- `projects.transitions.tsx`: workflow preview (GET, linkable, writes nothing) + generate form; "(not set)" added to the requires selector.
- `projects.settings.tsx`: transition-only checkbox at definition time and a per-property toggle.
- `mingle-ts/app/styles/card-list.css`: selection column and action panel styles harvested from legacy `_card_list_action_panel.rhtml`.

## Key Decisions

### 1. `applyCardPropertyValue` becomes the sole UI property-change entry point (candidate ADR, not yet written)
`setCardPropertyValue` is reserved for direct/admin writes; any future path (bulk set-properties, import, the REST API) must choose deliberately which one it calls.

### 2. Transition-only bypass asymmetry (candidate ADR, not yet written)
The project-admin bypass lives in `setCardPropertyValue`, while `applyCardPropertyValue`'s dispatcher routes on the raw `transitionOnly` flag regardless of role — legacy-faithful but a surprising split if not documented.

### 3. Null-valued `has_specific_value` means "unset" (candidate ADR, not yet written)
Phase 23 tree actions will inherit this semantics.

The user was asked "ADR-worthy?" per rule 11 for these three and has not yet answered — this is an **open item**, not a decision to treat as settled. Do not write ADR-0008 (next free number) without that confirmation.

## Next Phase
- **Phase 16**: "Wiki pages and rich editing" (Large, budget 350) — `Page` aggregate with `page_versions` mirroring `card_versions`, TipTap rich text, cross-page and page-to-card linking. Not started; not advanced to CURRENT per this project's per-phase go-ahead convention — awaiting explicit user go-ahead next session.
- **Entry state**: Phase 5's versioning pattern exists as the template to reuse (satisfied).

## Open Items

### Short Term
- Phase 16 awaits go-ahead: wiki pages and rich editing.
- ADR-worthy question from this session (3 candidate decisions above) still unanswered.
- Legacy's workflow generator also creates a hidden "Moved to `<Value>` on" date property per step — deferred this phase. No `hidden` column exists on `property_definitions` yet; honoring it properly means threading it through list columns, grid, filters, and the card page, which is cross-cutting work beyond Phase 15's exit state. The generated chain is complete without it.
- Carried forward from Phase 14, still open: `require_comment` (Phase 20 comments), project-variable bindings on prerequisites/actions, tree actions (Phase 23), transition edit-in-place (delete+recreate only), transition usage checks on card-type change or property-value rename.

### Long Term
- Attachments do not bump card version.
- A property rename must rewrite formula/MQL texts referencing the old name.
- `devarch activate team` capability suggestion still pending (raised by a prior `capability-sniffer` run).
- The Behavior Statement loop-fan-out prompt recommendation from the Phase 8 recurrence check still unacted-on.

## Files Modified

**New** (4 files):
- `mingle-ts/app/domain/cards/transition-workflows.server.ts` - workflow generation, preview, and `applyCardPropertyValue` auto-transition dispatcher
- `mingle-ts/drizzle/0010_salty_drax.sql` (+ `meta/0010_snapshot.json`) - `transition_only` column migration
- `mingle-ts/test/transition-workflows.behavior.test.ts` - 40 behavioral tests

**Modified** (10 files):
- `mingle-ts/app/domain/cards/transitions.server.ts` - `executeBulkTransition`, `commonTransitions`, `availableTransitionDetails`, null-unset prerequisite matching
- `mingle-ts/app/domain/cards/properties.server.ts` - `setPropertyTransitionOnly`, transition-only rejection in `setCardPropertyValue`
- `mingle-ts/app/db/schema/properties.ts` - `transition_only` column
- `mingle-ts/app/routes/projects.cards.tsx` - selection checkboxes, bulk-transition panel and action
- `mingle-ts/app/routes/projects.cards.card.tsx` - routed through `applyCardPropertyValue`
- `mingle-ts/app/routes/projects.cards.grid.tsx` - drop routed through `applyCardPropertyValue`, refusal on ambiguous match
- `mingle-ts/app/routes/projects.transitions.tsx` - workflow preview/generate UI
- `mingle-ts/app/routes/projects.settings.tsx` - transition-only toggle
- `mingle-ts/app/styles/card-list.css` - selection column and action panel styles
- `docs/work/mingle-ts-full-parity/plan.md` - Phase 15 marked DONE with exit detail

## Notes

**Session duration**: started 01:19 CDT.

**Approach**: Schema (transition_only column) first, then the bulk-transition transaction wrapper and workflow generator on top of the existing Phase 14 engine, then routes/UI, then the 40-test behavioral suite, then the HTTP walk against a fresh-DB dev server.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert (one new additive column plus new files; existing routes changed but no destructive schema changes)

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 14 transitions engine (`executeTransition`, `availableTransitions`, `appendPropertyValueChanges`) and Phase 9 list-view selection — both existed and were used directly.
- **Prerequisites discovered**: None beyond what the plan already listed.

## Architectural Decisions

- None this session — ADR-0007 (Phase 14) already covers the single-version-append shape `executeBulkTransition` reuses. Three candidate decisions (sole UI entry point, transition-only bypass asymmetry, null-means-unset) were raised for an "ADR-worthy?" ask per rule 11 but the user has not yet answered; no ADR-0008 exists.
- Pattern applied: transaction-around-a-loop for bulk execution, per ADR-0007's own Consequences section, rather than a new bulk-specific write path.

## Mutation Audit

- Files with state-changing logic modified: `mingle-ts/app/domain/cards/transitions.server.ts` (`executeBulkTransition`), `mingle-ts/app/domain/cards/transition-workflows.server.ts` (new — `generateTransitionWorkflow`, `applyCardPropertyValue`), `mingle-ts/app/domain/cards/properties.server.ts` (`setPropertyTransitionOnly`, transition-only rejection).
- Tests verify actual state mutations (not just events): YES (evidence: `mutation-verification` agent run this session, event-log row `{"ts":"2026-08-26T06:49:37Z","kind":"test","msg":"Tests passed","detail":"1 passed 38 passed","agent":{"type":"mutation-verification"}}`, timestamped after the last edit to the files it covers; the agent found one real gap — see below — which was fixed and re-verified at `06:50:35Z` ("1 passed 40 passed")).
- Gap found and fixed: the null "unset" `has_specific_value` prerequisite was asserted as a stored row but never evaluated at runtime, because every seeded card already had Status set. Fixed by adding two tests: a card with no Status entering the workflow chain's first step, and the same step dropping out once Status holds a value.

## Recurrence Check

- Similar to past issue? YES — mutation-verification surfacing a coverage gap on first pass matches the pattern the Phase 8 summary first flagged (Phases 2, 3, 6, 8 each surfaced one). This session's gap (a stored-but-unexercised branch condition) is a variant of that same class: a code path exists and is asserted structurally but the *runtime* branch it guards was never actually taken by any seeded fixture. The Phase 8 recommendation — have the Behavior Statement template explicitly prompt for "is every branch of this condition exercised by at least one test, not just the happy path" — remains open and unacted-on (see Open Items).

## Test Coverage Delta

- Tests added: 40 (`transition-workflows.behavior.test.ts`).
- Tests passing before: 389 (Phase 14 close) → after: 428/429 (evidence: `npx vitest run`, re-run directly to write this summary at 2026-08-26T07:04:53Z, after the last source edit; 14 of 15 files pass, the one failure is `test/healthz.real.test.ts` with `ECONNREFUSED` on `127.0.0.1:3000` — that test requires a live dev server by design and none was running for this verification pass; the session's own reported 429/429 reflects a run made with the dev server up during the HTTP walk). `npx tsc --noEmit` re-run at the same time: clean, exit 0.
- Known untested areas: legacy's hidden "Moved to `<Value>` on" date property (not implemented, see Open Items); tree actions and project-variable bindings on prerequisites/actions (deferred, no code exists yet); transition edit-in-place (still delete+recreate).

---

**Progressive update**: Session completed 2026-08-26 07:05
