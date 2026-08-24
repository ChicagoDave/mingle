# ADR-0003: Authorization checkpoint in the domain layer

**Status**: ACCEPTED

## Context

Phase 4 (team membership, groups, and permissions) had to establish the authorization checkpoint that every later phase's mutating operation reuses — the plan is explicit that it is "reused, not re-invented, by every later phase." Two questions needed settling: **where enforcement lives**, and **what the authorization model is**.

Options considered for where enforcement lives:

1. **Domain-layer checkpoint** — every mutating command handler calls it before writing. Non-bypassable: routes today, the Phase 30 public API, bulk operations, and background jobs all go through the same handlers and inherit enforcement for free. Directly testable as a rule 13 rejection (a readonly actor's command returns a specific error and provably mutates nothing). Costs: Card Management imports Identity & Access, and each new handler must remember the call — convention plus tests, no structural guarantee.
2. **HTTP-layer guards** — the legacy product's own model (`privileges PROJECT_ADMIN => %w(update ...)` declarations per controller, enforced by a filter). Keeps domain commands pure, but is re-wired per route, gives the Phase 30 API a second enforcement surface that can drift, fails open when a guard is missed, and tests via cookie-driven route invocation rather than the project's command-level rule 12/13 style.
3. **Both** — domain layer as the authority, route-level checks only for UX (hiding forms a viewer can't use, early 403/404, avoiding a doomed form round-trip).
4. **Command-bus middleware** — authorization applied declaratively by a dispatch layer, giving the structural guarantee option 1 lacks. Rejected for now: mingle-ts deliberately has no command bus (handlers are plain functions taking a `db` handle), and introducing one solely for this is a larger architectural move than the problem warrants.
5. **Database-enforced (row-level security)** — not viable: SQLite has no RLS and per-user database sessions don't fit the single-connection embedded model (ADR-0002).

For the model: a **privilege ladder** (rank comparison) versus per-capability permissions (`can("update_settings")`). The legacy product used a ladder (`UserAccess::PrivilegeLevel`, ranks 6..0), and all of its controllers' privilege declarations — which the remaining ~29 phases port — are expressed as minimum ranks. Full parity requires the ladder; capabilities would force a translation at every phase.

## Decision

**Enforcement lives in the domain layer** (option 1), with option 3's route-side conveniences allowed later as presentation only:

- `app/domain/identity/authorization.server.ts` is the single checkpoint: the ported privilege ladder (`MINGLE_ADMIN 6 > PROJECT_ADMIN 5 > FULL_TEAM_MEMBER 4 > READONLY_TEAM_MEMBER 3 > REGISTERED_USER 1 > ANONYMOUS 0`; the legacy LIGHT level is omitted — no light users in this rewrite), `privilegeLevelFor`, `authorizeProjectAction` (project-scoped minimum-rank check), and `authorizeSiteAdminAction` (project-less admin-only actions).
- **Every mutating command handler calls the checkpoint before its first write** and returns its rejection (`CommandResult` keyed on `"authorization"`, naming the unmet requirement) — never throws, never silently filters. Phase 4 retrofitted the Phase 3 handlers at legacy levels: project create is Mingle-admin, settings/variable changes are project-admin.
- **The site-wide `users.admin` flag outranks project roles** (legacy `admin? || project_admin?`); a non-member is `REGISTERED_USER`, an unknown user `ANONYMOUS`.
- **Card Management → Identity & Access is a sanctioned dependency direction** for authorization (and only via the checkpoint's public interface). The reverse direction remains forbidden.
- **Routes never enforce authorization.** They may consult `privilegeLevelFor` to shape presentation (hide controls, early 403), but the domain rejection is the only thing that counts; a route-side check is never a substitute.
- If "forgot the checkpoint call" ever actually occurs, the named escalation path is option 4 (a dispatch layer applying a declarative command → minimum-rank map), not ad-hoc route guards.

## Consequences

- Every later phase's mutating command (cards, transitions, wiki, trees, dependencies, programs, import/export, API) starts with a checkpoint call at the privilege level its legacy controller declared — the porting recipe is mechanical: read the legacy `privileges` block, translate to a rank.
- The Phase 30 public API gets enforcement for free by reusing the same handlers; no second authorization surface exists to drift.
- Rule 12/13 discipline extends naturally: each handler's Behavior Statement carries an "actor below X" REJECTS WHEN line, and each suite tests it independently (Phase 4's suites include a readonly/full-member/non-member sweep).
- The convention has no structural guarantee — code review and the per-handler rejection tests are the guard. The escalation path is pre-decided (option 4) so a future failure doesn't reopen this ADR from scratch.
- Read-path (loader) authorization is deliberately not covered: reads currently require only a login. When later phases port legacy view-level restrictions (e.g. anonymous project access toggles), they extend this checkpoint rather than inventing a read-side mechanism.

## Session

- 2026-08-24, session 619f09 — Phase 4 ("Team membership, groups, and permissions") of the mingle-ts full-parity plan.
