# ADR-0011: Page content is sanitized by parse-and-rebuild, and links are literal text resolved at render

**Status**: ACCEPTED

## Context

Phase 16 introduced the Page aggregate, whose body is authored as HTML
in a TipTap editor and stored in `pages.content`. Two questions had to
be answered together, because in this rewrite one pass answers both.

The first is trust. A page body is authored markup submitted over a
form by any full team member, and it is later injected into another
team member's browser. Legacy handled this with Rails' `sanitize`
helper applied at render, in a chain with a dozen
`Renderable::Substitution` classes. A filter-based sanitizer decides
what to *remove* from a string that is otherwise passed through
verbatim, which means every case its author failed to anticipate
survives by default.

The second is resolution. Legacy pages carry `[[Page Name]]` wiki links
(with `[[display|Page]]` and `[[project/Page]]` forms) and `#123` card
links. Legacy resolved both with regular expressions over the HTML
text, guarded by a stack of lookbehind heuristics —
`is_linked_aleady?`, `is_in_html_tag?`,
`seemingly_in_the_context_of_a_src_attribute?`, whose own comment calls
it "a lame ass implementation" — each of which exists to answer a
question about tree position using string context.

Phase 17 will expand `{{ macro }}` syntax in this same content, which
makes the ordering of these passes a durable constraint rather than an
implementation detail.

A third question was forced by circumstance and is recorded here so it
is not mistaken for a considered default: the session that built Phase
16 began with no reachable npm registry, so no sanitizing library was
available.

## Decision

1. **Sanitization is parse → allowlist rebuild → serialize, not
   filtering.** `sanitizePageContent` parses the body into a small node
   tree, rebuilds it from an allowlist of elements, per-element
   attributes and URL schemes, and serializes that tree. The output is
   *generated*; no byte of input is ever passed through. Text nodes are
   escaped on the way out, unknown elements are unwrapped (their
   children kept), elements in `DROP_SUBTREE` are removed with their
   contents, raw-text elements (`script`, `style`) are skipped without
   their contents ever being parsed as markup, and `href`/`src` are
   accepted only for `http`, `https`, `mailto`, and same-document or
   site-relative references. This is safe by construction rather than
   by enumeration: an unanticipated construct is dropped by default
   instead of surviving by default.

2. **Sanitize at both boundaries.** Bodies are sanitized on write
   (`storedContent` in `commands.server.ts`, so nothing unsanitized is
   ever stored) and again on render (`renderPageContent`, so a body
   stored under an older, looser allowlist cannot leak through after
   the allowlist tightens). This is affordable because the output is a
   fixed point — `sanitize(sanitize(x)) === x` — which is asserted as a
   test, not assumed.

3. **Link substitution runs over the parsed tree's TEXT NODES.** The
   legacy guards become structural: the walk does not descend into
   `<a>`, `<code>` or `<pre>`, so text inside them is never linkified,
   and no lookbehind is needed to discover that a match sits inside a
   tag or an attribute — such a position is not a text node. Every
   legacy heuristic listed in the Context is deleted rather than
   ported.

4. **Links are stored as literal text and resolved at render.**
   `[[Page Name]]` and `#123` are stored exactly as authored — not as
   editor node types, not as ids, and not mirrored into a link table.
   Resolution happens at display time against live rows, which is why a
   link to a page that does not exist yet renders (marked with legacy's
   `non-existent-wiki-page-link` class) and becomes live the moment
   someone writes that page.

5. **No link table as a source of truth.** Backlinks
   (`pagesLinkingTo`) are computed by scanning stored bodies through
   the same extractor the renderer uses. A *derived, rebuildable index*
   over that scan is permitted as a cache when scale demands it — it
   may be dropped and recomputed from content at any time. A link table
   that is written alongside content, and could therefore disagree with
   it, is not.

6. **Emptiness is a property of what a body shows, not of its
   length.** A rich editor serializes an empty document as `<p></p>`
   and a cleared one as `<p><br></p>`. `isBlankContent` walks the
   parsed body for visible content, and a blank body is stored as NULL.

7. **ORDERING INVARIANT — every future content transform produces
   NODES, before serialization.** Nothing may append, concatenate, or
   interpolate markup into already-serialized output. This is the one
   rule in this ADR whose violation is invisible: appending an HTML
   string after `serialize` bypasses the allowlist entirely, produces
   correct-looking pages, and breaks no existing test.

8. **The sanitizer is ours, deliberately, and stays ours.** A library
   would impose a second parse of the same document and could host
   neither the substitution in Decision 3 nor Phase 17's macro
   expansion, both of which need the tree the sanitizer already built.
   The absent registry made this the only available choice at the time;
   the reasoning above is why it remains the choice now that the
   registry is reachable. Revisit if the allowlist ever needs to
   accommodate untrusted authors — a different threat model than
   authenticated team members.

## Consequences

- **Phase 17 inherits Decision 7 as its hardest constraint.** A chart
  or table macro must expand into nodes within the tree. It must also
  register whatever elements and attributes it emits (a placeholder
  `<div data-macro=…>`, for instance) with the allowlist, which is
  today a private `Set` in `content.server.ts`. That set needs an
  explicit extension point before Phase 17 edits it in place, or it
  will rot the way allowlists do.
- **The sanitizer is security-relevant code with example-based tests
  only.** Its 42 tests are adversarial but enumerated. A generative
  property test — random markup in; assert the output re-parses to
  itself and contains no `script`, no `on*` attribute, no
  `javascript:` — is the test that would catch the case none of us
  thought of, and does not exist yet.
- **Backlinks parse every page body in the project on every page
  view.** Correct and fast enough at Phase 16's scale, and the licence
  to fix it is Decision 5's derived index, not a link table.
- **Existence resolution is not batched.** `renderPageContent` resolves
  each distinct link target with its own query (memoized for the life
  of one render context). `existingPageIdentifiers` resolves a whole
  set in one query and `referencedPageIdentifiers` produces that set,
  but nothing wires them together — the batch helper is currently
  reachable only from tests.
- **Deliberate narrowings against legacy**, all in the direction of
  doing less: a `#123` with no card behind it renders as plain text
  where legacy rendered a dead link; cross-project *card* links
  (`proj/#123`) are not supported, though cross-project *wiki* links
  are; an invalid `[[…]]` target renders an inert span rather than
  linking to a `show_page_name_error` action that does not exist here;
  and entity-escaped markup decodes to text and can therefore linkify,
  where legacy treated escaping as an opt-out — `<code>` is the
  supported opt-out.
- **The editor is not a trust boundary and must never become one.**
  `PageEditor` posts through a plain `<textarea>`; the server sanitizes
  what arrives. A future change that trusts editor output because the
  editor produced it — skipping sanitization for "our own" markup —
  reopens everything this ADR closes.
- **Storing HTML rather than a structured document keeps legacy's
  shape.** It also means the storage format is only as constrained as
  the allowlist, so widening the allowlist is a schema-level decision
  in effect if not in form, and belongs in review.

## Session

Session d46ff0, 2026-08-26 — decision taken in Phase 16 "Wiki pages and
rich editing" of `docs/work/mingle-ts-full-parity/plan.md`, recorded
here after confirmation. Related: ADR-0012 governs the `[[Page Name]]`
and `[[project/Page]]` occurrences this ADR stores as literal text.
