/**
 * /login — sign-in form.
 *
 * Purpose: verifies credentials via the LogInUser command and starts a
 * browser session. Rejections are a single generic message (no account
 * enumeration), matching the command's contract.
 *
 * Public interface: `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { Form, useActionData } from "react-router";
import type { Route } from "./+types/login";
import { db } from "~/db/client.server";
import { authenticateUser } from "~/domain/identity/commands.server";
import { createUserSession } from "~/auth/session.server";

/** Handles the login POST: LogInUser, then session on success. */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const result = authenticateUser(db, {
    login: String(form.get("login") ?? ""),
    password: String(form.get("password") ?? ""),
  });
  if (!result.ok) return { errors: result.errors };
  return createUserSession(result.value.id, "/profile");
}

/** Sign-in form. Styling is deliberately minimal until the UX-harvest phases. */
export default function Login() {
  const actionData = useActionData<typeof action>();
  const message = actionData?.errors?.login?.[0];
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Sign in to Mingle</h1>
      {message ? <p style={{ color: "crimson" }}>{message}</p> : null}
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
