/**
 * OIDC relying-party client — the Authorization Code + PKCE flow
 * against a configured OpenID provider (Phase 31).
 *
 * Purpose: turns the site's `OidcSettings` into a sign-in: discovers
 * the provider's endpoints, sends the browser to authorize with a
 * fresh state/nonce/PKCE verifier kept in a short-lived signed cookie,
 * then exchanges the returned code for tokens, verifies the ID token's
 * signature against the provider's JWKS and its issuer/audience/nonce,
 * and hands the claims to the Identity domain as
 * `ExternalIdentityClaims`. No identity is ever trusted from a bare
 * assertion — the token is verified end to end.
 *
 * Public interface: `beginOidcSignIn`, `completeOidcSignIn`,
 * `OidcSignInError`, `readPendingOidc`, `pendingOidcHeaders`,
 * `clearPendingOidcHeaders`.
 *
 * Owner context: infrastructure (OIDC protocol adapter) for Identity
 * & Access.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createCookieSessionStorage } from "react-router";
import { appSecret } from "~/auth/secret.server";
import type { OidcSettings } from "~/domain/identity/auth-configuration.server";
import type { ExternalIdentityClaims } from "~/domain/identity/external-login.server";

/** A sign-in that could not be completed; the message is safe to show. */
export class OidcSignInError extends Error {}

/** What is remembered between the redirect out and the callback in. */
export interface PendingOidc {
  state: string;
  nonce: string;
  verifier: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

/** Discovery documents by issuer; refetched when older than an hour. */
const discoveries = new Map<string, { fetchedAt: number; document: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Fetches (or reuses) the provider's discovery document. */
async function discover(issuer: string) {
  const cached = discoveries.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached;
  let document: Discovery;
  try {
    const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    document = (await res.json()) as Discovery;
  } catch (error) {
    throw new OidcSignInError(`The sign-in provider could not be reached (${String(error)})`);
  }
  for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const)
    if (typeof document[field] !== "string") throw new OidcSignInError(`The sign-in provider's discovery document lacks ${field}`);
  const entry = { fetchedAt: Date.now(), document, jwks: createRemoteJWKSet(new URL(document.jwks_uri)) };
  discoveries.set(issuer, entry);
  return entry;
}

// ------------------------------------------------------- pending cookie

const pending = createCookieSessionStorage({
  cookie: {
    name: "mingle_oidc",
    httpOnly: true,
    sameSite: "lax",
    path: "/auth/oidc",
    maxAge: 10 * 60,
    secrets: [appSecret()],
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "true",
  },
});

/** Headers that store the pending sign-in in its signed cookie. */
export async function pendingOidcHeaders(value: PendingOidc): Promise<HeadersInit> {
  const session = await pending.getSession();
  session.set("pending", value);
  return { "Set-Cookie": await pending.commitSession(session) };
}

/** The pending sign-in from the callback request's cookie, if any. */
export async function readPendingOidc(request: Request): Promise<PendingOidc | null> {
  const session = await pending.getSession(request.headers.get("Cookie"));
  const value = session.get("pending") as PendingOidc | undefined;
  return value && typeof value.state === "string" && typeof value.nonce === "string" && typeof value.verifier === "string"
    ? value
    : null;
}

/** Headers that drop the pending cookie. */
export async function clearPendingOidcHeaders(request: Request): Promise<HeadersInit> {
  const session = await pending.getSession(request.headers.get("Cookie"));
  return { "Set-Cookie": await pending.destroySession(session) };
}

// ---------------------------------------------------------------- flow

/**
 * Starts a sign-in: the provider's authorization URL for the browser
 * and the pending values to keep for the callback.
 *
 * @param settings - the enabled OIDC settings
 * @param callbackUrl - this app's absolute callback URL (registered with the provider)
 */
export async function beginOidcSignIn(
  settings: OidcSettings,
  callbackUrl: string,
): Promise<{ redirectTo: string; pending: PendingOidc }> {
  const { document } = await discover(settings.issuer);
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(document.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", settings.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { redirectTo: url.toString(), pending: { state, nonce, verifier } };
}

/**
 * Fetches the userinfo endpoint's claims for an access token. A
 * conforming provider that issues an access token puts only `sub` in
 * the ID token and serves the profile/email claims here. Failures are
 * swallowed — the verified ID token stays authoritative — and a
 * response whose `sub` differs is discarded.
 */
async function userinfoClaims(endpoint: string | undefined, accessToken: string | undefined, sub: string): Promise<Record<string, unknown>> {
  if (!endpoint || !accessToken) return {};
  try {
    const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return {};
    const claims = (await res.json()) as Record<string, unknown>;
    return claims.sub === sub ? claims : {};
  } catch {
    return {};
  }
}

/**
 * Completes a sign-in from the callback's query: checks the state,
 * exchanges the code (client_secret_post + PKCE), verifies the ID
 * token (signature via JWKS, issuer, audience, expiry, nonce), fills
 * in profile claims from the userinfo endpoint when the ID token
 * carries only `sub`, and maps the result.
 *
 * @throws OidcSignInError on any mismatch or provider failure
 * @returns claims with kind "oidc", subject = `sub`, login =
 *   `preferred_username` | `email` | `sub`
 */
export async function completeOidcSignIn(
  settings: OidcSettings,
  callbackUrl: string,
  query: URLSearchParams,
  pendingValue: PendingOidc,
): Promise<ExternalIdentityClaims> {
  if (query.get("error")) throw new OidcSignInError(`The sign-in provider refused: ${query.get("error_description") ?? query.get("error")}`);
  const code = query.get("code");
  if (!code || query.get("state") !== pendingValue.state) throw new OidcSignInError("The sign-in response did not match the request");

  const { document, jwks } = await discover(settings.issuer);
  let tokens: { id_token?: string; access_token?: string };
  try {
    const res = await fetch(document.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        code_verifier: pendingValue.verifier,
      }),
    });
    tokens = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok) throw new Error((tokens as { error_description?: string }).error_description ?? (tokens as { error?: string }).error ?? `HTTP ${res.status}`);
  } catch (error) {
    throw new OidcSignInError(`The sign-in provider did not issue a token (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!tokens.id_token) throw new OidcSignInError("The sign-in provider did not issue an ID token");

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, jwks, { issuer: document.issuer, audience: settings.clientId }));
  } catch (error) {
    throw new OidcSignInError(`The ID token could not be verified (${error instanceof Error ? error.message : String(error)})`);
  }
  if (payload.nonce !== pendingValue.nonce) throw new OidcSignInError("The ID token's nonce did not match");
  if (typeof payload.sub !== "string" || !payload.sub) throw new OidcSignInError("The ID token has no subject");

  const wanted = ["preferred_username", "email", "name"];
  const extra = wanted.every((claim) => typeof payload[claim] === "string")
    ? {}
    : await userinfoClaims(document.userinfo_endpoint, tokens.access_token, payload.sub);
  const text = (claim: string): string | null => {
    const value = payload[claim] ?? extra[claim];
    return typeof value === "string" && value ? value : null;
  };
  return {
    kind: "oidc",
    subject: payload.sub,
    login: text("preferred_username") ?? text("email") ?? payload.sub,
    name: text("name"),
    email: text("email"),
  };
}
