/**
 * /projects/:identifier/settings — project settings and variables.
 *
 * Purpose: the Phase 3 configuration route. Two forms post to one
 * action, discriminated by the `intent` field: "settings" runs
 * UpdateProjectSettings (redirecting when the identifier changed),
 * "variable" runs DefineProjectVariable. Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { eq, sql } from "drizzle-orm";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.settings";
import {
  PROJECT_VARIABLE_DATA_TYPES,
  PROJECT_VARIABLE_DATA_TYPE_LABELS,
  type FieldErrors,
} from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects, projectVariables } from "~/db/schema/projects";
import {
  defineProjectVariable,
  updateProjectSettings,
} from "~/domain/projects/commands.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the project's editable settings and its defined variables. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const variables = db
    .select({
      id: projectVariables.id,
      name: projectVariables.name,
      dataType: projectVariables.dataType,
      value: projectVariables.value,
    })
    .from(projectVariables)
    .where(eq(projectVariables.projectId, project.id))
    .orderBy(sql`lower(${projectVariables.name})`)
    .all();
  return {
    project: {
      name: project.name,
      identifier: project.identifier,
      description: project.description,
    },
    variables,
  };
}

/**
 * Dispatches the posted form by `intent` to UpdateProjectSettings or
 * DefineProjectVariable; returns field errors, or a saved flag on
 * success (redirecting when the settings change moved the identifier).
 */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "settings") {
    const result = updateProjectSettings(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      identifier: String(form.get("identifier") ?? ""),
      description: form.get("description")
        ? String(form.get("description"))
        : null,
      actorUserId: userId,
    });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    if (result.value.identifier !== params.identifier)
      throw redirect(`/projects/${result.value.identifier}/settings`);
    return { saved: "settings" as const };
  }
  if (intent === "variable") {
    const result = defineProjectVariable(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      dataType: String(form.get("dataType") ?? ""),
      value: form.get("value") ? String(form.get("value")) : null,
      actorUserId: userId,
    });
    return result.ok
      ? { saved: "variable" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Project settings page. Styling is deliberately minimal until the UX-harvest phases. */
export default function ProjectSettings() {
  const { project, variables } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;

  return (
    <main style={{ maxWidth: 560, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {project.name} <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}

      <h2>Settings</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="settings" />
        <p>
          <label>
            Name
            <br />
            <input name="name" defaultValue={project.name} />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <p>
          <label>
            Identifier
            <br />
            <input name="identifier" defaultValue={project.identifier} />
          </label>
          <ErrorLines field="identifier" errors={errors} />
        </p>
        <p>
          <label>
            Description
            <br />
            <textarea
              name="description"
              rows={4}
              defaultValue={project.description ?? ""}
            />
          </label>
          <ErrorLines field="description" errors={errors} />
        </p>
        <button type="submit">Save settings</button>
      </Form>

      <h2>Project variables</h2>
      {variables.length === 0 ? (
        <p>No project variables defined.</p>
      ) : (
        <ul>
          {variables.map((variable) => (
            <li key={variable.id}>
              ({variable.name}) —{" "}
              {PROJECT_VARIABLE_DATA_TYPE_LABELS[
                variable.dataType as keyof typeof PROJECT_VARIABLE_DATA_TYPE_LABELS
              ] ?? variable.dataType}
              {variable.value != null ? <>: {variable.value}</> : <>: (not set)</>}
            </li>
          ))}
        </ul>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="variable" />
        <p>
          <label>
            Name
            <br />
            <input name="name" />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <p>
          <label>
            Type
            <br />
            <select name="dataType" defaultValue="StringType">
              {PROJECT_VARIABLE_DATA_TYPES.map((dataType) => (
                <option key={dataType} value={dataType}>
                  {PROJECT_VARIABLE_DATA_TYPE_LABELS[dataType]}
                </option>
              ))}
            </select>
          </label>
          <ErrorLines field="dataType" errors={errors} />
        </p>
        <p>
          <label>
            Value
            <br />
            <input name="value" />
          </label>
          <ErrorLines field="value" errors={errors} />
        </p>
        <button type="submit">Define variable</button>
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
