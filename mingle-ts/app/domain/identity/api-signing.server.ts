/**
 * API request signing — the HMAC scheme for /api/v1 (Phase 31), the
 * successor of legacy's `ApiAuth` (`Authorization: APIAuth login:sig`).
 *
 * Purpose: one definition of what is signed and how, shared by the
 * server's verifier and by clients (the real-path test signs with
 * these same functions). A signature covers the method, the path with
 * its query, the request date, and the body's SHA-256, so a captured
 * request cannot be replayed elsewhere, later, or with another body.
 *
 * Wire format:
 *   Authorization: Mingle-HMAC-SHA256 <login>:<base64 signature>
 *   X-Mingle-Date: <RFC 3339 timestamp>, within ±15 minutes of the server
 *
 * Public interface: `HMAC_SCHEME`, `DATE_HEADER`, `SIGNATURE_WINDOW_MS`,
 * `canonicalRequest`, `bodySha256`, `signCanonical`, `signRequest`,
 * `signaturesMatch`.
 *
 * Owner context: Identity & Access (domain service, pure).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const HMAC_SCHEME = "Mingle-HMAC-SHA256";
export const DATE_HEADER = "X-Mingle-Date";
/** Legacy ApiAuth's default clock tolerance (900 s). */
export const SIGNATURE_WINDOW_MS = 15 * 60 * 1000;

/** The facts a signature covers. */
export interface CanonicalRequestInput {
  method: string;
  /** Path plus query string, e.g. `/api/v1/projects?x=1`. */
  pathWithQuery: string;
  /** The X-Mingle-Date value, verbatim. */
  date: string;
  /** Hex SHA-256 of the request body ("" hashes too). */
  bodySha256: string;
}

/** Hex SHA-256 of a request body. */
export function bodySha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** The string that is signed: four lines, in this order. */
export function canonicalRequest(input: CanonicalRequestInput): string {
  return [input.method.toUpperCase(), input.pathWithQuery, input.date, input.bodySha256].join("\n");
}

/** Base64 HMAC-SHA256 of a canonical string under a signing secret. */
export function signCanonical(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64");
}

/** Timing-safe comparison of two base64 signatures. */
export function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "base64");
  const b = Buffer.from(presented, "base64");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export interface SignRequestInput {
  login: string;
  secret: string;
  method: string;
  /** Absolute or path-only URL; only the path and query are signed. */
  url: string;
  body?: string;
  /** Defaults to now. */
  date?: Date;
}

/**
 * Produces the headers a client sends: `Authorization` and
 * `X-Mingle-Date`. Merge them with `Content-Type` and send the exact
 * body that was signed.
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const url = new URL(input.url, "http://localhost");
  const date = (input.date ?? new Date()).toISOString();
  const canonical = canonicalRequest({
    method: input.method,
    pathWithQuery: url.pathname + url.search,
    date,
    bodySha256: bodySha256(input.body ?? ""),
  });
  return {
    Authorization: `${HMAC_SCHEME} ${input.login}:${signCanonical(input.secret, canonical)}`,
    [DATE_HEADER]: date,
  };
}
