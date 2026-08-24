/**
 * /register — account registration form.
 *
 * Purpose: creates a user via the RegisterUser command and logs the
 * browser in. The first account on a fresh install becomes the admin
 * (legacy install-flow parity).
 *
 * Public interface: `action`, default component (React Router route
 * module contract).
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { Form, useActionData } from "react-router";
import type { Route } from "./+types/register";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { registerUser } from "~/domain/identity/commands.server";
import { createUserSession } from "~/auth/session.server";

/**
 * Handles the registration POST: runs RegisterUser, then starts a
 * session on success or returns field errors for the form.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const result = registerUser(db, {
    login: String(form.get("login") ?? ""),
    name: String(form.get("name") ?? ""),
    email: form.get("email") ? String(form.get("email")) : null,
    password: String(form.get("password") ?? ""),
  });
  if (!result.ok) return { errors: result.errors satisfies FieldErrors };
  return createUserSession(result.value.id, "/profile");
}

/** Registration form. Styling is deliberately minimal until the UX-harvest phases. */
export default function Register() {
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors ?? {};
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Sign up for Mingle</h1>
      <Form method="post">
        <FieldRow label="Sign-in name" name="login" errors={errors} />
        <FieldRow label="Display name" name="name" errors={errors} />
        <FieldRow label="Email (optional)" name="email" type="email" errors={errors} />
        <FieldRow label="Password" name="password" type="password" errors={errors} />
        <button type="submit">Sign up</button>
      </Form>
      <p>
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </main>
  );
}

/** One labeled input with its field errors, if any. */
function FieldRow({
  label,
  name,
  type = "text",
  errors,
}: {
  label: string;
  name: string;
  type?: string;
  errors: FieldErrors;
}) {
  return (
    <p>
      <label>
        {label}
        <br />
        <input name={name} type={type} />
      </label>
      {errors[name]?.map((message) => (
        <span key={message} style={{ color: "crimson", display: "block" }}>
          {label} {message}
        </span>
      ))}
    </p>
  );
}
