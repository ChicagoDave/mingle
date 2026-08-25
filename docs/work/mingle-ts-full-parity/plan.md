# Session Plan: Full feature-parity rewrite of Mingle in TypeScript (mingle-ts)

**Created**: 2026-08-21
**Plan Status**: ACTIVE
**Overall scope**: Rebuild the complete original Mingle product (`mingle/`, plus the programs/plans/objectives features from `mingle-rails5/`) as `mingle-ts/` — React Router (framework mode, SSR; v8 as scaffolded), SQLite + Drizzle (ADR-0002 — superseded the original Postgres + pg-boss choice on 2026-08-24; background jobs become a SQLite-backed jobs table with an in-process worker), Node 22 — with no feature area deferred indefinitely. Single-tenant (the on-prem edition is the parity target, not SaaS multitenancy). Feature inventory verified against `mingle/app/controllers`, `mingle/app/models`, `mingle/config/routes.rb`, `mingle/help/topics`, and `mingle-rails5/app/{controllers,models}`.
**Bounded contexts touched**: Card Management (Project, Card, CardType, PropertyDefinition, CardVersion), Identity & Access (User, Team, Group, Role, Auth), Workflow (Transition, TransitionWorkflow), Query (MQL), Wiki & Content (Page, Macro), Charting/Reporting, Collaboration (Murmur, HistoryFeed, Notification), Card Trees (TreeConfiguration, TreeRelationshipProperty, AggregateProperty), Cross-Project Dependencies, Program Management (Program, Plan, Objective, Backlog — kept as its own context, mirroring `mingle-rails5`'s original separation from core Card Management rather than merging it), Import/Export, Public API, External Integrations.
**Key domain language**: Project, Card, CardType, PropertyDefinition (Text | Number | Date | User | Enumerated | Formula | Aggregate), CardVersion, Transition, Murmur, Page, CardTree, TreeRelationshipProperty, Dependency, Program, Plan, Objective, MQL (Mingle Query Language), Macro.

## References consulted
- `docs/adrs/0001-rewrite-in-typescript-preserving-ux.md` — binds the stack (React Router 7 framework/SSR, React, Postgres + Drizzle, Node 22, pg-boss, dnd-kit for card-wall drag-drop, TipTap for rich text), pins new code to `mingle-ts/` with `mingle/` and `mingle-rails5/` strictly read-only, requires UX harvested from `mingle/app/views` and `mingle/public` CSS (not the legacy JS), requires wire types shared via direct import from the first slice onward (rule 8b), requires the schema not foreclose card versioning/history, and records the roadmap strategy explicitly as vertical slices ordered projects → cards → properties → card wall/grid → transitions → murmurs — this plan follows that same dependency order and extends it through every remaining legacy feature area instead of stopping at murmurs.
- `docs/context/project-profile.md` — confirms `mingle/` and `mingle-rails5/` are legacy Rails/JRuby codebases with no TypeScript precedent to inherit (mingle-ts establishes its own conventions from scratch); the legacy `card_versions` table (`mingle/db/migrate/041_early_access.rb`) is the domain precedent for versioning; and `mingle-rails5` is confirmed as a *separate, partial* rewrite of programs/plans/objectives that ran alongside (not instead of) the original app — this plan preserves that context boundary rather than folding Program Management into Card Management.

## Phases

## Milestone 1: Foundation

### Phase 1: Project scaffold and dev toolchain
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: N/A — infrastructure/tooling, no domain concepts introduced.
- **Entry state**: `mingle-ts/` does not exist; `mingle/` and `mingle-rails5/` remain untouched read-only reference material.
- **Deliverable**: `mingle-ts/` React Router 7 (framework mode, SSR) skeleton on Node 22 LTS, TypeScript strict; Drizzle ORM wired to Postgres; `pg-boss` installed; one shared wire-types module (e.g. `mingle-ts/app/shared/wire-types.ts`) as the single client/server import point per rule 8b, with no runtime-specific types in it; `docker-compose.yml` with an `app` and a `db` (Postgres) service for local dev; a `/healthz` route that opens a real connection to `db`.
- **Exit state**: `docker compose up` boots both services; a real-path test (rule 13a — this phase's name and content are database/docker-shaped) hits `/healthz` against the live `db` container and asserts a real round-trip, not a stub.
- **Status**: DONE (2026-08-24) — exit criteria met: compose stack boots (db healthy → app), real-path test passed 1/1 against live Postgres, degraded path (503 on db stop, 200 on recovery) verified. Note: scaffold landed on React Router v8 (current major of the framework-mode architecture ADR-0001 named as v7); Node 22 pinned in the Dockerfile, local dev runs Node 24. **Reworked same day under ADR-0002**: Postgres/pg-boss replaced by SQLite (better-sqlite3, WAL, startup migrations); compose collapsed to a single `app` service with a `/data` volume; healthz and the real-path test re-verified against the file-backed database (HTTP 200 / 1 passed).

### Phase 2: Identity & Access — users, authentication, profile
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Identity & Access context — `User` aggregate, session/login, profile settings. Basic username/password auth only; SSO, LDAP, OAuth gadgets, and HMAC auth are their own later phase (Phase 31), not dropped.
- **Entry state**: Phase 1 scaffold boots against real Postgres.
- **Deliverable**: `users` schema + migrations; login/logout routes and session handling (cookie-based, server-verified against a hashed password column — mirroring `login_access.rb`/`password_encryption.rb`'s intent, not their code); a profile settings route (display name, email, password change); domain events `UserRegistered`, `UserLoggedIn`, `UserProfileUpdated`, `PasswordChanged`.
- **Exit state**: a behavioral test suite (rule 12/13) registers a user, logs in, changes profile fields, and reloads the DB to assert the persisted row — plus a rejection test for a bad password. No project or card concepts required yet.
- **Status**: DONE (2026-08-24) — 23 behavioral tests passing against a real file-backed SQLite database (register/login/profile/password, all DOES lines asserted on reloaded rows, all REJECTS WHEN lines covered including the mutation-verification agent's three flagged gaps); first-user-is-admin install parity; domain_events table established (UserRegistered/UserLoggedIn/UserProfileUpdated/PasswordChanged); cookie sessions with a zero-config persistent secret beside the DB file; end-to-end register→profile verified over HTTP against the rebuilt container (which also proved startup migrations in the image — a missing drizzle/ folder in the runtime stage was caught and fixed to fail loudly). Built on SQLite per ADR-0002.

## Milestone 2: Projects & Team

### Phase 3: Project lifecycle and project variables
- **Tier**: Medium
- **Budget**: 200
- **Domain focus**: Card Management context — `Project` aggregate, `ProjectVariable` value object.
- **Entry state**: Phase 2 auth exists; an authenticated user can act.
- **Deliverable**: `projects` and `project_variables` schema/migrations; create/configure/settings routes for a project (name, identifier, description); command handlers `CreateProject`, `UpdateProjectSettings`, `DefineProjectVariable` each producing `ProjectCreated`/`ProjectSettingsUpdated`/`ProjectVariableDefined` or rejecting.
- **Exit state**: a logged-in user creates a project, edits its settings, and defines a project variable; tests assert on the persisted `projects`/`project_variables` rows.
- **Status**: DONE (2026-08-24) — 37 behavioral tests passing against a real file-backed SQLite database with the real `drizzle/0001` migration (all DOES lines asserted on reloaded rows; all REJECTS WHEN lines covered, including the mutation-verification agent's flagged update-path gaps). Legacy parity harvested from `project.rb`/`identifiable.rb`/`project_variable.rb`: identifier format + generation-from-name, case-insensitive name uniqueness, reserved variable names, per-type value validation (User values checked against `users` until Phase 4 team membership exists). `CommandResult` lifted to a shared domain kernel (`app/domain/command.server.ts`) so Card Management doesn't import Identity & Access. End-to-end HTTP walk (scripted, not yet a standing test) against the rebuilt container verified create → settings → variable plus the `ProjectCreated`/`ProjectSettingsUpdated`/`ProjectVariableDefined` event trail in the container's database.

### Phase 4: Team membership, groups, and permissions
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Identity & Access context — `TeamMembership`, `Group`, `Role` (admin | project admin | team member | readonly member), scoped per `Project`.
- **Entry state**: Phase 3 projects exist; Phase 2 users exist.
- **Deliverable**: `team_memberships`, `groups`, `group_memberships` schema; routes to add/remove team members, assign roles, and manage groups per project; every subsequent mutating route in later phases must check the acting user's role for that project (the authorization checkpoint established here is reused, not re-invented, by every later phase).
- **Exit state**: a project admin adds a member with a role, a readonly member's attempt to mutate a project setting is rejected with a specific authorization error (rule 13 rejection test), and group membership is queryable from the DB.
- **Status**: DONE (2026-08-24) — 44 behavioral tests passing against a real file-backed SQLite database with the real `drizzle/0002` migration (112/112 suite-wide; every REJECTS WHEN tested independently per handler, including a readonly/full-member/non-member authorization sweep — the Phase 2/3 recurrence checklist applied up front). Legacy parity harvested from `membership_role.rb`/`member_role.rb`/`group.rb`/`user_membership.rb`/`privilege_level.rb`: three project roles + site-admin trump, privilege ladder ranks, group name rules (CI-unique per project, no commas), remove-member group cleanup, and the "Cannot remove yourself from team." guard. The authorization checkpoint (`app/domain/identity/authorization.server.ts`) lives in the domain layer and was retrofitted into the Phase 3 commands at legacy privilege levels (create = Mingle admin; settings/variables = project admin); `UserType` variable values tightened to team membership as Phase 3 deferred. End-to-end HTTP walk (scripted, not yet a standing test) against a container rebuilt from a wiped volume verified migrations apply at startup, a non-site-admin project admin managing team/groups over HTTP, the readonly member's specific authorization error rendering, and the full membership event trail in the container's database. mutation-verification: clean, no findings.

## Milestone 3: Cards Core & Versioning

### Phase 5: Card aggregate, card types, and versioned history
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Card Management context — `Card` aggregate, `CardType`, `CardVersion` (append-only history, modeled on the legacy `card_versions` table — current-state row plus a never-overwritten version trail).
- **Entry state**: Phase 3 projects and Phase 4 permission checks exist.
- **Deliverable**: `card_types`, `cards`, `card_versions` schema/migrations; `CreateCard`, `UpdateCard`, `DeleteCard` command handlers, each producing `CardCreated`/`CardUpdated`/`CardDeleted` and a new `card_versions` row; basic card CRUD routes (no properties yet beyond name/description/type).
- **Exit state — REAL-PATH TEST (rule 13a, "versioning"/"database" shaped)**: create then update a card twice; query the DB directly and assert both the current `cards` row and three ordered `card_versions` rows exist with the correct diffs. No test may assert only on return values.
- **Status**: DONE (2026-08-24) — 31 behavioral tests passing against a real file-backed SQLite database with the real `drizzle/0003` migration (143/143 suite-wide), including the exit-criterion real-path test verbatim: create + update twice → current row and three ordered `card_versions` rows with correct per-version diffs, read from the DB. Legacy parity harvested from `card.rb`/`card_type.rb`/`acts_as_versioned_ext.rb`/`project.rb`: per-project never-reused card numbers (computed over cards ∪ card_versions, no sequence table), versions kept on destroy with an appended deletion version (description null, deleting user stamped — `create_card_deletion_version` parity), default "Card" type on project creation, card create/update = FULL_TEAM_MEMBER and delete/type-admin = PROJECT_ADMIN via the ADR-0003 checkpoint. Modernization: `cards.card_type_id` FK + `card_versions.card_type_name` text snapshot (legacy stored the name string on both). Routes: card list/new/show-edit-delete with version history, card-type management on settings. End-to-end HTTP walk against a wiped-volume container verified migrations 0000–0003 at startup, the full version trail (including deletion version and number reservation), both authorization rejections rendering, and the exact Card* event sequence. mutation-verification: clean, no findings.

### Phase 6: Attachments and checklists
- **Tier**: Medium
- **Budget**: 200
- **Domain focus**: Card Management context — `Attachment`, `CardChecklistItem`, both owned by `Card`.
- **Entry state**: Phase 5 cards exist.
- **Deliverable**: file upload storage (local filesystem volume for now — S3/tenant storage is out of scope for single-tenant parity) with `attachments` schema linked to a card and card version; `card_checklist_items` schema and CRUD.
- **Exit state**: a card gains an attachment and a checklist item; tests assert the persisted rows and that the attachment is retrievable by its stored path/key.
- **Status**: DONE (2026-08-24) — 31 behavioral tests passing (174/174 suite-wide) against a real SQLite database with the real `drizzle/0004` migration and a real temp-dir filesystem store: the exit criterion reads attachment bytes back by stored key. Legacy parity harvested from `attachment.rb`/`attachment_name_uniqueness.rb`/`checklist_item.rb`/`card_checklist_item.rb`: per-attachment random storage directory, project-unique display names via short random suffix (`.tar.gz` one extension), checklist text ≤255, completed/incomplete position lists with move-to-end on mark. Storage adapter (`app/files/attachment-storage.server.ts`) keeps `node:fs` out of the domain; routes orchestrate save-bytes→command→cleanup-on-reject. `deleteCard` extended to cascade checklist/attachment rows (legacy dependent-destroy); attaching records the card's version but does not bump it (legacy attach-creates-a-version deferred to history phases). Container walk from wiped volume: real multipart upload, byte-identical download, suffixed duplicate, checklist rows, bytes confirmed on /data volume. mutation-verification: one warning (`deleteAttachmentFile` untested) closed same-session with 3 storage-adapter tests before this phase was marked DONE.

## Milestone 4: Properties

### Phase 7: Managed properties — text, number, date, user, enumerated
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Card Management context — `PropertyDefinition` (Text | Number | Date | User | Enumerated variants), `PropertyValue`.
- **Entry state**: Phase 5 cards and card types exist.
- **Deliverable**: `property_definitions` (with a `kind` discriminator) and `card_property_values` schema; `DefinePropertyDefinition`, `SetCardPropertyValue` command handlers; every property mutation on a card produces a `card_versions` row (reusing Phase 5's versioning, not a parallel mechanism).
- **Exit state**: a card carries one property of each of the five kinds; an invalid enum value or a non-numeric value for a Number property is rejected (rule 13 rejection test) rather than silently coerced.
- **Status**: DONE (2026-08-24) — 26 behavioral tests passing (200/200 suite-wide) against a real file-backed SQLite database with the real `drizzle/0005` migration, including both exit-criterion rejection tests (non-numeric Number, out-of-list enum — never coerced) and the exit-criterion card carrying one property of each of the five kinds, asserted on reloaded rows. Legacy parity harvested from `property_definition.rb`/`property_type.rb`/`enumeration_value.rb`/`user_property_definition.rb`/`predefined_property_definitions.rb`: name rules (≤40 chars, forbidden `[]"&=#;`, not `_`, reserved predefined names, CI-unique), enumeration values CI-unique/ordered/no-parens-wrap, per-kind canonicalization (enum stored in defined casing, numbers compared numerically for no-op detection, users validated as team members), define = PROJECT_ADMIN / set = FULL_TEAM_MEMBER via the ADR-0003 checkpoint. Versioning reuses Phase 5's mechanism: every property mutation appends a `card_versions` row; the new `card_versions.property_values` column snapshots all values as JSON keyed by property definition ID (ADR-0004 — rename-immutable; readers join for the current name, matching legacy's rewrite-history-to-current-name behavior); `updateCard` snapshots current values, `deleteCard` cascades `card_property_values`. Container walk from wiped volume: five kinds defined and set over HTTP, cumulative snapshots v1→v6, canonicalization, both exit-criterion rejections and both authorization rejections rendered, `PropertyDefinitionDefined`/`CardPropertyValueSet` event trail verified in-container. mutation-verification: clean, no findings.

### Phase 8: Formula properties
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Card Management context — `FormulaPropertyDefinition`, a formula parser/evaluator over other numeric/date properties on the same card.
- **Entry state**: Phase 7 managed properties exist.
- **Deliverable**: a formula expression parser (arithmetic over property references, matching the legacy `formula.rb`/`formula_property_definition.rb` grammar) and an evaluator that recomputes a formula property's value whenever an input property changes.
- **Exit state — REAL-PATH TEST (rule 13a, "engine"-shaped)**: changing an input property on a real persisted card causes the formula property's stored value to be recomputed and persisted correctly on the next read; a malformed formula definition is rejected at definition time, not at evaluation time.
- **Status**: DONE (2026-08-24) — 17 behavioral tests passing (217/217 suite-wide) against a real file-backed SQLite database with the real `drizzle/0006` migration, including the exit-criterion real-path test (change a persisted card's input → the formula's materialized `card_property_values` row and the version snapshot both carry the recomputed value, read from the DB) and definition-time rejection of malformed/ill-typed formulas. Engine (`app/domain/cards/formula.server.ts`, pure — no DB imports) implements the legacy `formula_properties.grammar` surface: + - * / with unary minus, ()/{}/[] grouping, bare/quoted identifiers with doubled-quote escaping; type rules per Formula::*/ValidFormulaVisitor (number⊕number, date±number, date−date→days; date+date, number−date, date in *//, −date all rejected at definition time); formula-in-formula rejected (making circular references impossible this phase); division by zero → unset; `null_is_zero` flag; numbers at legacy default precision 2, dates ISO. Values materialize into `card_property_values` and recompute inside setCardPropertyValue's transaction before the snapshot (one user action = one version carrying fresh derived values — legacy same-save parity); defining a formula backfills all existing cards without version churn; direct sets of formula properties rejected. Formulas reference properties by NAME (legacy parity) — a future rename command must rewrite formula texts (noted in schema header; complements ADR-0004's id-keyed snapshots). mutation-verification: one warning (multi-card backfill fan-out untested) closed same-session with a three-card backfill test before this phase was marked DONE. Container walk from wiped volume: formulas defined over HTTP, backfill over a pre-existing card, input change → card page renders recomputed number and date values, malformed and ill-typed definitions rejected, direct set rejected, division-by-zero row deletion and same-version snapshot recompute verified in-container.

## Milestone 5: Card Views

### Phase 9: List view and filters
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Card Management context — presentation of `Card`/`PropertyDefinition`, plus a `CardListView`/filter value object (property-equality and range filters only — MQL-backed filtering is Phase 13).
- **Entry state**: Phase 7 properties (and optionally Phase 8 formulas) exist.
- **Deliverable**: a card list route with column selection and simple property filters, harvested layout/CSS from `mingle/app/views/cards` (`_card_list_results.rhtml`, `_card_list_action_panel.rhtml`) and `mingle/public`.
- **Exit state**: filtering the list by one or more property values returns exactly the matching cards, verified against seeded DB rows, and the layout visibly matches its legacy counterpart.
- **Status**: DONE (2026-08-24) — 25 behavioral tests passing (242/242 suite-wide) against a real file-backed SQLite database, `tsc` clean; no schema change this phase. New read model `app/domain/cards/list-view.server.ts` (CardListView): decodes the legacy `filters[]` encoded form (`[Property][operator][value]`, filters.rb ENCODED_FORM incl. `=`/`!=`/`<`/`>` and "is before"/"is after" aliases), validates against the project's definitions and the legacy per-kind operator vocabulary (operator.rb/available_operators: equality only for text/user/Type; + ordinals for number, date, enumerated, formula), and compiles to SQL EXISTS conditions with legacy semantics — numeric CAST comparison for numbers and number-valued formulas, ISO-lexical for dates, defined-position order for enumerated (proven against lexical-order traps), `is (not set)` = no value row, `is not X` matches unset cards, ordinals reject (not set), Type pseudo-property backed by card_type_id. Combination per filters.rb FilterGroup#as_query: same-property equality filters OR, equality-half OR collective-half within a group, collective AND within, groups AND across properties. Filter operator vocabulary added to wire-types (rule 8b). Route rewritten with legacy-harvested layout (`_card_list_results.rhtml` markup classes: #content, table.edit-table.sortable_table#cards, .cards-header with view_controls + card_count, tr.table-column-header, td.number/.card-name; `_column_selector.rhtml` Add / remove columns; filter tab "Show cards where:"), CSS harvested from base.scss/cards.scss into `app/styles/card-list.css`; no-JS filter and column-selector forms canonicalize via 302 into the legacy URL shape. Validation errors render in legacy phrasing and block the result list (never show unfiltered data as if filtered). HTTP walk (`phase9-walk.sh`, scratchpad, not a standing test) against a fresh-DB dev server: 38/38 — seeded over real routes, all filter/combination/error/column assertions plus legacy markup structure, and both form-canonicalization redirects verified. mutation-verification not run: rule 15's side-effect signals absent (pure read model + loader; no state-changing function touched). Deferred: sorting by column headers, pagination, tags/bulk-ops panels (later phases per plan).

### Phase 10: Card wall / grid view with drag-drop
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Card Management context — grid/"card wall" presentation grouped by a property (lane), with `dnd-kit` driving drag-drop that issues a `SetCardPropertyValue` command on drop.
- **Entry state**: Phase 9 list view and Phase 7 properties exist.
- **Deliverable**: grid view harvested from `mingle/app/views/cards` (`_card_grid_results.rhtml`, `_card_grid_action_panel.rhtml`, `lanes_controller.rb`'s lane semantics) with dnd-kit-powered drag between lanes.
- **Exit state**: dragging a card to a new lane persists the new property value (real DB assertion, not just UI state) and produces a `card_versions` row per Phase 5's versioning.
- **Status**: DONE (2026-08-24) — 11 behavioral tests passing (253/253 suite-wide), `tsc` clean; no schema change. New read model `app/domain/cards/grid-view.server.ts` (CardGridView): lanes over a finite-valued group-by property — enumerated (defined position order) or user (team members by name) — with a "(not set)" lane first, ungrouped wall as one lane, filters reused verbatim from Phase 9's list-view read model (`filters[]` accepted on the grid route), non-groupable kinds and unknown properties rejected. New route `projects/:identifier/cards/grid` with @dnd-kit/core (installed this phase per ADR-0001): draggable `.card-icon` mini-cards, droppable lane cells, onDragEnd posts intent=drop → SetCardPropertyValue (Phase 7 command unchanged — value set/cleared + version row in its one transaction; same-lane drops swallowed as quiet success via the command's no-change rejection). Exit criterion verified twice: behavioral tests assert the reloaded `card_property_values` row AND the new `card_versions` id-keyed snapshot after a drop (plus clear-on-(not set), invalid-lane and readonly-member rejections with zero state change); HTTP walk (`phase10-walk.sh`, scratchpad) 18/18 — the exact drop request over the wire, persistence re-read through the wall/card page/version count, 400 on invalid lane. Markup/CSS harvested from `_card_grid_results.rhtml`/`_group_lanes.rhtml`/`_card_div.rhtml`/`grid_view.scss` (#content-simple.grid-results, table#swimming-pool, th.lane_header #FAFAFA, td.cell #f3f3f3 with 5px white borders, golden-ratio white card-icon with gradient strip) into `app/styles/card-grid.css`; List↔Grid links carry filters across views. Rule 13a statement produced: no stubs; noted gap — the browser pointer gesture itself (pointer-down → dnd-kit onDragEnd) is not automated, the walk enters at the exact request onDragEnd submits. Deferred: grouping by card Type (needs type-change drops via UpdateCard), lane hide/show/reorder/rename and WIP limits (lanes_controller features), 2-D row×lane grids, color-by, aggregates other than count, the grid filter panel UI (Phase 13 adds advanced filters to both views). mutation-verification not run: rule 15's function-name signal absent in the changed files (read model + route adapter; the mutating command was not modified).

### Phase 11: Favorites, tabs, and saved views
- **Tier**: Medium
- **Budget**: 200
- **Domain focus**: Card Management context — `Favorite` (saved card view or page), `Tab`.
- **Entry state**: Phase 9/10 views exist.
- **Deliverable**: `favorites` schema and routes to save the current list/grid configuration as a favorite and promote a favorite to a project tab.
- **Exit state**: saving a favorite and reopening it reproduces the same filter/grouping state, verified by reloading from the persisted favorite row.
- **Status**: DONE (2026-08-25) — 28 behavioral tests passing (281/281 suite-wide), `tsc` clean. New `favorites` table (migration 0007) collapsing the legacy `Favorite` + `CardListView` pair into one row: team (`user_id` NULL) or personal scope, `tab_view`, `style` list|grid, stored legacy-wire params (`filters` JSON of encoded `filters[]`, `columns` JSON, `group_by`), `kind` discriminator reserved for page favorites; two partial unique indexes (team / per-user, case-insensitive name) because drizzle-kit mangles comma-bearing expression indexes. New `app/domain/cards/favorites.server.ts`: SaveFavorite (create-or-replace by same-scope name; params validated through the Phase 9/10 read models before storing, so a favorite never reopens to a filter error), MakeFavoriteTab / RemoveFavoriteTab (project admin, team favorites only), DeleteFavorite (owner for personal, full member for team, admin for tabs) — legacy favorites_controller/cards#create_view privilege ladder; events FavoriteSaved / FavoritePromotedToTab / FavoriteDemotedFromTab / FavoriteDeleted. New routes `projects/:identifier/favorites` (legacy favorites/list.rhtml manage page + intents save/make-tab/remove-tab/delete) and `projects/:identifier/favorites/:favoriteId` (legacy favorites#show redirect); list route honors legacy `?view=<name>`; list and grid pages carry the legacy tab bar (`#hd-nav ul.sortable-tabs`, All + tabs, current highlighted) and favorites sidebar (`#favorites-container`: team, mine, save-current-view form) via shared `app/components/favorites.tsx`; `CARD_VIEW_STYLES` and `FavoriteSummary` added to wire-types (rule 8b). Exit criterion verified twice: tests rebuild list filters/columns and grid lanes from the reloaded row (identical to the live view; canonical reopen URL asserted), and HTTP walk (`phase11-walk.sh`, scratchpad) 33/33 — exact panel post, redirect into the saved view, reopen, tab promotion visible in the tab bar, demote/delete, 404s. mutation-verification ran: one test gap (unknown-project rejection on tab/delete commands) closed in-session. Deferred: favorite rename (legacy favorites#rename), tab reordering (`ordered_tab_identifiers`), tab renaming, personal-favorite "update saved view" shortcut, page favorites (Wiki phase).

## Milestone 6: MQL (Mingle Query Language)

### Phase 12: MQL parser
- **Tier**: Large
- **Budget**: 350
- **Domain focus**: Query context — an MQL grammar (`SELECT ... WHERE ...`-style card queries) producing an AST, matching the legacy `card_query.rb`/`mql_support.rb` surface.
- **Entry state**: Phase 7 properties exist (MQL queries reference property names).
- **Deliverable**: a parser producing a typed AST from an MQL string, with validation against a project's actual property definitions (unknown property names rejected at parse time).
- **Exit state**: a corpus of representative MQL strings (harvested from `mingle/help/topics` MQL-related pages and legacy test fixtures) parses to the expected AST shape; malformed queries produce a specific parse error, not a silent empty result.
- **Status**: DONE (2026-08-25) — 45 behavioral tests passing (326/326 suite-wide), `tsc` clean; no schema change. New pure module `app/domain/cards/mql.server.ts` (`parseMql`): legacy-faithful lexer (case-insensitive keywords, IS/IS NOT/NOT = aliases, bare/quoted/backslash-escaped identifiers, plus mql.grammar's bare date literal), recursive-descent parser over the full `card_query.grammar` surface (SELECT [DISTINCT]/aggregates/AS OF/FROM TREE/WHERE/GROUP BY/ORDER BY, bare conditions, AND>OR precedence with NOT tightest, NULL/TODAY/CURRENT USER/THIS CARD[.prop]/PROPERTY/NUMBER n/(plv), IN lists, NUMBERS IN, nested IN (SELECT …), TAGGED WITH, IN PLAN), and a resolver producing a typed `MqlQuery` whose columns carry `PropertyRef` (definition id + kind, or predefined key for Type/Name/Number/Created On/Modified On/Project — the last SELECT-only) and whose literals carry a canonical stored form (enumeration casing, user id, card-type casing, numeric, ISO date). Errors collected in source order with legacy wording (`Card property 'X' does not exist!`, quoted-TODAY/CURRENT USER hints, relationship-only NUMBER/THIS CARD clauses); constructs without a backing model yet (trees, tags, plans, NUMBERS IN) parse into the AST and are rejected by name. `mql-schema.server.ts` (`loadMqlSchema`, `parseProjectMql`) is the Drizzle adapter. Tests run resolution against real definitions created through domain commands into a migrated SQLite file. mutation-verification not run: rule 15's side-effect signals absent (pure parser + read-only loader). Deferred to Phase 13: evaluation, `THIS CARD` context binding, MQL string re-generation (legacy MqlGeneration) for property/value renames.

### Phase 13: MQL evaluator wired into filters and views
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Query context — evaluating an MQL AST against real `cards`/`card_property_values` rows (translated to a Drizzle query, not a hand-rolled in-memory filter, so it stays correct as the schema grows).
- **Entry state**: Phase 12 parser exists.
- **Deliverable**: an "advanced filter" option on the Phase 9 list view and Phase 10 grid view that accepts raw MQL instead of the simple filter builder.
- **Exit state — REAL-PATH TEST (rule 13a, "database"-shaped evaluation)**: an MQL query executed against a real seeded set of cards returns exactly the expected subset, verified by row-level DB comparison, not by mocking the query layer.
- **Status**: DONE (2026-08-25) — 22 behavioral tests passing (348/348 suite-wide), `tsc` clean; migration 0008 adds `favorites.mql` (single ALTER, SQL verified). New read model `app/domain/cards/mql-evaluator.server.ts` (`mqlCondition`, `queryCardsByMql`, `conditionUsesThisCard`): translates the ADR-0006 AST to one Drizzle SQL predicate — EXISTS/NOT EXISTS over `card_property_values` with the Phase 9 unset semantics (`!=` matches unset, `= NULL` = no row), REAL casts for numbers/number formulas, ISO text for dates, defined-position ranking for enumeration ordinals, Type via `card_types`, Created/Modified On as UTC dates, `IN (SELECT …)` as a correlated sub-select over an aliased `cards`, CURRENT USER/TODAY bound from an explicit `MqlEvaluationContext`, unset project variables as NULL. `property-compare.server.ts` extracted from list-view so both read models share `comparisonKind` without a cycle. Advanced filter wired as legacy `filters[mql]` (MqlFilters#to_params) on list and grid — replaces simple filters when present, conditions-only (SELECT/GROUP BY/ORDER BY/AS OF rejected with legacy-style message, THIS CARD refused), textarea panel harvested from `_mql_filter_tab.rhtml` wording, `apply-mql` canonicalization redirect; favorites store and reopen MQL views (`saveFavorite` validates via the read models). REAL-PATH suite `test/mql-filter.behavior.test.ts`: six cards seeded via domain commands into a migrated SQLite file, every query compared by card number to the hand-computed subset; agreement test with the simple filters; HTTP walk (`phase13-walk.sh`, scratchpad, not a standing test) 24/24 on a fresh-DB dev server. mutation-verification: clean (saveFavorite mql path asserted on persisted rows). Deferred: SELECT-column projection/GROUP BY/AS OF evaluation (chart and history phases), THIS CARD context binding (card descriptions/defaults), MQL text re-generation on rename.

## Milestone 7: Transitions & Workflow

### Phase 14: Transitions engine
- **Tier**: Large
- **Budget**: 350
- **Domain focus**: Workflow context — `Transition` (requirements + actions), `TransitionExecution` command producing `TransitionExecuted` or a specific rejection when requirements aren't met.
- **Entry state**: Phase 7 properties and Phase 4 permissions exist (transitions can restrict who may execute them).
- **Deliverable**: `transitions` schema (requirement/action pairs referencing property definitions) and a single-card transition execution route.
- **Exit state — REAL-PATH TEST (rule 13a, "engine"-shaped)**: executing a transition against a real card whose properties satisfy its requirements persists the action's property changes and a `card_versions` row; executing it against a card that fails a requirement is rejected with the specific unmet requirement named, and no state changes.
- **Status**: PENDING

### Phase 15: Bulk transitions and transition workflows
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Workflow context — bulk execution of a `Transition` across a card selection, and `TransitionWorkflow` (auto-transitions triggered by a property change rather than a user action).
- **Entry state**: Phase 14 transitions exist.
- **Deliverable**: a bulk-transition route operating on a Phase 9 list-view selection; an auto-transition rule that fires a transition automatically when its trigger condition is met.
- **Exit state**: bulk-transitioning 3+ selected cards updates all of them atomically (all-or-none on a shared requirement failure) and an auto-transition fires without user action when its condition becomes true, both verified against persisted rows.
- **Status**: PENDING

## Milestone 8: Wiki & Macros

### Phase 16: Wiki pages and rich editing
- **Tier**: Large
- **Budget**: 350
- **Domain focus**: Wiki & Content context — `Page` aggregate with the same versioning discipline as `Card` (a `page_versions` table mirroring `card_versions`), rich text authored via TipTap.
- **Entry state**: Phase 5's versioning pattern exists as the template to reuse.
- **Deliverable**: `pages`/`page_versions` schema; page CRUD routes with a TipTap editor; cross-page and page-to-card linking, harvested layout from `mingle/app/views` wiki templates.
- **Exit state**: editing a page twice produces two ordered `page_versions` rows and the current `pages` row reflects the latest content, verified against the DB.
- **Status**: PENDING

### Phase 17: Macro framework and chart macros
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Wiki & Content context — a macro syntax (`{{ macro-name: params }}`-style, matching the legacy macro editor's intent) expanded at render time, including chart macros that delegate to Milestone 9.
- **Entry state**: Phase 16 pages exist; Phase 13 MQL evaluator exists (chart macros query cards via MQL).
- **Deliverable**: a macro parser/registry and at least the table-query and chart macros wired to real MQL queries against real project data.
- **Exit state**: a page containing a chart macro renders a chart reflecting the current state of real seeded cards; changing an underlying card property and re-rendering the page changes the chart output, verified end to end.
- **Status**: PENDING

## Milestone 9: Charts & Dashboards

### Phase 18: Daily history chart
- **Tier**: Medium
- **Budget**: 300
- **Domain focus**: Charting/Reporting context — a time-series reconstruction of property state per day, computed from `card_versions` (Phase 5), using an OSS charting library (not Highcharts, per ADR-0001).
- **Entry state**: Phase 5 versioning and Phase 12/13 MQL exist.
- **Deliverable**: a daily-history-chart macro/route that reconstructs, for each day in a range, the count of cards matching an MQL condition at that day's end-of-day state (reading `card_versions`, not just current `cards`).
- **Exit state**: seeding cards with known version timestamps and property changes produces a chart series matching a hand-computed expected series for at least 3 distinct days.
- **Status**: PENDING

### Phase 19: Pie, stacked-bar, and data-series charts
- **Tier**: Medium
- **Budget**: 300
- **Domain focus**: Charting/Reporting context — aggregate chart types backed by MQL group-by queries.
- **Entry state**: Phase 18's charting library integration and Phase 13 MQL exist.
- **Deliverable**: pie, stacked-bar, and data-series chart macros, each backed by an MQL query with a grouping dimension.
- **Exit state**: each chart type renders correct segment/series values against a seeded dataset, verified by comparing rendered data (not just "no error thrown") to the expected aggregation.
- **Status**: PENDING

## Milestone 10: Collaboration

### Phase 20: Murmurs, mentions, and card comment linkage
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Collaboration context — `Murmur` aggregate, `@mention` parsing, `CardCommentMurmur` linkage (a card comment is a murmur tied to a card).
- **Entry state**: Phase 5 cards and Phase 2 users exist.
- **Deliverable**: `murmurs` schema; posting a murmur on a project or a card comment; `@mention` parsing that resolves to a real team member (Phase 4) and records a mention record.
- **Exit state**: posting a card comment persists a murmur row linked to the card, and a mention of a real team member is queryable as a distinct persisted fact — not just text matching at render time.
- **Status**: PENDING

### Phase 21: History feed and Atom feeds
- **Tier**: Medium
- **Budget**: 200
- **Domain focus**: Collaboration context — a project-wide `HistoryFeed` projection over `card_versions`/`page_versions`/murmurs, exposed as both an in-app feed and an Atom feed (matching `feeds_controller.rb`).
- **Entry state**: Phase 5/16/20 version and murmur data exist.
- **Deliverable**: an in-app history feed route and an Atom XML feed route, both reading the same underlying projection.
- **Exit state**: a real card update, page edit, and murmur post each appear in the history feed and the Atom feed within the same session's test run, verified against the feed's actual emitted entries.
- **Status**: PENDING

### Phase 22: Email and subscription notifications
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Collaboration context — `HistorySubscription`, delivered via the SQLite-backed job queue (ADR-0002 — a jobs table drained by an in-process worker, established when first needed; replaces the originally planned pg-boss).
- **Entry state**: Phase 21 history feed exists; the job queue is built here if no earlier phase needed it first.
- **Deliverable**: a subscription model (per user, per project or per MQL filter) and a queued job that, on a matching history event, enqueues and sends an email (a real SMTP call against a test mail server in dev/test — e.g. Mailpit/MailHog in docker-compose, not a stubbed mailer).
- **Exit state — REAL-PATH TEST (rule 13a, the job queue is an OWNED dependency)**: a triggering event causes a real job to run through the jobs table and a real email to land in the test mail server's inbox, verified by querying that inbox — not by asserting the job function was called.
- **Status**: PENDING

## Milestone 11: Card Trees & Aggregates

### Phase 23: Tree configurations, relationship properties, and hierarchy view
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Card Trees context — `TreeConfiguration`, `TreeRelationshipProperty` (a property whose value is a parent card in the tree), hierarchy/tree view rendering.
- **Entry state**: Phase 5 cards and Phase 7 properties exist.
- **Deliverable**: `tree_configurations` and tree membership schema; adding/removing a card type to a tree; a hierarchy view harvested from `mingle/app/views` tree templates.
- **Exit state**: a 3-level card hierarchy (e.g., Release > Iteration > Story) persists correctly, a card's tree-relationship property correctly identifies its parent, and removing a card from the tree cascades per the legacy semantics (children detached, not deleted), verified against real rows.
- **Status**: PENDING

### Phase 24: Aggregate properties over trees
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Card Trees context — `AggregateProperty` (sum/count/average of a descendant property up a tree relationship).
- **Entry state**: Phase 23 trees and Phase 7 properties exist.
- **Deliverable**: an aggregate property definition that recomputes when a descendant's contributing property changes, reusing Phase 8's recomputation pattern rather than inventing a second one.
- **Exit state**: changing a leaf card's property recomputes and persists the correct aggregate value on its ancestor, verified against real seeded tree data with a hand-computed expected total.
- **Status**: PENDING

## Milestone 12: Cross-Project Dependencies

### Phase 25: Card dependencies across projects
- **Tier**: Medium
- **Budget**: 300
- **Domain focus**: Cross-Project Dependencies context — `Dependency` linking a resolving card in one project to a raising card in another, with its own status lifecycle (matching `dependency.rb`/`dependencies_controller.rb`).
- **Entry state**: Phase 5 cards exist in at least two distinct projects.
- **Deliverable**: `dependencies` schema and routes to raise, accept, and resolve a dependency; a `dependency_version_event` history mirroring card versioning.
- **Exit state**: raising a dependency from project A referencing a card in project B, then resolving it, persists the correct status transitions and is visible from both projects' dependency lists, verified against real rows in both projects' scopes.
- **Status**: PENDING

## Milestone 13: Program Management (Programs, Plans, Objectives)

### Phase 26: Programs, plans, and objectives
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Program Management context (kept separate from Card Management, per `mingle-rails5`'s original separation) — `Program` aggregate, `Plan`, `Objective`, each referencing member projects.
- **Entry state**: Phase 3 projects and Phase 4 team/permissions exist.
- **Deliverable**: `programs`, `plans`, `objectives` schema; program membership (which projects belong to a program); objective CRUD with scheduling fields, matching `mingle-rails5/app/models/{program,plan,objective}.rb`.
- **Exit state**: creating a program, adding two member projects, and defining an objective with a date range persists correctly and is queryable per-program, verified against real rows.
- **Status**: PENDING

### Phase 27: Backlog
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: Program Management context — `Backlog` (an ordered, program-scoped list of proposed objectives/cards awaiting planning).
- **Entry state**: Phase 26 programs/objectives exist.
- **Deliverable**: backlog schema and ordering, backed by `list_reordering_support.rb`'s legacy semantics (stable explicit ordering, not implicit created-at ordering).
- **Exit state**: reordering backlog items persists the new order, verified by reloading and asserting the exact sequence.
- **Status**: PENDING

## Milestone 14: Import & Export

### Phase 28: Project export/import
- **Tier**: Large
- **Budget**: 350
- **Domain focus**: Import/Export context — a full project template export (schema definitions, card types, property definitions, transitions, trees — data optional) and import, matching `project_exports_controller.rb`/`project_import_controller.rb`.
- **Entry state**: Milestones 1–11's project-scoped schema exists (properties, transitions, trees included) — this phase deliberately comes late so it has a complete surface to export.
- **Deliverable**: an export format (a versioned JSON bundle, not the legacy XML/YAML format, since this is a rewrite) capturing a project's full configuration; an import route that reconstructs a new project from that bundle.
- **Exit state**: exporting a fully-configured project (card types, properties, a transition, a tree) and importing it into a fresh project produces a structurally identical configuration, verified field-by-field against the source project's rows.
- **Status**: PENDING

### Phase 29: Card import and dependencies import/export
- **Tier**: Medium
- **Budget**: 300
- **Domain focus**: Import/Export context — bulk `Card` creation from tab-separated/CSV data (`card_importer.rb`), and `Dependency` import/export (`dependencies_import_export_controller.rb`).
- **Entry state**: Phase 7 properties and Phase 25 dependencies exist.
- **Deliverable**: a CSV/TSV card-import route with a column-to-property mapping preview step; a dependency export/import format.
- **Exit state**: importing a 5-row CSV creates 5 cards with correctly mapped property values, verified against the DB; a malformed row is rejected with a specific error identifying the row, not a silent skip.
- **Status**: PENDING

## Milestone 15: Public API

### Phase 30: Versioned HTTP API
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Public API context — a versioned JSON API (the spiritual successor to the legacy v2 XML/JSON API in `mingle/app/controllers/api/`) exposing Project, Card, PropertyDefinition, and Transition resources for external clients.
- **Entry state**: Milestones 1–7's domain model (projects, cards, properties, transitions) exists.
- **Deliverable**: `/api/v1/...` routes reusing the same command handlers as the UI routes (no parallel business logic), with API-key or token authentication distinct from the browser session (Phase 2).
- **Exit state**: an external HTTP client (not the app's own UI) creates a project, creates a card, sets a property, and executes a transition purely via the API, each verified against real persisted state.
- **Status**: PENDING

## Milestone 16: Advanced Auth & External Integrations

### Phase 31: SSO, LDAP, OAuth, and HMAC authentication
- **Tier**: Large
- **Budget**: 400
- **Domain focus**: Identity & Access context — pluggable authentication strategies alongside Phase 2's basic auth, matching `auth_configuration.rb`/`sso_config_controller.rb`/HMAC auth support.
- **Entry state**: Phase 2 basic auth and Phase 30 API exist (HMAC auth is API-facing).
- **Deliverable**: a pluggable auth-strategy interface; at minimum one working SSO (OIDC) strategy, one LDAP bind-based strategy, and HMAC request signing for the API, each behind project-level configuration.
- **Exit state**: a user authenticates via the configured SSO provider (a real OIDC test provider in dev/test, not a stubbed identity assertion) and is mapped to a real `users` row; an HMAC-signed API request is accepted and an incorrectly-signed one is rejected.
- **Status**: PENDING

### Phase 32: Slack and GitHub integrations
- **Tier**: Medium
- **Budget**: 250
- **Domain focus**: External Integrations context — outbound webhooks/notifications to Slack, and inbound GitHub commit-message card references (matching `slack_controller.rb`/`github_controller.rb`).
- **Entry state**: Phase 21 history feed exists (integrations post from the same event stream).
- **Deliverable**: a Slack webhook notifier triggered by history events; a GitHub webhook receiver that links a commit to a card by card number in the commit message.
- **Exit state**: a real webhook call (against a local test HTTP receiver standing in for Slack/GitHub's endpoints, since the actual third-party services are EXTERNAL per rule 13a) is issued with the correct payload for a triggering event, and an inbound GitHub webhook payload correctly links a commit to the referenced card, verified against a persisted link record.
- **Status**: PENDING

## Milestone 17: Production Packaging

### Phase 33: Production packaging and one-command install
- **Tier**: Small
- **Budget**: 150
- **Domain focus**: N/A — infrastructure/tooling. This phase's name is docker/deploy-shaped, so rule 13a's stub prohibition applies in full.
- **Entry state**: All prior milestones are feature-complete against a dev `docker-compose.yml` (Phase 1).
- **Deliverable**: a production-hardened single-container install (ADR-0002) — `app` image built from `mingle-ts/Dockerfile` with the SQLite volume, migrations run automatically on `app` startup, no manual seeding step, documented backup story (copy the volume's database file).
- **Exit state — REAL-PATH TEST (rule 13a)**: from a completely clean checkout, `docker compose up` boots both containers; a smoke test script exercises project creation, card creation/editing, a transition, and a wiki page purely through the running containers' real HTTP routes, then queries the `db` container directly to confirm persistence — covering every OWNED dependency (the `app` image and the `db` container this repo ships).
- **Status**: PENDING
