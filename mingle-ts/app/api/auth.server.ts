/**
 * API authentication — resolves the credentials on an /api/v1 request.
 *
 * Purpose: the one place API routes decide who is calling. Two schemes
 * are accepted, both distinct from the browser session (plan, Phases
 * 30–31); the session cookie is deliberately never consulted, so a
 * browser cannot be made to call the API with ambient credentials:
 *
 *   Authorization: Bearer <key>                       (Phase 30)
 *   Authorization: Mingle-HMAC-SHA256 <login>:<sig>   (Phase 31)
 *     + X-Mingle-Date, per app/domain/identity/api-signing.server.ts
 *
 * Public interface: `requireApiUser`, `AUTHENTICATE_HEADER`.
 *
 * Owner context: Public API (HTTP adapter) for Identity & Access.
 */
import type { UserRow } from "~/db/schema/identity";
import { db } from "~/db/client.server";
import { sealer } from "~/auth/sealer.server";
import { authenticateApiKey, verifySignedRequest } from "~/domain/identity/api-keys.server";
import { bodySha256, canonicalRequest, DATE_HEADER, HMAC_SCHEME } from "~/domain/identity/api-signing.server";
import { apiError } from "~/api/http.server";

/** The challenge sent with every 401. */
export const AUTHENTICATE_HEADER = { "WWW-Authenticate": `Bearer realm="mingle-api", ${HMAC_SCHEME} realm="mingle-api"` };

const unauthenticated = (message: string) => apiError(401, message, undefined, AUTHENTICATE_HEADER);

/**
 * Authenticates the request by its Authorization header.
 *
 * @param request - the incoming API request (its body is read from a
 *   clone for the HMAC scheme; the route still reads the original)
 * @returns the user the credentials belong to
 * @throws a 401 JSON Response (with a WWW-Authenticate challenge) when
 *   the header is missing or malformed, the bearer key is unknown or
 *   revoked, or the signature does not verify (unknown login, wrong
 *   secret, altered request, or a date outside the allowed window).
 *   Cookies are never consulted.
 */
export async function requireApiUser(request: Request): Promise<UserRow> {
  const header = request.headers.get("Authorization");
  if (!header)
    throw unauthenticated(`Authentication required: send 'Authorization: Bearer <key>' or '${HMAC_SCHEME} <login>:<signature>'`);

  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (bearer) {
    const user = authenticateApiKey(db, bearer[1]);
    if (!user) throw unauthenticated("Invalid or revoked API key");
    return user;
  }

  const signed = new RegExp(`^${HMAC_SCHEME}\\s+([^:\\s]+):(\\S+)\\s*$`, "i").exec(header);
  if (signed) {
    const date = request.headers.get(DATE_HEADER);
    if (!date) throw unauthenticated(`A signed request must carry the ${DATE_HEADER} header`);
    const url = new URL(request.url);
    const body = await request.clone().text();
    const user = verifySignedRequest(db, sealer, {
      login: signed[1],
      signature: signed[2],
      date,
      canonical: canonicalRequest({ method: request.method, pathWithQuery: url.pathname + url.search, date, bodySha256: bodySha256(body) }),
    });
    if (!user) throw unauthenticated("Invalid request signature");
    return user;
  }

  throw unauthenticated("Unsupported Authorization scheme");
}
