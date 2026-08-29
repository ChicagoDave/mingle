/**
 * /login — sign-in form.
 *
 * Purpose: verifies credentials through the configured strategies
 * (Mingle password, or LDAP when enabled — app/auth/sign-in.server.ts)
 * and starts a browser session; offers single sign-on for each enabled
 * OIDC (Phase 31) or SAML (P-9) source. Rejections are a single generic
 * message (no account enumeration), matching the commands' contract.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/login";
import {  } from "~/components/forms";
import "../styles/login.css";
import { db } from "~/db/client.server";
import { sealer } from "~/auth/sealer.server";
import { createUserSession } from "~/auth/session.server";
import { signInWithCredentials } from "~/auth/sign-in.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";

/** Whether single sign-on is offered, and any message a failed SSO attempt returned with. */
export async function loader({ request }: Route.LoaderArgs) {
  const { oidc, saml } = loadAuthenticationConfiguration(db, sealer);
  const sso: { kind: "oidc" | "saml"; displayName: string; href: string }[] = [];
  if (oidc.enabled) sso.push({ kind: "oidc", displayName: oidc.displayName, href: "/auth/oidc" });
  if (saml.enabled) sso.push({ kind: "saml", displayName: saml.displayName, href: "/auth/saml" });
  return {
    sso,
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
  return createUserSession(result.value.user.id, "/profile", result.value.kind);
}

/** Sign-in form — legacy users/login.rhtml (the `.profile-box` graphic dialog). */
export default function Login() {
  const { sso, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const message = actionData?.errors?.login?.[0] ?? error;
  return (
    <div id="graphic-dialog-container">
      <div id="graphic-dialog" className="profile-box">
        <div className="login-branding">
          <img src="/images/logo.png" className="login-logo" alt="mingle" />
        </div>
        <Form method="post" id="login_form" className="login-form">
          {message ? (
            <div className="error-box">
              <div id="error" className="flash-content">
                {message}
              </div>
            </div>
          ) : null}
          <label htmlFor="user_login">Sign-in name or email:</label>
          <input id="user_login" name="login" className="width-full" tabIndex={1} autoFocus />
          <label htmlFor="user_password">Password:</label>
          <input
            type="password"
            id="user_password"
            name="password"
            className="width-full"
            tabIndex={2}
            autoComplete="off"
          />
          <div className="submit-login">
            <button type="submit" className="primary" tabIndex={4}>
              Sign in
            </button>
            {sso.map((source) => (
              <div className="single-sign-on" key={source.kind}>
                <a href={source.href} id={`sign-in-${source.kind}`}>
                  Sign in with {source.displayName}
                </a>
              </div>
            ))}
            <div className="forgot-password">
              New here? <Link to="/register">Sign up</Link>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}
