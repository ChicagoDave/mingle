# ADR-0010: A null `has_specific_value` prerequisite means "the property is unset"; blank is a rejection

**Status**: ACCEPTED

## Context

ADR-0007 Decision 1 gave `transition_actions` a nullable canonical
`value` where null means "clear the property" — legacy's "(not set)"
option in the action selector. The prerequisite side was left with only
two kinds that speak about a property: `has_specific_value` (the
property equals V) and `has_set_value` (the property is anything but
unset). Neither expresses "the property is unset", which legacy does
express — `HasSpecificValue` with a nil `value`, offered in the same
"(not set)" form option as the action.

Phase 15 needed it immediately. A generated workflow chain's first step
is "Move `<Type>` to `<first value>`", and its prerequisite is precisely
that the property is not yet set — otherwise the first step stays
available for a card already midway through the workflow, and every card
can jump back to the start.

The open question was whether "unset" should be a fifth prerequisite
kind (`has_no_value`) or a null value on the existing kind, and how a
form that posts an empty string should be treated — as "unset" or as a
mistake.

## Decision

1. **Null value on `has_specific_value`, not a new kind.**
   `transition_prerequisites.value` is nullable, and null means the
   property must be UNSET. This mirrors the action side exactly: on both
   sides of a transition row, a null canonical value is "(not set)".
   No `has_no_value` kind is added.

2. **Blank is not null.** `defineTransition` accepts `value: null` as
   the deliberate "(not set)" requirement, but rejects an empty or
   whitespace-only string with "`<name>`: required value can't be
   blank". A form that posted nothing is a mistake, not a requirement
   that the property be empty. The distinction is made once, at
   definition time.

3. **Evaluation is `samePropertyValue(null, current)`.** `unmetRequirements`
   compares the stored prerequisite value against the card's current
   value with the same kind-aware comparator used everywhere else; null
   compares equal only to an absent value row. There is no separate
   null branch to keep in sync.

4. **It renders as "(not set)".** `displayValue(null)` returns
   "(not set)" for both prerequisites and actions, so the admin list,
   the rejection message ("requires Status to be (not set)"), and the
   transition form all say the same thing.

## Consequences

- Workflow generation is expressible with no schema addition: step 1
  requires null and sets the first value; step *n* requires value *n-1*
  and sets value *n*.
- `has_set_value` and a null `has_specific_value` are now exact
  complements. Nothing enforces that a transition does not carry both
  for the same property — the duplicate-property guard in
  `defineTransition` already rejects that, since both kinds share the
  `requiredProperties` set.
- Every future prerequisite kind that speaks about a property value
  inherits this convention: nullable column, null means unset, blank
  rejected at definition time. Tree actions and project-variable
  bindings (Phase 23) are the next to add rows to these tables and must
  follow it rather than inventing a sentinel.
- The branch needs its own coverage. A null prerequisite stored but
  never *evaluated against an unset card* passes a structural test and
  fails in production — exactly the gap `mutation-verification` caught
  in Phase 15, fixed by seeding a card with the property genuinely
  absent. Any change to `samePropertyValue`'s null handling must keep
  those two tests (enters the chain when unset, drops out once set).
- Import and the REST API (Phase 30) must map legacy's nil-valued
  `HasSpecificValue` to null rather than to an empty string, or a
  round-tripped transition silently becomes invalid.

## Session

Session 3076c1, 2026-08-26 — decision taken in Phase 15 "Bulk
transitions and transition workflows" of
`docs/work/mingle-ts-full-parity/plan.md` (session 2026-08-26 01:19),
recorded here after confirmation.
