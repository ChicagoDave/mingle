# Session Plan: Implement the post-parity-deferrals proposal (P-1 through P-17)

**Created**: 2026-08-28
**Plan Status**: ACTIVE
**Overall scope**: Build all 17 ACCEPTED items from `docs/proposals/post-parity-deferrals.md` — the capabilities consciously deferred out of Phases 30–33 of the completed `mingle-ts-full-parity` plan (API breadth, per-project auth, LDAP/SAML, integrations, packaging, scheduling, metrics) plus the visual-parity gap found after that plan closed (no site chrome, 13 unstyled routes).
**Bounded contexts touched**: Frontend UI / site chrome (P-16, P-17); API / Service `/api/v1` (P-1, P-2, P-3, P-4); Identity & Access — auth, LDAP, SAML, API credentials (P-5, P-6, P-7, P-8, P-9); Integrations — Slack, GitHub, GitLab, Bitbucket (P-10, P-11, P-12); Cloud Infrastructure — registry image and CI (P-13); Pub/Sub & Messaging — scheduler and backups (P-14); Observability (P-15).
**Key domain language**: site chrome, form-page parity, cursor pagination, permitted-strategy-kind constraint, bearer key / HMAC signing secret, sealed secret, transactional outbox, schedule dedupe key (`<schedule>:<next_run_at>`), delivery cursor.

## References consulted
- `docs/adrs/0001-rewrite-in-typescript-preserving-ux.md` — UX must be harvested from the legacy views and stylesheets (not invented), which is the entire constraint P-16/P-17 build against; the ADR names `mingle/public` where the SCSS actually lives under `mingle/app/assets/stylesheets`.
- `docs/adrs/0002-sqlite-over-postgres.md` — single SQLite file, single-node deployment; P-14's backup handler must use SQLite's online backup API, never a file copy, and the scheduler is in-process per this ADR's stance.
- `docs/adrs/0003-authorization-checkpoint-in-domain-layer.md` — one non-bypassable checkpoint in the domain layer enforces every mutation and, per ADR-0021, every read-path restriction too; P-5 extends this checkpoint rather than adding a second one.
- `docs/adrs/0005-favorites-as-single-row-with-kind-discriminator.md` — the tab bar P-16 harvests is fed by the Phase 11 favorites/tabs read model built on this single-row-with-discriminator shape.
- `docs/adrs/0007-transitions-as-discriminated-rows-executing-as-one-card-version.md` — transition edit remains delete-and-recreate; P-2's transitions API must not silently add a domain edit command.
- `docs/adrs/0010-null-has-specific-value-prerequisite-means-unset.md` — a null `has_specific_value` prerequisite means unset; P-2's API must round-trip that as JSON null, never an empty string.
- `docs/adrs/0011-page-content-is-sanitized-on-parse-and-links-resolve-at-render.md` — page sanitization is parse→allowlist-rebuild→serialize, not filtering; P-3's wiki routes must call the existing `sanitizePageContent`/`renderPageContent`, never re-implement.
- `docs/adrs/0012-a-name-stored-in-text-is-a-reference-rename-rewrites-or-is-refused.md` — names stored inside authored text are references; bears on P-3's wiki/attachment resources inheriting the same reference rules rather than a parallel rename path.
- `docs/adrs/0017-mention-and-link-resolution-is-frozen-at-post-time.md` — mentions and card links resolve once, at post time, and are stored, not re-derived; P-3's murmur routes must read the stored rows through the existing modules.
- `docs/adrs/0018-background-work-is-a-transactional-outbox-drained-in-process.md` — every background job follows the enqueue-on-tx / register-handler / idempotent-handler recipe; P-14's scheduler is a second enqueue origin onto the same outbox, not a new mechanism.
- `docs/adrs/0020-api-credentials-are-distinct-from-the-session-and-secrets-are-sealed-at-rest.md` — bearer keys are hashed, HMAC/LDAP/OIDC secrets are sealed, the API never consults the session; P-8's rotation UI and P-15's metrics endpoint must follow this hash/seal split and bearer-only auth.
- `docs/adrs/0021-authentication-is-configured-site-wide-and-projects-constrain-access.md` — the full decision P-5 implements: a project declares a permitted-strategy-kind constraint enforced at the ADR-0003 checkpoint in order trump → constraint → role rank; membership is never changed by it.
- `docs/adrs/0022-prebuilt-image-is-published-to-a-registry-by-a-tag-driven-pipeline.md` — the full decision P-13 implements: `ghcr.io/chicagodave/mingle`, three tags, gate-first tag-driven GitHub Actions, multi-arch, `compose.build.yaml` override, `test/image.real.test.ts`.
- `docs/adrs/0023-time-triggered-work-is-an-in-process-scheduler-enqueuing-onto-the-outbox.md` — the full decision P-14 implements: `schedules` rows, one-minute UTC tick, `<schedule>:<next_run_at>` dedupe, keep-last-N retention, `users.time_zone` for display only.
- `docs/context/project-profile.md` — the standing end-of-phase gate is `cd mingle-ts && npm run verify` (typecheck, behavioral suite, build); every phase below closes against it.
- `docs/context/session-20260828-2134-main.md` — confirms no CI configuration exists anywhere in the repo (P-13 is greenfield, not a fix to an existing pipeline) and records no open blockers carrying into this plan.
- `docs/proposals/post-parity-deferrals.md` — source of all 17 items; each item's "Done when" line is this plan's exit-criterion source, cited per phase below.

## Phases

### Phase 1: Site chrome harvested from the legacy application layout
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Frontend UI — `root.tsx` shell, ported plain CSS under `app/styles/`.
- **Entry state**: Working tree has the uncommitted root-redirect/sign-in changes from this session; `root.tsx` still renders the React Router scaffold shell (Inter font link, `dark:` variants, `@theme` block); no site chrome exists.
- **Deliverable**: Implements P-16. `root.tsx` renders the legacy application shell harvested from `mingle/app/views/layouts/application.rhtml` and its partials (`_application_hd.rhtml` header: logo, project name, user menu; `_tabs.rhtml` project tab bar fed by the Phase 11 favorites/tabs read model per ADR-0005; `_flash.rhtml`; `_footbar.rhtml`), styles ported from `mingle/app/assets/stylesheets/{application,base,common/*}.scss` into plain CSS under `app/styles/` following the `card-list.css`/`card-grid.css` precedent, scaffold remnants removed, every project route rendering inside the shell.
- **Exit state**: A behavior test asserts a signed-in project page's HTML carries the header, tab bar, and footer; the shell has been reviewed side by side against the legacy layout per ADR-0001; `cd mingle-ts && npm run verify` passes.
- **Status**: CURRENT (since 2026-08-28)

### Phase 2: Form-page parity for the thirteen unstyled routes
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Frontend UI — the 13 route modules named in P-17, rebuilt inside the Phase 1 chrome.
- **Entry state**: Phase 1 done — `root.tsx` renders the legacy shell and every project route already renders inside it.
- **Deliverable**: Implements P-17. Each of `login`, `register`, `projects` (index), `projects.new`, `projects.settings`, `projects.team`, `projects.groups`, `projects.transitions`, `projects.integrations`, `projects.cards.new`, `profile`, and `admin.authentication` is rebuilt from its legacy view (`users/login.rhtml`, `users/new.rhtml`, `projects/index`/`projects/new.rhtml`, project settings, `team/`, `groups/index.rhtml`, `transitions/`, profile views, plus `account.scss`/`action_bar.scss` and view-specific stylesheets); routes with no legacy counterpart (`projects.integrations`, `admin.authentication`) reuse the legacy settings-page structure.
- **Exit state**: A test fails if any route module under `app/routes/` renders a page without a stylesheet import or class attribute; each page reviewed side by side against its legacy template per ADR-0001; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 3: Prebuilt registry image and tag-driven CI
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Cloud Infrastructure — GitHub Actions workflow, `ghcr.io/chicagodave/mingle`, compose overrides.
- **Entry state**: Phase 2 done; no `.github/workflows` exists anywhere in the repo (confirmed in `session-20260828-2134-main.md`); `npm run verify` is the standing gate but runs unattended nowhere yet.
- **Deliverable**: Implements P-13 per ADR-0022. A GitHub Actions workflow runs `cd mingle-ts && npm run verify` as the gate on every push to `main` (advisory) and, on a `v<major>.<minor>.<patch>` tag, builds and pushes a multi-arch (`linux/amd64`, `linux/arm64`) image to `ghcr.io/chicagodave/mingle` tagged with the exact version, its minor line, and `latest`; `compose.yaml` pulls by minor line; `compose.build.yaml` restores `build: .` for the source-build override.
- **Exit state**: Both `test/install.real.test.ts` (build-from-source path) and the new `test/image.real.test.ts` (registry pull path — asserts image reference, `healthy` status, `/healthz` db:connected, and the `org.opencontainers.image.version` label match the tag) pass end to end through Docker; rule 13a Integration Reality Statement produced before declaring complete; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 4: List filtering and pagination on `/api/v1` collections
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: API / Service — `/api/v1` collection routes.
- **Entry state**: Phase 3 done (CI now runs the gate on every push); the Phase 30/31 `/api/v1` routes exist with no `limit`/`cursor` support.
- **Deliverable**: Implements P-1. Every `/api/v1` collection route accepts `limit` and `cursor` query parameters; the card list route additionally accepts filter parameters; responses carry a next-cursor in the envelope. Cursor paging is recorded as a deliberate departure from legacy's `page=`.
- **Exit state**: A behavior test walks a multi-page result end to end via the cursor; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 5: Card types, transitions, attachments, murmurs, and wiki over `/api/v1`
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: API / Service — new `/api/v1` resource routes over Card Management, Collaboration, and Wiki & Content.
- **Entry state**: Phase 4 done — pagination exists on collection routes these new resources will reuse.
- **Deliverable**: Implements P-2 and P-3. `/api/v1` exposes create/delete for card types and transitions with the same validation the UI applies (transition edit stays delete-and-recreate per ADR-0007; a nil `has_specific_value` prerequisite crosses the wire as JSON null per ADR-0010); attachments, murmurs, and wiki pages get list/get/create routes that call the existing page, murmur, and attachment commands so ADR-0011 sanitization, ADR-0017 post-time mention resolution, and ADR-0012 reference rules are inherited rather than re-implemented; attachments round-trip a file body.
- **Exit state**: Behavior tests cover each operation, including a rejected invalid card-type/transition definition; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 6: API reference document
- **Tier**: Small
- **Budget**: 100
- **Domain focus**: API / Service — documentation and drift guard.
- **Entry state**: Phases 4 and 5 done — the full `/api/v1` route set (pagination, card types/transitions, attachments/murmurs/wiki) exists.
- **Deliverable**: Implements P-4. A reference document under `mingle-ts/docs/` describes every `/api/v1` route, the auth modes (bearer, HMAC), the response envelope, and the status-code mapping ADR-0020 fixes.
- **Exit state**: A test compares the documented route set against `app/routes.ts` so drift fails the suite; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 7: Per-project authentication settings
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Identity & Access — the ADR-0003 checkpoint extended per ADR-0021.
- **Entry state**: Phase 2 done (project settings and team pages carry chrome and styling to add the constraint control to); ADR-0021 ACCEPTED.
- **Deliverable**: Implements P-5 per ADR-0021. A project admin sets a permitted-strategy-kind constraint in project settings; sessions record their strategy kind; the checkpoint enforces the constraint on reads and writes in order trump → constraint → role rank; API principals are judged by linked identities (`external_identities`); membership is never changed by the constraint and the team list badges non-qualifying members via the same predicate function the checkpoint uses.
- **Exit state**: Tests cover a refused session, a refused API key, the same user passing after an SSO sign-in, the site-admin bypass, no membership event fired on set, and fall-through when no constraint is set; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 8: Signing-secret rotation UI
- **Tier**: Small
- **Budget**: 100
- **Domain focus**: Identity & Access — profile page, API credentials (ADR-0020).
- **Entry state**: Phase 2 done (profile page carries chrome/styling); Phase 31's API key/HMAC secret minting exists.
- **Deliverable**: Implements P-8. A user rotates the HMAC signing secret of one of their own API keys from the profile page, with an overlap window during which requests signed with the previous secret are still accepted.
- **Exit state**: Tests cover both sides of the window boundary (accepted just inside, rejected just after); `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 9: SAML sign-in strategy
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Identity & Access — a new sign-in strategy alongside OIDC/LDAP.
- **Entry state**: Phase 2 done (admin.authentication page carries chrome/styling); Phase 31's `signInExternalUser` path and OIDC real-provider test pattern exist.
- **Deliverable**: Implements P-9. SAML 2.0 (SP-initiated, HTTP-POST binding) is a selectable strategy on the authentication admin page, mapped to `users` rows through the same `signInExternalUser` path as OIDC. CAS is not carried.
- **Exit state**: Verified against a real identity provider in test the way OIDC was in Phase 31 (rule 13a real-path test); `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 10: LDAP group sync and StartTLS
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Identity & Access — LDAP configuration and bind path.
- **Entry state**: Phase 2 done (admin.authentication page, where the LDAP config and the group-mapping UI beside it live, carries chrome/styling); Phase 31's LDAP bind auth exists.
- **Deliverable**: Implements P-6 and P-7. Configured LDAP group DNs map to Mingle project groups, with the mapping living beside the site-level LDAP configuration; membership is reconciled on each LDAP login. LDAP configuration accepts a StartTLS flag and the bind path upgrades the connection before binding when set.
- **Exit state**: Tests cover a user gaining and losing a Mingle group across two logins, plus a real-path test exercising StartTLS against the test directory (rule 13a); `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 11: Slack per-event filters and webhook mapping UI
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Integrations — Slack delivery, extending ADR-0018's outbox.
- **Entry state**: Phase 2 done (projects.integrations page carries chrome/styling); Phase 32's Slack incoming-webhook notifier exists.
- **Deliverable**: Implements P-10. An admin registers more than one incoming-webhook URL per project (a webhook is bound to its channel at creation, so channel routing is URL routing), maps history event types to URLs, and suppresses individual event types; each URL is its own delivery cursor under ADR-0018.
- **Exit state**: Tests cover a routed event, a suppressed event, and the default-URL fall-through; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 12: GitHub pull-request/status events and GitLab/Bitbucket push receivers
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Integrations — SCM event receivers, sealed per-integration secrets (ADR-0020).
- **Entry state**: Phase 11 done (webhook/delivery-cursor infrastructure exercised); Phase 32's GitHub receiver and commit→card linking exist.
- **Deliverable**: Implements P-11 and P-12. The GitHub receiver handles `pull_request` and `status` payloads, links pull requests to cards alongside existing commit links, and posts murmurs for them. GitLab (shared-token header) and Bitbucket (HMAC signature) push receivers, each verifying a per-integration sealed secret in its adapter per ADR-0020, link commits to cards and post murmurs the way the GitHub receiver does.
- **Exit state**: Signed-payload tests cover each new GitHub event type and verification-failure/success tests cover each new receiver; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 13: Scheduled backups
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Pub/Sub & Messaging — in-process scheduler (ADR-0023) extending the ADR-0018 outbox.
- **Entry state**: Phase 2 done (profile page carries the `time_zone` field's chrome/styling); ADR-0023 ACCEPTED.
- **Deliverable**: Implements P-14 per ADR-0023. The in-process scheduler (`schedules` rows edited on `/admin/schedules`, one-minute UTC tick, `<schedule>:<next_run_at>` dedupe) runs a backup handler that writes a restorable archive of the database (SQLite online backup, never a file copy) and attachments to `BACKUPS_DIR`, keeping the newest `BACKUP_KEEP`; `users.time_zone` exists as a profile setting for display.
- **Exit state**: Tests cover restart/overlap dedupe, retention-after-failure, and a restore into a fresh instance asserting data parity with the source; `npm run verify` passes.
- **Status**: NOT STARTED

### Phase 14: Metrics beyond `/healthz`
- **Tier**: Small
- **Budget**: 150
- **Domain focus**: Observability — Prometheus-format `/metrics` endpoint.
- **Entry state**: Phase 13 done; the outbox/queue-depth data it exposes exists from ADR-0018/ADR-0023 work.
- **Deliverable**: Implements P-15. A `/metrics` endpoint exposes request count, latency, and outbox/queue depth in Prometheus exposition format, served only to a request bearing a valid API key through the existing `/api/v1` bearer auth (no new credential kind, per ADR-0020).
- **Exit state**: Tests assert the counters move after requests are made and that an unauthenticated scrape gets 401; `npm run verify` passes.
- **Status**: NOT STARTED
