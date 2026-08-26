# ADR-0004: Property history as id-keyed JSON snapshots on card versions

**Status**: ACCEPTED

## Context

Phase 7 introduced managed card properties and had to decide how property
state enters card history. The constraints: ADR-0001 requires the schema
not foreclose versioning/history; Phase 5 established `card_versions` as
an append-only trail (rows are only ever inserted); Phase 18 (daily
history chart) must reconstruct any card's property state at end-of-day
for arbitrary past days; Phases 12/13 (MQL) must query *current* property
state efficiently.

Three shapes were considered for history:

1. **Per-version EAV table** (`card_version_property_values`): N rows per
   version for values that mostly did not change between versions.
2. **Delta records** (legacy's `changes` table): compact, but
   reconstructing point-in-time state requires replaying deltas — the
   wrong trade for Phase 18. Legacy itself kept deltas *in addition to*
   full snapshots, not instead of them.
3. **JSON snapshot column on `card_versions`**: the modern equivalent of
   legacy's actual design (wide per-property columns on the versions
   table — a full snapshot per version), one append-only row per version.

A second decision hid inside the first: the snapshot's key. Keying by
property *name* was initially attractive ("history reads as it did at
the time", extending the `cardTypeName` precedent) but is wrong on
inspection: legacy **rewrote history to the current name** on a property
rename (`property_definition.rb#update_changes_table_on_name_change`),
and name-keyed snapshots would either break Phase 18 queries after a
rename (old versions carry the old key) or force rewriting old snapshot
rows, violating the append-only invariant.

## Decision

- **Current state** lives in the `card_property_values` EAV table (one
  row per card × definition, canonical stored values, no row when unset).
  MQL and views query this.
- **History** lives in `card_versions.property_values`: a JSON object
  snapshot of ALL the card's property values at version time, written by
  every version-appending command (SetCardPropertyValue, UpdateCard;
  the deletion version snapshots `{}`).
- **Snapshots are keyed by property definition id** (stringified), never
  by name. Renaming a property definition therefore never touches
  history rows; readers join `property_definitions` to display the
  current name — the legacy-faithful rename semantics, pre-decided here
  so the future rename command needs no history migration.
- `cardTypeName` on `card_versions` stays a text snapshot (display-only
  precedent, unchanged by this ADR).

## Consequences

- Phase 18's daily-history reconstruction reads version snapshots
  (SQLite `json_extract` by definition id) — no delta replay, no
  rename-history mapping.
- Phase 12/13 MQL evaluates against `card_property_values` — two read
  shapes, one per purpose; neither serves the other's queries.
- A property **rename** command (future) updates only
  `property_definitions.name` *as far as history is concerned* — it
  never rewrites snapshot rows, which is this ADR's point. What a
  rename owes the human-authored texts that name the property
  (formulas, stored MQL, encoded filters) is decided by ADR-0012, which
  narrows the "updates only" reading above. A property **deletion**
  command must
  decide what orphaned snapshot keys mean at render time (legacy hid the
  property from history); it must NOT rewrite snapshot rows.
- Raw snapshot JSON in the database is not human-readable without a join
  against `property_definitions`; nothing depends on it being readable.
- Every future version-appending command (transitions in Phase 14, bulk
  updates in Phase 15, aggregate/formula recomputation if it versions)
  must write the full id-keyed snapshot via `cardPropertySnapshot` — not
  a partial or name-keyed variant.

## Session

2026-08-24 (session e0173d, Phase 7 — managed properties).
