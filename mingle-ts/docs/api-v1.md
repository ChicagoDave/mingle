# Mingle API v1

The public API lives under `/api/v1` and speaks JSON. Every route is a
resource route module under `app/routes/api.v1.*.ts`; the wire shapes are
the `Api*` types in `app/shared/wire-types.ts`, which the routes and the
tests share by import (rule 8b). This document is checked against
`app/routes.ts` by `test/api-docs.behavior.test.ts`: a route added, removed,
or given a new method without a matching row below fails the suite.

## Authentication

The API never consults the browser session cookie (ADR-0020). Two schemes
are accepted on the `Authorization` header; a missing, malformed, unknown,
revoked, or unverifiable credential is `401` with a `WWW-Authenticate`
challenge naming both.

| Scheme | Header | Notes |
|---|---|---|
| Bearer key | `Authorization: Bearer <key>` | A key generated on **Profile → API keys**; shown once. Its last use is stamped on every authenticated request. |
| HMAC signature | `Authorization: Mingle-HMAC-SHA256 <login>:<base64 signature>` plus `X-Mingle-Date: <RFC 3339>` | The signature is HMAC-SHA256, under the key's signing secret, of four lines: `METHOD`, path with query, the `X-Mingle-Date` value verbatim, and the hex SHA-256 of the body (`""` hashes too). The date must be within ±15 minutes of the server. `app/domain/identity/api-signing.server.ts` is the reference implementation clients can copy. A secret is rotated from **Profile → API keys → Rotate**; the replaced secret keeps verifying for 24 hours after the rotation, then is refused. |

Authorization after authentication is the same checkpoint the UI uses
(ADR-0003): a route runs the domain command as the calling user, and the
command decides.

## Envelope

- A successful single resource is the resource itself, `200` (or `201` on
  create, `204` with no body on delete).
- A successful collection is one page, `ApiPage<T>`:

  ```json
  { "items": [ ... ], "nextCursor": "eyJ..." }
  ```

  `?limit=` sizes the page (default 50, maximum 200 — larger is clamped;
  non-positive or non-numeric is `400`). `nextCursor` is an opaque keyset
  cursor: send it back as `?cursor=` for the next page; `null` means the
  last page. A cursor the API did not issue is `400`. Keyset paging means a
  write between two requests never shifts or repeats items — a deliberate
  departure from legacy's `page=` (proposal P-1).

- Every non-2xx response is `ApiErrorBody`:

  ```json
  { "error": "one human-readable line", "errors": { "field": ["message"] } }
  ```

  `errors` is present when a command rejected the request, keyed by the
  field the message is about, in legacy Mingle's phrasing.

## Status mapping

| Status | Meaning |
|---|---|
| `400` | The request itself is malformed: not a JSON object, a field of the wrong type, a bad `limit`/`cursor`, an invalid card filter (`errors.filters` carries the list page's messages), a non-multipart attachment upload. |
| `401` | No usable credential (see Authentication). |
| `403` | The authorization checkpoint refused the calling user (`errors.authorization`). |
| `404` | No such project, card, page, murmur, attachment, or definition. |
| `405` | Method not supported on the route; `Allow` names the supported ones. |
| `422` | The command rejected the request on its own rules (blank or taken name, an unknown property or user named in a definition, a value invalid for its kind, a card type still in use, ...). |

## Routes

Paths are written as `app/routes.ts` writes them (`:identifier` is the
project identifier). The **Methods** column is the drift guard: a route's
module must export `loader` for `GET` and `action` for the others, and name
each non-GET method it handles.

| Route | Methods | Resource |
|---|---|---|
| `/api/v1/projects` | GET, POST | Page of `ApiProject` by name; `ApiCreateProjectBody` creates one (site admin). |
| `/api/v1/projects/:identifier` | GET | One `ApiProject`. |
| `/api/v1/projects/:identifier/card_types` | GET, POST | Page of `ApiCardType` in display order; `ApiDefineCardTypeBody` defines one (project admin). |
| `/api/v1/projects/:identifier/card_types/:id` | GET, DELETE | One `ApiCardType`; DELETE refuses the last type or one in use by a card or a tree (`422`) and deletes the transitions restricted to it. |
| `/api/v1/projects/:identifier/property_definitions` | GET, POST | Page of `ApiPropertyDefinition` in display order; `ApiDefinePropertyDefinitionBody` defines one (project admin). |
| `/api/v1/projects/:identifier/transitions` | GET, POST | Page of `ApiTransition` by name; `ApiDefineTransitionBody` defines one by property/type/user/group names (project admin). A prerequisite `value: null` requires the property to be unset (ADR-0010). |
| `/api/v1/projects/:identifier/transitions/:id` | GET, DELETE | One `ApiTransition`; editing is delete-and-recreate (ADR-0007). |
| `/api/v1/projects/:identifier/cards` | GET, POST | Page of `ApiCard` newest first, filtered by repeated `filters[]=[Property][operator][value]` or one `filters[mql]=`; `ApiCreateCardBody` creates a card with its properties in one transaction → `ApiCardWrite`. |
| `/api/v1/projects/:identifier/cards/:number` | GET, PATCH, DELETE | One `ApiCard`; `ApiUpdateCardBody` changes fields and properties (a transition-only property runs its transition, ADR-0008) → `ApiCardWrite`; DELETE removes the card (project admin). |
| `/api/v1/projects/:identifier/cards/:number/transitions` | GET, POST | Page of `ApiAvailableTransition` the caller may execute now; `ApiExecuteTransitionBody` executes one → `ApiTransitionExecution`. |
| `/api/v1/projects/:identifier/cards/:number/attachments` | GET, POST | Page of `ApiAttachment` by file name; POST is `multipart/form-data` with one `file` part (full team member). |
| `/api/v1/projects/:identifier/cards/:number/attachments/:attachmentId` | GET | The stored bytes with their content type and a download disposition; `Accept: application/json` returns the `ApiAttachment` instead. |
| `/api/v1/projects/:identifier/pages` | GET, POST | Page of `ApiWikiPage` by name; `ApiCreateWikiPageBody` creates one — the body is sanitized by the command (ADR-0011). |
| `/api/v1/projects/:identifier/pages/:pagename` | GET | One `ApiWikiPage` by URL identifier (the name with `_` for spaces, matched case-insensitively). |
| `/api/v1/projects/:identifier/murmurs` | GET, POST | Page of `ApiMurmur` newest first; `ApiPostMurmurBody` posts one — `@` mentions and `#123` card references resolve at post time (ADR-0017) and are reported as `mentions` and `cards`. |
| `/api/v1/projects/:identifier/murmurs/:id` | GET | One `ApiMurmur`. |

## Not in the API

Everything else in the product (favorites, trees, dependencies, programs,
history and subscriptions, integrations, authentication settings) is
UI-only. The `/healthz` probe is not part of `/api/v1` and needs no
credential.
