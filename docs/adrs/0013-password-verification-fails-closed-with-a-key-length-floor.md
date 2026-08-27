# ADR-0013: Password verification fails closed, with a key-length floor on the stored hash

**Status**: ACCEPTED

## Context

`app/domain/identity/password.server.ts` stores passwords in a
self-describing format:

```
scrypt:<N>:<r>:<p>:<salt-hex>:<hash-hex>
```

The format carries the cost parameters so they can be raised later
without invalidating existing hashes — an old row still verifies under
the N, r and p it was written with. Verification therefore has to take
those parameters from the stored string rather than from a constant,
and for the same reason it took the *key length* from the stored string
too, deriving it as `Buffer.from(hashHex, "hex").length`.

That derivation is what made the module's stated promise false. The
mutation audit of 2026-08-27 (`docs/context/mutation-audit-20260827.md`,
Finding 4) reported three sites in `verifyPassword` as executed by no
test — `:52`, the malformed-hash guard, and `:62`/`:63`, the branch taken
when scrypt throws. Writing those tests found the defect they were
hiding:

```
verifyPassword("any password at all", "scrypt:16384:8:1:<salt>:")  ===  true
```

An empty final field decodes to a zero-length buffer, so the derived key
length was zero, so scrypt produced zero bytes, so `timingSafeEqual`
compared two empty buffers and reported them equal. Every password
matched. The same shape appears in miniature for a *short* hash field: a
one-byte stored hash admits any password with probability 1/256.

`hashPassword` always emits 128 hex characters, so no row this system
writes can reach that state. The exposure is a corrupted, restored, or
hand-edited `users.password_hash` — which is precisely the input class
the malformed-input branch exists for. Its doc comment already promised
"false for malformed/unknown stored formats"; the code did not deliver
it.

A second, quieter version of the same problem sits next to it:
`Buffer.from(s, "hex")` does not reject bad input, it stops at the first
character it cannot read. A salt of `"zz"` decodes to zero bytes without
complaint.

## Decision

**Verification fails closed on every malformed *hex* field, and enforces a
floor on the decoded hash length.**

1. Each hex field is decoded through `decodeHexField`, which returns
   `null` unless the field is non-empty, even-length, and entirely
   `[0-9a-f]`. Silent truncation by `Buffer.from` is no longer reachable.
2. A decoded hash shorter than `KEY_LENGTH` (64 bytes) is refused before
   any comparison is attempted.
3. The compare length is still derived from the stored value, so a hash
   written at a *larger* key length continues to verify at its own
   length. The floor bounds the derivation from below; it does not
   replace it.

The choice is between the floor and the derivation, and the derivation
is the one worth keeping — it is what makes the self-describing format
mean anything. A floor is the cheapest thing that stops the derivation
from being a bypass.

**The cost fields are deliberately outside this decision.** `N`, `r` and
`p` are read from the same untrusted string and are *not* validated. They
do not fail closed the way the hex fields now do: Node's `scryptSync`
treats a falsy option as absent and substitutes its own default, so a row
whose `N` is corrupted to `0`, `""` or `" "` silently verifies under
Node's default N=16384 rather than being refused. Measured, 2026-08-27:

```
stored N/r/p = 16384 8 1
N=0     right-password -> true   wrong-password -> false
r=0     right-password -> true   wrong-password -> false
p=0     right-password -> true   wrong-password -> false
N=''    right-password -> true   wrong-password -> false
```

This is **not** a bypass — every wrong password is still rejected, because
real scrypt still runs — and an attacker who can write `password_hash`
would write their own hash rather than blank a cost field. It is left
alone for that reason. Two things follow from leaving it alone, and both
are traps for whoever revisits this:

- The benign outcome above holds only while `SCRYPT_N`/`SCRYPT_R`/
  `SCRYPT_P` happen to equal Node's defaults. Raise `SCRYPT_N` and a
  zeroed `N` field stops matching, and those rows fail closed instead —
  a change in behaviour with no change in this file.
- A non-numeric cost field (`"abc"` → `NaN`) and an out-of-range one
  (`N = 2^20`, over Node's 32MB `maxmem`) *do* fail closed, via the
  `catch`. The gap is specifically falsy-but-parseable values.

## Consequences

- **Raising `KEY_LENGTH` is no longer a free change.** Existing rows
  hold 64-byte hashes and would fall below a raised floor, so a future
  increase must either re-hash on next successful login (verify at the
  old length, re-store at the new one) or keep the floor at 64 while
  writing longer hashes. The stored format carries N, r and p but not
  the key length, so nothing in a row distinguishes "written at 64" from
  "truncated to 64" — which is why the floor is a constant and not read
  from the row. Anyone raising `KEY_LENGTH` must decide this
  deliberately; **it will not surface as a test failure.** Verified
  2026-08-27: `KEY_LENGTH` raised 64 → 128 in place, full suite re-run,
  576/576 still passing — every fixture hashes fresh at the new length,
  so no test holds a row written at the old one. The failure appears
  first in production, as users who cannot log in.
- **Cost-parameter raises are unaffected**, which was the point of the
  self-describing format. N, r and p continue to come from the row.
- **Corrupted rows now fail loudly in the only way a login may fail
  loudly** — as a rejected password, not as a 500 and not as an
  admission. `verifyPassword` still never throws.
- **The three clauses inside `decodeHexField` are individually
  redundant** and each survives being removed on its own: the floor
  catches a bad hash field, and a bad salt merely derives a different
  key. They are defense in depth, and the audit records them as
  equivalent mutants so a future pass does not chase them with tests
  that cannot fail.
- **This is the second audit finding to argue for keeping mutation
  testing report-only.** The pass found a real authentication defect
  *and* thirteen mutants that no test should ever be written for. A break
  threshold would have to tell those apart, and it cannot. Confirmed
  this session: the Stryker run stays report-only, with no break
  threshold.

## Session

Session 858a15, 2026-08-27 — decision taken while closing Findings 3 and
4 of `docs/context/mutation-audit-20260827.md`, outside the phase
sequence of `docs/work/mingle-ts-full-parity/plan.md`. Related:
ADR-0003 places the authorization checkpoint in the domain layer; this
ADR governs the credential check that runs before any of it.
