/**
 * /login — sign-in form.
 *
 * Purpose: verifies credentials through the configured strategies
 * (Mingle password, or LDAP when enabled — app/auth/sign-in.server.ts)
 * and starts a browser session; offers single sign-on when an OIDC
 * source is enabled (Phase 31). Rejections are a single generic
 * message (no account enumeration), matching the commands' contract.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/login";
import { db } from "~/db/client.server";
import { sealer } from "~/auth/sealer.server";
import { createUserSession } from "~/auth/session.server";
import { signInWithCredentials } from "~/auth/sign-in.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";

/** Whether single sign-on is offered, and any message a failed SSO attempt returned with. */
export async function loader({ request }: Route.LoaderArgs) {
  const { oidc } = loadAuthenticationConfiguration(db, sealer);
  return {
    sso: oidc.enabled ? { displayName: oidc.displayName } : null,
    error: new URL(request.url).searchParams.get("error"),
  };
}

/** Handles the login POST: the configured strategies, then session on success. */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const result = await signInWithCredentials({
    login: String(form.get("login") ?? ""),
    password: String(form.get("password") ?? ""),
  });
  if (!result.ok) return { errors: result.errors };
  return createUserSession(result.value.id, "/profile");
}

/** Sign-in form. Styling is deliberately minimal until the UX-harvest phases. */
export default function Login() {
  const { sso, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const message = actionData?.errors?.login?.[0] ?? error;
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Sign in to Mingle</h1>
      {message ? <p style={{ color: "crimson" }}>{message}</p> : null}
      {sso ? (
        <p>
          <a href="/auth/oidc">Sign in with {sso.displayName}</a>
        </p>
      ) : null}
      <Form method="post">
        <p>
          <label>
            Sign-in name
            <br />
            <input name="login" />
          </label>
        </p>
        <p>
          <label>
            Password
            <br />
            <input name="password" type="password" />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </Form>
      <p>
        New here? <a href="/register">Sign up</a>
      </p>
    </main>
  );
}
