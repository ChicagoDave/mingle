# ADR-0024: Project templates are versioned bundles carrying optional content sections

**Status**: ACCEPTED

## Context

Legacy Mingle was a Scrum/Kanban product because of what it shipped in
`mingle/templates/specs/` — `scrum_template.yml`, `agile_template.yml`,
`kanban_template.yml` — offered as "Pre-defined templates" on New
Project and copied into the new project by `ConfigurableTemplate#copy_into`
→ `ProjectCreator#merge!`. A spec carried configuration (card types,
properties with ordered managed values, project variables, trees) *and*
content: card defaults, seed cards, tabs with lanes and WIP limits, and
wiki pages whose macros were expanded with ERB at copy time so their
dates were relative to the day the project was created.

The port has one document that a project's shape travels in: the
configuration bundle, `mingle-project-template` version 1
(`app/domain/import-export/bundle.server.ts`, Phase 28). Its header
records an explicit position: "configuration only — no cards, versions,
members, pages or history … Identity is per installation, so `is_user` /
`in_group` prerequisites and the values of UserType / CardType variables
are not carried." Everything is named by name, never id, so a bundle
imports into any installation. `/projects/new` has no template step; a
new project is one default card type and nothing else.

`docs/proposals/project-templates.md` (P-1) proposes carrying the four
content kinds a Kanban template needs. Its review found the undecided
decision underneath: whether a template *is* the bundle format widened,
or a separate artifact composing a bundle with card rows and pages;
whether exporting a live project now emits its content — a project with
five thousand cards is not a template — or only on request; and how a
template expresses "relative to the day it is copied in", which legacy
did with ERB and which a JSON document cannot do by itself. ADR-0001
puts templates in scope ("everything the installed product did is in
scope"); ADR-0004, ADR-0012 and ADR-0019 constrain how imported content
may be written.

## Decision

1. **A template is a bundle.** There is one document format,
   `mingle-project-template`, and a template is a bundle file shipped in
   the repository under `mingle-ts/templates/<name>.json`. No second
   artifact, no manifest composing several files: the thing a person
   exports from a project and the thing the New Project page offers are
   the same shape, parsed by the same `parseBundle`, applied by the same
   `importProject`.

2. **Version 2 adds four optional content sections; version 1 stays
   readable.** `cards`, `pages`, `favorites` (team favorites, including
   `tabView` and, once they exist, per-lane WIP limits) and
   `cardDefaults`. Each is optional and defaults to empty; a version-1
   document is a version-2 document with none of them, and imports
   unchanged. Names, never ids, as before. The bundle module's invariant
   — no runtime-specific types — holds for the new sections.

3. **Content sections are emitted only on request.** `exportProject`
   gains an explicit `includeContent` input, false by default. A plain
   export of a live project is still configuration only; a person who
   wants a template with seed cards and pages asks for it. This keeps
   the Phase 28 "configuration only" promise as the default behaviour
   rather than reversing it, and keeps an export from silently carrying
   a project's whole card table.

4. **Identity is still not carried.** A user-typed property value in
   `cards` or `cardDefaults` may hold only the marker `(current user)`
   (legacy's own spelling), resolved to the importing actor when the
   template is applied; any other user value is rejected by
   `parseBundle`. Nothing in a template names a login, a group, or a
   member.

5. **Template-time substitution is one token, expanded by the
   importer.** Page content may contain `{{template:today}}` and
   `{{template:today±N}}` (days), which `importProject` replaces with
   ISO dates relative to the instantiation date before the page is
   stored — the only substitution, applied once, on the way in. Stored
   page content never carries the token, so the page renderer, the
   sanitizer (ADR-0011) and the macro registry (ADR-0014) are untouched;
   this is legacy's ERB-at-copy-time, narrowed to the one thing the
   shipped templates used it for.

6. **Imported content goes through the existing writers.** Seed cards
   land through the card-import path (`importCards`), so each gets its
   version row and id-keyed snapshot (ADR-0004) and no code writes
   `card_property_values` from a new place (ADR-0019 Decision 4). Pages
   are applied after every configuration section, so a macro naming a
   property names one that exists, and are validated on the way in
   rather than resolved later (ADR-0012). Favorites go through
   `app/domain/cards/favorites.server` (ADR-0005). Card defaults, when
   applied at card creation, are written by the same property writer
   `createCard` already uses.

## Consequences

- **The Kanban template, and later Scrum and Agile, are data files with
  a test each**, not code: `mingle-ts/templates/*.json` parsed by
  `parseBundle` in the suite, so a hand-edit that breaks one fails the
  gate. Adding a template is adding a file and a test.
- **The New Project picker is a thin adapter.** It lists
  `mingle-ts/templates/*.json` and calls `importProject` with the entered
  name and identifier; legacy's "use an existing project as a template"
  is expressible as export-with-content followed by import and is not a
  separate feature.
- **`BUNDLE_VERSION` moves to 2 and stays backward-readable.** Any
  future section is added the same way — optional, default empty,
  version bumped — never by making an old document unreadable.
- **Card defaults and WIP limits are engine features first.** Decision 2
  names them as sections, but a section can only carry what the engine
  stores; proposal items P-2 and P-3 precede P-1's `cardDefaults` and
  WIP fields in any plan.
- **`(current user)` is the only identity marker, and it resolves to
  the importer.** A template cannot pre-assign work to anyone; that is
  the cost of importing into any installation, accepted knowingly.
- **The substitution token is deliberately not a template language.**
  If a future template needs more than dates relative to today, that is
  the moment to revisit Decision 5 — not to add a second token beside it.
- **A version-2 export with `includeContent` is not a backup.** It
  carries cards' current values and page bodies, not versions, history,
  attachments, murmurs or members; the backup job (ADR-0023) remains
  the way to preserve a project.

## Session

- Decided during session ba5848 (2026-08-29), while reviewing
  `docs/proposals/project-templates.md` item P-1; summary
  `docs/context/session-20260829-*-*.md` for that session.
