# ADR-0016: Categorical ordering is a query concern, not a presentation concern

**Status**: ACCEPTED

## Context

Phase 19 added `{{ stacked-bar-chart }}` and `{{ data-series-chart }}`.
Both plot several MQL group-by queries against one shared x axis, so
before anything can be drawn, something has to decide what the axis
contains and what order it runs in.

The obvious implementation is to run each series' query, collect the
label strings that come back, and sort them in JavaScript. It is one
function, it needs no extra query, and it looks correct in a test
seeded with `open` / `closed`.

It is wrong in three separate ways, and each way is invisible until a
particular project's data hits it:

- **Enumerated properties have a declared order that is not
  alphabetical.** A `Status` declared `new`, `open`, `closed` sorts to
  `closed`, `new`, `open`. The chart still renders. Its bars are simply
  in an order the project never chose, and the reader has no way to
  tell — a Kanban-shaped property read right to left looks like a
  regression rather than a rendering bug.
- **Numbers stored as text sort as text.** An `Iteration` axis runs
  1, 10, 11, 2 — a defect that only appears once a project reaches
  iteration 10, which is to say after the feature has been trusted for
  months.
- **The unset bucket has a defined position.** `card-grid.behavior.test.ts:204`
  already asserts an enumerated card-grid lane comes back
  `["(not set)", "New", "Open", "Closed"]`. A chart that sorted its own
  labels would put `(not set)` wherever the string happened to fall,
  and the same cards would be ordered one way in the grid and another
  way in a chart on the wiki page beside it.

The third is the one that matters most, and it is the same failure
ADR-0015 was written about: not a crash, but **two renderings of the
same cards that disagree, both of which look correct**. ADR-0015 solved
it for *which rows* a query sees by giving the evaluator one
`CardSource` rather than two reconstructions. This is the same problem
one axis over: *which order* those rows come back in.

The machinery to do it properly already existed and was already correct.
`mql-evaluator.server.ts`'s `orderExpr` casts numerics to real, resolves
an enumerated value to its `enumeration_values.position`, and returns
the plain value otherwise. Every card list and card grid in the product
already orders through it. Nothing needed to be built — only *reached*.

## Decision

1. **A grouped or categorical view delegates label ordering to SQL,
   never to JavaScript.** The x axis is produced by executing a
   `SELECT DISTINCT <x property>` query carrying an `orderBy` on the
   grouping column, and the axis is the order the rows come back in.
   `chart-series.server.ts` contains no comparator, no `.sort()`, and no
   knowledge of what an enumerated property is.

2. **The ordering authority is the evaluator's `orderExpr`, not a
   second implementation of it.** Position order for enumerations,
   numeric casting for numbers, and chronological order for dates are
   properties of `orderExpr`. A view that wants a different order
   changes the query it sends, not the ordering rule.

3. **Where the unset bucket sits is inherited, not chosen.** It leads,
   because `orderExpr` yields NULL for an unset value and SQLite sorts
   NULL first — the same reason a card grid's `(not set)` lane leads.
   No view re-decides this locally. A future decision to move it moves
   it everywhere at once, which is the point.

4. **Grouping and ordering are injected into a series query the author
   did not fully specify.** `data: SELECT Status, COUNT(*)` means
   grouped by `Status` and ordered by `Status`, matching legacy's
   `order_and_group_by_first_column_if_necessary`. Without the injected
   `GROUP BY` the query returns one row per card and the chart plots one
   arbitrary card's value while looking exactly like a total.

5. **The axis comes from the chart's own scope, not from the property
   definition — a deliberate divergence from legacy.** Legacy's
   `StackBarChartXAxisLabels` builds the axis from every value the
   property can take, so an enumerated value no card currently has still
   gets an empty column. This runs `SELECT DISTINCT` under the
   chart-level `conditions`, so the axis shows the values the chart's
   scope actually contains. The `labels:` parameter remains the explicit
   override in either direction, and a label a series produces that an
   author-supplied `labels:` query omits is **appended rather than
   dropped** — dropping it would silently lose cards the series counted.

## Consequences

- **The remaining macro catalogue inherits this.** pivot-table,
  ratio-bar, and cumulative-flow all group by a property and all face
  this exact decision. Each of them delegating to `orderExpr` is now the
  default rather than a judgment call, and a JS sort appearing in one of
  them is a defect with a name.

- **Ordering costs one extra query per chart.** The axis is its own
  `SELECT DISTINCT` rather than a by-product of the series queries. That
  is accepted deliberately: deriving the axis by merging the series
  results would require reconstructing the global order in JavaScript,
  which is the thing this ADR exists to forbid.

- **A view cannot order by something SQL cannot express.** Ordering by
  a computed or presentation-only value — a formatted label, a
  translated string, a rank the client knows and the database does not
  — has no path under this decision. No current view needs one; a view
  that does is a decision to revisit here, not to solve locally.

- **`orderExpr` is now load-bearing for two independent surfaces.** It
  was already the card list's and grid's ordering; it is now also every
  chart axis. A change to it moves charts and lists together, which is
  the guarantee being bought — but it means `orderExpr` can no longer be
  tuned for lists alone.

- **The scope-derived axis can change width as data changes.** A status
  with no cards today produces no column; the same chart grows a column
  when the first card lands there. This is visible behaviour, not a
  bug, and `labels:` is the fix for an author who wants a fixed axis.

- **Verified by mutation, not by inspection.** Removing the `orderBy`
  from the axis query fails 10 of the phase's 27 tests, and dropping the
  injected `GROUP BY` fails 13. The ordering guarantee is asserted
  behaviour rather than a convention that could erode silently.

## Session

Session 9439a9, 2026-08-27 — decision taken in Phase 19 "Pie,
stacked-bar, and data-series charts" of
`docs/work/mingle-ts-full-parity/plan.md`, recorded here after
confirmation.

Related: ADR-0015 established that two reconstructions of the same cards
that disagree are the failure worth designing against, and solved it for
*which rows* a query sees; this applies the identical argument to the
order those rows arrive in, and reuses the evaluator rather than adding
a second authority. ADR-0006 is cited here for one narrow thing and
nothing more: its resolved, typed AST is what carries a `PropertyRef`'s
`kind` and `id`, which is the only reason `orderExpr` can tell an
enumerated property from a number without a name lookup. **ADR-0006 did
not decide ordering, and this ADR does not claim it did** — ADR-0014's
closing note already warned that sharing the evaluator's builder
"extends ADR-0006's principle one layer down; it is not something
ADR-0006 already decided", and ADR-0015 quoted that warning when it
revisited the same seam. Delegating axis order to `orderExpr` is one
layer further down again, and it is this ADR that decides it.

ADR-0014 established that a chart is nodes in the content tree rather
than a client-side rendering; a chart that sorted its own axis in the
browser was never available, which is what made delegating to SQL the
natural rather than the expensive option.
