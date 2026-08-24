# Project Profile

**Generated**: 2026-08-21
**Repository**: mingle (github.com/mingle/mingle) — archived ThoughtWorks Agile Project Management product, open-sourced ~2020

## Domains

- **API / Service** — Two Rails MVC applications: `mingle/` (Rails 2.3.18, JRuby 1.7.27) and `mingle-rails5/` (Rails 5.0.1, JRuby 9.1.13.0); classic `app/controllers`, `app/models`, `app/views`.
- **Domain Modeling** — Rich model layer under `mingle/app/models/{card,card_tree,plan,project,deliverable,formula,...}` and `mingle-rails5/app/models/{plan,project,deliverable,user}`; card/tree/formula/plan are the core Mingle domain concepts (cards, card trees, programs/plans, objectives).
- **Data Storage** — ActiveRecord ORM against PostgreSQL and Oracle 11g (dual-DB support), `db/migrate` in both apps, `activerecord-jdbc-adapter` / `activerecord-oracle_enhanced-adapter`, schema-per-tenant multitenancy (`mingle-rails5/app/lib/multitenancy/{tenant,schema,database_schema,schema_selector}.rb`, `mingle/app/models/multitenancy/schema_pool.rb`).
- **Pub/Sub & Messaging** — Custom messaging framework with pluggable adapters: `mingle/lib/messaging/adapters/{jms,sqs}` (JMS and Amazon SQS endpoints) and `mingle-rails5/app/lib/messaging/{base,mailbox,processor,endpoint,multicasting}.rb`; `aws-sdk` gem for S3/SQS.
- **Cloud Infrastructure** — `mingle/.ebextensions/*.config` (AWS Elastic Beanstalk: auto-scaling group, Apache/Tomcat config, CloudFormation-style `Resources:` blocks); `mingle-rails5/app/lib/multitenancy/s3_bucket_manager.rb` for per-tenant S3 storage.
- **Frontend State** — Vuex stores in `mingle-rails5/app/javascript/stores/` (`program_team_store.js`, `objectives.js`, `program_settings_store.js`, `modules/current_user.js`, `modules/toggles.js`) backing the Vue-based "programs/plan" rewrite UI.
- **Frontend UI** — `mingle-rails5/app/javascript/components/*.vue` (Vue 2 + Vuex + vue-select/vuedraggable/vue-tables-2), bundled with Webpacker/webpack 3. The older `mingle/` app is server-rendered ERB/Erubis with Prototype/Scriptaculous-era jQuery-free JS, Sprockets 2 asset pipeline, Compass/Sass.
- **CLI / Tooling** — Rake-driven build/test/install pipeline (`mingle/build.xml` + Ant for JAR assembly, install4j installer generation, yGuard obfuscation); `mingle-rails5` adds Gradle (`settings.gradle`, `gradlew`) for its installer module and a `./go` bootstrap script for JRuby/rbenv setup.

## Tech Stack

- **Language**: Ruby (JRuby-only, two incompatible generations) + plain JavaScript (ES5/ES2015, Vue 2 SFCs, no TypeScript) + some Java (custom JARs under `mingle/development/build_java`, JDBC adapters).
- **Runtime**: `mingle/` → JRuby 1.7.27 (`.ruby-version`), Ruby 1.8 compatibility mode, deployed inside Tomcat 8. `mingle-rails5/` → JRuby 9.1.13.0 (`.ruby-version`). Both are JVM-hosted, not MRI.
- **Framework**: Rails 2.3.18 (`mingle/`) and Rails 5.0.1 (`mingle-rails5/`) — the repo holds two sibling apps of very different Rails vintage that run side by side ("mingle-rails5" is a partial in-place rewrite, not a superseding replacement — see README.adoc: "must be used along with main mingle code base").
- **Data layer**: ActiveRecord (bundled versions matching each Rails generation) against PostgreSQL 9.x or Oracle 11g via JDBC adapters (`activerecord-jdbc-adapter`, `activerecord-jdbcpostgresql-adapter`, `activerecord-oracle_enhanced-adapter`); schema-per-tenant multitenancy; Elasticsearch 6 client (`mingle/lib/elastic_search`, `mingle/lib/aws/elastic_search_client.rb`) for search.
- **Messaging**: Custom `Messaging` module with JMS and Amazon SQS adapters; no off-the-shelf broker client (Kafka/RabbitMQ) used.
- **Test framework**: `mingle/` → Test::Unit via Rails 2.3's `test_help` (`mingle/test/test_helper.rb`), with Mocha 0.9.7 stubbing, `ci_reporter`, and TLB (`tlb-core`/`tlb_patches`) for cross-agent parallelization; JS tests are legacy HTML-runner files (`test/javascript/*_test.html`). `mingle-rails5/` → Minitest via `rails/test_help`, with Shoulda, Mocha (`mocha/mini_test`), WebMock, FactoryGirl, `minitest-reporters` (JUnit/HTML/Spec reporters gated by `GO_ENVIRONMENT_NAME`); JS unit tests are Karma + Mocha + Sinon specs (`test/javascript/**/*.spec.js`).
- **Test command**: `(cd mingle-ts && npx vitest run --exclude test/healthz.real.test.ts)` — the TypeScript rewrite's behavioral suite (real temp-file SQLite, no running app needed). The excluded `test/healthz.real.test.ts` is the rule-13a real-path test; it requires the compose stack up (`cd mingle-ts && docker compose up -d && npm run test:realpath`). Typecheck: `(cd mingle-ts && npm run typecheck)`. The two legacy apps remain unrunnable in this checkout: `mingle/` requires JRuby 1.7.27 plus assets this repo deliberately does not bundle for licensing reasons (Highcharts 2.2.3 JS, Oracle `ojdbc6.jar`) and a live PostgreSQL/Oracle instance before `rake` will even boot the environment; `mingle-rails5/` requires JRuby 9.1.13.0, the same missing Oracle driver, and a separate `bundle install`/`yarn install`. Neither toolchain (JRuby, PhantomJS, Postgres 9.x) is present in this sandbox, and there is no root-level command spanning both apps. When the toolchain is available, the historical per-app commands are `(cd mingle && bundle exec rake test:precommit)` (runs `checkstyle`, `test:units`, `test:functionals`, `test:javascripts`; excludes the Selenium/Gauge-based `test:acceptance`) and `(cd mingle-rails5 && bundle exec rake test)` plus `(cd mingle-rails5 && yarn ci-test)` for the Karma JS suite.
- **Build tool**: `mingle/` → Ant (`build.xml`, `mingle.xml`) for JAR assembly + install4j for installers + yGuard for obfuscation; Sprockets 2 for asset pipeline. `mingle-rails5/` → Webpack 3 via `@rails/webpacker` for JS/Vue bundling, plus Gradle for its installer submodule.
- **Package manager**: Bundler 1.16.1 (both apps, pinned in each `Gemfile.lock`); Yarn (`yarn.lock`) / npm scripts for `mingle-rails5` frontend.
- **CI/CD**: None present in this checkout — no `.github/workflows`, `Jenkinsfile`, or `.gitlab-ci.yml`. Legacy code still references ThoughtWorks' internal "Go" CI/CD product (`GO_AGENT_ID`, `GO_ENVIRONMENT_NAME` env vars in `go`, `test_helper.rb`) and CruiseControl-era rake tasks (`mingle/lib/tasks/cruise.rake`, `cruise_maintain.rake`), but the pipeline definitions themselves were not open-sourced.
- **Monorepo**: No, in the tooled sense (no Lerna/Nx/Turborepo/Yarn workspaces) — but structurally the repo holds two independent, differently-versioned Rails/JRuby applications (`mingle/`, `mingle-rails5/`) that must be run together, each with its own Gemfile, Rakefile, and `.ruby-version`.

## Conventions

- **Test location**: Separate `test/` tree mirroring `app/`, classic Rails layout — `test/unit`, `test/functional`, `test/integration`, `test/acceptance` in `mingle/`; `test/models`, `test/controllers`, `test/integration`, `test/mailers` in `mingle-rails5/`. Never co-located with source.
- **Test naming**: `*_test.rb` (Ruby, both apps); `mingle/test/javascript/*_test.html` (legacy HTML JS-test runners) vs `mingle-rails5/test/javascript/**/*.spec.js` (Karma/Mocha specs) — the two generations use different JS test conventions.
- **Source structure**: Layer-based Rails MVC (`controllers/`, `models/`, `views/`, `helpers/`) with domain sub-namespacing inside `models/` (e.g. `models/card`, `models/plan`, `models/multitenancy`, `models/deliverable`). `mingle-rails5` additionally splits browser code into `app/javascript/{components,stores,services,apps}` (Vue/Vuex feature areas).
- **TypeScript strict mode**: N/A — no TypeScript anywhere in the repo; frontend is plain JavaScript/Vue 2 SFCs.
- **Import style**: Ruby uses Rails classic autoloading (`config.autoload_paths << "#{Rails.root}/lib"`), not Zeitwerk (too old for `mingle`, and `mingle-rails5` is Rails 5 which predates Zeitwerk). JS in `mingle-rails5` uses ES module `import`/`export` in Vue components, bundled by Webpacker; `mingle`'s JS predates ES modules entirely (Sprockets concatenation, global scripts).

## Mutation Signatures

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
- **Mutation calls**: `Messaging::Base`/`Mailbox` `#publish`/`#send_message` on JMS or SQS endpoints (`mingle/lib/messaging/adapters/{jms,sqs}`, `mingle-rails5/app/lib/messaging/{mailbox,endpoint,multicasting}.rb`), and `Processor` classes that consume and act on queued messages.
- **Reporting without mutation**: Code that logs "message sent" or "event published" without actually enqueueing to the JMS/SQS adapter, or a `Processor#on_message` that acknowledges/deletes a message without performing the state change it was queued to trigger.
- **Test assertions — verify**: Tests that inspect the queue/mailbox content (test adapter's in-memory queue, `Messaging::Mailbox` test doubles) for the actual enqueued payload, or that run the processor and assert on the resulting state change (e.g., the record the message was supposed to update).
- **Test assertions — insufficient**: Asserting only that `#publish` didn't raise, or that a mock's `expects(:send_message)` was called, without checking the message payload or the downstream effect of processing it.

### Cloud Infrastructure
- **Mutation calls**: `.ebextensions` container_commands and CloudFormation `Resources:` blocks that provision/scale AWS resources (`AWSEBAutoScalingGroup`), and `Multitenancy::S3BucketManager` operations that create/delete per-tenant S3 buckets or objects.
- **Reporting without mutation**: Deploy scripts or bucket-manager methods that log "provisioned"/"bucket created" without an actual AWS API call (or, in tests, without hitting a fake/stubbed S3 endpoint that records the call).
- **Test assertions — verify**: Tests using a fake S3 (or `webmock`-stubbed AWS endpoint) that assert the specific bucket/object operation was issued with the expected tenant-scoped key/name.
- **Test assertions — insufficient**: Asserting the method returned truthy or didn't raise, without checking which AWS operation (create/delete/put) was actually invoked or with what parameters.

### Frontend State (Vuex)
- **Mutation calls**: Vuex `mutations` (`state.x = ...`) invoked via `commit`, and `actions` that `commit` after an async call, in `mingle-rails5/app/javascript/stores/**` (`program_team_store.js`, `objectives.js`, `modules/current_user.js`, `modules/toggles.js`).
- **Reporting without mutation**: An action that resolves/logs success without calling `commit`, leaving `state` unchanged while the UI assumes it updated.
- **Test assertions — verify**: `test/javascript/stores/*.spec.js` tests that dispatch an action/commit a mutation and then assert on `store.state.<field>` (or the module's returned state) reflecting the new value.
- **Test assertions — insufficient**: Asserting only that the action's promise resolved or that a mocked API client was called, without checking `store.state` afterward.

## Notes

- **This is a dual-generation codebase, not one app.** `mingle/` (Rails 2.3.18 / JRuby 1.7.27) is the original ~15-year-old product; `mingle-rails5/` (Rails 5.0.1 / JRuby 9.1.13.0) is a partial in-place rewrite of specific features (programs/plans, objectives) that runs *alongside* — not instead of — the original app. They have separate `Gemfile`s, separate `.ruby-version`s, and cannot share a Ruby process.
- **Archived project.** README.adoc states "Mingle [Archived]" and "This project is not active any more. Any support email addresses found in the codebase are not valid any more." There is no active CI/CD, and no expectation of further upstream development.
- **Two commercially-licensed assets are deliberately excluded from the repo**: Highcharts 2.2.3 (charting) and Oracle's `ojdbc6.jar` JDBC driver — both must be manually sourced and placed before either app will boot or test successfully. This alone makes the test suites unrunnable out of the box.
- **Pre-Git heritage still visible in the build**: `mingle`'s default Rake task graph invokes `svn:up`/`svn:add`/`svn:st` (Subversion) tasks (`mingle/lib/tasks/application.rake`), a holdover from before this code moved to Git — those tasks will simply fail/no-op in this checkout.
- **JRuby-only, no MRI path**: both apps rely on JDBC database adapters and JVM-hosted Tomcat deployment; there is no supported way to run either app under standard MRI Ruby.
- **Distribution via commercial installer tooling**: `mingle/build.xml` drives install4j (paid) and yGuard bytecode obfuscation to produce the shipped installers; `generate-installers.sh` at the repo root orchestrates building installers for both apps together.
