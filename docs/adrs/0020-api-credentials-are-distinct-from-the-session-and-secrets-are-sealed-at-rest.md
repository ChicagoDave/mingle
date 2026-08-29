# ADR-0020: API credentials are distinct from the browser session; verifiable secrets are hashed, usable secrets are sealed

**Status**: ACCEPTED

## Context

Phase 30 added the public `/api/v1` HTTP API and Phase 31 added external
sign-in (OIDC, LDAP) and HMAC request signing. Each needed a place to
stand on three questions the legacy product answered loosely:

1. **What authenticates an API request?** Legacy accepted the session
   cookie, HTTP basic auth, a plaintext `users.api_key` sent as a
   bearer, and `ApiAuth` HMAC signatures with that same plaintext key as
   the secret — all on the same routes. A browser could therefore be made
   to call the API with ambient cookie credentials.
2. **How are credentials stored?** Legacy kept `api_key`, the LDAP bind
   password, and SSO client secrets in the clear (database column or
   `auth_config.yml`).
3. **What does an API error mean?** Legacy rendered `errors.to_xml` with
   422 for everything the model refused, including authorization.

Phase 30 first shipped bearer keys only, hashed at rest. Phase 31's HMAC
scheme cannot work against a hash — the server must recover the secret
to recompute a signature — so a second storage rule was needed without
reopening the first.

## Decision

1. **The API never consults the session cookie.** `app/api/auth.server.ts`
   accepts exactly two schemes — `Authorization: Bearer <key>` and
   `Authorization: Mingle-HMAC-SHA256 <login>:<signature>` (with
   `X-Mingle-Date`, ±15 minutes, signing method + path/query + date +
   body SHA-256) — and answers 401 with a `WWW-Authenticate` challenge
   otherwise. No basic auth, no cookie fallback.
2. **Hash what is only verified; seal what must be used.** A bearer key
   is stored as its SHA-256 hash and shown once (`api_keys.key_hash`).
   A secret the server must read back — the HMAC signing secret minted
   with every key, the LDAP bind password, the OIDC client secret — is
   stored sealed (`app/domain/identity/sealer.server.ts`: AES-256-GCM
   under a key derived from the install secret, `app/auth/secret.server.ts`)
   and is write-only from the UI. Plaintext of either kind never enters
   an event payload, a view, a rejection message, or a log.
3. **Status codes carry the rejection's kind.** A checkpoint refusal
   (`errors.authorization`, ADR-0003) is 403; any other command rejection
   is 422 with the field errors; unknown project/card in the URL is 404;
   a malformed body or wrongly typed field is 400; a wrong method 405.
   All bodies share `ApiErrorBody`.
4. **The API adds no commands.** Every write goes through the UI's
   command handlers; where a request bundles several (a card with its
   properties), the adapter composes them on one transaction
   (`app/api/card-writes.server.ts`) so a request is all-or-nothing, and
   a transition-only property change is routed through its transition
   exactly as the card page does (ADR-0008).
5. **External identities are mapped in the domain, not the adapter.**
   OIDC and LDAP adapters produce `ExternalIdentityClaims`; the Identity
   context (`signInExternalUser`) resolves them by (kind, subject), then
   by login, then by auto-enrolment, and enrolled users carry an
   unusable password hash so ADR-0013's fail-closed verification keeps
   them out of the password form.

## Consequences

- A future authentication scheme for the API (e.g. OAuth bearer tokens
  from the Phase 31 provider) is added to `app/api/auth.server.ts` and
  must resolve to a `users` row the same way; it must not reintroduce
  the cookie.
- Any new stored secret must pick one of the two rules: hash if the
  server only verifies it, seal if it must read it back. A plaintext
  credential column is a defect.
- Rotating the install secret (`SESSION_SECRET` or the `session-secret`
  file) invalidates every sealed value: signing secrets stop verifying
  and the configured bind password / client secret read as blank until
  re-entered. Operators must treat that file as they treat the database.
- Clients can branch on status codes without parsing messages;
  message wording is free to change, the code mapping is not.
- Phase 32's inbound webhooks (GitHub signatures) must authenticate the
  same way — a per-integration sealed secret verified in the adapter,
  never the session — and outbound integrations store their tokens
  sealed.

## Session

- Decided during session a7b218 (2026-08-28), Phases 30–31 of
  `docs/work/mingle-ts-full-parity/plan.md`; summary
  `docs/context/session-20260828-*-main.md` for that session.
