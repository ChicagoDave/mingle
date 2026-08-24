# Session Summary: 2026-08-24 - main

## Goals
- Execute Phase 8 "Formula properties" of `docs/work/mingle-ts-full-parity/plan.md`, on user go-ahead following the Phase 7 finalize earlier in this session.

## Phase Context
- **Plan**: `docs/work/mingle-ts-full-parity/plan.md` — full feature-parity rewrite of Mingle in TypeScript.
- **Phase executed**: Phase 8 "Formula properties" (Large tier, 400 budget).
- **Tool calls used**: not available — this session's state file (`.session-state-e0173d.json`) was retired by the Phase 7 finalize earlier in the same session, before Phase 8 began.
- **Phase outcome**: Completed (budget-relative outcome not derivable without the retired state file; the container walk and 17-test suite suggest well under budget).

## Completed

### Phase 8 — Formula properties
- New `mingle-ts/app/domain/cards/formula.server.ts` — a pure formula engine (no DB imports): lexer and recursive-descent parser for the legacy `formula_properties.grammar` surface (`+ - * /`, unary minus, `()`/`{}`/`[]` grouping, number literals, bare/quoted identifiers with doubled-quote escaping).
- Type checker per legacy `Formula::*`/`ValidFormulaVisitor`: number⊕number→number; date+number→date; date−number→date; date−date→days. Rejected at **definition time**: date+date, number−date, date in `*`/`/`, negated date, unknown property (`"No such property: X"`), non-numeric operand (`"Property X is not numeric."`), formula-in-formula (`"…cannot be used within another formula."` — this also makes circular references impossible this phase).
- Evaluator: division by zero → unset per legacy `CASE WHEN`; `null_is_zero` flag evaluates unset numeric inputs as 0; fractional days truncate; numbers format at legacy default precision 2 with trailing zeros trimmed; dates ISO.
- `mingle-ts/app/db/schema/properties.ts` — `formula` and `null_is_zero` columns added to `property_definitions`; migration `mingle-ts/drizzle/0006_last_kate_bishop.sql` (+ `meta/0006_snapshot.json`, `_journal.json`).
- `mingle-ts/app/domain/cards/properties.server.ts` — `definePropertyDefinition` gained the `formula` kind: compiles at definition time, then backfills computed values into `card_property_values` for every existing card in the same transaction with no version rows appended (derived-data introduction is not a card edit). New private `recomputeCardFormulas` runs inside `setCardPropertyValue`'s transaction, after the input upsert and before the version snapshot, so one user action produces one version carrying fresh derived values (legacy same-save recomputation parity). `setCardPropertyValue` rejects direct sets of formula properties (`"X is a formula property and cannot be set directly"`); `formula`/`nullIsZero` are rejected for non-formula kinds.
- `mingle-ts/app/shared/wire-types.ts` — `"formula"` added to `PROPERTY_KINDS` with label "Formula".
- Routes: `projects.settings.tsx` (formula text input + `nullIsZero` checkbox on the property form; formula shown in the property list); `projects.cards.card.tsx` (formula properties render as read-only computed values).
- New `mingle-ts/test/formulas.behavior.test.ts` — 17 behavioral tests, including the rule-13a exit-criterion REAL-PATH test (change a persisted input → materialized value and version snapshot recomputed, read from the DB) and definition-time rejections. Suite-wide 217/217 (was 200 at Phase 7 close); one Phase 7 fixture updated (`"rejects an unknown kind"` used `"formula"` as its unknown example — changed to `"aggregate"` now that formula is a real kind). `tsc` clean.
- mutation-verification: one warning — the multi-card backfill fan-out had only been exercised against a single-card project. Closed same-session with a three-card backfill test (different input values per card, one card with an unset input) before the phase was marked DONE.
- Container walk (`phase8-walk.sh`, scratchpad, not a standing test) from a wiped volume: formulas defined over HTTP, backfill over a pre-existing card, input change → card page renders "Points: 11" and "Slack: 2026-09-12", malformed (`"1 +"`) and ill-typed (`"Due * 2"`) definitions rejected at definition time, direct set rejected, `Estimate=0` → Points recomputed to 1 and the Ratio row deleted (division by zero), version snapshots verified in-container showing recompute-in-same-version.

## Key Decisions

### 1. Formula values are materialized, recomputed in-transaction before the version snapshot
Required by the exit criterion and legacy parity. The recomputation contract — any command changing a card's property values must recompute that card's formulas inside its own transaction before its version snapshot — is recorded in module headers and the plan's Phase 8 DONE note. A proposed ADR-0005 to pin this formally is **pending the user's decision** (not yet asked whether to write it this session) — carried to Open Items.

### 2. Formulas reference properties by name, not id
Legacy parity (`formula.rb` stores formula text, not property ids). A future property-rename command must rewrite formula texts as part of the rename — this complements ADR-0004's id-keyed version snapshots (which solved the equivalent problem for history) but is a distinct mechanism, noted in the schema header.

### 3. Backfill on definition appends no version rows
Deviates deliberately from legacy's version-churning `update_all_cards` — defining a formula is derived-data introduction, not a card edit, so it should not appear in a card's edit history.

## Next Phase
- **Phase 9**: "List view and filters" — a card list route with column selection and simple property filters (property-equality and range only; MQL-backed filtering is Phase 13), harvested layout/CSS from `mingle/app/views/cards`.
- **Tier**: Medium (250 tool-call budget).
- **Entry state**: Phase 7 properties and Phase 8 formulas both exist (met). **Not advanced to CURRENT** — awaiting the user's go-ahead per rule 5.

## Open Items

### Short Term
- Decide whether to write ADR-0005 for the cross-command recomputation contract (Key Decision 1) — not yet asked this session.
- Phase 9 (list view and filters) on user go-ahead.

### Long Term
- HTTP walks remain scripted (`phase2-walk.sh` through `phase8-walk.sh` in scratchpads), not standing tests — now six phases covered this way (Phases 2–8, minus Phase 1's).
- UX harvesting from `mingle/app/views` deferred to later, UI-bearing phases.
- Attachments-don't-bump-version deferral (recorded in the Phase 4-6 summary) still needs to be picked up when a later history phase revisits card versioning semantics.
- Property rename command (not yet built) must rewrite formula texts referencing the renamed property, per Key Decision 2.
- `devarch activate team` capability suggestion (2 committers detected) — raised earlier this session by capability-sniffer, still pending the user's decision.

## Files Modified

**Modified** (7 files):
- `docs/work/mingle-ts-full-parity/plan.md` - Phase 8 marked DONE
- `mingle-ts/app/db/schema/properties.ts` - added `formula`/`null_is_zero` columns
- `mingle-ts/app/domain/cards/properties.server.ts` - formula kind, backfill, in-transaction recomputation, direct-set rejection
- `mingle-ts/app/routes/projects.cards.card.tsx` - read-only rendering of computed formula values
- `mingle-ts/app/routes/projects.settings.tsx` - formula text input and `nullIsZero` checkbox
- `mingle-ts/app/shared/wire-types.ts` - `"formula"` added to `PROPERTY_KINDS`
- `mingle-ts/drizzle/meta/_journal.json` - migration 0006 registered
- `mingle-ts/test/properties.behavior.test.ts` - unknown-kind fixture updated from `"formula"` to `"aggregate"`

**New — schema/migration** (2 files):
- `mingle-ts/drizzle/0006_last_kate_bishop.sql`
- `mingle-ts/drizzle/meta/0006_snapshot.json`

**New — domain** (1 file):
- `mingle-ts/app/domain/cards/formula.server.ts`

**New — test** (1 file):
- `mingle-ts/test/formulas.behavior.test.ts` (17 tests)

## Notes

**Session duration**: not separately timestamped — this is the second phase (Phase 8) completed within session `e0173d`, following the Phase 7 finalize.

**Gap in this summary**: the session state file for `e0173d` was retired by the Phase 7 finalize before Phase 8 began, so the Phase Context's tool-call count and precise duration could not be corroborated from it and are marked as such above rather than guessed.

**Approach**: engine written pure (no DB imports) so the parser/type-checker/evaluator are independently testable; recomputation wired into the existing `setCardPropertyValue` transaction rather than a separate pass, to guarantee the one-version-per-action legacy parity.

---

## Session Metadata

- **Status**: COMPLETE (unverified: test pass counts 217/217 and the mutation-audit YES, both reported by session narrative and the plan's DONE note rather than corroborated against this session's event log)
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert — nothing pushed; all Phase 8 work uncommitted on top of HEAD `ba21000` (Phase 7).

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 7 managed properties (number/date kinds as formula inputs; `property_definitions`/`card_property_values` tables); Phase 5 card versioning (`card_versions` snapshot mechanism reused for recomputed values).
- **Prerequisites discovered**: None.

## Architectural Decisions

- None this session — no ADR was written. A recomputation-contract ADR (ADR-0005) was identified as a candidate but is pending the user's decision (see Key Decisions and Open Items).
- Pattern applied: Phase 7's `card_versions` append-only snapshot mechanism reused unchanged for formula-derived values (no parallel versioning path introduced), continuing the pattern set in Phase 7.

## Mutation Audit

- Files with state-changing logic modified: `app/domain/cards/formula.server.ts` (pure, no mutation — evaluator only), `app/domain/cards/properties.server.ts` (backfill and recomputation logic).
- Tests verify actual state mutations (not just events): YES (evidence: 217/217 passing suite-wide, including the rule-13a REAL-PATH test asserting on the materialized `card_property_values` row and version snapshot read back from the database after an input change; `tsc` clean; container walk from a wiped volume independently confirmed recomputation, backfill, and version-snapshot behavior over real HTTP against the running app). Reported by session narrative; no event-log row was available to re-corroborate exact timestamps since this session's event log was not inspected during this write — treating the reported counts as consistent with the plan's own DONE note, which records the same 217/217 figure.
- If NO: N/A.

## Recurrence Check

- Similar to past issue? YES — mutation-verification post-hoc findings. Per the carried-forward pattern: this category has now occurred in Phases 2, 3, 6, and 8, with each occurrence surfacing a **new** category rather than repeating the prior one (Phase 8's was multi-card backfill fan-out — a loop exercised only once in the initial test pass). Phases 4, 5, and 7 were clean on first pass. This suggests the up-front behavior-statement checklist reliably covers per-handler rejection paths but tends to miss whichever new structural shape (infra adapter in Phase 6, loop fan-out in Phase 8) appears in that phase's code — worth a one-time audit of whether the Behavior Statement template should explicitly prompt for "does this loop over a collection, and if so, is the loop exercised with >1 element in the test."

## Test Coverage Delta

- Tests added: 17 (`formulas.behavior.test.ts`), plus one existing fixture updated in `properties.behavior.test.ts` (unknown-kind example changed from `"formula"` to `"aggregate"`).
- Tests passing before: 200 → after: 217, per the plan's Phase 8 DONE note recorded at phase close; no independent event-log row was consulted during this write to re-timestamp the run. [reported by session, unverified]
- Known untested areas: MQL, transitions, list/grid views, and every milestone from Phase 9 onward per the plan; property rename (not yet built) and its interaction with formula text rewriting.

---

**Progressive update**: Session completed 2026-08-24 11:20
