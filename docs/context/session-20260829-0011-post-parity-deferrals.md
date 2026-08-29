# Session Summary: 2026-08-29 - main (2026-08-29 00:11 CDT)

## Goals
- Execute the `post-parity-deferrals` plan (14 phases, proposal items P-1 through P-17) end to end.
- Close the plan and its source proposal once every phase's exit criteria are met.

## Phase Context
- **Plan**: `post-parity-deferrals` — deliver every item deferred out of the legacy-parity effort (site chrome, form-page parity, registry image + CI, API surface + docs, per-project auth constraint, signing-secret rotation, SAML, LDAP group sync + StartTLS, Slack routing, GitHub/GitLab/Bitbucket receivers, scheduled backups, metrics).
- **Phase executed**: All 14 phases (1–14), run consecutively in this one session, each closed DONE with its own exit-criteria line in the plan before the next began.
- **Tool calls used**: 511 total across the 14 phases (session state `toolCalls`); per-phase budgets ranged Medium (250) to Large (400), reset each phase.
- **Phase outcome**: All 14 completed; several individual phases ran over their own budget (mid-session budget lines show `296/100`, `342/250`, `500/250`) but the plan as a whole closed clean. Plan and proposal are both already marked DONE (verified by reading `docs/work/archive/post-parity-deferrals/plan.md` line 4: `**Plan Status**: DONE (2026-08-29 — all 14 phases complete; P-1 through P-17 delivered)`, and `docs/proposals/post-parity-deferrals.md` line 3: `**Status**: DONE — 17/17 items delivered`) — this summary performs no plan-mutation of its own.

## Completed

### 1. Site chrome (P-16)
`app/shell/site-context.server.ts`, `app/components/site-chrome.tsx`, `app/styles/site.css`, `app/root.tsx` loader; Tailwind removed; legacy logo/background assets ported. `test/site-chrome.behavior.test.tsx` (9 tests) drives the real root loader and asserts header/tab-bar/body/footbar structure against the legacy templates; ADR-0001 wording amended to `mingle/app/assets/stylesheets`.

### 2. Form-page parity (P-17)
`app/components/forms.tsx` + `app/styles/forms.css` and five per-page stylesheets; 12 routes rebuilt on the shared primitives; header pills added for non-project pages. `test/route-styling.behavior.test.ts` fails any `.tsx` page route missing a stylesheet/class; every page screenshotted against a scratch dev server and compared to the legacy templates.

### 3. Registry image + CI (P-13)
`.github/workflows/verify-and-publish.yml` (gate → multi-arch buildx → tag-triggered publish), `compose.yaml` now pulls `ghcr.io/chicagodave/mingle:1.0`, `compose.build.yaml` restores the source build path, Dockerfile OCI labels. `test/image.real.test.ts` (3/3) and `npm run test:install` (3/3) both run against a locally built image. Integration Reality Statement produced. Open until the owner runs `git tag v1.0.0 && git push --tags`.

### 4. API cursor pagination + card filters (P-1)
`app/api/pagination.server.ts` — opaque keyset cursors, `ApiPage<T>` envelope applied to all six collection routes; card list filters ported via `buildCardListView`/`queryCardList`.

### 5. Card types/transitions/pages/murmurs/attachments over `/api/v1` (P-2, P-3)
New `DeleteCardType` command; 8 new routes; 15 new tests in `test/api-v1.behavior.test.ts`.

### 6. API reference (P-4)
`mingle-ts/docs/api-v1.md` plus `test/api-docs.behavior.test.ts` as a drift guard against `app/routes.ts`.

### 7. Per-project authentication constraint (P-5, ADR-0021)
Migration 0021; `app/domain/identity/principal.server.ts` (request principal via `AsyncLocalStorage` entered by root middleware); `app/domain/identity/access-constraint.server.ts`; checkpoint order trump → constraint → role; sessions record their strategy kind; `requireApiUser` judges by `external_identities`. `test/project-authentication.behavior.test.ts` (13 tests).

### 8. Signing-secret rotation (P-8)
Migration 0022; `RotateSigningSecret` with a 24h overlap window. `test/signing-secret-rotation.behavior.test.ts`.

### 9. SAML (P-9)
`@node-saml/node-saml` SP; routes `/auth/saml`, `/auth/saml/callback`, `/auth/saml/metadata`. Test harness: `samlify`'s in-process IdP. `test/saml.behavior.test.ts` (6 tests). Integration Reality Statement produced.

### 10. LDAP group sync + StartTLS (P-6, P-7)
`app/domain/identity/ldap-group-sync.server.ts`; StartTLS added to the ldapts adapter (constructor `tlsOptions` means LDAPS in ldapts — corrected during the phase). `test/ldap-group-sync.behavior.test.ts` and `test/ldap-starttls.real.test.ts` against OpenLDAP in Docker with a minted CA (the image's baked CA had expired in 2026).

### 11. Slack routing (P-10)
Multiple webhooks per project, `slack_event_routes`, per-webhook cursors (migration 0023).

### 12. GitHub PR/status + GitLab/Bitbucket receivers (P-11, P-12)
Migration 0024; `pull_request_links`, commit-status columns; `app/domain/integrations/scm-receivers.server.ts`; two new webhook routes.

### 13. Scheduled backups (P-14, ADR-0023)
Migration 0025 (seeded `schedules`, `users.time_zone`); `app/jobs/cron.server.ts`, `app/jobs/scheduler.server.ts`, `app/jobs/backup.server.ts`; `/admin/schedules`; profile time-zone setting. `test/scheduler.behavior.test.ts`, `test/backup.behavior.test.ts`, `test/profile-time-zone.behavior.test.ts`.

### 14. Metrics (P-15)
`app/observability/metrics.server.ts`; `GET /metrics` gated by `requireApiUser`; root middleware records every request. `test/metrics.behavior.test.ts`.

## Key Decisions

### 1. Request principal via AsyncLocalStorage
`app/domain/identity/principal.server.ts` is entered by root middleware and is the explicit cross-cutting mechanism ADR-0021 requires; in-process work outside a request (jobs, scheduler ticks) is deliberately not subject to the per-project access constraint.

### 2. SAML test harness = samlify's in-process IdP
Chosen over a hosted test IdP to keep `test/saml.behavior.test.ts` hermetic while still exercising real signature/audience/InResponseTo validation on the SP side.

### 3. LDAP StartTLS real-path test uses Docker OpenLDAP with a minted CA
The prebuilt OpenLDAP test image's baked-in CA had already expired by the current date (2026), which mutation-verification caught; the fix mints a fresh CA/cert pair for the container per test run rather than trusting a baked artifact.

### 4. Slack routing model
A webhook maps to a channel; routing defaults to the project's `is_default` webhook when an event type has no explicit route, and a failing webhook records its error without blocking delivery to the others (per prior ADR-0018 per-webhook cursor pattern).

### 5. LDAP group sync is additive-only for team membership
`LdapGroupsReconciled` adds team + group membership on sign-in and removes group membership only — team membership is never revoked by directory sync.

### 6. Backup archives are directories, not single files
`runBackup` writes `<BACKUPS_DIR>/<UTC stamp>/mingle.db` via better-sqlite3's online backup API plus a copy of the attachments directory, so a restore is a directory-level operation.

## Next Phase
Plan complete — all 14 phases done, plan archived to `docs/work/archive/post-parity-deferrals/plan.md`, `.current-plan` pointer released. No successor plan exists yet.

## Open Items

### Short Term
- Everything from this session is **uncommitted by explicit user instruction** ("no commit") — the working tree still needs a commit (and push) in a future session.
- Owner action: `git tag v1.0.0 && git push --tags` to exercise `.github/workflows/verify-and-publish.yml` publish path and confirm the image pulls cleanly from `ghcr.io/chicagodave/mingle:1.0`.
- Confirm with the user that bearer-gating `/metrics` (P-15) via `requireApiUser` — an assistant judgment call carried over from a prior session's open item — is the intended access model; it is now implemented as such.

### Long Term
- `docs/context/project-profile.md` lives at the repo root (`docs/context/project-profile.md`), not under `mingle-ts/` — two mutation-verification runs this session looked for it under `mingle-ts/docs/context/` and reported it missing. This is a false alarm worth fixing in the `mutation-verification` agent's path assumptions, not a real gap.

## Files Modified

**CI / release** (3 files):
- `.github/workflows/verify-and-publish.yml` — gate → buildx → tag-triggered publish
- `mingle-ts/compose.build.yaml` — source-build override for the pull-by-default compose
- `mingle-ts/vite.config.ts`

**Site chrome & form parity** (11 files):
- `mingle-ts/app/shell/site-context.server.ts`, `app/components/site-chrome.tsx`, `app/components/forms.tsx`, `app/root.tsx`
- `mingle-ts/app/styles/site.css`, `forms.css`, `login.css`, `profile.css`, `projects-list.css`, `transitions.css`, `card-new.css`

**API surface + docs** (3 files, plus 8 new route files not itemized here):
- `mingle-ts/app/api/pagination.server.ts`, `mingle-ts/docs/api-v1.md`
- `mingle-ts/app/routes/api.v1.projects.{murmurs,pages,transitions,cards.card.attachments}*.ts`

**Identity / auth** (5 files):
- `mingle-ts/app/domain/identity/principal.server.ts`, `access-constraint.server.ts`, `ldap-group-sync.server.ts`
- `mingle-ts/app/auth/saml-client.server.ts`
- `mingle-ts/app/routes/auth.saml*.ts`

**Integrations** (4 files):
- `mingle-ts/app/domain/integrations/slack.server.ts`, `scm-receivers.server.ts`
- `mingle-ts/app/routes/projects.gitlab.webhook.ts`, `projects.bitbucket.webhook.ts`

**Scheduling / backups / metrics** (6 files):
- `mingle-ts/app/jobs/cron.server.ts`, `scheduler.server.ts`, `backup.server.ts`
- `mingle-ts/app/routes/admin.schedules.tsx`, `mingle-ts/app/observability/metrics.server.ts`, `mingle-ts/app/routes/metrics.ts`

**Tests** (12 files):
- `mingle-ts/test/site-chrome.behavior.test.tsx`, `route-styling.behavior.test.ts`, `image.real.test.ts`, `api-docs.behavior.test.ts`, `project-authentication.behavior.test.ts`, `signing-secret-rotation.behavior.test.ts`, `saml.behavior.test.ts`, `ldap-group-sync.behavior.test.ts`, `ldap-starttls.real.test.ts`, `scheduler.behavior.test.ts`, `backup.behavior.test.ts`, `metrics.behavior.test.ts`, `profile-time-zone.behavior.test.ts`

Full per-file list (including migrations and scratch screenshot bodies used for visual comparison, since deleted from the repo tree) is in the session state file `docs/context/.session-state-ba5848.json`.

## Notes

**Session duration**: ~7 hours (started 00:11 CDT, event log runs through ~01:57 CDT the following calendar segment in UTC terms — see `started`/last event timestamps).

**Approach**: Executed the plan phase by phase without re-planning; ran `mutation-verification` after phases 5, 7, 10, 11, 12, and 13, fixing every finding in-session (LDAPS+StartTLS rejection test, expired test CA, disabled-integration rejection test for PR/status receivers, time-zone test gaps) before moving on. Two `session-checkpoint` runs found no scope drift.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A
- **Rollback Safety**: safe to revert — all work this session is uncommitted per explicit user instruction ("no commit"); `git status` shows a dirty working tree with no local commits ahead of `9c650e4`.

## Dependency/Prerequisite Check

- **Prerequisites met**: Docker available for the OpenLDAP StartTLS real-path test and the registry image real-path tests; existing `npm run verify` gate from the prior session (Phase 33) as the standing acceptance bar.
- **Prerequisites discovered**: The bundled OpenLDAP test image's baked-in CA had expired (dated for a period before 2026), forcing a switch to minting a fresh CA per test run.

## Architectural Decisions

- ADR-0021 (per-project authentication constraint): implemented this session via `principal.server.ts` + `access-constraint.server.ts`, closing the prior session's open item about sessions without a recorded strategy kind.
- ADR-0023 (scheduled backups / time zone): implemented via `cron.server.ts`, `scheduler.server.ts`, `backup.server.ts`.
- ADR-0001: wording amended from its original path to `mingle/app/assets/stylesheets` to match the ported site-chrome asset layout.
- ADR-0010, ADR-0007, ADR-0011, ADR-0017, ADR-0018: applied (not amended) as pre-existing constraints — nil `HasSpecificValue` prerequisite encoding, no PATCH on transitions, `CreatePage` sanitization, `PostMurmur` mention/link resolution, per-webhook Slack cursors respectively.

## Mutation Audit

- Files with state-changing logic modified: `principal.server.ts`, `access-constraint.server.ts`, `ldap-group-sync.server.ts`, `scm-receivers.server.ts`, `slack.server.ts`, `backup.server.ts`, `scheduler.server.ts`, `cron.server.ts`, `metrics.server.ts`, plus the new API route handlers.
- Tests verify actual state mutations (not just events): YES (evidence: `mutation-verification` agent runs at 2026-08-29T06:26:21Z "1 passed 3 passed" (ldap-starttls fix) and 2026-08-29T06:38:48Z "1 passed 17 passed" (session-wide re-run after PR/status receiver and time-zone fixes), both from `docs/context/.devarch-events-ba5848.jsonl`, both timestamped after the edits they cover).
- If NO: N/A.

## Recurrence Check

- Similar to past issue? YES — the LDAPS-vs-StartTLS constructor confusion (`tlsOptions` on the ldapts constructor silently means LDAPS) is the same class of "library option semantics differ from the obvious reading" issue flagged in mutation-verification during LDAP work in a prior session (`docs/context/mutation-audit-20260827.md`).
- If YES: Consider a one-time audit of every ldapts call site for the same constructor-vs-method TLS option split, since this session only fixed the StartTLS path it touched.

## Test Coverage Delta

- Tests added: ~80 net across the session (13 behavior test files added/extended: site-chrome, route-styling, api-docs, api-v1 additions, project-authentication, signing-secret-rotation, saml, ldap-group-sync, ldap-starttls, scheduler, backup, metrics, profile-time-zone).
- Tests passing before: 44 files / 1086 tests (Phase 1 exit line in the archived plan) → after: **54 files / 1166 tests**, all passing, typecheck and build clean (evidence: `npm run verify` run by this agent directly, exit code 0, `Test Files 54 passed (54)` / `Tests 1166 passed (1166)`, run 2026-08-29 ~01:59 CDT, after every source/test edit in the session).
- Known untested areas: search box and murmur badge, Source tab, tab reordering/renaming (explicitly not carried from legacy per Phase 1's exit line); the CI publish workflow itself has not yet run on a GitHub runner (blocked on the owner's `v1.0.0` tag).

---

**Progressive update**: Session completed 2026-08-29 02:00 CDT

**See also**: this session continued later the same day with the project-templates plan — see `docs/context/session-20260829-0011-project-templates.md`.
