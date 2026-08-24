/**
 * /profile — profile settings (display name, email, password change).
 *
 * Purpose: the Phase 2 profile route. Two forms post to one action,
 * discriminated by the `intent` field: "profile" runs UpdateUserProfile,
 * "password" runs ChangePassword. Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/profile";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { users } from "~/db/schema/identity";
import {
  changePassword,
  updateUserProfile,
} from "~/domain/identity/commands.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the logged-in user's editable profile fields. */
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Response("Not Found", { status: 404 });
  return {
    login: user.login,
    name: user.name,
    email: user.email,
    admin: user.admin,
  };
}

/**
 * Dispatches the posted form by `intent` to UpdateUserProfile or
 * ChangePassword; returns field errors, or a saved flag on success.
 */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "profile") {
    const result = updateUserProfile(db, {
      userId,
      name: String(form.get("name") ?? ""),
      email: form.get("email") ? String(form.get("email")) : null,
    });
    return result.ok
      ? { saved: "profile" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "password") {
    const result = changePassword(db, {
      userId,
      currentPassword: String(form.get("currentPassword") ?? ""),
      newPassword: String(form.get("newPassword") ?? ""),
    });
    return result.ok
      ? { saved: "password" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Profile page. Styling is deliberately minimal until the UX-harvest phases. */
export default function Profile() {
  const user = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {user.name} <small>({user.login}{user.admin ? ", administrator" : ""})</small>
      </h1>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}

      <h2>Profile</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="profile" />
        <p>
          <label>
            Display name
            <br />
            <input name="name" defaultValue={user.name} />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <p>
          <label>
            Email
            <br />
            <input name="email" type="email" defaultValue={user.email ?? ""} />
          </label>
          <ErrorLines field="email" errors={errors} />
        </p>
        <button type="submit">Save profile</button>
      </Form>

      <h2>Change password</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="password" />
        <p>
          <label>
            Current password
            <br />
            <input name="currentPassword" type="password" />
          </label>
          <ErrorLines field="currentPassword" errors={errors} />
        </p>
        <p>
          <label>
            New password
            <br />
            <input name="newPassword" type="password" />
          </label>
          <ErrorLines field="newPassword" errors={errors} />
        </p>
        <button type="submit">Change password</button>
      </Form>

      <Form method="post" action="/logout">
        <button type="submit">Sign out</button>
      </Form>
    </main>
  );
}

/** Renders a field's error messages, if any. */
function ErrorLines({ field, errors }: { field: string; errors: FieldErrors }) {
  return (
    <>
      {errors[field]?.map((message) => (
        <span key={message} style={{ color: "crimson", display: "block" }}>
          {message}
        </span>
      ))}
    </>
  );
}
