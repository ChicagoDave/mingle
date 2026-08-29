/**
 * /auth/oidc/callback — completes a single sign-on (resource route, GET).
 *
 * Purpose: the provider redirects here with a code and state. The
 * code is exchanged and the ID token verified (app/auth/oidc-client),
 * the claims are mapped to a user by SignInExternalUser, and a
 * browser session starts. Any failure returns to /login with the
 * reason; the pending cookie is dropped either way.
 *
 * Public interface: `loader`.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { redirect } from "react-router";
import type { Route } from "./+types/auth.oidc.callback";
import { db } from "~/db/client.server";
import {
  clearPendingOidcHeaders,
  completeOidcSignIn,
  OidcSignInError,
  readPendingOidc,
} from "~/auth/oidc-client.server";
import { sealer } from "~/auth/sealer.server";
import { createUserSession } from "~/auth/session.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";
import { signInExternalUser } from "~/domain/identity/external-login.server";
import { oidcCallbackUrl } from "~/routes/auth.oidc";

/** GET: finish the sign-in and start the session, or return to /login with the reason. */
export async function loader({ request }: Route.LoaderArgs) {
  const { oidc } = loadAuthenticationConfiguration(db, sealer);
  if (!oidc.enabled) throw new Response("Not Found", { status: 404 });
  const clear = await clearPendingOidcHeaders(request);
  const fail = (message: string) => redirect(`/login?error=${encodeURIComponent(message)}`, { headers: clear });

  const pending = await readPendingOidc(request);
  if (!pending) return fail("The sign-in took too long or was not started here; please try again");
  try {
    const claims = await completeOidcSignIn(oidc, oidcCallbackUrl(request), new URL(request.url).searchParams, pending);
    const result = signInExternalUser(db, { claims, autoEnroll: oidc.autoEnroll });
    if (!result.ok) return fail(result.errors.login?.[0] ?? "Sign-in refused");
    const response = await createUserSession(result.value.id, "/profile");
    for (const [name, value] of new Headers(clear)) response.headers.append(name, value);
    return response;
  } catch (error) {
    if (error instanceof OidcSignInError) return fail(error.message);
    throw error;
  }
}
