# ADR-0009: Transition-only enforcement is split — the direct write guards by role, the UI dispatcher routes by flag

**Status**: ACCEPTED

## Context

`property_definitions.transition_only` (legacy migration 059) marks a
property that may not be edited directly, because its value is a
workflow's state. Legacy enforces this in two unrelated places, and they
disagree about administrators:

- `Card#transition_only_for_updating_card?` refuses a direct edit of a
  transition-only property — but only for a user below project
  administrator. A project admin editing a card can write the value
  outright, which is legacy's escape hatch for fixing a card stuck in a
  workflow.
- The auto-transition controller, which is what the card page and card
  wall actually post to, routes on the `transition_only` flag alone. It
  asks no question about the actor's role: an admin dragging a card
  across the wall takes the workflow step exactly as a team member does.

Phase 15 reproduced both. The result is a split that reads as a bug on
first encounter: the same project admin changing the same property gets
a direct write through one path and a transition execution through the
other, depending only on which command the caller reached for. The
choice was to reproduce the split, unify on the role check, or unify on
the flag.

## Decision

1. **Reproduce the split, and name it.** `setCardPropertyValue` keeps
   the role-sensitive guard: a real change to a transition-only property
   is rejected with legacy's exact message
   "`<name>`: is a transition only property." for anyone below
   `PROJECT_ADMIN`; a project admin passes through and writes directly.
   `applyCardPropertyValue` (ADR-0008) routes on `definition.transitionOnly`
   with no role test *in the routing decision* — every actor, admin
   included, goes through the matching transition. The actor is still
   authorized at entry (`FULL_TEAM_MEMBER`, as in every card command,
   `transition-workflows.server.ts`); what the dispatcher does not do is
   let a role change *which branch* it takes.

2. **The guard fires only on a real change.** It sits *after* the
   no-change check, so setting a transition-only property to the value it
   already holds is "has no changes to save", never the transition-only
   rejection. Legacy orders the checks the same way.

3. **The transition path never meets the guard.** `executeTransition`
   writes through `appendPropertyValueChanges` directly (ADR-0007
   Decision 4), not through `setCardPropertyValue`, so a transition
   setting a transition-only property is not a special case that must be
   exempted — it structurally cannot reach the guard.

4. **The two rules are about different questions.** The guard answers
   "may this actor bypass the workflow?" — an authorization question, so
   it is role-sensitive. The dispatcher answers "what does this gesture
   mean?" — a semantic question, and dragging a card means the same
   thing whoever drags it. An admin who genuinely wants the bypass asks
   for it by calling the direct write, not by being an admin while
   dragging.

## Consequences

- Legacy behavioral parity is exact, including the surprise: a project
  admin cannot escape a workflow through the card wall, only through a
  path that calls `setCardPropertyValue`. Anyone reading one enforcement
  point in isolation will assume the other matches; this ADR is the
  answer when they ask.
- The admin bypass is only as reachable as the UI makes it. Today no
  card-page or wall gesture routes to `setCardPropertyValue` for a
  transition-only property, so the bypass is effectively unreachable
  from the browser. If parity later demands a reachable admin override,
  it is a new deliberate UI affordance calling the direct write — not a
  role check added to the dispatcher, which would silently give admins a
  different meaning for the same drag.
- Every future property-writing path inherits an enforcement decision
  along with its ADR-0008 command choice: reaching for the direct write
  means "admins may bypass here", reaching for the dispatcher means
  "nobody bypasses here". Import and the REST API (Phase 30) must make
  that call explicitly; neither has yet.
- Tests must cover both sides for both roles — four cases, not two — or
  the split silently collapses under a later refactor. As of Phase 15
  the guard is covered both ways (`test/transition-workflows.behavior.test.ts`:
  a non-admin rejected with the transition-only message, a project admin
  writing directly) and the dispatcher is covered for a full team member
  and a read-only user. The fourth case — a project admin through the
  dispatcher, which must still take the transition — is covered by
  "routes a project admin through the transition too, instead of writing
  the value", which asserts the transition's *other* action also landed:
  a direct write would set the routed property alone, so the assertion
  distinguishes the two paths rather than restating the outcome. That
  test is the guard on this ADR — it fails if a role check is ever added
  to the dispatcher (verified by mutation: adding a PROJECT_ADMIN bypass
  to the routing branch fails exactly that test, 2026-08-26).
- If legacy parity is ever relaxed as a project-wide goal, this is a
  named candidate for unification — on the flag, not the role, since the
  dispatcher's reading is the one that keeps a workflow honest.

## Session

Session 3076c1, 2026-08-26 — decision taken in Phase 15 "Bulk
transitions and transition workflows" of
`docs/work/mingle-ts-full-parity/plan.md` (session 2026-08-26 01:19),
recorded here after confirmation.
