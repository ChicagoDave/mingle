/**
 * /programs — the program list and creation form (Phase 26; legacy
 * ProgramsController#index + #create).
 *
 * Purpose: lists every program with its member-project and objective
 * counts; Mingle administrators see the create form. Creation posts
 * `intent=create` and redirects to the new program.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Program Management (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/programs";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import { createProgram } from "~/domain/programs/commands.server";
import { listPrograms } from "~/domain/programs/read.server";

/** Loads every program and whether the viewer may create one. */
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  return {
    programs: listPrograms(db),
    canCreate: authorizeSiteAdminAction(db, userId) === null,
  };
}

/** Dispatches the create form to CreateProgram; redirects to the new program on success. */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "create") throw new Response("Unknown intent", { status: 400 });
  const result = createProgram(db, {
    name: String(form.get("name") ?? ""),
    identifier: String(form.get("identifier") ?? ""),
    description: String(form.get("description") ?? ""),
    actorUserId: userId,
  });
  if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
  throw redirect(`/programs/${result.value.identifier}`);
}

/** Program list page (legacy programs/index). */
export default function Programs() {
  const { programs, canCreate } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];

  return (
    <main id="programs" style={{ maxWidth: 720, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Programs</h1>
      <p>
        <Link to="/projects">Projects</Link>
      </p>
      {programs.length === 0 ? (
        <p>There are no programs yet.</p>
      ) : (
        <ul id="program-list">
          {programs.map((program) => (
            <li key={program.id}>
              <Link to={`/programs/${program.identifier}`}>
                <strong>{program.name}</strong>
              </Link>{" "}
              <small>({program.identifier})</small>
              {program.description ? <> — {program.description}</> : null}{" "}
              <small>
                {program.projectCount} project{program.projectCount === 1 ? "" : "s"}, {program.objectiveCount}{" "}
                objective{program.objectiveCount === 1 ? "" : "s"}
              </small>
            </li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {canCreate && (
        <>
          <h2>Create a program</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <p>
              <label>
                Name <input name="name" type="text" size={40} required />
              </label>
            </p>
            <p>
              <label>
                Identifier <input name="identifier" type="text" size={30} placeholder="(generated from the name)" />
              </label>
            </p>
            <p>
              <label>
                Description <input name="description" type="text" size={60} />
              </label>
            </p>
            <button type="submit">Create program</button>
          </Form>
        </>
      )}
    </main>
  );
}
