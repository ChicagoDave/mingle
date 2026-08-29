# Mingle

A self-hosted rewrite of ThoughtWorks Mingle in TypeScript: React Router
(framework mode, server-rendered), SQLite via Drizzle, Node 22 — one
container, one data volume (ADR-0001, ADR-0002).

## Install (one command)

Requires Docker with Compose v2. No checkout is needed: the image is
published to `ghcr.io/chicagodave/mingle` (ADR-0022). Save
[`compose.yaml`](compose.yaml) into an empty directory and run:

```bash
docker compose up -d
```

`compose.yaml` pins the image's minor line (`ghcr.io/chicagodave/mingle:1.0`),
so `docker compose pull` picks up patch releases and never a surprise
minor. `latest` moves across minors and is for trying the product, not for
running it. To build from source instead, clone the repository and layer the
build override:

```bash
git clone https://github.com/ChicagoDave/mingle && cd mingle/mingle-ts
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Open <http://localhost:3000>, click **Sign up** — the first account created
is the site administrator. Everything Mingle stores lives in the
`mingle-data` volume at `/data` inside the container:

| Path | What |
|---|---|
| `/data/mingle.db` | the SQLite database (WAL mode) |
| `/data/attachments/` | card attachments |
| `/data/session-secret` | the auto-generated secret that signs cookies and seals stored credentials |

Pending schema migrations are applied every time the container starts.
There is no manual seeding step.

### Configuration

Set these in the environment (or a `.env` file beside `compose.yaml`):

| Variable | Default | Purpose |
|---|---|---|
| `MINGLE_PORT` | `3000` | host port published |
| `SITE_URL` | `http://localhost:3000` | the address people reach Mingle at — used in emails, chat notifications, and as the OIDC callback origin |
| `INSECURE_COOKIES` | `true` | send session cookies over plain HTTP; set to `false` behind an HTTPS reverse proxy |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | unset, `587`, `mingle@localhost` | outbound mail for history notifications; unset means notifications queue until a relay is configured |
| `SESSION_SECRET` | generated into `/data/session-secret` | override the install secret; changing it invalidates sessions and every sealed credential |
| `BACKUPS_DIR`, `BACKUP_KEEP` | `/data/backups`, `7` | where scheduled backups are written and how many newest archives are kept |

Sign-in sources (LDAP — with StartTLS and LDAP-group → Mingle-group
mappings — OpenID Connect, SAML 2.0) and API keys are configured inside
the app: **Profile → Authentication settings** (site admins) and
**Profile → API keys**. A project may restrict access to sessions opened
through some of those strategies (**Settings → Authentication**, ADR-0021);
members who signed in another way keep their membership and are refused
until they sign in through a permitted strategy, API keys qualify by their
owner's linked identities, and site administrators always have access —
the same safeguard that keeps a site admin's Mingle password valid under
LDAP. Project integrations (Slack webhooks with
per-event routing; GitHub, GitLab, and Bitbucket repositories — commits and
GitHub pull requests link to the cards they mention) are under a project's
**Settings → Integrations**.

### Upgrade

```bash
docker compose pull && docker compose up -d
```

To move to a new minor, change the tag in `compose.yaml` first. The new
image applies its migrations on start; the volume is untouched. A
source-built install upgrades with `git pull` and the build override
(`docker compose -f compose.yaml -f compose.build.yaml up -d --build`).

### Releases

A release is a git tag: `git tag v1.0.1 && git push --tags`. The
`verify-and-publish` workflow (`.github/workflows/`) runs `npm run verify`
and, only if it passes, builds the multi-architecture image
(`linux/amd64`, `linux/arm64`) and pushes it tagged `1.0.1`, `1.0`, and
`latest`. Every push to `main` runs the same gate on its own, as a report.
This repository is a tribute to the original tool and accepts no
contributions; a fork publishes its own image by changing `IMAGE_NAME` in
the workflow and the `image:` line in `compose.yaml`.

### Backup and restore

Scheduled backups (ADR-0023): a site admin enables the **Nightly backup**
schedule on **Profile → Schedules** (`/admin/schedules`; the default
expression is `0 3 * * *`, UTC; **Run now** takes one immediately). Each run
writes `BACKUPS_DIR/<UTC timestamp>/` — `mingle.db` through SQLite's online
backup API and a copy of `attachments/` — and keeps the newest `BACKUP_KEEP`
(default 7). `BACKUPS_DIR` defaults to `/data/backups` in the container, so
the volume-archive recipe below captures the archives too; mount another
disk there to keep them elsewhere. Off-site copies are yours to arrange.
To restore an archive: stop the app, copy its `mingle.db` over
`/data/mingle.db` and its `attachments/` over `/data/attachments`, start
the app (pending migrations apply on boot).

Manual backup while running — SQLite in WAL mode stays consistent under a copy:

```bash
docker compose cp app:/data/mingle.db ./mingle-backup.db
```

To keep attachments as well, archive the whole volume:

```bash
docker run --rm -v mingle-ts_mingle-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/mingle-data.tgz /data
```

Restore by stopping the app, copying the file back, and starting it:

```bash
docker compose stop app
docker compose cp ./mingle-backup.db app:/data/mingle.db
docker compose start app
```

### HTTPS

Put a reverse proxy (Caddy, nginx, Traefik) in front of port 3000, set
`SITE_URL` to the public `https://` address and `INSECURE_COOKIES=false`.

## Project templates

New Project offers the templates shipped under `templates/` (legacy's "Pre-defined templates"): today `kanban.json` — one `Work` card type, a `Status` flowing Proposed → Ready → Backlog → In Progress → In Test → Completed, `Owner`/`Pair`, new cards defaulting to Proposed and owned by their creator, a **Kanban Board** tab with WIP limits of 2 on In Progress and In Test, four seed cards, and an Overview Page with a cumulative-flow chart. Choosing a template runs the same import as **Projects → Import**, with the name and identifier you enter.

A template is a version-2 bundle (ADR-0024): what **Export with content** on a project's settings page produces. Drop another `.json` into `templates/` (or point `TEMPLATES_DIR` at a directory) and it appears on New Project; a file that does not parse is skipped. Inside page content, `{{template:today}}` and `{{template:today±N}}` become dates relative to the day the project is created. Only `(current user)` may stand for a user in a template — identity does not travel between installations.

## Metrics

`GET /metrics` answers Prometheus text exposition — request counts by
method and status, request latency histograms, outbox/queue depth by job
status, the oldest pending job's age, enabled schedules, and process
uptime — to a scraper presenting an API key (`Authorization: Bearer <key>`,
or the HMAC scheme); anything else gets `401`. `/healthz` stays
unauthenticated and answers only up/down.

## Public API

Every project, card, property definition, and transition is available
under `/api/v1` as JSON, authenticated by an API key from the profile page
(`Authorization: Bearer <key>`) or an HMAC signature
(`Authorization: Mingle-HMAC-SHA256 <login>:<signature>` with
`X-Mingle-Date`). The wire shapes are the `Api*` types in
`app/shared/wire-types.ts`; each route module under `app/routes/api.v1.*`
documents its resource. Collections answer one page at a time —
`{ items, nextCursor }` — sized by `?limit=` (default 50, max 200) and
continued by sending `nextCursor` back as `?cursor=`; cursors are keyset
cursors, so a walk is neither shifted nor repeated by writes in between
(a deliberate departure from legacy's `page=`). The card list also takes
the card list page's own filter parameters: repeated
`filters[]=[Status][is][Open]` entries or a `filters[mql]=` condition.

## Development

```bash
npm install
npm run dev                      # http://localhost:5173, data in ./data/mingle.db
npm run typecheck                # react-router typegen + tsc
npm test                         # the behavioral suites (seconds)
npm run verify                   # typecheck + behavioral suites + production build
```

`npm run verify` is the standing end-of-phase gate. The build step matters:
`tsc` and Vitest both resolve `.server.ts` modules freely, so a browser
route that imports a server-only value passes both and fails only when
the client bundle is built.

The development stack with a local mail server (Mailpit at
<http://localhost:8025>):

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d
```

Real-path suites drive real infrastructure and are run on demand:

| Command | Needs |
|---|---|
| `npm run test:install` | a Docker daemon — builds the image from source (`compose.build.yaml`), boots an isolated stack, drives it over HTTP, checks the database inside the container, restarts it |
| `npm run test:image` | a Docker daemon and the published image — `docker compose up` with the plain `compose.yaml`, asserting the container runs `ghcr.io/chicagodave/mingle` at the pinned minor, is healthy, and carries the version label |
| `npm run test:realpath` | the above, plus the dev stack up (`/healthz` over TCP, notifications delivered to Mailpit, the API over TCP against a built server) |

Migrations are generated from the schema with `npm run db:generate` and
applied at app start (never by hand).

## Layout

| Directory | Owner |
|---|---|
| `app/domain/<context>/` | bounded contexts — commands, read models, invariants |
| `app/routes/` | HTTP adapters (pages and resource routes) |
| `app/api/`, `app/auth/`, `app/jobs/`, `app/mail/`, `app/integrations/`, `app/files/` | infrastructure adapters |
| `app/shared/wire-types.ts` | every shape that crosses the wire (client and server import it directly) |
| `app/db/schema/` | Drizzle tables; `drizzle/` the generated migrations |
| `test/` | behavioral suites against real SQLite; `*.real.test.ts` against real infrastructure |

Architecture decisions are recorded in `../docs/adrs/`.
