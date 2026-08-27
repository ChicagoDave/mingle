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

## Finding 3 — changed-field lists in event payloads never asserted

`...(name !== current.name ? ["name"] : [])` and siblings survive inversion, so
the emitted "which fields changed" payload is not asserted anywhere:
`identity/commands.server.ts:222`, `:223`; `projects/commands.server.ts:280`,
`:281`, `:282`.

## Finding 4 — no-coverage regions (199 mutants, 84 of them branch-shaped)

Whole branches no test executes at all. Concentrated in three places:

- `cards/mql.server.ts` — 25 sites, nearly all parser `this.fail(...)` error
  paths (`:437`, `:506`, `:512`, `:575`, `:623`, `:633`, `:648`, `:663`, `:666`,
  `:691`, `:697`, `:707`) plus type-check branches `:880`, `:912`, `:915`, `:979`.
- `pages/content.server.ts` — the numeric-character-entity decoder (`:119`–`:123`,
  including the entire `&#x`/`&#X` hex path) and the comment/doctype/unterminated-tag
  skips (`:184`, `:186`, `:201`). This is the sanitizer, where untested means
  unproven against exactly the input class ADR-0011 exists to defend.
- `cards/mql-evaluator.server.ts` — unreached `case` arms: `modified_on`,
  `project`, `!=`, `thisCard`, `cardNumber`, `taggedWith`, `inPlan` (`:158`–`:269`).

Also `identity/password.server.ts:52`, `:62`, `:63` — the malformed-hash and
scrypt-throws branches of verification, both security-relevant.

## State at end of session 39e7a3

Findings 1 and 2 closed — 18 tests added, 21 mutant-kills individually verified,
4 mutants proved equivalent. Findings 3 and 4 recorded and untouched. Suite
518 → **536 passing**, `npm run typecheck` clean, `npm run build` clean.

The score above is the pre-fix baseline; re-run `npm run test:mutation` to
measure the delta. Next is Finding 3 (five changed-field event-payload
assertions), then Finding 4, whose sanitizer entity-decoder and password
verification branches carry the most risk per test.

**Method note worth carrying forward.** Four of the twenty-five sites this audit
first called gaps turned out to be equivalent mutants — three redundant
authorization guards and one unreachable length bound. A surviving mutant is a
*question*, not a defect: neutralize it, run the suite, and see whether behavior
actually changes before writing a test for it. Conversely, every test written
here was checked the other way too — mutant applied, test fails; mutant
reverted, test passes — so none of them is a test that cannot fail.
