/**
 * /auth/oidc — starts a single sign-on (resource route, GET).
 *
 * Purpose: sends the browser to the configured OpenID provider's
 * authorization endpoint, remembering the state/nonce/PKCE verifier in
 * the short-lived signed `mingle_oidc` cookie for the callback.
 * Answers 404 when no OIDC source is enabled.
 *
 * Public interface: `loader`.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { redirect } from "react-router";
import type { Route } from "./+types/auth.oidc";
import { db } from "~/db/client.server";
import { beginOidcSignIn, OidcSignInError, pendingOidcHeaders } from "~/auth/oidc-client.server";
import { sealer } from "~/auth/sealer.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";

/** The absolute callback URL for this deployment, derived from the request. */
export function oidcCallbackUrl(request: Request): string {
  return new URL("/auth/oidc/callback", request.url).toString();
}

/** GET: redirect to the provider, or 404 when SSO is not enabled. */
export async function loader({ request }: Route.LoaderArgs) {
  const { oidc } = loadAuthenticationConfiguration(db, sealer);
  if (!oidc.enabled) throw new Response("Not Found", { status: 404 });
  try {
    const { redirectTo, pending } = await beginOidcSignIn(oidc, oidcCallbackUrl(request));
    return redirect(redirectTo, { headers: await pendingOidcHeaders(pending) });
  } catch (error) {
    if (error instanceof OidcSignInError) return redirect(`/login?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
}
