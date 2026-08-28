# ADR-0019: Derived values on other cards recompute in the writing transaction, without versioning the holder

**Status**: ACCEPTED

## Context

Phase 8 settled how a derived value on the *same* card works: a
formula property is materialized into `card_property_values` and
recomputed inside the transaction that changed one of its inputs,
before the version snapshot, so the card's next version carries the
fresh value. Phase 24 (aggregate properties over card trees) is the
first derived value that lands on a *different* card than the one
being edited — a story's estimate changes and a release's total must
follow — and it had to answer two questions Phase 8 never faced.

First, *when* the other card is refreshed. Legacy Mingle computed
aggregates asynchronously through a message queue
(`AggregatePublisher`, `AggregateComputationProcessor`), which is why
it needed a `StalePropertyDefinition` table, a "stale" indicator in
the card view, and an admin page to recompute a project's aggregates
by hand. Phase 22 (ADR-0018) gave this rewrite a transactional outbox,
so an asynchronous design was available. The plan's exit criterion for
the phase — "changing a leaf card's property recomputes and persists
the correct aggregate value on its ancestor" — is a statement about
the next read, not about eventual consistency.

Second, *whether the refresh is an edit* of the other card. Every
value write in this rewrite appends a `card_versions` row (ADR-0004),
and the history feed, subscriptions and Atom feed are all projected
over that trail. If a holder's refresh appended a version, one story
edit would fan out into a version on its iteration and another on its
release, each attributed to the editing user and each delivered as a
notification to everyone subscribed to those cards. Legacy wrote
aggregate values with `bypass_versioning: true` for exactly this
reason.

Phases still to come — cross-project dependencies, programs and plans
with their own roll-ups, backlog — will each carry values derived from
rows on other cards or in other projects, and will face both questions
again.

## Decision

### 1. A derived value on another card is recomputed synchronously, inside the writing transaction

Whatever changes a contributing card — a value write, a placement in
or removal from a tree, a card type change, a deletion, a tree
reconfiguration — refreshes every holder it can affect before its
transaction commits. There is no queue, no stale marker, and no
recompute-by-hand page, because nothing is ever stale. The outbox of
ADR-0018 is for work that leaves the process (mail, indexing), not for
keeping two rows in one database consistent.

The refresh is keyed off the *write path*, not the command: Phase 7's
`appendPropertyValueChanges` — the single writer of card property
values — refreshes the ancestors a card named before and after the
write, so every present and future command that writes a relationship
value gets the refresh for free. Membership changes that no value
write reports (a first placement, a departure, a type change, a
deletion) are refreshed explicitly by the command that makes them,
each with one stated reason, so no two mechanisms cover the same case
and a survived mutant cannot hide behind the other.

### 2. The computation is one statement, and its inputs are all fixed at definition time

An aggregate is computed as one SQL statement over the holder's member
descendants, reusing the MQL evaluator's predicate builder for its
condition. Everything that could make that statement fail is refused
when the property is defined: a holder type at the leaf, a non-numeric
or aggregate target, a scope above the holder, a condition that is not
a plain condition or that binds to a viewer or a moment (`TODAY`,
`CURRENT USER`, `THIS CARD`, `FROM TREE`), or a condition that reads
another aggregate. The last is stricter than legacy and is what makes
the recomputation order across tree levels irrelevant. A condition
that stops parsing later (a renamed property) makes the value unset;
it never fails the edit that triggered the refresh.

### 3. The refresh appends no version to the holder

A holder's `card_property_values` row is inserted, updated or deleted
in place. The holder's `cards.version` does not move, no
`card_versions` row is written, and no history entry or notification
is produced. The fresh value is carried by whichever version the
holder's *next user edit* creates — so the version trail still records
every value a user ever saw, attributed to the edit that was actually
made on that card.

This is a deliberate exception to "every value mutation appends a
version", scoped to derived values whose inputs live on other cards.
Same-card derived values (formulas) keep Phase 8's behaviour: they are
recomputed *before* the editing card's own snapshot and ride that
version.

### 4. Derived values share one materialization path

Formulas and aggregates both land in `card_property_values` through
the same insert/update/delete helper in `properties.server.ts`, which
stays the only writer of that table. Reading code — MQL, list sorting,
comparison kinds, snapshots, the card page — sees a derived value as an
ordinary stored value of a numeric kind and needs no second code path.

## Consequences

- A phase that adds a value derived from other rows (dependency
  status roll-ups, plan/objective progress, backlog ranks) recomputes
  it in the writing transaction and does not version the row it lands
  on. It does not add a queue, a stale flag, or an admin recompute
  page. If a future derivation genuinely cannot be one statement — a
  cross-database or network-bound input — that is the moment to
  revisit this ADR, not to add a stale marker beside it.
- The cost of an edit now includes one aggregate query per (holder,
  definition) pair for the ancestors it names — bounded by tree depth
  times the number of aggregates on those types, and zero when a
  project has no aggregate definitions (the relationship lookup
  short-circuits). A project with many aggregates on a deep tree pays
  it on every leaf edit; that is the trade accepted here.
- History and subscriptions never report a derived value changing on
  its own. A subscriber to a release hears about the release's edits,
  not about every story under it — the same rule that made Phase 20
  deliver one email per card comment rather than one per half.
- Formulas may not read aggregates (legacy `dependant_formulas`). It
  would require ordering recomputation across cards — a holder's
  formula after its aggregates, then that holder's own ancestors — and
  the phase deferred it rather than compute the reference stale. Lifting
  this needs the order defined here first.
- `defineAggregateProperty` lives with the other property-definition
  writers, and the aggregate engine is read-only; a session that finds
  itself writing `card_property_values` from anywhere else is breaking
  Decision 4.

## Session

Phase 24 — aggregate properties over trees, 2026-08-28
(`docs/context/session-20260828-*-main.md`, session c719b1).
Implementation: `mingle-ts/app/domain/cards/aggregates.server.ts`,
`mingle-ts/app/domain/cards/properties.server.ts`,
`mingle-ts/app/domain/trees/commands.server.ts`,
`mingle-ts/app/domain/cards/commands.server.ts`; tests in
`mingle-ts/test/aggregates.behavior.test.ts`.
