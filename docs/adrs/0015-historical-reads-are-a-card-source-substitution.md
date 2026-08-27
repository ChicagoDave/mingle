# ADR-0015: Historical reads are a card-source substitution, not a second query path

**Status**: ACCEPTED

## Context

Phase 18 needed a daily history chart: for each day in a range, how many
cards matched an MQL condition *at the end of that day*. That number is
not derivable from the `cards` table. Only `card_versions` holds it —
the append-only trail ADR-0004 established, keyed by property definition
id and kept even when a card is deleted.

The obvious implementation is a bespoke one. Read the version rows the
chart needs, reconstruct each day's snapshot in memory or in a
purpose-built query, and evaluate the chart's condition against it. It
is self-contained, it touches no shipped code, and it would have worked.

It would also have been the second implementation of MQL's semantics in
this codebase, and the first one already carries a warning against
exactly that. `mql-evaluator.server.ts`'s header states the unset rule —
a managed property's value is present or absent, so `=` requires a
present value and `!=` therefore *matches unset cards* — and says in as
many words that two translations of that rule drift, which is why
projection was made to reuse the evaluator's builder in Phase 17 rather
than re-derive it. ADR-0014's closing note sharpened the point: sharing
the builder "extends ADR-0006's principle one layer down; it is not
something ADR-0006 already decided, and if that sharing is ever
revisited it is this note, not ADR-0006, that the reviewer should
weigh." Phase 18 is the session that revisited it.

The drift here would not be theoretical. A history chart built its own
way would answer `Status != Open` one way for a filter and another way
for a chart on the same page, for the cards that have no Status at all —
and both answers look right. Nothing in the test suite would have caught
it, because the two paths would have had separate tests, each internally
consistent.

There was a second signal pointing the same way. `AS OF` already
*parsed*: `mql.server.ts` accepts it and validates it as an ISO date,
and `mql-projection.server.ts` refused it at execution with "AS OF is
not supported yet", naming Phase 18 as its subject. A bespoke chart
query would have left that refusal standing forever — a query language
with a clause it will not run, and a chart that answers the same
question through a private door.

ADR-0006 had in fact already anticipated the shape without naming it.
Its consequences say Phase 13's evaluator translates the AST "by
switching on `PropertyRef.source`/`kind` and comparing `canonical`
values — no name lookups, no literal parsing", and then: "The same holds
for chart macros **and the daily-history reconstruction**." The
reconstruction was expected to share the translation from the beginning;
what was missing was the seam that lets it.

The structural question was therefore not "how do we read history" but
"what actually varies between a live read and a historical one". The
answer is narrow: the *relation* a condition is evaluated against.
Everything else — operators, casting rules, enumeration ordering, unset
handling, `CURRENT USER`, `TODAY`, nesting — is identical.

## Decision

1. **The evaluator is parameterized over a `CardSource`: the relation of
   card states a condition is evaluated against.** It supplies a card's
   identity columns, the project scope, a scalar expression for any
   property's value, the unset-aware wrapper around a per-value
   predicate, and a distinct alias of itself for nested queries. The
   condition walker takes a `CardSource` and never branches on which one
   it has.

2. **Two implementations, and adding a third is a decision, not a
   detail.** `currentCards` reads the live `cards` row and
   `card_property_values`, exactly as shipped. `cardsAsOf(date)` reads
   each card's highest `card_versions` row created before the start of
   the following day, with deletion versions excluded, taking property
   values from the row's `property_values` snapshot by definition id.

3. **Both sources implement the same unset rule, and that identity is
   the reason the interface exists.** `CurrentCards` spells it as
   `EXISTS` / `NOT EXISTS` over value rows; `CardsAsOf` spells it as a
   JSON key being present or absent. They are the same rule in two
   dialects, and the interface's contract says so, because a future
   source that got this subtly wrong would produce right-looking wrong
   answers indefinitely.

4. **`AS OF` compiles to a source substitution and nothing else.** It is
   not special-cased in projection or in any macro. Every consumer that
   passes a whole resolved query through gained historical reads at once
   — the `table`, `value` and `pie-chart` macros included — because none
   of them had to be told. The one consumer that did not is the card
   list's advanced filter, and deliberately: it accepts bare conditions
   only, and already refused `AS OF` by name along with SELECT, GROUP BY
   and ORDER BY before this phase. That refusal stands.

5. **A card deleted after the as-of date is present in the days it was
   alive.** This diverges from legacy deliberately. Legacy's `AS OF`
   join inner-joins the live `cards` table inside its `MAX(version)`
   subquery, so a card deleted at any point vanishes from its own
   history. This schema keeps versions on delete and marks the final one
   `is_deletion` precisely so history can be read without current state.
   Using that is the whole reason the column exists.

6. **A second `AS OF` inside a nested `IN (SELECT …)` is refused by
   name, as legacy refuses it.** The nested query inherits the outer
   source, so one condition asks about one point in time. Inheriting the
   outer date while a different one was written would silently discard
   what the author asked for.

7. **The chart macro computes no history.** `macros-history.server.ts`
   composes each series' MQL, parses it once, and re-runs the same
   resolved query with a different `asOf` per day. Reconstruction lives
   in the evaluator or it does not exist.

## Consequences

- **Every future historical read goes through a `CardSource`.** Phase 19
  (aggregate charts), Phase 21 (history feed), and Phase 24 (tree
  aggregates) inherit this. A phase that finds itself reading
  `card_versions` directly to answer a question MQL can express is
  doing the thing this ADR forbids, and should add or reuse a source
  instead.

- **`page_versions` has no equivalent and this ADR does not give it
  one.** Phase 21's history feed spans cards, pages and murmurs, and
  only the card half has a source. Whether that feed generalizes
  `CardSource`, sits beside it, or stays a separate projection is Phase
  21's decision to make consciously — the parallel is suggestive, not
  binding.

- **Cost is one query per (day × series), each carrying a correlated
  `max(version)` lookup.** Legacy solved this with an asynchronous cache
  (`DailyHistoryChartProcessor`) that computed days in the background
  and published progress. This renders synchronously, so the range is
  capped at 366 days and refused beyond it by name. A phase that wants
  multi-year charts is signing up for the cache, not for a wider cap.

- **`AS OF` is now answerable everywhere MQL is, including in places
  nobody has thought about.** A table macro can be given `AS OF`, and
  will answer historically. That is the intended consequence of Decision
  4, but it means the surface that has to stay correct is larger than
  the chart that motivated it.

- **`Created On` costs a subquery under `AS OF`.** A version row's own
  timestamp is when that state began, so the card's creation date is a
  correlated `min(created_at)` over its versions rather than a column
  read. Correct, and worth knowing before someone measures it.

- **The historical source is only as good as what the write path
  snapshots.** `card_versions.property_values` holds the managed
  property values and the row holds name, number and type name. A future
  card attribute that is *not* snapshotted will be invisible to every
  historical read, and will fail silently by reading as unset rather
  than by erroring. Adding a card attribute is therefore also a decision
  about whether history needs it.

- **Testing history requires backdating version rows.** There is no
  clock seam in this codebase, so both Phase 18 test files run the real
  domain commands and then move the rows they wrote in time. This is
  data setup rather than a stub — the production write path still
  produced every row (rule 13a) — but it is a standing reason a clock
  abstraction would be worth having if a later phase needs one anyway.

## Session

Session 234772, 2026-08-27 — decision taken in Phase 18 "Daily history
chart" of `docs/work/mingle-ts-full-parity/plan.md`, recorded here after
confirmation.

Related: ADR-0004 established the id-keyed version snapshot this reads
from and is the reason a property rename does not corrupt history.
ADR-0006 settled that every consumer shares one resolved parse and named
the daily-history reconstruction among them; this extends the same
argument to the relation the parse is evaluated against. ADR-0014's closing note explicitly deferred the question of
whether sharing the evaluator's builder should be revisited to whoever
next touched it — this ADR is that answer, and it doubles down rather
than backing off.

One thing this ADR does NOT decide: whether charts should stay static.
ADR-0014 flagged that server-rendered SVG means no tooltips and no
drill-through, and asked Phase 19 to decide deliberately rather than
discover it. Phase 18 followed ADR-0014's approach without reopening it,
and the daily history chart is subject to that same open question — it
is ADR-0014's to settle, not this one's.
