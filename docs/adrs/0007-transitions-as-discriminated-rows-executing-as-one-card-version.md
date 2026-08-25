# ADR-0007: Transitions are discriminated rows owned by a transition, and execute as exactly one card version

**Status**: ACCEPTED

## Context

Phase 14 rebuilt Mingle transitions in TypeScript. Legacy modeled them
with Rails single-table inheritance and a polymorphic association:
`transition_prerequisites.type` selected one of four classes
(`HasSpecificValue`, `HasSetValue`, `IsUser`, `InGroup`),
`transition_actions.type` selected `PropertyDefinitionTransitionAction`
or its `UserInputRequired`/`UserInputOptional` subclasses (plus tree
actions), and actions hung off a polymorphic `executor_id/executor_type`
because both `Transition` and `TransitionWorkflow` owned actions.
Execution ran every action against the in-memory card and then called
`card.save` once — one card version per transition regardless of how
many properties changed, and nothing saved when nothing changed.

The TypeScript rewrite already has a single-property command
(`setCardPropertyValue`, Phase 7) that appends one `card_versions` row
per call. Phase 15 (bulk transitions, auto-transition workflows) and
later phases (tree actions, project-variable bindings, transition edit)
will extend the same tables and the same execution path, so the shape
chosen now constrains them.

## Decision

1. **Discriminators, not STI or polymorphism.** `transition_prerequisites`
   carries `kind` ∈ {`has_specific_value`, `has_set_value`, `is_user`,
   `in_group`} with nullable `property_definition_id`/`value`/`user_id`/
   `group_id` columns used per kind. `transition_actions` carries
   `input_mode` ∈ {`fixed`, `user_input_required`, `user_input_optional`}
   and a nullable canonical `value` (null = clear). Both reference their
   owner by a plain `transition_id`; there is no `executor_type`.
   Phase 15 workflows will *generate* transitions (as legacy
   `TransitionWorkflow#create_transitions` did) rather than own actions.
   Later kinds (tree actions, project-variable bindings) are new enum
   members plus nullable columns, not new tables or a polymorphic join.

2. **Values are canonical at definition time.** `defineTransition`
   validates every fixed action value and specific-value requirement
   through the property module's `canonicalPropertyValue` and stores the
   canonical form (enumerated values in defined casing, users as ids,
   numbers/dates in stored form). Execution never re-validates or
   coerces a stored transition value; only user-entered values are
   validated at execution time.

3. **Prerequisite semantics are fixed as legacy's.** Property
   prerequisites AND together; `is_user`/`in_group` prerequisites OR
   together and then AND with the rest; a null `card_type_id` means any
   type. A transition may not carry both `is_user` and `in_group` rows.

4. **One transition execution is one card version.** `executeTransition`
   applies all actions through `appendPropertyValueChanges`, extracted
   from `setCardPropertyValue` into `properties.server.ts`, which writes
   the value rows, recomputes formulas, bumps `cards.version` once and
   inserts exactly one `card_versions` snapshot. When no action changes a
   value, no version is appended (legacy `card.save if altered?`) but
   `TransitionExecuted` is still emitted. Any future command that sets
   several properties in one user gesture — bulk transitions,
   auto-transitions, bulk set-properties, import — MUST go through
   `appendPropertyValueChanges`, never loop over `setCardPropertyValue`.

5. **Rejections name the unmet requirement.** A non-applicable transition
   is rejected as `"<name> is not applicable to Card #<n>: <requirement>;
   …"` where each requirement is one of "requires P to be V", "requires P
   to be set", "applies only to cards of type T", "may only be used by
   U, members of G". Legacy's bare "is not applicable" message is
   extended, not replaced, so the card page can show why.

## Consequences

- `properties.server.ts` remains the only writer of
  `card_property_values` and the only appender of property-driven
  versions; `appendPropertyValueChanges`, `canonicalPropertyValue`, and
  `samePropertyValue` are its intentional interface to sibling Card
  Management commands. Route code still never touches these tables.
- Phase 15 bulk execution is a loop over `executeTransition` per card
  (one version per card, all-or-none per card); atomic all-or-none across
  the selection is a transaction around that loop, not a new write path.
- Phase 15 auto-transitions (workflows) generate `transitions` rows
  and reuse `executeTransition`; they do not need an `executor_type`.
- Adding tree actions (Phase 23) or project-variable bindings adds enum
  members and nullable columns to the existing tables (ALTER, not new
  tables) and a branch in `unmetRequirements`/`executeTransition`.
- Deferred and unaffected by this decision: `require_comment` (needs
  Phase 20 comments), transition edit (delete + recreate for now),
  usage checks on card-type change and property-value rename,
  MQL/formula-style text rewrite on rename (transitions store ids, so
  they are rename-safe already).
- Legacy `transition_ids` in the card API and `TransitionExecution` XML
  (Phase 30) map onto `availableTransitions` and `executeTransition`
  without schema change.

## Session

Session 03169b, 2026-08-25 — Phase 14 "Transitions engine" of
`docs/work/mingle-ts-full-parity/plan.md`.
