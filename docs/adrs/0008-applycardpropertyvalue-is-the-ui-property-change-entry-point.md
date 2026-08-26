# ADR-0008: `applyCardPropertyValue` is the property-change entry point for the card UI; `setCardPropertyValue` is the direct write

**Status**: ACCEPTED

## Context

Through Phase 14 there was exactly one way to change a card property:
`setCardPropertyValue` (Phase 7), which validates the value, appends the
`card_property_values` row, recomputes formulas and writes one
`card_versions` snapshot via `appendPropertyValueChanges` (ADR-0007
Decision 4). Every caller — the card page's property editor, the card
wall's drag-and-drop, admin paths — called it directly.

Phase 15 introduced transition-only properties (legacy migration 059's
`property_definitions.transition_only`) and auto-transitions (legacy
`app/controllers/auto_transition`). Legacy's rule is that a
transition-only property is a *workflow's state*: it moves only by
executing the transition that produces the next value, so that the
step's prerequisites are enforced and the step's other actions fire in
the same card version. A user who drags a card to the next column on the
wall is not asking to overwrite a value — they are asking to take the
workflow step.

That makes "change this property to that value" a genuinely different
operation from "write this value": one of them may resolve to executing
a transition, may need more input from the user, may be ambiguous, or
may be impossible. Legacy expressed this as a separate controller in
front of the same model. The TypeScript rewrite had to decide whether to
fold that branch into `setCardPropertyValue` — where every existing
caller would inherit it silently — or to put it in a new command and
make each caller choose.

## Decision

1. **Two commands, deliberately chosen per caller.**
   `applyCardPropertyValue` (`transition-workflows.server.ts`) is the
   property-change entry point for any *user gesture that expresses
   intent about a card's state* — today the card page's property editor
   and the card wall's drop handler. `setCardPropertyValue`
   (`properties.server.ts`) remains the direct write, for callers that
   mean "put this value in this column" and have already decided that is
   correct.

2. **The dispatcher writes nothing itself.** `applyCardPropertyValue`
   composes its siblings: an ordinary property is delegated verbatim to
   `setCardPropertyValue`; a transition-only property is routed to
   `executeTransition`. It never touches `card_property_values` or
   `card_versions`, preserving ADR-0007 Decision 4's single-writer
   invariant — `properties.server.ts` stays the only writer of those
   tables.

3. **Non-writing outcomes are values, not errors.** The command returns
   a discriminated `AutoTransitionOutcome`: `value_set`,
   `transition_applied`, `unchanged`, `require_user_input`,
   `multi_transitions_matched`, `no_transition_matched`. The last four
   change no state (rule 10: no state change, no event). `unchanged`
   is checked *before* the transition-only branch, mirroring legacy's
   `no_property_value_changed?` — a drag that lands where the card
   already is must not fire a transition, and must not report an error.
   Note the deliberate asymmetry with the direct write, which rejects
   that same case ("has no changes to save"): a drop landing where the
   card already sits is a successful no-op, not a user error, so a
   caller moving between the two commands under Decision 5 must re-map
   it rather than assume the contracts match.

4. **Matching is over available transitions only.** Candidates come from
   `availableTransitionDetails` — the transitions this user can execute
   on this card right now — filtered to those with a `fixed` action
   setting that property to that value. A transition whose prerequisites
   do not hold is not "a match that was rejected"; it is simply not
   there. Exactly one match with all-`fixed` actions executes
   unattended; anything else reports back rather than guessing.

5. **New callers choose explicitly.** Any future path that sets a
   property — bulk set-properties, card import, the REST API (Phase 30),
   Excel-style paste — MUST pick one of the two commands as a documented
   decision. Neither is the default.

## Consequences

- The card wall refuses a drop it cannot resolve to a single unattended
  transition rather than silently writing the value; the card page shows
  the same four non-writing outcomes as messages. Any new UI surface for
  property changes owes the user the same four cases.
- A caller that reaches for `setCardPropertyValue` on a transition-only
  property gets that command's own guard (ADR-0009), not this
  dispatcher's routing — the two enforcement points are different and
  intentionally so.
- Phase 16+ features that change properties as a side effect (wiki-driven
  changes, tree actions in Phase 23, murmur/comment-driven updates in
  Phase 20) inherit an explicit choice rather than an implicit one; each
  gets one line in its own plan phase saying which command it calls.
- The composition direction is fixed: `transition-workflows.server.ts`
  imports `properties.server.ts` and `transitions.server.ts`, never the
  reverse. Putting auto-transition awareness back into
  `setCardPropertyValue` would create a cycle and is therefore ruled out
  structurally, not only by convention.
- Cost accepted: two commands with overlapping validation prologues
  (project, card, property, formula rejection, canonicalization,
  no-change check). The duplication is deliberate — the alternative is a
  flag parameter on one command, which is the implicit-default this
  decision exists to avoid.

## Session

Session 3076c1, 2026-08-26 — decision taken in Phase 15 "Bulk
transitions and transition workflows" of
`docs/work/mingle-ts-full-parity/plan.md` (session 2026-08-26 01:19),
recorded here after confirmation.
