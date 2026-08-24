# Session Summary: 2026-08-24 - main

## Goals
- Execute Phase 7 "Managed properties — text, number, date, user, enumerated" of `docs/work/mingle-ts-full-parity/plan.md`, on explicit user go-ahead given at session start.

## Phase Context
- **Plan**: `docs/work/mingle-ts-full-parity/plan.md` — full feature-parity rewrite of Mingle in TypeScript.
- **Phase executed**: Phase 7 "Managed properties — text, number, date, user, enumerated" (Medium, 250 budget).
- **Tool calls used**: 108 / 250 (per `.session-state-e0173d.json`).
- **Phase outcome**: Completed under budget.

## Completed

### Phase 7 — Managed properties
- New schema `mingle-ts/app/db/schema/properties.ts`: `property_definitions` (`kind` discriminator: text|number|date|user|enumerated), `enumeration_values` (ordered, CI-unique per definition), `card_property_values` (one row per card × definition, unique) + migration `mingle-ts/drizzle/0005_eminent_toro.sql`.
- `mingle-ts/app/db/schema/cards.ts` gained `card_versions.property_values` (JSON snapshot column, default `"{}"`).
- New `mingle-ts/app/domain/cards/properties.server.ts`:
  - `definePropertyDefinition` (PROJECT_ADMIN via the ADR-0003 checkpoint) — legacy name rules from `property_definition.rb`: ≤40 chars, forbidden `[]"&=#;` chars, not `_`, reserved predefined names (type/number/name/project/description/project_card_rank/modified_by/created_by/created_on/modified_on), CI-unique; enumerated values validated non-blank, ≤255, no parens-wrap, CI-unique → `PropertyDefinitionDefined`.
  - `setCardPropertyValue` (FULL_TEAM_MEMBER) — per-kind validation that never silently coerces: numbers via regex, dates ISO `yyyy-mm-dd`, users must be valid and team members, enum values canonicalized to defined casing; numeric no-op comparison (`5.0 == 5`); clearing a value deletes the row → `CardPropertyValueSet` + a new `card_versions` row via Phase 5's existing versioning mechanism (one history trail, not a parallel one).
  - `cardPropertySnapshot` helper shared with `commands.server.ts`.
- `mingle-ts/app/domain/cards/commands.server.ts`: `updateCard` snapshots property values into its version rows; `deleteCard` cascades `card_property_values` rows (trail keeps pre-deletion snapshots); header promise re-scoped to the `app/domain/cards` modules collectively.
- Routes: `projects.settings.tsx` gained property definition management (kind selector, one-value-per-line textarea for enumerated); `projects.cards.card.tsx` gained per-kind property editors (text/number/date inputs, user/enum selects, "set-property" intent) and history rendering of each version's property snapshot with ids translated to current names at read time.
- `mingle-ts/app/shared/wire-types.ts` gained `PROPERTY_KINDS`/`PROPERTY_KIND_LABELS`/`PropertyKind`.
- New `mingle-ts/test/properties.behavior.test.ts`: 26 behavioral tests derived from rule 12 Behavior Statements, all asserting on reloaded DB rows; suite-wide 200/200 passing (was 174), `tsc` clean.
- mutation-verification: clean, no findings (verified upsert/delete paths, version-row appends, `deleteCard` cascade, `updateCard` snapshot; rejection paths verified via `expectNothingMutated`).
- Container walk (`phase7-walk.sh`, scratchpad, not a standing test) against a wiped-volume rebuilt container, run twice (before and after the snapshot-rekey redesign): five kinds defined and set over HTTP, cumulative id-keyed snapshots v1→v6, lowercase `high` canonicalized to `High`, both exit-criterion rejections (non-numeric number, out-of-list enum) rendered, both authorization rejections (full-member defining property, readonly setting value) rendered, `PropertyDefinitionDefined`×5 + `CardPropertyValueSet`×5 event trail verified in-container.

## Key Decisions

### 1. ADR-0004 — Property history as id-keyed version snapshots
`docs/adrs/0004-property-history-as-id-keyed-version-snapshots.md`, ACCEPTED. Property history is stored as JSON snapshots on `card_versions` keyed by property definition ID, not name. The phase was initially implemented name-keyed; the user asked "is there a better way?", and analysis found legacy rewrites history to the current name on rename (`update_changes_table_on_name_change`), so name-keyed snapshots would break Phase 18 daily-history queries after a rename or force violating the append-only invariant. Rekeyed to ids same-session, before commit; display joins `property_definitions` for current names. The ADR also pre-decides rename semantics (rename never touches history) and constrains every future version-appending command (Phase 14 transitions, Phase 15 bulk updates) to write the full snapshot via `cardPropertySnapshot`. Current state stays in the `card_property_values` EAV table for MQL (Phases 12/13) — two read shapes, one per purpose.

## Next Phase
- **Phase 8**: "Formula properties" — a formula expression parser (arithmetic over property references, matching legacy `formula.rb`/`formula_property_definition.rb` grammar) and an evaluator that recomputes a formula property's value whenever an input property changes.
- **Tier**: Large (400 tool-call budget).
- **Entry state**: Phase 7 managed properties exist (met). Phase 8 remains PENDING — not advanced to CURRENT, awaiting the user's go-ahead per rule 5.

## Open Items

### Short Term
- Commit this session's work (in progress as part of this finalize).
- Phase 8 (formula properties) on user go-ahead.

### Long Term
- HTTP walks remain scripted (`phase2-walk.sh` through `phase7-walk.sh` in scratchpads), not standing tests — five phases now covered this way.
- UX harvesting from `mingle/app/views` deferred to later, UI-bearing phases.
- Attachments-don't-bump-version deferral (recorded in the Phase 4-6 summary) still needs to be picked up when a later history phase revisits card versioning semantics.

## Files Modified

**Modified** (7 files):
- `docs/work/mingle-ts-full-parity/plan.md` - Phase 7 marked DONE
- `mingle-ts/app/db/schema/cards.ts` - added `card_versions.property_values` JSON snapshot column
- `mingle-ts/app/domain/cards/commands.server.ts` - `updateCard`/`deleteCard` extended for property snapshots and cascade
- `mingle-ts/app/routes/projects.cards.card.tsx` - per-kind property editors, version-history property rendering
- `mingle-ts/app/routes/projects.settings.tsx` - property definition management UI
- `mingle-ts/app/shared/wire-types.ts` - `PROPERTY_KINDS`/`PROPERTY_KIND_LABELS`/`PropertyKind`
- `mingle-ts/drizzle/meta/_journal.json` - migration 0005 registered

**New — schema/migration** (3 files):
- `mingle-ts/app/db/schema/properties.ts`
- `mingle-ts/drizzle/0005_eminent_toro.sql`
- `mingle-ts/drizzle/meta/0005_snapshot.json`

**New — domain** (1 file):
- `mingle-ts/app/domain/cards/properties.server.ts`

**New — test** (1 file):
- `mingle-ts/test/properties.behavior.test.ts` (26 tests)

**New — ADR** (1 file):
- `docs/adrs/0004-property-history-as-id-keyed-version-snapshots.md`

## Notes

**Session duration**: ~19 minutes (10:41–11:00 local, per event log timestamps).

**Approach**: implemented name-keyed first, then rekeyed to ids mid-session after the user pushed back on the initial design (see ADR-0004); the container walk was re-run after the rekey to re-verify the exit criteria against the new shape. `npx tsc --noEmit` clean; test suite grew 174 → 200, all against a real file-backed SQLite database with real migrations.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert — nothing pushed; all session work uncommitted on top of HEAD `7159968`.

## Dependency/Prerequisite Check

- **Prerequisites met**: Phase 5 cards and card types (for property attachment and version snapshotting); Phase 4 authorization checkpoint (PROJECT_ADMIN/FULL_TEAM_MEMBER gating); Phase 4 team membership (User-property validation).
- **Prerequisites discovered**: None.

## Architectural Decisions

- ADR-0004: property history stored as id-keyed JSON snapshots on `card_versions`, not name-keyed — chosen so renaming a property definition does not retroactively corrupt or require rewriting the append-only history trail, and so Phase 18's daily-history queries stay correct across renames. Constrains every future version-appending command (Phase 14 transitions, Phase 15 bulk updates) to write the full snapshot via `cardPropertySnapshot`.
- Pattern applied: Phase 5's `card_versions` append-only mechanism reused unchanged for property mutations (no parallel versioning path introduced).

## Mutation Audit

- Files with state-changing logic modified: `app/domain/cards/properties.server.ts`, `app/domain/cards/commands.server.ts`.
- Tests verify actual state mutations (not just events): YES (evidence: event log rows — "7 passed 200 passed" at 2026-08-24T16:00:37Z, after the last edit to `properties.server.ts` at 15:59:34Z, `cards.ts` at 15:59:37Z, and `properties.behavior.test.ts` at 16:00:21Z).
- If NO: N/A.

## Recurrence Check

- Similar to past issue? Partial — one item checked, did not recur.
  1. **Empty session-state file** (flagged in sessions 19e1a7/619f09, per the pre-session-audit at this session's start): did NOT recur this session — `.session-state-e0173d.json` is populated with a full `files` array and tool-call count throughout.
  2. No new recurring pattern identified this session; mutation-verification was clean on first pass (no post-hoc gap, unlike Phase 6's `deleteAttachmentFile` finding).

## Test Coverage Delta

- Tests added: 26 (`properties.behavior.test.ts`).
- Tests passing before: 174 → after: 200 (evidence: event log "7 passed 200 passed" at 2026-08-24T16:00:37Z, after the last edit to the covered source files).
- Known untested areas: formula properties (Phase 8, not yet started); MQL, transitions, and every milestone from Phase 8 onward per the plan.

---

**Progressive update**: Session completed 2026-08-24 11:00
