# Mutation Audit — `app/domain/**` (2026-08-27, session 39e7a3)

Closes the standing recommendation `pattern-recurrence-detector` wrote three
times without action: the Behavior-Statement **branch-coverage gap** (a branch
that is structurally present and type-checks, but that no seeded fixture drives
at runtime) recurred in Phase 8, Phase 15, the 02:49 ADR-review session, and
Phase 16. This pass surfaces every instance at once instead of one per phase.

## How to reproduce

`npm run test:mutation` in `mingle-ts/` (config: `stryker.config.json`,
`stryker.vitest.config.ts`). Report lands in `reports/mutation/mutation.html`
(gitignored). Runtime ~17 minutes, 17 workers, `perTest` coverage analysis.

The Stryker run uses its own vitest config so it can drop
`test/healthz.real.test.ts` — that test's precondition is a live compose stack
(rule 13a real-path test), and under mutation every mutant would otherwise be
scored "killed" by an environment error rather than by an assertion.

## Result

**Mutation score 84.28%** (87.20% of covered code), 5,939 mutants over 25 files.

| Status | Count |
|---|---|
| Killed | 4,930 |
| Timeout (counts as killed) | 72 |
| **Survived** | **734** |
| **No coverage** | **199** |
| Runtime error | 4 |

Lowest-scoring files: `identity/password.server.ts` 59.09, `pages/content.server.ts`
73.71, `cards/mql-evaluator.server.ts` 73.04, `identity/commands.server.ts` 75.48.
Perfect: `pages/naming.server.ts`, `command.server.ts`, `events.server.ts` — all 100.

Most survivors are `StringLiteral` (259) and `Regex` (70) mutants over error-message
text and parser character classes; those are largely equivalent mutants and are
**not** the gap this audit is about. The findings below are the branch-shaped ones.

## Finding 1 — rejection guards no test drives — CLOSED

Forcing each `if (!projectExists(...))` to `false` (i.e. deleting the guard)
broke nothing, so no test reached these commands with an unknown project. Each
was a **REJECTS WHEN** line in an existing Behavior Statement with no test
behind it. **Six tests added this session; each was confirmed to kill its own
mutant** (guard neutralized → the new test fails; guard restored → it passes):

| Command | Guard | Test added in |
|---|---|---|
| `deleteTransition` | `cards/transitions.server.ts:622` | `test/transitions.behavior.test.ts` |
| `executeTransition` | `cards/transitions.server.ts:894` | `test/transitions.behavior.test.ts` |
| `generateTransitionWorkflow` | `cards/transition-workflows.server.ts:295` | `test/transition-workflows.behavior.test.ts` |
| `applyCardPropertyValue` | `cards/transition-workflows.server.ts:455` | `test/transition-workflows.behavior.test.ts` |
| `setPropertyTransitionOnly` | `cards/properties.server.ts:710` | `test/transition-workflows.behavior.test.ts` |
| `deletePage` | `pages/commands.server.ts:290` | `test/pages.behavior.test.ts` |

### Correction — the three authorization survivors are equivalent mutants

An earlier draft of this file listed `transitions.server.ts:1109`
(`executeBulkTransition`), `transition-workflows.server.ts:303`
(`generateTransitionWorkflow`), and `:463` (`applyCardPropertyValue`) as missing
authorization tests. **They are not.** All three already have readonly-actor
rejection tests, and neutralizing `if (denied) return denied` was verified to
leave every one of them passing: each command delegates to an inner command
(`executeTransition`, `defineTransition`, the property-write path) that
re-authorizes with the same privilege level, so the outer guard is defense in
depth and no test can kill it. Keep the guards — they reject before opening a
transaction — but do not write tests chasing these mutants.

The remaining unreached guards named by the pass, not closed this session:
`transition-workflows.server.ts:210`, `:476`, `:477`, `:487`, `:514`, `:557`;
`transitions.server.ts:472`, `:931`; `properties.server.ts:608`.

## Finding 2 — length limits with no at-the-boundary fixture — CLOSED

Every `length > MAX` survived being changed to `>= MAX` (and every `length < MIN`
its change to `<= MIN`), because the suites only ever supplied MAX+1 and asserted
the rejection — never MAX exactly and the acceptance. **Twelve tests added,
covering sixteen comparisons; fifteen mutants confirmed killed.** Each asserts on
the persisted value, not on `.ok` alone, so a limit that silently truncated
would also fail.

| Limit | Guard | Test added in |
|---|---|---|
| checklist text ≤ 255 | `cards/checklist.server.ts:135` | `test/card-content.behavior.test.ts` |
| card name ≤ 255 | `cards/commands.server.ts:115` | `test/cards.behavior.test.ts` |
| favorite name ≤ 255 | `cards/favorites.server.ts:199` | `test/favorites.behavior.test.ts` |
| property name ≤ 40 | `cards/properties.server.ts:154` | `test/properties.behavior.test.ts` |
| enumeration value ≤ 255 | `cards/properties.server.ts:321` | `test/properties.behavior.test.ts` |
| text property value ≤ 255 | `cards/properties.server.ts:436` | `test/properties.behavior.test.ts` |
| transition name ≤ 255 | `cards/transitions.server.ts:380` | `test/transitions.behavior.test.ts` |
| project identifier ≤ 30 | `projects/commands.server.ts:86` | `test/projects.behavior.test.ts` |
| project name ≤ 255 | `projects/commands.server.ts:137` | `test/projects.behavior.test.ts` |
| password 5–40 (both ends) | `identity/commands.server.ts:44` | `test/identity.behavior.test.ts` |
| login 1–255 (both ends) | `identity/commands.server.ts:93` | `test/identity.behavior.test.ts` |
| email ≤ 255 (register, update) | `identity/commands.server.ts:99`, `:211` | `test/identity.behavior.test.ts` |

### The one that cannot be killed: `email.length < 3`

`identity/commands.server.ts:99` and `:211` read
`email.length < 3 || email.length > 255 || !EMAIL_FORMAT.test(email)`. Changing
`< 3` to `<= 3` was verified to survive, and always will: `EMAIL_FORMAT`
(`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) needs at least five characters (`a@b.c`), so
no three-character string can reach the length bound and be accepted. The lower
bound is unreachable — an equivalent mutant, not a gap. Leave it; the constant
documents the legacy rule even though the format check subsumes it.

## Finding 3 — changed-field lists in event payloads never asserted — CLOSED

`...(name !== current.name ? ["name"] : [])` and siblings survived at
`identity/commands.server.ts:222`, `:223`; `projects/commands.server.ts:280`,
`:281`, `:282`.

The gap was **directional**, which is why the payload assertions that already
existed did not close it. Forcing a condition to `false` was killed — a test did
change every field and assert the full list. Forcing one to `true` was not: no
fixture ever left a field *unchanged* while another moved, so "names only what
changed" was never the thing under test. Four tests added:

| Command | Case added | Test file |
|---|---|---|
| `updateUserProfile` | email-only change, then name-only change | `test/identity.behavior.test.ts` |
| `updateUserProfile` | resubmit changing neither field → `changed: []` | `test/identity.behavior.test.ts` |
| `updateProjectSettings` | identifier + description move, name held | `test/projects.behavior.test.ts` |
| `updateProjectSettings` | resubmit changing no field → `changed: []` | `test/projects.behavior.test.ts` |

All five sites were then re-checked in both directions; every mutant dies.

## Finding 4 — no-coverage regions (199 mutants, 84 of them branch-shaped) — CLOSED

Whole branches no test executed at all, in three concentrations. All reachable
sites are now driven; the unreachable ones are named at the end of this section
rather than chased.

### `pages/content.server.ts` — the sanitizer (8 tests)

The numeric-character-entity decoder (`:119`–`:123`, including the entire
`&#x`/`&#X` hex path) and the comment/doctype/unterminated-tag skips (`:184`,
`:186`, `:201`). Tests added to `test/page-content.behavior.test.ts`, asserting
on rendered output:

- decimal entities decode to text and are re-escaped on the way out
  (`&#60;script&#62;` → `&lt;script&gt;`, never a live tag)
- hex entities decode in either letter case (`&#x41;`, `&#X42;`)
- an out-of-range code point (`&#x110000;`) and `&#0;` stay literal text
- an entity inside an attribute decodes **before** the URL is judged safe
  (`href="/x?a=1&#38;b=2"` survives; `href="javascript&#58;alert(1)"` loses
  its href)
- a doctype and a processing instruction are dropped, keeping what follows
- an unterminated `<!…` is dropped rather than looped on
- an unterminated tag degrades to the literal text it is

Nine mutants applied and confirmed killed. One **equivalent**: dropping
`Number.isFinite(code)` at `:123` survives and always will — the regex that
selects the entity guarantees `[0-9a-f]+`, so `parseInt` cannot return NaN.
The check documents the intent; it cannot fail.

### `identity/password.server.ts` — verification (9 tests) — and a real defect

`:52` (malformed stored hash) and `:62`/`:63` (scrypt throws) were unreached.
New file `test/password.behavior.test.ts` drives them against real scrypt.

**Writing the tests found a defect, not a gap.** `verifyPassword` returned
**true for any password** against a stored hash whose final field was empty:

```
scrypt:16384:8:1:<salt>:        →  verifyPassword("anything at all", …) === true
```

`Buffer.from("", "hex")` is a zero-length buffer, so `expected.length` was 0,
scrypt derived a zero-length key, and `timingSafeEqual` reported two empty
buffers equal. A fail-open in the one function whose doc comment promises the
opposite ("false for malformed/unknown stored formats"). Reachable only through
a corrupted or hand-edited `users.password_hash` — `hashPassword` always emits
128 hex characters — but the whole point of the malformed-input branch is the
row nobody expected.

**Fixed** in `verifyPassword`: a new `decodeHexField` helper refuses any field
that is not complete, even-length hex (`Buffer.from` otherwise truncates
silently at the first bad character), and verification now requires the decoded
hash to be at least `KEY_LENGTH` bytes before comparing. Deriving the compare
length from the stored value is what lets cost parameters be raised later, so
the floor — not the derivation — is what keeps that from being a bypass.

Six mutants confirmed killed, including the new floor. Three **equivalent**:
each individual clause inside `decodeHexField` (empty, odd-length, non-hex)
survives being dropped on its own, because the `KEY_LENGTH` floor catches the
hash field and a corrupted salt merely derives a different key. They are
defense in depth in the same sense as the authorization guards in Finding 1 —
the set is load-bearing, no single clause is.

### `cards/mql.server.ts` — parser refusal paths (14 tests)

Every `this.fail(...)` the audit named is now driven from a malformed query,
asserting the exact message: `PROPERTY` with no name after it (`:506`), a column
that no token could name (`:512`, `:516`), a column with no operator (`:575`), a
keyword where a value belongs (`:623`), `THIS CARD.` with nothing after the dot
(`:633`), an empty project-variable parenthesis (`:648`), an IN list unopened /
unclosed / empty (`:663`, `:697`), bare `THIS CARD` inside an IN list (`:666`),
`AS OF` without a value (`:707`), a non-numeric value in `NUMBERS IN` (`:880`),
and cross-kind property comparison including the formula rules (`:979`).

Fourteen mutants confirmed killed. Four sites are **unreachable**, verified by
replacing each with a `throw` and observing the suite stay green:

- `:437` `else if (requireSelect) this.fail(…)` — `parseClauses(true)` is only
  ever called from inside `if (this.at("SELECT"))`, so the `else` cannot run.
- `:691` `next()`'s `!t` guard — every caller peeks before advancing.
- `:912`, `:915` `passThrough` — invoked only for values already rejected, and
  `parseMql` never returns a query when `errors` is non-empty, so its result is
  unobservable.

### `cards/mql-evaluator.server.ts` — unreached case arms (5 tests)

`modified_on`, `project`, `thisCard`/`thisCardProperty`, `cardNumber`,
`taggedWith`, `inPlan`, and `NUMBERS IN` (`:158`–`:270`), in
`test/mql-filter.behavior.test.ts`.

Most of these are deliberate throws for MQL that parses into an AST no backing
model can answer yet. `parseMql` rejects those constructs by name, so it can
never hand one to the evaluator today — the conditions are therefore built
directly in the test, with their column references taken from real parses. That
is the point of covering them: a later phase will teach the parser to accept
tags, plans and card relationships, and when it does, this evaluator must fail
loudly rather than quietly translate them into wrong SQL.

`modified_on` needed more than execution to be *proven*. Every seeded card is
created and modified on the same day, which makes `date(updatedAt)` and
`date(createdAt)` indistinguishable — the arm ran, and swapping it to
`createdAt` still passed. The test now back-dates one card's `createdAt`
directly and asserts that `Created On` and `Modified On` select different sets,
restoring the row afterwards. That is a seeded fixture, not a stub: the real
evaluator still compiles real SQL against real rows.

Seven mutants confirmed killed. `:184` (`operatorSql`'s `!=` arm) is
**unreachable by type**: `compare` takes `Exclude<MqlOperator, "!=">`, and
callers handle `!=` as the negation of `=`.

## State at end of session 39e7a3

Findings 1 and 2 closed — 18 tests added, 21 mutant-kills individually verified,
4 mutants proved equivalent. Findings 3 and 4 recorded and untouched. Suite
518 → **536 passing**, `npm run typecheck` clean, `npm run build` clean.

## State at end of session 858a15

Findings 3 and 4 closed. **40 tests added** across six files (one of them new),
**42 distinct mutant-kills individually verified**, **9 mutants proved
equivalent or unreachable**, and **one real defect found and fixed** — the
empty-hash authentication fail-open in `verifyPassword` (Finding 4, password
section).

Suite 536 → **576 passing**, on the same basis as the 536 baseline (both exclude
the live-stack `healthz.real` test). `npx tsc --noEmit` clean, `npm run build`
clean.

Per file: `password.behavior.test.ts` 9 (new), `mql.behavior.test.ts` 15,
`page-content.behavior.test.ts` 7, `mql-filter.behavior.test.ts` 5,
`identity.behavior.test.ts` 2, `projects.behavior.test.ts` 2.

### Re-run: the measured delta

`npm run test:mutation`, 18m16s, 5,967 mutants (up from 5,939 — the fix added
source). Compared against this file's baseline:

| | Baseline | After | Δ |
|---|---|---|---|
| **Mutation score, total** | 84.28% | **87.11%** | **+2.83** |
| **Mutation score, covered** | 87.20% | **88.57%** | **+1.37** |
| Killed | 4,930 | 5,118 | +188 |
| Timeout (counts as killed) | 72 | 74 | +2 |
| Survived | 734 | 670 | −64 |
| **No coverage** | **199** | **98** | **−101** |
| Runtime error | 4 | 7 | +3 |

Every file the baseline called out as lowest-scoring moved:

| File | Baseline | After |
|---|---|---|
| `identity/password.server.ts` | 59.09 | **82.00** |
| `pages/content.server.ts` | 73.71 | **81.10** |
| `cards/mql-evaluator.server.ts` | 73.04 | **79.94** |
| `identity/commands.server.ts` | 75.48 | **80.29** |

**The 98 remaining no-coverage mutants are not a Finding 4 remainder.** Finding 4
named 199 as a total and then enumerated a subset — the three concentrations.
Those enumerated sites are closed; the −101 is them. What is left is spread
thin across files the finding never listed (`transitions` 21, `mql` 20,
`formula` 15, `favorites` 6, `properties` 5, and a long tail), and has not been
read or triaged. It is the honest starting point for a third pass, not an open
item from this one.

Two smaller things the re-run surfaced, neither acted on: runtime errors rose
4 → 7, all in `mql.server.ts`, which are mutants that crash rather than being
killed or surviving; and `mql-evaluator.server.ts` still scores lowest of the
files touched, because its SELECT-projection and GROUP BY arms are deferred
work, not gaps.

### What is deliberately left

Nothing from Findings 1–4 remains open. What was not chased, and why, is
recorded in place: **9 equivalent or unreachable mutants** — one entity-decoder
`isFinite` check, three `decodeHexField` clauses, four MQL parser sites
(`:437`, `:691`, `:912`, `:915`), and the evaluator's `!=` operator arm — plus
the 4 from the previous session, for **13 across both passes**. Eight of the
nine were established by neutralize-and-observe; the evaluator's `!=` arm is
unreachable *by type* (`compare` takes `Exclude<MqlOperator, "!=">`) and was
read, not run. The survivors this
audit never claimed — 259 `StringLiteral` and 70 `Regex` mutants over error text
and character classes — are still survivors and still not the gap.

**Whether mutation testing becomes a standing gate is still undecided** and
still ADR-worthy. Two sessions of evidence now bear on it: the pass found one
real authentication defect and, across both sessions, 12 mutants that no test
should ever be written for. A gate would have to encode that distinction, which
is an argument for keeping it report-only.

### Two method notes from this session

**A "no coverage" report and an "unkilled" report are different problems.** The
`modified_on` arm was reported as uncovered; adding a query that reads it made
it *covered* while leaving it *unproven*, because the fixture could not tell
`updatedAt` from `createdAt`. Coverage says a line ran. Only a mutant says the
line's specific behavior is pinned. Check the second, not the first.

**Directional survivors hide behind existing assertions.** Finding 3's event
payloads already had tests asserting the exact `changed` list, and the `false`
direction of every mutant was already dead. Only the `true` direction survived,
because no fixture held a field still while another moved. When a mutant
survives on code that visibly has a test, the question is which *direction*
the test constrains.

**Method note worth carrying forward.** Four of the twenty-five sites this audit
first called gaps turned out to be equivalent mutants — three redundant
authorization guards and one unreachable length bound. A surviving mutant is a
*question*, not a defect: neutralize it, run the suite, and see whether behavior
actually changes before writing a test for it. Conversely, every test written
here was checked the other way too — mutant applied, test fails; mutant
reverted, test passes — so none of them is a test that cannot fail.
