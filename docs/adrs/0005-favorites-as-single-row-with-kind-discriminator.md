# ADR-0005: Favorites as one row collapsing Favorite + CardListView, with a `kind` discriminator

**Status**: ACCEPTED

## Context

Legacy Mingle stored a saved view as two rows: a polymorphic `Favorite`
(project, `favorited_type`/`favorited_id`, `tab_view`, `user_id` scope)
pointing at a `CardListView` (name, style, serialized params). Pages
could also be favorited through the same polymorphic pointer. Phase 11
had to decide whether to reproduce that pair in TypeScript or collapse
it, knowing that page favorites arrive with the Wiki phase (Phase 16)
and that the only favoritable thing today is a card view.

Options considered:

1. **Reproduce the pair** — `favorites` + `card_list_views` with a
   polymorphic (`favorited_type`, `favorited_id`) join. Faithful, but a
   polymorphic FK cannot be enforced by SQLite, every read is a join,
   and the pair exists only to serve a second kind that does not yet
   exist.
2. **One `favorites` row with a `kind` discriminator** — the card-view
   columns (`style`, `filters`, `columns`, `group_by`) live on the row;
   `kind = "card_view"` today; a page favorite adds `kind = "page"` +
   a nullable `page_id` FK later.
3. **Card-view-only table with no discriminator** — simplest now, but
   page favorites would force either a second table (and a second tab
   bar source) or a retrofitted discriminator with a data migration.

## Decision

- A **single `favorites` table** (`mingle-ts/app/db/schema/favorites.ts`)
  holds saved views: scope (`user_id` NULL = team, else personal),
  `tab_view`, `style`, and the view params stored in **legacy wire form**
  (`filters` JSON array of `[Property][op][value]` strings, `columns`
  JSON array, `group_by` name) so a favorite reopens to exactly the URL
  it was saved from.
- The row carries a **`kind` discriminator**, defaulting to
  `"card_view"`. Page favorites (Wiki phase) extend this table by adding
  `kind = "page"` and a nullable `page_id` column — not a second table
  and not a polymorphic join.
- View params are **validated through the Phase 9/10 read models before
  storage** so a saved favorite can never reopen to a filter error.
- Name uniqueness is case-insensitive within scope, enforced by **two
  partial unique indexes** (team scope; per-user scope) rather than one
  `coalesce()` expression index, because drizzle-kit mis-generates SQL
  for comma-bearing expression indexes.
- Write rules (privilege ladder mirroring legacy `favorites_controller`:
  full member saves/removes team favorites, project admin
  promotes/demotes/deletes tabs, owner deletes personal favorites) live
  only in `app/domain/cards/favorites.server.ts`; routes never write the
  table directly.

## Consequences

- The tab bar and favorites panel read one table for every favoritable
  kind; Phase 16 adds a `kind`/`page_id` migration plus a branch in
  `favoriteHref`, and no data migration of existing rows.
- Card-view columns are nullable-in-spirit for non-card kinds: a `page`
  row will carry `style`/`filters` defaults that mean nothing. Readers
  must branch on `kind`, never on column presence.
- Legacy features deferred by Phase 11 — favorite rename, tab
  reorder/rename (`ordered_tab_identifiers`), personal "update saved
  view" — must be built on this row shape, not by reintroducing a
  `card_list_views` table.
- Any change to the legacy wire encoding of filters/columns (Phase 9/10
  read models) must remain backward-readable by stored favorites, or
  ship a migration rewriting `favorites.filters`/`columns`.

## Session

2026-08-25 (session 9463f0 shipped the schema in Phase 11 — favorites,
tabs, saved views; session 9ef269 recorded the decision on user
confirmation).
