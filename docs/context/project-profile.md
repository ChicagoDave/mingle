# Project Profile

**Generated**: 2026-08-28
**Repository**: mingle (github.com/mingle/mingle) — archived ThoughtWorks Agile Project Management product, being rewritten from Ruby/Rails to TypeScript. The repo now holds three code trees: `mingle/` and `mingle-rails5/` (the two legacy Ruby generations, kept as the parity reference) and `mingle-ts/` (the active rewrite and primary target of current work).

## Domains

*(mingle-ts/ — active rewrite)*

- **Domain Modeling** — Bounded contexts under `mingle-ts/app/domain/{cards,projects,trees,dependencies,programs,identity,import-export,murmurs,pages,history,subscriptions}`, each with a command/read module split; command kernel (`app/domain/command.server.ts`) and event store (`app/domain/events.server.ts`) shared as cross-context infrastructure ("domain kernel").
- **Event Sourcing** — Append-only `domain_events` table (single writer: `emitEvent` in `app/domain/events.server.ts`), past-tense event names (`CardCreated`, `CardUpdated`, `CardDeleted`, `CardTypeDefined`, etc.) emitted on the same connection as the state change; append-only `card_versions`/history trails (four history trails per ADR-0025 era work: card, tree, dependency, program).
- **API / Service** — React Router (Remix-family) v8 framework routes under `mingle-ts/app/routes/*.tsx`/`*.ts` acting as the HTTP boundary; route loaders/actions call into domain command/read modules — no separate REST/controller layer.
- **Data Storage** — Drizzle ORM (`drizzle-orm`, `drizzle-kit`) against SQLite via `better-sqlite3`; single-file DB (ADR-0002: SQLite over Postgres, "one container, one SQLite volume"); schema modules under `app/db/schema/*.ts` (cards, projects, trees, dependencies, programs, identity, membership, murmurs, pages, properties, subscriptions, transitions, events, favorites, jobs, card-content); migrations under `mingle-ts/drizzle/`.
- **Pub/Sub & Messaging** — Transactional outbox pattern for background work (ADR-0018: "background work is a transactional outbox drained in-process"); email notifications via `nodemailer` (`app/mail/`) delivered through SMTP to Mailpit in dev (`compose.yaml`); history/subscription notification scheduling (`scheduleHistoryNotification`, `app/domain/subscriptions/notify.server.ts`).
- **Frontend UI** — React 19 + React Router v8 (file-route framework mode) components under `app/components/`, `app/routes/`, Tailwind CSS v4 (`@tailwindcss/vite`), TipTap rich-text editor (`@tiptap/react`, `@tiptap/starter-kit`) for wiki/card content, `@dnd-kit/core` for drag-and-drop (tree/backlog reordering).
- **Cloud Infrastructure** — Minimal: a single `Dockerfile` + `compose.yaml`/`docker-compose.yml` (app container + Mailpit container, SQLite on a named volume) — no CDK/Terraform/Beanstalk; deliberately simple per ADR-0002.

*(mingle/, mingle-rails5/ — legacy parity reference, unchanged this pass)*

- **API / Service** — Two Rails MVC applications: `mingle/` (Rails 2.3.18, JRuby 1.7.27) and `mingle-rails5/` (Rails 5.0.1, JRuby 9.1.13.0); classic `app/controllers`, `app/models`, `app/views`. These are the behavioral source of truth the TypeScript rewrite is ported from (ADR-0001: "rewrite in TypeScript, preserving UX").
- **Domain Modeling** — Rich model layer under `mingle/app/models/{card,card_tree,plan,project,deliverable,formula,...}` and `mingle-rails5/app/models/{plan,project,deliverable,user}`.
- **Data Storage** — ActiveRecord ORM against PostgreSQL and Oracle 11g (dual-DB support), schema-per-tenant multitenancy.
- **Pub/Sub & Messaging** — Custom messaging framework with JMS and Amazon SQS adapters (`mingle/lib/messaging/adapters/{jms,sqs}`, `mingle-rails5/app/lib/messaging/*`).
- **Cloud Infrastructure** — `mingle/.ebextensions/*.config` (AWS Elastic Beanstalk); `mingle-rails5/app/lib/multitenancy/s3_bucket_manager.rb`.
- **Frontend State** — Vuex stores in `mingle-rails5/app/javascript/stores/`.
- **Frontend UI** — `mingle-rails5/app/javascript/components/*.vue` (Vue 2); `mingle/` is server-rendered ERB/Erubis.
- **CLI / Tooling** — Rake/Ant build pipeline (`mingle/build.xml`), Gradle for `mingle-rails5`'s installer module.

## Tech Stack

### mingle-ts (primary target)

- **Language**: TypeScript 5.9 (`strict: true` in `tsconfig.json`, `verbatimModuleSyntax: true`).
- **Runtime**: Node.js (ESM — `"type": "module"` in `package.json`).
- **Framework**: React Router v8 (framework/Remix mode: `@react-router/dev`, `@react-router/node`, `@react-router/serve`) + React 19.
- **Data layer**: Drizzle ORM 0.45 + `better-sqlite3` 13; single SQLite file per install (`DATABASE_FILE`); migrations via `drizzle-kit generate`/`drizzle-kit migrate` (`app/db/schema/*.ts`, `drizzle/`).
- **Messaging**: In-process transactional outbox (ADR-0018) for background work; `nodemailer` over SMTP for email (Mailpit in dev, `SMTP_HOST`/`SMTP_PORT` env-configured for prod).
- **Test framework**: Vitest 4 (`vitest.config.ts` — Node environment by default, `@vitest-environment jsdom` opt-in per file for component suites via `@testing-library/react`); mutation testing via Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, `stryker.config.json`, `npm run test:mutation`).
- **Test command**: `cd mingle-ts && npx vitest run --exclude '**/*.real.test.ts'` — the full behavioral suite runs against a real temporary-file SQLite database, no running app or external services needed. The excluded `*.real.test.ts` suites (`test/healthz.real.test.ts`, `test/notifications.real.test.ts`) are the rule-13a real-path tests and require the compose stack up (`cd mingle-ts && docker compose up -d && npm run test:realpath`) — a live dev server plus Mailpit on `:1025`. Typecheck: `cd mingle-ts && npm run typecheck` (runs `react-router typegen && tsc`). The two legacy Ruby apps remain unrunnable in this checkout (missing JRuby toolchains, Highcharts/Oracle JDBC assets excluded for licensing, no live Postgres/Oracle) — see Notes.
- **Build tool**: Vite 8 (via `@react-router/dev`); `react-router build`/`react-router dev` scripts.
- **Package manager**: npm (`package-lock.json`).
- **CI/CD**: None present in this checkout (no `.github/workflows`).
- **Monorepo**: No — `mingle-ts/` is a single npm package; it sits alongside the two independent legacy Ruby apps in the same repo, not under a workspace tool.

### mingle / mingle-rails5 (legacy parity reference)

- **Language**: Ruby (JRuby-only, two incompatible generations) + plain JavaScript (Vue 2 SFCs, no TypeScript) + some Java.
- **Runtime**: `mingle/` → JRuby 1.7.27, Tomcat 8. `mingle-rails5/` → JRuby 9.1.13.0.
- **Framework**: Rails 2.3.18 (`mingle/`) and Rails 5.0.1 (`mingle-rails5/`) — run side by side, not sequentially replacing one another.
- **Data layer**: ActiveRecord against PostgreSQL 9.x or Oracle 11g via JDBC adapters; schema-per-tenant multitenancy; Elasticsearch 6 for search.
- **Test framework**: `mingle/` → Test::Unit + Mocha 0.9.7 + TLB. `mingle-rails5/` → Minitest + Shoulda + Mocha + WebMock + FactoryGirl; JS via Karma + Mocha + Sinon.
- **Test command**: Unrunnable in this checkout — both apps require JRuby toolchains not installed in this sandbox, plus commercially-licensed assets deliberately excluded from the repo (Highcharts 2.2.3, Oracle `ojdbc6.jar`) and a live PostgreSQL/Oracle instance. When the toolchain is available: `(cd mingle && bundle exec rake test:precommit)` and `(cd mingle-rails5 && bundle exec rake test)` plus `(cd mingle-rails5 && yarn ci-test)`.
- **Build tool**: `mingle/` → Ant + install4j + yGuard + Sprockets 2. `mingle-rails5/` → Webpack 3 via Webpacker + Gradle.
- **Package manager**: Bundler 1.16.1 (both apps); Yarn for `mingle-rails5` frontend.
- **CI/CD**: None present in this checkout.
- **Monorepo**: No (tooled sense) — but two independently versioned Rails/JRuby apps live side by side.

## Conventions (mingle-ts)

- **Command/read module split**: each bounded context under `app/domain/<context>/` separates writes from reads into `commands.server.ts` (state-mutating command handlers) and `read.server.ts` (query-only projections); contexts with a richer surface add focused sibling modules (e.g. `cards/properties.server.ts`, `cards/formula.server.ts`, `cards/aggregates.server.ts`, `programs/backlog.server.ts`, `pages/macros*.server.ts`). The `.server.ts` suffix is React Router's server-only module convention — these files never bundle into the client.
- **Transactional command handlers**: command handlers that touch more than one table wrap the mutation in `db.transaction((tx) => { ... })` (Drizzle's transaction API), so partial writes are never observable — e.g. `app/domain/projects/commands.server.ts`, `app/domain/cards/commands.server.ts`. ADR-0019 extends this to in-transaction recomputation of derived/aggregate values on other cards.
- **Command kernel and events**: every command handler returns a `CommandResult<T>` (`app/domain/command.server.ts`: `{ ok: true, value } | { ok: false, errors }`) and, on success, calls `emitEvent` (`app/domain/events.server.ts`) with a past-tense event type on the same connection as the state change — the concrete application of rule 10 (commands imperative, events past-tense, every handler produces an event or explicitly rejects) and rule 8 (module boundaries: one writer per concern).
- **Behavior tests**: the primary test suite is named `test/<feature>.behavior.test.ts` (not co-located with source; all tests live under `mingle-ts/test/`), one file per cross-cutting behavior/feature area rather than per source file (e.g. `cards.behavior.test.ts`, `trees.behavior.test.ts`, `programs.behavior.test.ts`, `mql.behavior.test.ts`). Component tests use the `.test.tsx` extension and opt into jsdom per file. Real-path integration tests are named `*.real.test.ts` and excluded from the default run (rule 13a real-path tests, require the compose stack).
- **Source structure**: domain/feature-based, not layer-based — `app/domain/<bounded-context>/` groups a context's commands, reads, and helpers together; `app/routes/` is a thin HTTP-boundary layer that calls into domain modules; `app/db/schema/` holds Drizzle table definitions (one file per aggregate/table group); `app/shared/wire-types.ts` is the single cross-boundary type file (rule 8b/ADR-0001) with a documented invariant against runtime-specific types.
- **TypeScript strict mode**: Yes — `strict: true` and `verbatimModuleSyntax: true` in `tsconfig.json`; path alias `~/*` → `./app/*`.
- **Import style**: ESM (`"type": "module"`), path aliases via `~/` (tsconfig `paths` + Vite/Vitest `tsconfigPaths` resolution).
- **Documentation standard**: `documentationStandard: "always"` in `.devarch/descriptor.json` — every file in this repo gets a header comment (purpose, public interface, owner context) and every public function a method header, per rule 9. Observed consistently in sampled files (`command.server.ts`, `events.server.ts`, `wire-types.ts`, `cards/commands.server.ts`, `cards/aggregates.server.ts`).
- **ADRs**: `docs/adrs/0001` through `0019` (as of this profile), one topic per file, covering the rewrite decision itself (0001), storage engine choice (0002), authorization checkpoint placement (0003), and a series of domain-semantics pins (property history as snapshots, MQL as a typed AST, transitions as discriminated rows, aggregate recomputation in-transaction, etc.) — this project uses ADRs heavily to pin behavioral parity decisions against the legacy Ruby apps, not just structural/technology choices.

## Mutation Signatures

### Domain Modeling / Event Sourcing (mingle-ts)

- **Mutation calls**: command handler functions in `app/domain/<context>/commands.server.ts` (e.g. `createCard`, `updateCard`, `deleteCard`, `defineCardType`, `createProject`, `moveTreeNode`) that perform Drizzle `insert`/`update`/`delete` against `app/db/schema/*.ts` tables, followed by a call to `emitEvent` recording a past-tense event on the same connection; multi-table handlers wrap the whole thing in `db.transaction((tx) => ...)`.
- **Reporting without mutation**: a command handler that returns `{ ok: true, value }` (or a route action that renders success) without a corresponding Drizzle write reaching the target table, or that performs the write but never calls `emitEvent` — silently breaking the append-only `domain_events`/version-trail invariant (rule 10, ADR-0004's "property history as version snapshots" specifically depends on every mutation appending a version row).
- **Test assertions — verify**: `test/<feature>.behavior.test.ts` suites that call the command handler against a real temp-file SQLite database (via the shared test DB fixture), then re-query the affected table(s) directly (`db.select().from(...)`) and assert on the persisted row's fields — not on the handler's return value alone. For event-sourced flows, tests query `domainEvents`/`cardVersions` rows and assert on the emitted event's `type` and payload.
- **Test assertions — insufficient**: asserting only that the handler returned `{ ok: true }` or that no exception was thrown, without a follow-up query against the actual table; asserting on an in-memory object passed into the handler rather than what Drizzle persisted; checking that a version-trail table has "a new row" without asserting on that row's content.

### API / Service — React Router routes (mingle-ts)

- **Mutation calls**: route `action` functions in `app/routes/*.tsx`/`*.ts` that parse form/request data and delegate to a domain `commands.server.ts` handler; loaders are read-only and must not mutate.
- **Reporting without mutation**: an action that redirects or returns a success response without its delegated command handler's `CommandResult` being `ok: true`, or that ignores a rejected `CommandResult` and reports success anyway.
- **Test assertions — verify**: `test/route-wiring.behavior.test.ts` and feature behavior tests that invoke the route action/loader (via React Router's testing utilities or direct handler import) and assert on both the HTTP-facing response *and* the underlying table state after the call.
- **Test assertions — insufficient**: asserting only on response status/redirect location without checking the domain-layer mutation actually landed.

### Data Storage — Drizzle/SQLite (mingle-ts)

- **Mutation calls**: Drizzle `db.insert(table).values(...)`, `db.update(table).set(...).where(...)`, `db.delete(table).where(...)`, and `db.transaction(...)` blocks against `app/db/schema/*.ts` table definitions; migrations applied via `drizzle-kit migrate` against files in `mingle-ts/drizzle/`.
- **Reporting without mutation**: a migration script or seed routine that logs success without the corresponding `CREATE`/`ALTER`/`INSERT` actually executing against the SQLite file; a command handler that builds a Drizzle query object but never `.execute()`s or awaits it.
- **Test assertions — verify**: tests that open the same (or a fresh temp-file) SQLite database used by the handler under test and run a `select` against the target table, asserting on actual column values — this is the norm across the `*.behavior.test.ts` suite since ADR-0002 makes SQLite-on-disk the only storage engine (no separate "test double" datastore).
- **Test assertions — insufficient**: asserting on a Drizzle query builder object's shape without executing it; asserting on a return value the handler constructed itself rather than re-reading from the database.

### Pub/Sub & Messaging — outbox and notifications (mingle-ts)

- **Mutation calls**: `scheduleHistoryNotification` and other outbox-writing calls in `app/domain/subscriptions/notify.server.ts` that enqueue background work transactionally (ADR-0018); the in-process outbox drain that sends via `nodemailer` (`app/mail/`) over SMTP.
- **Reporting without mutation**: a handler that logs "notification scheduled"/"email sent" without an outbox row being inserted in the same transaction as the triggering state change, or a drain step that marks an outbox entry processed without the SMTP send actually completing (or failing loudly).
- **Test assertions — verify**: `test/notifications.real.test.ts` (rule 13a real-path test) which sends through real SMTP to Mailpit and asserts on the message actually received via Mailpit's HTTP API; behavior-test-level suites that assert on the outbox table row being inserted with the expected payload.
- **Test assertions — insufficient**: asserting only that the scheduling function didn't throw, without checking the outbox table row or (for the real-path suite) the Mailpit inbox.

### Legacy Ruby apps (mingle/, mingle-rails5/ — parity reference, unchanged)

### API / Service
- **Mutation calls**: ActiveRecord `save`/`save!`/`update`/`update_attributes`/`destroy` on models under `app/models`; controller actions named `create`/`update`/`destroy`/`transition` in `app/controllers`.
- **Reporting without mutation**: A controller action or model method that renders a success view/JSON or logs "created"/"updated" without a corresponding `save`/`update`/`destroy` call or persisted record change.
- **Test assertions — verify**: Functional/integration tests that reload the record (`Model.find(id)` or `record.reload`) after the request and assert on the persisted attributes, or assert on `response.body`/`assigns` reflecting the new state.
- **Test assertions — insufficient**: Asserting only `assert_response :success` or that a redirect occurred, with no query against the database for the mutated row.

### Data Storage
- **Mutation calls**: `ActiveRecord::Base` subclasses calling `save`, `update_column(s)`, `delete`, raw `execute` SQL, and multitenancy schema switches (`Multitenancy::Schema`, `SchemaSelector`) that change which tenant schema subsequent writes land in.
- **Reporting without mutation**: A migration or data-fix (`app/models/data_fixes`) that logs "migrated"/"fixed" without executing the corresponding `ALTER`/`UPDATE`, or a tenant operation that swaps schema context but never persists after the switch.
- **Test assertions — verify**: Tests that query the actual table/schema after the call (`ActiveRecord::Base.connection.select_value`, `Model.count`, cross-schema lookups) and assert on real column values, not just the in-memory object.
- **Test assertions — insufficient**: Asserting on an in-memory attribute (`record.name`) without reloading from the DB; asserting a migration "ran" only by checking it didn't raise.

### Pub/Sub & Messaging
- **Mutation calls**: `Messaging::Base`/`Mailbox` `#publish`/`#send_message` on JMS or SQS endpoints, and `Processor` classes that consume and act on queued messages.
- **Reporting without mutation**: Code that logs "message sent" or "event published" without actually enqueueing to the JMS/SQS adapter, or a `Processor#on_message` that acknowledges/deletes a message without performing the state change it was queued to trigger.
- **Test assertions — verify**: Tests that inspect the queue/mailbox content for the actual enqueued payload, or that run the processor and assert on the resulting state change.
- **Test assertions — insufficient**: Asserting only that `#publish` didn't raise, or that a mock's `expects(:send_message)` was called, without checking the message payload or downstream effect.

### Frontend State (Vuex, mingle-rails5)
- **Mutation calls**: Vuex `mutations` (`state.x = ...`) invoked via `commit`, and `actions` that `commit` after an async call, in `mingle-rails5/app/javascript/stores/**`.
- **Reporting without mutation**: An action that resolves/logs success without calling `commit`, leaving `state` unchanged while the UI assumes it updated.
- **Test assertions — verify**: `test/javascript/stores/*.spec.js` tests that dispatch an action/commit a mutation and assert on `store.state.<field>` reflecting the new value.
- **Test assertions — insufficient**: Asserting only that the action's promise resolved or that a mocked API client was called, without checking `store.state` afterward.

## Notes

- **mingle-ts is the active target; the legacy apps are the parity reference, not dead code.** ADR-0001 frames the entire rewrite as "preserving UX" — legacy `mingle/` and `mingle-rails5/` model/controller code is the behavioral specification the TypeScript domain modules are ported from, and ADRs throughout `docs/adrs/` pin specific parity decisions (e.g. ADR-0004 property history, ADR-0007 transitions, ADR-0009 transition-only enforcement) by name-checking legacy classes and methods.
- **Both legacy Ruby apps remain unrunnable in this checkout**: `mingle/` requires JRuby 1.7.27, `mingle-rails5/` requires JRuby 9.1.13.0, both need commercially-licensed assets excluded for licensing (Highcharts 2.2.3, Oracle `ojdbc6.jar`) and a live PostgreSQL/Oracle instance. Neither toolchain is present in this sandbox. This does not affect `mingle-ts/`'s test suite, which is fully self-contained (temp-file SQLite, no external services) except for the two `*.real.test.ts` suites that need the Docker Compose stack.
- **Phase-numbered build-out**: `mingle-ts/` development proceeds in numbered phases (visible in commit history — "Phase 5" card management, "Phase 18" outbox, "Phase 19" in-transaction recomputation, "Phase 22" history notifications, "Phase 23–29" trees/dependencies/programs/import-export most recently) tracked against `docs/work/` plans; ADR numbers and phase numbers are not the same sequence but are frequently cross-referenced in module header comments.
- **Mutation testing is configured but separate from the main gate**: Stryker (`stryker.config.json`, `stryker.vitest.config.ts`, `npm run test:mutation`) exists for deeper mutation-coverage analysis of the TypeScript domain layer; it is not part of the standard `vitest run` test command and is a heavier, separately-invoked check.
- **Archived legacy project**: `mingle/`'s and `mingle-rails5/`'s own README.adoc still states "Mingle [Archived] — This project is not active any more." That framing applies to the legacy Ruby product, not to the `mingle-ts/` rewrite, which is the live, actively developed part of this repository.
