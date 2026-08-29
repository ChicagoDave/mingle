/**
 * /auth/saml/callback — the assertion consumer service (resource
 * route, POST).
 *
 * Purpose: receives the identity provider's HTTP-POST Response,
 * validates it (app/auth/saml-client.server.ts), signs the user in
 * through SignInExternalUser — the same path OIDC uses, so linking,
 * auto-enrolment, and the UserLoggedIn event are shared — and starts
 * the browser session with strategy kind "saml" (ADR-0021). Any
 * refusal returns to /login with the reason. GET is not a sign-in.
 *
 * Public interface: `action`, `loader`.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { redirect } from "react-router";
import type { Route } from "./+types/auth.saml.callback";
import { db } from "~/db/client.server";
import { clearPendingSamlHeaders, completeSamlSignIn, readPendingSaml, samlCallbackUrl, SamlSignInError } from "~/auth/saml-client.server";
import { sealer } from "~/auth/sealer.server";
import { createUserSession } from "~/auth/session.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";
import { signInExternalUser } from "~/domain/identity/external-login.server";

/** GET: nothing to show — back to the sign-in page. */
export async function loader() {
  return redirect("/login");
}

/** POST: validate the Response, sign the user in, start the session, or return to /login with the reason. */
export async function action({ request }: Route.ActionArgs) {
  const { saml } = loadAuthenticationConfiguration(db, sealer);
  if (!saml.enabled) throw new Response("Not Found", { status: 404 });
  const clear = await clearPendingSamlHeaders(request);
  const fail = (message: string) => redirect(`/login?error=${encodeURIComponent(message)}`, { headers: clear });

  const pending = await readPendingSaml(request);
  if (!pending) return fail("The sign-in took too long or was not started here; please try again");
  try {
    const claims = await completeSamlSignIn(saml, samlCallbackUrl(request), await request.formData());
    const result = signInExternalUser(db, { claims, autoEnroll: saml.autoEnroll });
    if (!result.ok) return fail(result.errors.login?.[0] ?? "Sign-in refused");
    const response = await createUserSession(result.value.id, "/profile", "saml");
    for (const [name, value] of new Headers(clear)) response.headers.append(name, value);
    return response;
  } catch (error) {
    if (error instanceof SamlSignInError) return fail(error.message);
    throw error;
  }
}
