# Mingle

A self-hosted rewrite of ThoughtWorks Mingle in TypeScript: React Router
(framework mode, server-rendered), SQLite via Drizzle, Node 22 — one
container, one data volume (ADR-0001, ADR-0002).

## Install (one command)

Requires Docker with Compose v2.

```bash
git clone <this repository> && cd mingle/mingle-ts
docker compose up -d
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

Sign-in sources (LDAP, OpenID Connect) and API keys are configured inside
the app: **Profile → Authentication settings** (site admins) and
**Profile → API keys**. Project integrations (Slack notifier, GitHub
repositories) are under a project's **Settings → Integrations**.

### Upgrade

```bash
git pull
docker compose up -d --build
```

The new image applies its migrations on start; the volume is untouched.

### Backup and restore

Back up while running — SQLite in WAL mode stays consistent under a copy:

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

## Public API

Every project, card, property definition, and transition is available
under `/api/v1` as JSON, authenticated by an API key from the profile page
(`Authorization: Bearer <key>`) or an HMAC signature
(`Authorization: Mingle-HMAC-SHA256 <login>:<signature>` with
`X-Mingle-Date`). The wire shapes are the `Api*` types in
`app/shared/wire-types.ts`; each route module under `app/routes/api.v1.*`
documents its resource.

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
| `npm run test:install` | a Docker daemon — builds the image, boots an isolated stack, drives it over HTTP, checks the database inside the container, restarts it |
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
