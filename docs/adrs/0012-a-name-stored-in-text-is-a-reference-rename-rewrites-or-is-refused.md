# ADR-0012: A name stored inside text is a reference — renaming it rewrites every occurrence, or it is refused

**Status**: ACCEPTED

## Context

This rewrite stores human-facing names inside human-authored text in
several places, and later resolves those names back to rows:

- page bodies store `[[Page Name]]` and `[[project_identifier/Page
  Name]]` (ADR-0011 Decision 4);
- formulas store property names as written by the author
  (`formula.server.ts`);
- MQL texts — advanced filters, and the `mql` column on saved
  favorites (ADR-0005) — store property names, card type names, and
  enumeration values;
- favorites' `filters` column stores legacy-encoded
  `[Property][operator][value]` strings, naming the property.

ADR-0004 already faced this question once and answered it the other
way: card version property snapshots are keyed by property definition
*id*, precisely so that history survives a property rename. That
decision is the counterexample that frames this one — where a machine
format could hold an id, it holds an id. The cases listed above are
different in kind: the text is authored and read by people, so the name
is not an implementation choice that could have been an id.

Three separate notes had accumulated around this without anyone
noticing they were the same note. The first is carried in session
summaries' Open Items — "a property rename must rewrite formula/MQL
texts referencing the old name" — restated every session since Phase 11
(`docs/context/session-20260825-0018-phase11-favorites.md` onward, most
recently `session-20260826-0249-main.md`), and recorded in the plan
inside Phase 8's own entry rather than as a standing item. Open,
unshaped, and carried without a decision for five sessions. Phase 16 separately decided that pages cannot be renamed,
matching legacy, where a page's name is its URL identifier. And Phase
16 introduced a third instance nobody flagged at the time:
`updateProjectSettings` permits changing `projects.identifier`, and as
of Phase 16 page bodies can contain that identifier as literal text in
a cross-project wiki link.

The temptation in each individual case is to treat the rename as a
column update, because in each individual case that is what it looks
like.

## Decision

1. **A name stored inside text that is later resolved by name is a
   reference, not a display string.** This is the general rule the
   three local cases are instances of. Renaming the referent must
   therefore do one of exactly two things: rewrite every occurrence, or
   refuse.

2. **Rewrite means rewrite, transactionally and with history.** A
   rename that takes the rewrite path must, in one transaction: find
   every text holding an occurrence, rewrite each, and append a version
   to every versioned aggregate it thereby modifies. A rewritten page
   body is a change to that page and its history must say so. A rename
   that updates the name column and rewrites nothing is forbidden,
   whatever the local convenience.

3. **Refusal is a legitimate answer, and is the current answer for
   pages.** `pages` has no rename path and the Page commands expose
   none; the name is the page's address (legacy parity). Refusing is
   not a deferral of Decision 2 — it is the other branch of it, and it
   is honest as long as it is enforced by the absence of a command
   rather than by nobody having asked yet.

4. **Prefer an id where the format is not human-authored.** ADR-0004's
   id-keyed snapshots are the pattern. A new stored format that
   *could* hold an id must hold an id; this ADR governs only the texts
   where a person writes the name.

5. **This narrows one sentence of ADR-0004.** That ADR's Consequences
   say "a property **rename** command (future) updates only
   `property_definitions.name`". Read in its own context the sentence
   is about *history* — its point is that rename must not rewrite
   snapshot rows, which remains true and is not disturbed here. Read on
   its own, "updates only" also says a rename touches nothing else,
   which this ADR contradicts: it must additionally rewrite the
   human-authored texts naming the property, or be refused. ADR-0004
   keeps its subject (snapshots are id-keyed; rename never migrates
   history); this ADR owns what else a rename owes. A pointer has been
   added to ADR-0004 so the narrower reading is not missed by someone
   reading it alone; no Status flip is required, because nothing ADR-0004
   decided is reversed.

6. **The scan is the mechanism.** `pagesLinkingTo` already locates page
   bodies referencing a given page name, going through the renderer's
   own extractor so it sees what the renderer sees. Any rewrite
   implementation uses that shape — the extractor that resolves a
   reference is the one that must find it — rather than a second,
   independently-written matcher that could disagree about what counts
   as an occurrence.

7. **`projects.identifier` is currently in violation and is recorded as
   such.** `updateProjectSettings` changes it while rewriting nothing,
   so changing a project's identifier silently breaks every
   cross-project `[[other/Page]]` link pointing into it. Phase 16
   created this exposure and this ADR names it rather than leaving it
   to be discovered. It is a defect against Decision 1, to be resolved
   by either branch of Decision 2 when the identifier-rename path is
   next touched.

## Consequences

- **The property-rename open item now has a shape.** It stops being
  "someday we must handle this" and becomes: either property rename
  rewrites every formula, MQL text and encoded filter naming the
  property, in one transaction, with versions appended where the
  rewritten thing is versioned — or property rename is refused. No
  third option, and in particular not a rename that leaves stale text
  behind to fail at evaluation time.
- **MQL and formulas are the hard instance, pages the easy one.** A
  page reference is a bracketed literal; a property name inside an MQL
  text is a token whose boundaries only the MQL parser knows. Rewriting
  it means going through the Phase 12 parser (ADR-0006) and
  re-serializing, not running a string replacement — a name substring
  can appear inside a value, a comment, or another identifier. ADR-0006
  anticipated exactly this and did two things this ADR depends on: it
  deferred legacy's `MqlGeneration` rewrite-on-rename as "a separate,
  future deliverable that re-generates text from an AST", and it
  required the AST to stay round-trippable to text, every node retaining
  its source literal. That requirement is what makes the rewrite branch
  of Decision 2 reachable for MQL at all. ADR-0006 deferred the work;
  this ADR decides its shape, so the two are not competing owners.
- **Refusal must be enforced structurally.** The reason page rename is
  safe today is that no code path performs it. Anyone adding an
  `updatePage` name parameter, or a settings form field, is making the
  decision this ADR reserves — and the reviewer's cue is that the
  change looks trivial.
- **Cross-project references raise the blast radius.** A page body can
  name another project, so a rename in one project can break content in
  another. Any rewrite implementation must search across projects, not
  only within the renamed thing's own project.
- **This constrains the REST/import surface (Phase 30).** An import that
  creates content naming things that do not exist yet, or that renames
  on the way in, is subject to this rule too; it cannot rely on
  resolution happening later.
- **Deleting is not renaming, and stays cheap.** A reference to a
  deleted page renders as a link to a page that does not exist
  (ADR-0011 Decision 4), which is exactly what a reference to a
  not-yet-written page renders as. No rewrite is owed on delete.

## Session

Session d46ff0, 2026-08-26 — decision taken in Phase 16 "Wiki pages and
rich editing" of `docs/work/mingle-ts-full-parity/plan.md`, generalizing
a page-local question into the rule that also governs the
long-standing property/MQL rename open item. Related: ADR-0011
(links stored as literal text), ADR-0004 (id-keyed snapshots, the
counterexample), ADR-0006 (the MQL parser a rewrite would go through),
ADR-0005 (favorites' stored MQL and encoded filters).
