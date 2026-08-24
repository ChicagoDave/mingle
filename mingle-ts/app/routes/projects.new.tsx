/**
 * /projects/new — project creation.
 *
 * Purpose: the CreateProject form (name, optional identifier,
 * description). On success, redirects to the new project's settings
 * page. Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { Form, Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/projects.new";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { createProject } from "~/domain/projects/commands.server";
import { requireUserId } from "~/auth/session.server";

/** Requires a logged-in session before showing the form. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  return null;
}

/** Runs CreateProject; redirects to the project's settings on success. */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const result = createProject(db, {
    name: String(form.get("name") ?? ""),
    identifier: form.get("identifier") ? String(form.get("identifier")) : null,
    description: form.get("description")
      ? String(form.get("description"))
      : null,
    actorUserId: userId,
  });
  if (!result.ok) return { errors: result.errors satisfies FieldErrors };
  throw redirect(`/projects/${result.value.identifier}/settings`);
}

/** Project creation page. Styling is deliberately minimal until the UX-harvest phases. */
export default function NewProject() {
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors = actionData?.errors ?? {};

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>New project</h1>
      <Form method="post">
        <p>
          <label>
            Name
            <br />
            <input name="name" required />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <p>
          <label>
            Identifier <small>(optional — generated from the name)</small>
            <br />
            <input name="identifier" />
          </label>
          <ErrorLines field="identifier" errors={errors} />
        </p>
        <p>
          <label>
            Description
            <br />
            <textarea name="description" rows={4} />
          </label>
          <ErrorLines field="description" errors={errors} />
        </p>
        <button type="submit">Create project</button>{" "}
        <Link to="/projects">Cancel</Link>
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
