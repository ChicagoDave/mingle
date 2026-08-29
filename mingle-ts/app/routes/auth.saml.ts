/**
 * /auth/saml — starts a SAML sign-in (resource route, GET).
 *
 * Purpose: sends the browser to the configured identity provider's
 * single sign-on URL with an AuthnRequest, remembering that the
 * sign-in was started here in the short-lived signed `mingle_saml`
 * cookie for the callback. Answers 404 when no SAML source is enabled.
 *
 * Public interface: `loader`.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { redirect } from "react-router";
import type { Route } from "./+types/auth.saml";
import { db } from "~/db/client.server";
import { beginSamlSignIn, pendingSamlHeaders, samlCallbackUrl, SamlSignInError } from "~/auth/saml-client.server";
import { sealer } from "~/auth/sealer.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";

/** GET: redirect to the identity provider, or 404 when SAML is not enabled. */
export async function loader({ request }: Route.LoaderArgs) {
  const { saml } = loadAuthenticationConfiguration(db, sealer);
  if (!saml.enabled) throw new Response("Not Found", { status: 404 });
  try {
    const { redirectTo, pending } = await beginSamlSignIn(saml, samlCallbackUrl(request));
    return redirect(redirectTo, { headers: await pendingSamlHeaders(pending) });
  } catch (error) {
    if (error instanceof SamlSignInError) return redirect(`/login?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
}
