# ADR-0017: Mention and card-link resolution is frozen at post time

**Status**: ACCEPTED

## Context

Phase 20 added murmurs: short plain-text messages posted to a project
stream or as a comment on a card. Two things have to be read out of a
murmur's text — the `@` tokens naming people, and the `#123` tokens
naming cards — and the question this ADR settles is **when** that
reading happens.

Legacy answered "on every read", twice over, and in two different ways:

- **Mentions were recomputed per read.** `MurmurUserMentions` took the
  project and the body and re-scanned it, resolving `@team`, group
  names, and logins against the team *as it stood at that moment*. There
  was no mention table. Nothing persisted the answer.
- **Card links were computed once, but asynchronously.**
  `CardMurmurLinkProcessor` consumed a message off a queue after the
  murmur was already committed, scanned for card numbers, and inserted
  `card_murmur_links` rows some time later.

The read-time approach has three failures, and the interesting thing
about them is that none of them is a crash:

- **The answer drifts under the reader.** A murmur saying `@reviewers
  please look` resolves to whoever is in the Reviewers group *today*.
  Someone who joined the group last week becomes retroactively mentioned
  in a message written before they arrived; someone who left stops
  having been mentioned in a message that did name them. Neither is
  visible as a change — the murmur's text never moved.
- **It cannot be queried.** "Which murmurs mention me?" has no index to
  use. Legacy could only answer it by loading bodies and re-scanning
  them, which is why it never offered the view at all. Phase 20's plan
  named this directly as the phase's exit criterion: a mention must be
  *queryable as a distinct persisted fact — not just text matching at
  render time*.
- **Two views can disagree.** A rendered murmur decides which words are
  links by re-running resolution; a notification decides who to notify
  by re-running it too. Nothing forces the two runs to agree, and the
  same class of failure ADR-0015 and ADR-0016 were written about —
  *two derivations of the same thing that disagree, both of which look
  correct* — reappears here with people instead of card rows.

The asynchronous approach has a fourth: a murmur is committed and
visible while its links do not yet exist, so a card's discussion is
briefly, silently incomplete.

## Decision

1. **Resolution happens once, inside the posting transaction.**
   `postMurmur` and `addCardComment` write the murmur, its
   `murmur_mentions` rows, and its `card_murmur_links` rows together or
   not at all. There is no queue, no deferred processor, and no window
   in which a murmur exists with an incomplete answer.

2. **What was resolved is stored, not just who.** A mention row carries
   the resolved `user_id`, the `kind` it was written as
   (`team` / `group` / `user`), the `group_id` it expanded through when
   applicable, and the token as written. Storing only the user id would
   lose why they were mentioned; storing only the token would put the
   scan back at read time.

3. **A mention is frozen at the moment it was posted.** Later changes to
   team membership, group membership, or account activation do not
   change who a past murmur mentioned. `@team` in a murmur means the
   team as it stood when the murmur was written. This is a deliberate
   divergence from legacy, and it is the whole point: a message is a
   record of something someone said to specific people, not a live
   query re-evaluated forever.

4. **Rendering links exactly what was persisted, and derives nothing.**
   The display path reads a murmur's stored `mention_text` values and
   links those tokens; it never calls back into the resolver. A token
   that resolved to nobody stays plain text. This makes "the rendered
   murmur and the stored facts disagree" unrepresentable rather than
   merely unlikely.

5. **Card links are scoped to the murmur's own project, and a comment
   never links to the card it is on.** A `#123` naming a card in another
   project links to nothing — the number space is per project. A comment
   on card #7 whose body says `#7` produces no self-link, matching
   legacy's rejection of `origin_id`: a comment is not *also about* its
   own card.

6. **The `#123` grammar has one definition, in a cross-context module.**
   `app/domain/text-references.server.ts` owns the pattern; Wiki &
   Content imports it to linkify page bodies and Collaboration imports
   it to write card links. A second copy would let a page and a murmur
   disagree about the same characters, which is the failure this
   codebase has now designed against three times.

7. **A murmur outlives the card it was posted on, and says so.**
   Deleting a card removes the `cards` row and keeps the version trail
   (Phase 5). Its comments are not deleted and its `card_murmur_links`
   rows are not cascaded — legacy rendered "deleted card" rather than
   dropping the conversation, and a record of what people said is not
   the card's to destroy. Two things follow, and both are decided here
   rather than left to whichever reader gets there first: the comment's
   card **number** is recovered from `card_versions`, which deletion
   keeps, so a murmur never loses its origin; and a `#123` naming a
   card that no longer exists renders as **plain text, not a dead
   link**, which is the same narrowing `content.server.ts` already
   applies to page bodies.

8. **A murmur body is plain text end to end.** It is stored as typed,
   split server-side into text / card / mention segments, and rendered
   as elements from those segments. No HTML string is ever built from a
   murmur body. This is how ADR-0011's generated-not-passed-through rule
   is honoured in a context that has no editor and no sanitizer to
   inherit it from.

**Modules this governs**: `app/domain/murmurs/commands.server.ts`
(`postMurmur`, `addCardComment` — the only writers of `murmurs`,
`murmur_mentions`, `card_murmur_links`), `mentions.server.ts`
(resolution), `read.server.ts` (every view), `app/domain/text-references.server.ts`
(Decision 6), `app/components/murmur-body.tsx` (Decision 8), and
migration `0012`, which adds the three tables plus
`card_versions.comment`.

## Consequences

- **Phases 21 and 22 read these rows; they do not re-derive.** The
  history feed and subscription notifications both need "who was
  mentioned". Under this decision that is a join, and a notification
  fired later necessarily agrees with the murmur as displayed. A future
  phase re-scanning a body to answer it is a defect with a name.

- **A membership change never repairs a past mention, and never should
  be made to.** Adding someone to a group does not retroactively mention
  them. If a project ever wants "notify the group as it stands now", that
  is a *subscription* — a standing query over future events — not a
  mention, and it belongs in Phase 22's model rather than here.

- **The mention rows are the authority, so a bug in the resolver is
  permanent for murmurs already posted.** Read-time resolution would
  have healed itself on the next render; this does not. A resolver fix
  therefore needs a backfill decision, and backfilling would rewrite
  history that people may have already acted on. Accepted knowingly:
  the same property that makes the record stable makes it uncorrectable
  in place.

- **One mentioned user, one row — enforced, not assumed.** `@team @alice`
  mentions Alice once, matching legacy's `.uniq`. That is a unique index
  on `(murmur_id, user_id)`, so a resolver that stopped deduping would
  fail loudly at the database rather than quietly double-notify.

- **A stale token is possible if a login or group is ever renamed.**
  Nothing renames either today — `users.login` is set at registration
  and never changed, and groups have create and delete but no rename —
  so this is latent, not live. If a rename is added, ADR-0012 already
  decides the shape of the answer: a name stored inside text is a
  reference, so the rename rewrites every occurrence or is refused.
  Under this ADR that obligation covers **two** places, not one — the
  murmur body *and* the `mention_text` column beside it — and the
  `user_id` stays correct through either, which is why the resolution is
  stored as an id rather than a name.

- **Posting costs more than it did; reading costs far less.** A post
  runs the resolution queries and the inserts synchronously. That is
  paid once, by the author, at human typing speed. The reads it buys —
  a card's discussion, the mentions view, and Phase 22's notification
  matching — become indexed lookups instead of body scans.

- **`text-references.server.ts` is now load-bearing for two contexts.**
  Changing the `#123` pattern moves pages and murmurs together, which is
  the guarantee being bought, but it means the pattern can no longer be
  tuned for page rendering alone. Legacy's configurable
  `project.card_keywords` was deliberately not carried over; adding it
  later is a change to this shared module, not to either caller.

- **Verified by mutation, not by inspection.** 16 mutants were applied
  to this logic and reverted against `test/murmurs.behavior.test.ts`
  (36 tests); all 16 were caught, 1 to 4 tests failing per mutant.
  Six of them target this ADR's decisions directly: dropping the
  origin-card exclusion (Decision 5) fails 1, dropping the project
  scope on card links (Decision 5) fails 1, dropping mention dedupe
  (Consequence above) fails 1, rendering tokens that never resolved
  (Decision 4) fails 1, reading the origin card's number from `cards`
  instead of `card_versions` (Decision 7) fails 1, and hardcoding the
  deleted-card flag false (Decision 7) fails 1. The guarantees are
  asserted behaviour, not conventions that could erode silently.

## Session

Session eea0c3, 2026-08-27 — decision taken in Phase 20 "Murmurs,
mentions, and card comment linkage" of
`docs/work/mingle-ts-full-parity/plan.md`, recorded here after
confirmation.

Related: ADR-0015 and ADR-0016 established that two derivations of the
same thing that disagree is the failure worth designing against, and
each solved it for card data — *which rows* a query sees, and *what
order* they arrive in. This applies the same argument to a third
derivation, over people rather than rows, and answers it by storing the
result instead of by unifying the derivation, because unlike a row set a
mention has a moment attached to it.

ADR-0011 established that page content is sanitized on parse and links
resolve at render, with output generated rather than passed through.
Decision 7 keeps the generated-output half of that promise for murmurs;
Decision 4 deliberately does **not** keep the resolve-at-render half,
and the difference is the subject of this ADR. A page link is a live
pointer — `[[Roadmap]]` should find the Roadmap page that exists now. A
mention is not a pointer; it is a record of who was addressed. ADR-0011
did not decide this, and this ADR does not claim it did.

ADR-0012 is cited for exactly one thing: it decides what a rename owes
to a name stored inside text, which is the obligation a future login or
group rename would inherit. It does not decide anything about when
mentions resolve.
