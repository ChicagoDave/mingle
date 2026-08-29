# Proposal: Post-parity deferrals

**Status**: DONE — 17/17 items delivered by `docs/work/archive/post-parity-deferrals/plan.md` (2026-08-29)
**Origin**: conversation — the Long Term deferrals recorded in `docs/context/session-20260828-1938-main.md`, each explicitly deferred out of Phases 30–33 of the completed `mingle-ts-full-parity` plan (API, auth, integrations, packaging). The process item from that list (`npm run build` as a standing gate) was closed in the 2026-08-28 21:34 session and is not carried here.
**Date**: 2026-08-28
**Session**: 952c08

The `mingle-ts` parity plan reached DONE at Phase 33. During Phases 30–33 a number of capabilities were consciously scoped out to keep those phases session-sized; this proposal captures them as discrete items so they can be accepted selectively and planned from. Items are grouped by area and ordered so that a later item never depends on an earlier one that is still open. Reviewed 2026-08-28 (session 952c08): P-5, P-13, and P-14 each surfaced an unrecorded decision, extracted as ADR-0021, ADR-0022, and ADR-0023; all three were resolved through the open-questions interview and ACCEPTED in the same session, and the review's advisory rewordings are folded into the "Done when" lines below. Added 2026-08-28 (same session) after running the app: P-16 and P-17 capture the visual-parity gap found when `/login` rendered as an unstyled form — 13 of 54 routes carry no styling and there is no site chrome, though ADR-0001 requires the UX be harvested from the legacy views and stylesheets. (The root route rendering the React Router scaffold page was fixed directly in that session — `/` now redirects to `/projects` as legacy's `map.root` did — and is not an item.) These two precede every UI-bearing item when planned (their review found tensions only: ADR-0001 names `mingle/public` where the SCSS actually lives in `mingle/app/assets/stylesheets`; the tab bar must stay on the ADR-0005 favorites row; Tailwind remains for its preflight only; P-17 shares pages with P-5/P-8/P-9/P-10 and is sequenced before them). Every item is ACCEPTED.

## Items

### P-1: List filtering and pagination on `/api/v1` collection endpoints
- **Done when**: every `/api/v1` collection route accepts `limit` and `cursor` query parameters, the card list additionally accepts filter parameters, responses carry a next-cursor in the envelope, and a behavior test walks a multi-page result end to end. (Cursor paging is a deliberate departure from legacy's `page=`; the plan phase records it as such.)
- **Status**: DONE (2026-08-29)

### P-2: Define card types and transitions over the API
- **Done when**: `/api/v1` exposes create and delete for card types and for transitions with the same validation the UI applies (transition edit remains delete-and-recreate per ADR-0007 unless the plan phase adds a domain edit command explicitly), a nil `has_specific_value` prerequisite crosses the wire as null per ADR-0010, and behavior tests cover each operation including a rejected invalid definition.
- **Status**: DONE (2026-08-29)

### P-3: Attachments, murmurs, and wiki resources over the API
- **Done when**: each of attachments, murmurs, and wiki pages has list/get/create routes under `/api/v1` that call the existing page, murmur, and attachment commands (so ADR-0011 sanitization, ADR-0017 post-time mention resolution, and ADR-0012 reference rules are inherited rather than re-implemented), attachments round-trip a file body, and behavior tests cover each resource.
- **Status**: DONE (2026-08-29)

### P-4: API reference document
- **Done when**: a reference document under `mingle-ts/docs/` describes every `/api/v1` route, the auth modes (bearer, HMAC), the response envelope, and the status-code mapping ADR-0020 fixes, and a test compares the documented route set against `app/routes.ts` so drift fails the suite.
- **Status**: DONE (2026-08-29)

### P-5: Per-project authentication settings
- **Done when**: a project admin can set a permitted-strategy-kind constraint in project settings (ADR-0021; site-level remains the only place strategies and providers are configured), sessions record their strategy kind, the ADR-0003 checkpoint enforces the constraint on reads and writes in the order trump → constraint → role rank, API principals are judged by linked identities, membership is never changed by the constraint and the team list badges non-qualifying members via the same predicate, and tests cover a refused session, a refused API key, the same user passing after an SSO sign-in, the site-admin bypass, no membership event on set, and fall-through when no constraint is set.
- **Status**: DONE (2026-08-29)

### P-6: LDAP group → Mingle group sync
- **Done when**: configured LDAP group DNs map to Mingle project groups (the mapping lives beside the LDAP configuration — site-level today, moving only if ADR-0021 moves it), membership is reconciled on each LDAP login, and tests cover a user gaining and losing a Mingle group across two logins.
- **Status**: DONE (2026-08-29)

### P-7: LDAP StartTLS
- **Done when**: LDAP configuration accepts a StartTLS flag, the bind path upgrades the connection before binding when it is set, and a real-path test exercises it against the test directory.
- **Status**: DONE (2026-08-29)

### P-8: Signing-secret rotation UI
- **Done when**: a user can rotate the HMAC signing secret of one of their own API keys from the profile page (where the key and its secret are minted, per ADR-0020 and Phase 31) with an overlap window during which requests signed with the previous secret are still accepted, requests signed with it after the window are rejected, and tests cover both sides of the window boundary.
- **Status**: DONE (2026-08-29)

### P-9: SAML sign-in strategy
- **Done when**: SAML 2.0 (SP-initiated, HTTP-POST binding) is a selectable strategy on the authentication admin page, mapped to `users` rows through the same `signInExternalUser` path as OIDC, and verified against a real identity provider in test the way OIDC was in Phase 31. (CAS is not carried; SAML is the one still deployed.)
- **Status**: DONE (2026-08-29)

### P-10: Slack per-event filters and webhook mapping UI
- **Done when**: an admin can register more than one incoming-webhook URL per project (an incoming webhook is bound to its channel at creation, so channel routing is URL routing), map history event types to URLs, and suppress individual event types; each URL is its own delivery cursor under ADR-0018; and tests cover a routed event, a suppressed event, and the default-URL fall-through.
- **Status**: DONE (2026-08-29)

### P-11: GitHub pull-request and status events
- **Done when**: the GitHub receiver handles `pull_request` and `status` payloads, links pull requests to cards alongside the existing commit links, posts murmurs for them, and signed-payload tests cover each event type.
- **Status**: DONE (2026-08-29)

### P-12: GitLab and Bitbucket push receivers
- **Done when**: push receivers for GitLab (shared-token header) and Bitbucket (HMAC signature), each verifying the per-integration sealed secret in its adapter per ADR-0020, link commits to cards and post murmurs the way the GitHub receiver does, with verification-failure and success tests for each.
- **Status**: DONE (2026-08-29)

### P-13: Prebuilt registry image
- **Done when**: a tagged image is published to `ghcr.io/chicagodave/mingle` by the tag-driven GitHub Actions workflow ADR-0022 defines (gate first, three tags, multi-arch), `compose.yaml` pulls it by minor line with `compose.build.yaml` restoring the source build, and both `test/install.real.test.ts` and the new `test/image.real.test.ts` pass end to end through Docker.
- **Status**: DONE (2026-08-29)

### P-14: Scheduled backups
- **Done when**: the in-process scheduler ADR-0023 defines (`schedules` rows edited on `/admin/schedules`, one-minute UTC tick, `<schedule>:<next_run_at>` dedupe) runs a backup handler that writes a restorable archive of the database (SQLite online backup, never a file copy) and attachments to `BACKUPS_DIR` keeping the newest `BACKUP_KEEP`, `users.time_zone` exists as a profile setting for display, and tests cover restart/overlap dedupe, retention-after-failure, and a restore into a fresh instance asserting data parity with the source.
- **Status**: DONE (2026-08-29)

### P-15: Metrics beyond `/healthz`
- **Done when**: a `/metrics` endpoint exposes request count, latency, and outbox/queue depth in Prometheus exposition format, served only to a request bearing a valid API key through the existing `/api/v1` bearer auth (no new credential kind, per ADR-0020), and tests assert that the counters move after requests are made and that an unauthenticated scrape gets 401.
- **Status**: DONE (2026-08-29)

### P-16: Site chrome harvested from the legacy application layout
- **Done when**: `root.tsx` renders the legacy application shell harvested from `mingle/app/views/layouts/application.rhtml` and its partials — `_application_hd.rhtml` (header: logo, project name, user menu), `_tabs.rhtml` (project tab bar fed by the Phase 11 favorites/tabs read model), `_flash.rhtml`, `_footbar.rhtml` — with its styles ported from `mingle/app/assets/stylesheets/{application,base,common/*}.scss` into plain CSS under `app/styles/` (the precedent set by `card-list.css` and `card-grid.css`), the scaffold remnants removed (Inter font link, `dark:` variants, `@theme` block — legacy had no dark mode), every project route rendering inside the shell, a behavior test asserting a signed-in project page's HTML carries the header, tab bar, and footer, and the shell reviewed side by side against the legacy layout per ADR-0001.
- **Status**: DONE (2026-08-29)

### P-17: Form-page parity for the thirteen unstyled routes
- **Done when**: each of `login`, `register`, `home`-adjacent `projects` (index), `projects.new`, `projects.settings`, `projects.team`, `projects.groups`, `projects.transitions`, `projects.integrations`, `projects.cards.new`, `profile`, and `admin.authentication` is rebuilt from its legacy view (`users/login.rhtml`, `users/new.rhtml`, `projects/index` and `projects/new.rhtml`, the project settings, `team/`, `groups/index.rhtml`, `transitions/`, the profile views, plus `account.scss`/`action_bar.scss` and the view-specific stylesheets) inside the P-16 chrome; routes that have no legacy counterpart (`projects.integrations`, `admin.authentication` — both Phase 31/32 additions) reuse the legacy settings-page structure; a test fails if any route module under `app/routes/` renders a page without a stylesheet import or class attribute; and each page is reviewed side by side against its legacy template per ADR-0001.
- **Status**: DONE (2026-08-29)
