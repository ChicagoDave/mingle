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
import { Form, Link, useActionData } from "react-router";
import type { Route } from "./+types/register";
import { ActionBar, FormItem } from "~/components/forms";
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
  return createUserSession(result.value.id, "/profile", "password");
}

/** Registration form — legacy users/new.rhtml with users/_form.rhtml. */
export default function Register() {
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors ?? {};
  return (
    <div id="new-user">
      <Form method="post">
        <h1>New User</h1>
        <div className="intructions">
          <p>
            <span className="required">*</span> indicates a required field
          </p>
        </div>
        <FormItem
          label="Sign-in name:"
          htmlFor="user_login"
          required
          notes="Used every time you sign in to Mingle"
          field="login"
          errors={errors}
          errorPrefix="Sign-in name"
        >
          <input id="user_login" name="login" className="large" />
        </FormItem>
        <FormItem
          label="Display name:"
          htmlFor="user_name"
          required
          notes="Used as display name in Mingle, i.e. this is the name other Mingle users see"
          field="name"
          errors={errors}
          errorPrefix="Display name"
        >
          <input id="user_name" name="name" className="large" />
        </FormItem>
        <FormItem
          label="Choose password:"
          htmlFor="user_password"
          required
          field="password"
          errors={errors}
          errorPrefix="Password"
        >
          <input id="user_password" name="password" type="password" className="large" />
        </FormItem>
        <FormItem
          label="Email:"
          htmlFor="user_email"
          notes="Used for subscribing to alerts, etc. Should be of the form sam@email.com"
          field="email"
          errors={errors}
          errorPrefix="Email"
        >
          <input id="user_email" name="email" type="email" className="large" />
        </FormItem>
        <ActionBar>
          <button type="submit" className="save">
            Create this profile
          </button>
          <Link to="/login" className="cancel">
            Cancel
          </Link>
          <span className="notes">Already have an account? Cancel returns you to sign in.</span>
        </ActionBar>
      </Form>
    </div>
  );
}
