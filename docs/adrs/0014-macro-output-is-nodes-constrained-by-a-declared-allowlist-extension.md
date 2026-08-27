# ADR-0014: Macro output is nodes, constrained by a declared allowlist extension

**Status**: ACCEPTED

## Context

ADR-0011 settled how page content is sanitized: parse into a node tree,
rebuild it from an allowlist, serialize. Its Decision 7 states the
ordering invariant that follows — *every future content transform
produces NODES, before serialization* — and names why that rule needed
writing down: appending an HTML string after `serialize` bypasses the
allowlist entirely, produces correct-looking pages, and breaks no
existing test. It is the one rule in that ADR whose violation is
invisible.

ADR-0011 also left this phase a specific instruction rather than a
general warning. Its consequences section says a chart or table macro
"must also register whatever elements and attributes it emits (a
placeholder `<div data-macro=…>`, for instance) with the allowlist,
which is today a private `Set` in `content.server.ts`. That set needs an
explicit extension point before Phase 17 edits it in place, or it will
rot the way allowlists do."

Phase 17 made both concrete. A pie chart's natural output is `<svg>`,
which sits in the sanitizer's `DROP_SUBTREE` — deliberately, because a
body a team member typed has no business carrying one. So the phase had
to answer two questions at once: what a macro is allowed to return, and
how an element becomes legal for macro output without becoming legal
for authored content.

Three shapes were available. Let macros return HTML strings and trust
them, which is the option ADR-0011 Decision 7 exists to forbid. Widen
`ALLOWED_TAGS` to include the union of everything any macro might emit,
which makes authored bodies more permissive every time a macro is
added — allowlist rot, named in advance. Or give macros a separate,
declared policy.

## Decision

1. **A macro is a function from parameters to `ContentNode[]`.** The
   `MacroDefinition.expand` signature returns nodes. There is no string
   path: `renderPageContent` takes a `MacroExpansion` callback whose
   return type is `ContentNode[]`, so ADR-0011 Decision 7 is enforced by
   the type checker for macros rather than by reviewer attention.

2. **Macro elements are declared, not added in place.**
   `registerMacroElements({ tag: [attrs] })` in `content.server.ts` is
   the extension point ADR-0011's consequences asked for. A macro module
   declares its elements at import time; nothing edits `ALLOWED_TAGS`.

3. **Two policies, not one widened allowlist.** Authored content is
   cleaned against `AUTHORED_POLICY`. Macro output is cleaned against
   that policy widened by exactly the declared elements — which also
   *removes* those tags from `DROP_SUBTREE` for that pass only. A
   declared tag is therefore emittable by a macro and still dropped from
   anything a person typed.

4. **The widened pass runs last, over the whole tree.** Order is:
   clean authored → expand macros → linkify → clean with the macro
   policy → serialize. Authored markup has already been through the
   strict pass before the widened one runs, so widening cannot
   retroactively admit an authored `<svg>`; only macro output reaches
   the second pass carrying declared tags.

5. **Macro output is exempt from link substitution.** `expandMacros`
   adds each output root to a `WeakSet` the caller passes in, and
   `linkify` skips those subtrees. A generated table cell holding a card
   name is data, not authoring, and `[[…]]` in it is not a link the
   author wrote. Node identity is the mechanism because it needs no
   marker attribute and cannot be spoofed by content.

6. **The dependency points macros → content, never back.**
   `content.server.ts` does not import the macro registry; it takes the
   expander as a parameter. The sanitizer stays pure and knows nothing
   about what macros exist.

7. **A macro that cannot run says so in place.** Unknown name, refused
   parameters, or a thrown error each become
   `<div class="error macro">` carrying the reason, added to the
   produced set like any other output. Silent empty output is not an
   option, because a chart that renders as nothing is indistinguishable
   from a chart with no data.

8. **Macro parameters are parsed as a YAML subset, not by a YAML
   library.** Legacy parses them as YAML and then has to defend against
   what that admits — `Macro.parse_parameters` refuses `!ruby/` tags
   outright. The block mappings, nested mappings and `- ` sequences real
   macros use are a small grammar; implementing that subset avoids
   taking a dependency whose surface must then be fenced off.

## Consequences

- **Phases 18 and 19 inherit Decision 2 as the way to add a chart.** A
  new chart type declares any element it needs and returns nodes. The
  cost is one declaration per new element; the benefit is that the set
  of things macro output may contain is enumerable by reading the
  `registerMacroElements` calls, rather than by auditing every macro.

- **The declared SVG surface is deliberately narrow and will need
  widening.** `svg`, `g`, `path`, `circle`, `rect`, `text`, `desc` with
  presentation attributes only — no `foreignObject`, no `href` in any
  form, no event attributes. A future chart wanting a clip path or a
  gradient must add it consciously. That friction is the point, but it
  is friction, and a phase that needs six new elements should question
  whether it is still drawing a chart.

- **Charts are server-rendered SVG, so they are static.** No tooltips,
  no drill-through, no client interactivity — legacy's C3-based charts
  had all three. Interactivity would mean either shipping script (which
  Decision 1 makes awkward by design) or a client component that renders
  beside the macro's output rather than from it. Phase 19 should decide
  which, rather than discovering the constraint mid-phase.

- **Two clean passes run over every page body with a macro.** Measured
  against nothing; it is a tree walk over content already small enough
  that Phase 16's backlink implementation parses every page body in the
  project on every page view. If page rendering ever needs optimizing,
  this is not the first thing to look at.

- **Macro round-tripping through the TipTap editor is unaddressed.**
  Legacy stores a macro as a `<div class="macro" raw_text="…">` element
  so the editor can show a placeholder and give back the source. This
  rewrite stores the macro as literal text in the body and expands it at
  render, which means the editor currently shows raw `{{ … }}`. That is
  usable and honest, and it is not what legacy's editing experience was.

- **A macro invocation split across nodes does not expand.** Because
  expansion scans text nodes after the authored clean, a `{{ … }}` with
  a dropped element inside it survives as literal text rather than
  running with a mangled parameter. Correct, and worth knowing before
  someone reports it as a bug.

## Session

Session 8ef929, 2026-08-27 — decision taken in Phase 17 "Macro framework
and chart macros" of `docs/work/mingle-ts-full-parity/plan.md`, recorded
here after confirmation. Related: ADR-0011 Decision 7 is the invariant
this ADR implements, and ADR-0011's consequences requested Decision 2 by
name.

One thing this ADR does NOT decide, recorded so it is not read into the
above: in the Query context, projection reuses the evaluator's SQL
expression builder rather than re-deriving it. ADR-0006 names "chart
macros (Phases 17-19)" as a consumer of the same parse and rules that
"consumers never resolve names themselves" — but it governs parse-time
name resolution and canonical literals, not SQL translation. The unset
semantics the builder encodes (a managed property's value lives in a
`card_property_values` row or in no row at all) are Phase 13's, stated
in the evaluator's own header and in list-view. Sharing the builder
extends ADR-0006's principle one layer down; it is not something
ADR-0006 already decided, and if that sharing is ever revisited it is
this note, not ADR-0006, that the reviewer should weigh.
