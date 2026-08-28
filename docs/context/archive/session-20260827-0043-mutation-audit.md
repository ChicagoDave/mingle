# Session Summary: 2026-08-27 - main (2026-08-27 00:43 CDT)

## Goals
- Close the standing `pattern-recurrence-detector` recommendation (Behavior-Statement branch-coverage gap, 4 occurrences, recommended 3x with no systemic fix) by running a Stryker mutation pass over the domain layer.
- Act on the findings: close what can be closed, record the rest.

## Phase Context
- **Plan**: docs/work/mingle-ts-full-parity/plan.md — Phase 16 (Wiki pages and rich editing) DONE, Phase 17 (Macro framework and chart macros) PENDING.
- **Phase executed**: Not a plan phase — this session acted directly on a cross-session tooling recommendation, independent of the plan's phase sequence.
- **Tool calls used**: 87 / 350 (budget figure carried over from the stale session-state tier; not meaningful for a non-phase session).
- **Phase outcome**: N/A — no plan phase was in progress or advanced.

## Completed

### Stryker mutation testing installed
- `mingle-ts/package.json`: added devDependencies `@stryker-mutator/core@^10.0.0` and `@stryker-mutator/vitest-runner@^10.0.0`, and script `test:mutation` = `stryker run` (verified via `git diff`).
- `mingle-ts/stryker.config.json` (new): scope `app/domain/**/*.server.ts`, `perTest` coverage analysis, html + clear-text + progress reporters, break threshold `null` (report-only, not a gate).
- `mingle-ts/stryker.vitest.config.ts` (new): extends `vitest.config.ts`, excludes `test/healthz.real.test.ts` because its live-compose-stack precondition would score every mutant "killed" by an environment error rather than an assertion.
- `mingle-ts/.gitignore`: added `/reports/` and `/.stryker-tmp/` (verified via `git diff`).
- Mid-session defect caught by `npm run build`/typecheck: the config's base import was briefly written with a `.ts` extension (`./vitest.config.ts`), which fails `tsc` (TS5097 — import specifiers cannot end in a TS extension). Reverted to the extensionless form with a header comment explaining the tradeoff (Vite's native config loader warns but doesn't fail on it).

### Mutation pass run and findings recorded
- 5,939 mutants over 25 files in `app/domain/`, ~17 minutes, 17 workers. **84.28% total / 87.20% covered** mutation score: 4,930 killed, 72 timeout (counted as killed), 734 survived, 199 no-coverage, 4 runtime errors.
- Findings written to `docs/context/mutation-audit-20260827.md` (new file, read in full and confirmed to match this narrative).

### Finding 1 closed — rejection guards no test drove
Six tests added, each individually verified to kill its mutant (guard neutralized → new test fails; guard restored → passes): `deleteTransition` and `executeTransition` (`test/transitions.behavior.test.ts`), `generateTransitionWorkflow`, `applyCardPropertyValue`, `setPropertyTransitionOnly` (`test/transition-workflows.behavior.test.ts`), `deletePage` (`test/pages.behavior.test.ts`).

**Correction recorded in the audit doc**: three sites first reported as missing authorization tests — `transitions.server.ts:1109` (`executeBulkTransition`), `transition-workflows.server.ts:303` and `:463` — are equivalent mutants. Verified by neutralizing `if (denied) return denied` in each and observing the suite stay green: each command delegates to an inner command that re-authorizes at the same privilege level, so the outer guard is defense in depth, not a gap.

### Finding 2 closed — length limits with no at-the-boundary fixture
12 tests added covering 16 comparisons across `test/card-content`, `cards`, `favorites`, `properties`, `transitions`, `projects`, `identity` behavior test files. 15 mutants confirmed killed by the same apply/revert method. One confirmed **equivalent** and left alone: `email.length < 3` at `identity/commands.server.ts:99` and `:211` — `EMAIL_FORMAT` requires at least 5 characters, so the 3-character lower bound is unreachable.

### Not closed this session (recorded only)
- **Finding 3**: five changed-field event-payload assertions unproven (`identity/commands.server.ts:222`, `:223`; `projects/commands.server.ts:280`, `:281`, `:282`).
- **Finding 4**: 199 no-coverage mutants — MQL parser error paths (`cards/mql.server.ts`, 25 sites), `mql-evaluator.server.ts` unreached case arms, `pages/content.server.ts` numeric-entity decoder (including the whole `&#x` hex path — the sanitizer, security-relevant), `identity/password.server.ts` malformed-hash and scrypt-throws branches (also security-relevant).

## Key Decisions

### 1. Mutation testing scoped to `app/domain/**/*.server.ts` only, report-only (no break threshold)
Keeps the pass targeted at the state-mutating code Behavior Statements are written against, and avoids turning an 84% score into a hard CI gate before the team has decided that's wanted. Whether mutation testing becomes a standing gate is flagged as an open ADR-worthy question — not asked, not decided this session.

### 2. Equivalent mutants are resolved by neutralize-and-observe, not by writing a test to chase them
Four of the 25 sites first flagged as gaps turned out to be equivalent mutants (3 authorization guards that are defense-in-depth, 1 unreachable length bound). The audit doc records this as a method note: a surviving mutant is a question, not an automatic defect.

## Next Phase
- **Phase 17**: "Macro framework and chart macros" — a `{{ macro-name: params }}`-style macro parser/registry with chart macros delegating to Milestone 9's MQL evaluator, per `docs/work/mingle-ts-full-parity/plan.md`.
- **Tier**: Large (400 tool-call budget).
- **Entry state**: Phase 16 pages exist; Phase 13 MQL evaluator exists. Awaiting explicit user go-ahead per rule 5 — not started this session.

## Open Items

### Short Term
- Finding 3 (5 event-payload assertions) and Finding 4 (199 no-coverage mutants, concentrated in the MQL parser, the content sanitizer's entity decoder, and password verification) remain open in `docs/context/mutation-audit-20260827.md`.
- The `npm run build` verification-gap recommendation from `pattern-recurrence-detector` (build ran in only 2 of 14 prior sessions) is still not institutionalized into standard end-of-phase verification — it was run manually this session (confirmed clean) but not added as a standing step.

### Long Term
- Whether mutation testing becomes a standing gate (ADR-worthy question raised in the audit doc, not decided).

## Files Modified

**Mutation-testing infrastructure** (4 files):
- `mingle-ts/package.json` - added Stryker devDependencies and `test:mutation` script
- `mingle-ts/package-lock.json` - lockfile update from install
- `mingle-ts/stryker.config.json` - new, mutation scope/config
- `mingle-ts/stryker.vitest.config.ts` - new, vitest config for the mutation run (excludes the real-path healthz test)
- `mingle-ts/.gitignore` - ignores `/reports/` and `/.stryker-tmp/`

**Test files** (9 files, 18 new tests total):
- `mingle-ts/test/transitions.behavior.test.ts` - unknown-project guard tests (deleteTransition, executeTransition), boundary test (transition name)
- `mingle-ts/test/transition-workflows.behavior.test.ts` - unknown-project guard tests (generateTransitionWorkflow, applyCardPropertyValue, setPropertyTransitionOnly)
- `mingle-ts/test/pages.behavior.test.ts` - unknown-project guard test (deletePage)
- `mingle-ts/test/card-content.behavior.test.ts` - boundary test (checklist text length)
- `mingle-ts/test/cards.behavior.test.ts` - boundary test (card name length)
- `mingle-ts/test/favorites.behavior.test.ts` - boundary test (favorite name length)
- `mingle-ts/test/properties.behavior.test.ts` - boundary tests (property name, enum value, text property value lengths)
- `mingle-ts/test/projects.behavior.test.ts` - boundary tests (project identifier, project name lengths)
- `mingle-ts/test/identity.behavior.test.ts` - boundary tests (password, login, email lengths)

**Documentation** (1 file):
- `docs/context/mutation-audit-20260827.md` - new, full findings record with reproduction steps

**No files under `mingle-ts/app/` were modified** — confirmed via `git diff --stat -- mingle-ts/app/` returning empty. Mutant apply/revert cycles touched source files transiently during verification but every one was restored.

## Notes

**Session duration**: not directly recorded; event log spans 05:43–06:29 UTC (~46 minutes).

**Approach**: Install Stryker scoped to the domain layer → run the full pass → write findings to a dated audit doc → close the two findings whose mutants are unambiguously branch-coverage gaps (rejection guards, boundary comparisons) → correct the audit doc in place when verification showed 4 of the 25 flagged sites were equivalent mutants rather than gaps → leave the two findings needing broader design discussion (event-payload assertions, parser/sanitizer/password no-coverage regions) recorded but untouched.

---

## Session Metadata

- **Status**: COMPLETE
- **Blocker** (if any): N/A
- **Blocker Category**: N/A
- **Estimated Remaining**: N/A (Findings 3 and 4 are open items, not a blocker on this session's goal)
- **Rollback Safety**: safe to revert — no `app/` source files changed; all changes are new test assertions, new tooling config, and a new doc.

## Dependency/Prerequisite Check

- **Prerequisites met**: Stryker's vitest-runner requires a working vitest config to extend, which `mingle-ts/vitest.config.ts` already provided; the existing 518-test suite passing beforehand was the precondition for a clean mutation baseline.
- **Prerequisites discovered**: None.

## Architectural Decisions

- None this session. One ADR-worthy question was raised in the audit doc (mutation testing as a standing gate) but explicitly not asked or decided — flagged in Long Term open items above.

## Mutation Audit

- Files with state-changing logic modified: none in `app/domain/` — this session added tests against existing domain code, it did not modify domain code.
- Tests verify actual state mutations (not just events): YES (evidence: each of the 18 new tests was individually verified by neutralizing its target mutant, confirming the new test fails, then restoring the mutant and confirming it passes again — recorded per-test in `docs/context/mutation-audit-20260827.md` Findings 1 and 2 tables).
- If NO: N/A.

## Recurrence Check

- Similar to past issue? YES — the Behavior-Statement branch-coverage gap this session was raised to close. Prior occurrences per the audit doc: Phase 8, Phase 15, the 2026-08-26 02:49 ADR-review session (`docs/context/session-20260826-0249-main.md`), and Phase 16 (`docs/context/session-20260826-1111-main.md`). `pattern-recurrence-detector` recommended a systemic fix 3 times before this session acted on it with the Stryker pass.
- This session is the systemic fix for 2 of the 4 gap categories found (rejection guards, boundary comparisons); Findings 3 and 4 remain open, so the pattern is only partially closed.

## Test Coverage Delta

- Tests added: 18 (evidence: `npx vitest run --config stryker.vitest.config.ts` run independently this session — 17 files passed, 536 tests passed, matching the session's claimed before/after of 518 → 536).
- Tests passing before: 518 → after: 536 (evidence: fresh run, 2026-08-27, `Test Files 17 passed (17)`, `Tests 536 passed (536)`).
- `npm run typecheck` and `npm run build` both re-run independently this session and confirmed clean.
- Known untested areas: Finding 3 (5 event-payload change-list assertions) and Finding 4 (199 no-coverage mutants: MQL parser error paths, mql-evaluator unreached case arms, content sanitizer's numeric-entity decoder, password verification's malformed-hash/scrypt-throws branches) — all recorded in `docs/context/mutation-audit-20260827.md`, none closed this session.

---

**Progressive update**: Session completed 2026-08-27 01:30
