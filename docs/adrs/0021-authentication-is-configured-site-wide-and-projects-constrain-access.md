# ADR-0021: Authentication is configured site-wide; a project constrains access, it does not select a strategy

**Status**: ACCEPTED

## Context

Phase 31 built pluggable authentication (password, LDAP bind, OIDC, HMAC
for the API) behind one site-wide configuration (`auth_configurations`,
`/admin/authentication`, site admin only), matching legacy's
`auth_config.yml`. The plan phase's own text said "project-level
configuration", and the phase closed by recording that wording as a
deferral rather than a decision. Proposal `post-parity-deferrals` item
P-5 now asks for "per-project authentication settings", and the review
found an undecided boundary inside it:

- **Sign-in happens before any project is known.** A strategy chosen
  per project cannot select how the login form authenticates, because
  the login form has no project. "Per-project strategy" therefore has
  no meaning at the sign-in step unless projects are encoded into the
  login URL — a UX legacy never had (ADR-0001 fidelity).
- **API credentials are user-scoped.** ADR-0020 makes a bearer key or
  HMAC secret belong to a `users` row and never consults how that user
  signs in interactively. A project-level strategy setting has nothing
  to attach to on an API request.
- **Credentials and providers are operator concerns.** A bind password
  or client secret is sealed under the install secret (ADR-0020) and
  entered by a site admin. Letting project admins configure providers
  would spread sealed secrets across projects and give a project admin
  a site-level capability.

What a project can meaningfully want is narrower than "its own
authentication": to require that whoever reaches it *came in a
particular way* — an SSO-only project in a site that still allows
passwords, for instance.

## Decision

1. **Strategies and providers are configured once, site-wide.** The
   Phase 31 model stands: `auth_configurations` is the only place a
   strategy is enabled or a provider's credentials live, and only a
   site admin edits it. No project-scoped copy of it is introduced.
2. **A project may declare an access constraint on how the current
   session was authenticated** — a set of permitted strategy kinds
   (`password`, `ldap`, `oidc`, `saml` as they exist), empty meaning
   "site default, no constraint". A project admin sets it with the
   project's other settings.
3. **The constraint is enforced at the ADR-0003 authorization
   checkpoint**, on the read side as well as the write side — the
   first read-path restriction ADR-0003 anticipated ("when later phases
   port view-level restrictions, they extend this checkpoint"). A
   session that does not satisfy the project's constraint is refused
   with the checkpoint's authorization error, not redirected to a
   different login.
4. **Sessions record the strategy kind that produced them.** The
   checkpoint reads it from the session, never re-derives it from the
   user row; a user who holds both a password and a linked external
   identity is judged by how *this* session was opened.
5. **An API request passes a constrained project only if its user holds
   a linked identity of a permitted kind.** A bearer key or HMAC
   signature carries no strategy kind (ADR-0020), so the checkpoint
   judges the key's user by `external_identities`: at least one row
   whose `kind` is in the project's permitted set, or — when `password`
   is permitted — any user at all. The query runs only for API
   principals and only when the project has a constraint. "SSO-only"
   therefore means the same thing over the API as in the browser: a
   member who has never authenticated through a permitted provider
   cannot reach the project with a key either.
6. **A constraint never changes membership.** Setting or tightening it
   is a plain project-settings write; members who do not satisfy it
   stay on the team, keep their role and group memberships, and are
   refused at the checkpoint until they open a session — or, for API
   access, link an identity — of a permitted kind. No membership
   command runs and no `TeamMemberRemoved` event fires. The team list
   badges such members as unable to access the project under the
   current constraint, so the list stays truthful without becoming a
   side effect. Removing the constraint restores their access with no
   further action.
7. **Site admins bypass a project's constraint.** The checkpoint
   evaluates the Phase 4 site-admin trump before the constraint, so a
   site admin reaches every project regardless of how they signed in —
   the same lock-out safeguard Phase 31 chose when it kept a site
   admin's Mingle password valid under LDAP. The exception is
   documented beside the setting and in the README's authentication
   section, in the sentence that already documents the LDAP one.

## Consequences

- P-5 is buildable without touching the login form, the strategy
  interface, or the sealed configuration; it is a project setting, a
  session field, and one branch in the checkpoint.
- The checkpoint gains its first read-side rule; loaders for project
  routes must call it, which is the structural change ADR-0003 said a
  view-level restriction would bring.
- ADR-0020 is untouched: the API still never consults the session,
  and the key still resolves to a `users` row first. The constraint
  check for API principals is a second step after that resolution, in
  the checkpoint, keyed on `external_identities` — not a change to how
  the key authenticates.
- The checkpoint now needs to know *which kind of principal* it is
  judging — a browser session with a recorded strategy kind, or an
  API user judged by linked identities. That is a parameter on the
  checkpoint call, not a second checkpoint; ADR-0003's single
  enforcement surface holds.
- "SSO-only" is exactly true for members and has one named exception
  for site admins. A site with many site admins weakens the guarantee
  by that many people; that is a reason to keep site admins few, which
  Phase 4's model already encourages, not a reason to bind them.
- The checkpoint's evaluation order is now load-bearing: trump, then
  constraint, then role rank. A test must cover a site admin with a
  non-permitted session kind reaching a constrained project, or a
  later refactor that reorders the checks will lock admins out
  silently.
- Because membership is untouched, a constraint is fully reversible:
  nothing has to be re-added, re-invited, or re-assigned when it is
  removed. The alternative — removing non-qualifying members at
  constraint time — would also have collided with Phase 4's "cannot
  remove yourself" guard, silently exempting the admin who set it.
- The team-list badge is a read-model concern: it evaluates the same
  predicate the checkpoint uses (session kind is not available for a
  listed member, so the badge uses the API-principal rule from
  Decision 5 — linked identities) and must call the same function, not
  restate it.
- A user's linked identities are a history, not a live state: an
  identity linked once stays linked. Unlinking is not a feature
  today, so "has ever authenticated via a permitted kind" and "can
  authenticate via a permitted kind" coincide; if unlinking arrives,
  it must delete the `external_identities` row so this check follows.
- A project constraint cannot name a specific provider, only a kind;
  a site with two OIDC providers cannot distinguish them here. That
  is deliberate — one provider per kind is the Phase 31 model — and a
  second provider of the same kind is a change to ADR-0020's
  configuration shape first.
- Legacy never had this feature. ADR-0001 keeps everything the
  installed product did in scope; it does not forbid additions, but an
  addition is judged on its own merits, not on parity, and P-5's
  acceptance is where that judgment is made.

## Session

- Decided during session 952c08 (2026-08-28), while reviewing
  `docs/proposals/post-parity-deferrals.md` item P-5; summary
  `docs/context/session-20260828-*-main.md` for that session.
