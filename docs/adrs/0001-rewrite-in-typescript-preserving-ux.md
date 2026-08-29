# ADR-0001: Rewrite Mingle in TypeScript, preserving the UX

**Status**: ACCEPTED (superseded in part by ADR-0002: SQLite replaces PostgreSQL, and pg-boss is dropped for a SQLite-backed job table)

## Context

This repository is the archived source of Mingle, ThoughtWorks' agile project management product, open-sourced in 2020 and unmaintained since. It contains two sibling apps: the original product (`mingle/`, Rails 2.3.18 on JRuby 1.7.27) and an abandoned partial rewrite (`mingle-rails5/`, Rails 5.0.1 on JRuby 9.1.13.0) that ran alongside it.

An architect review (session 43e4c4) established: the legacy stack is EOL with unpatchable CVEs and must never face the internet; the checkout cannot boot without two commercially licensed assets (Highcharts 2.2.3, `ojdbc6.jar`); every dependency is 6+ years stale; and finishing the Rails 5 strangler migration is team-years of work that ThoughtWorks itself abandoned.

The goal is a modern, easily installed (Docker) Mingle that preserves the UX of the original — its interaction design, layout, and visual identity — not its code. Two paths were considered: containerize the legacy app as-is (a time capsule), or rewrite. Three rewrite stacks were compared: TypeScript full-stack, Elixir/Phoenix LiveView, and Go + HTMX.

The repo is unusually strong raw material for a rewrite: 1,553 help files (functional/UX spec), 1,272 test files (behavior spec), and 687 ERB templates + CSS (visual reference).

## Decision

Rewrite Mingle as a new TypeScript application, harvesting the UX from the legacy artifacts. Specifically:

- **Stack**: TypeScript end to end — React Router (framework mode, SSR; v7 at decision time, v8 adopted at scaffold, 2026-08-24), React, PostgreSQL with Drizzle ORM, Node 22 LTS. Background jobs via a Postgres-backed queue (pg-boss) rather than Redis, preserving a one-container-plus-Postgres install. Intended UI libraries: dnd-kit (card wall drag-drop), TipTap (rich text, replacing CKEditor).
- **UX preservation** means interaction design, layout, and CSS harvested from `mingle/app/views` and `mingle/app/assets/stylesheets` (amended 2026-08-29: the SCSS lives there, not under `mingle/public`) — not the 2010-era Prototype.js JavaScript, which is not portable.
- **Roadmap strategy**: full feature-for-feature parity with the original product — nothing is cut from scope. The parity target is the on-prem installed edition (single-tenant), including the program/planner features from `mingle-rails5/`. Work is still phased by dependency order (foundation → cards → properties → views → MQL → wiki/charts → collaboration → trees/dependencies → planner → import/export → API → packaging), but phasing is sequencing, not scoping: every feature is planned, none deferred indefinitely.
- **Location**: new code lives in a `mingle-ts/` directory in this repository, so the legacy source stays adjacent as reference. `mingle/` and `mingle-rails5/` are read-only reference material — never modified, never deployed.
- **Wire types**: client and server share protocol types via direct import from a runtime-neutral module (per rule 8b), enforced from the first slice.
- Elixir/Phoenix was runner-up (best live-collaboration fit); TypeScript won on ecosystem depth and AI-assisted porting velocity, and because every candidate stack needed substantial client-side JS for the card wall anyway.

## Consequences

- Future sessions build in `mingle-ts/`; no session invests in the JRuby toolchain, legacy gem resurrection, or the Rails 5 migration except to read code as reference.
- The legacy apps receive no security fixes and must never be network-exposed; any future "run the original" effort (e.g., a containerized living UX reference, deferred but still open) is LAN-only.
- The commercial-asset problem (Highcharts, ojdbc6) disappears — the rewrite uses OSS charting when charts arrive, and is Postgres-only.
- TypeScript ecosystem churn is accepted: expect at least one framework/tooling migration over the project's life.
- UX fidelity is verified against the legacy templates, CSS, and help documentation — disputes about "how did it behave" are settled by those artifacts, not memory.
- Full parity is a multi-year commitment, accepted knowingly. Only SaaS-specific machinery is out of scope (schema-per-tenant multitenancy, Mixpanel telemetry, license enforcement); everything the installed product did is in scope. The schema must carry card versioning/history from day one — it is foundational to Mingle's model and retrofitting it would be prohibitive.

## Session

43e4c4 — 2026-08-21. Preceded by the architect review and stack comparison recorded in that session's conversation.
