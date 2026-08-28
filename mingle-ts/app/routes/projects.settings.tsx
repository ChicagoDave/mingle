/**
 * /projects/:identifier/settings — project settings and variables.
 *
 * Purpose: the project configuration route (Phases 3–7). Forms post to
 * one action, discriminated by the `intent` field: "settings" runs
 * UpdateProjectSettings (redirecting when the identifier changed),
 * "variable" runs DefineProjectVariable, "cardType" runs
 * DefineCardType, "property" runs DefinePropertyDefinition (enumerated
 * values arrive one per line), and "transitionOnly" runs
 * SetPropertyTransitionOnly, which flips an existing property's
 * transition-only restriction (Phase 15). Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { asc, eq, sql } from "drizzle-orm";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.settings";
import {
  PROJECT_VARIABLE_DATA_TYPES,
  PROJECT_VARIABLE_DATA_TYPE_LABELS,
  DEFINABLE_PROPERTY_KINDS,
  PROPERTY_KIND_LABELS,
  type FieldErrors,
  type PropertyKind,
} from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects, projectVariables } from "~/db/schema/projects";
import { cardTypes } from "~/db/schema/cards";
import { enumerationValues, propertyDefinitions } from "~/db/schema/properties";
import { setPropertyTransitionOnly } from "~/domain/cards/properties.server";
import {
  defineProjectVariable,
  updateProjectSettings,
} from "~/domain/projects/commands.server";
import { defineCardType } from "~/domain/cards/commands.server";
import { definePropertyDefinition } from "~/domain/cards/properties.server";
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
  const types = db
    .select({ id: cardTypes.id, name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, project.id))
    .orderBy(asc(cardTypes.position))
    .all();
  const definitions = db
    .select({
      id: propertyDefinitions.id,
      name: propertyDefinitions.name,
      kind: propertyDefinitions.kind,
      formula: propertyDefinitions.formula,
      transitionOnly: propertyDefinitions.transitionOnly,
    })
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .orderBy(asc(propertyDefinitions.position))
    .all();
  const allowedValues = db
    .select({
      propertyDefinitionId: enumerationValues.propertyDefinitionId,
      value: enumerationValues.value,
    })
    .from(enumerationValues)
    .innerJoin(
      propertyDefinitions,
      eq(propertyDefinitions.id, enumerationValues.propertyDefinitionId),
    )
    .where(eq(propertyDefinitions.projectId, project.id))
    .orderBy(asc(enumerationValues.position))
    .all();
  const properties = definitions.map((definition) => ({
    ...definition,
    values: allowedValues
      .filter((row) => row.propertyDefinitionId === definition.id)
      .map((row) => row.value),
  }));
  return {
    project: {
      name: project.name,
      identifier: project.identifier,
      description: project.description,
    },
    variables,
    cardTypes: types,
    properties,
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
  if (intent === "cardType") {
    const result = defineCardType(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      actorUserId: userId,
    });
    return result.ok
      ? { saved: "cardType" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "property") {
    const result = definePropertyDefinition(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      kind: String(form.get("kind") ?? ""),
      values: String(form.get("values") ?? "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      formula: form.get("formula") ? String(form.get("formula")) : null,
      nullIsZero: form.get("nullIsZero") === "on",
      transitionOnly: form.get("transitionOnly") === "on",
      actorUserId: userId,
    });
    return result.ok
      ? { saved: "property" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "transitionOnly") {
    const result = setPropertyTransitionOnly(db, {
      projectId: project.id,
      propertyDefinitionId: Number(form.get("propertyDefinitionId") ?? 0),
      transitionOnly: form.get("transitionOnly") === "on",
      actorUserId: userId,
    });
    return result.ok
      ? { saved: "property" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Project settings page. Styling is deliberately minimal until the UX-harvest phases. */
export default function ProjectSettings() {
  const { project, variables, cardTypes, properties } =
    useLoaderData<typeof loader>();
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
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/team`}>Team</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/groups`}>Groups</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/transitions`}>Transitions</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/trees`}>Trees</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/cards`}>Cards</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/wiki`}>Pages</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/murmurs`}>Murmurs</Link> ·{" "}
        <a href={`/projects/${project.identifier}/export`} download>
          Export as template
        </a>
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

      <h2>Card types</h2>
      <ul>
        {cardTypes.map((type) => (
          <li key={type.id}>{type.name}</li>
        ))}
      </ul>
      <Form method="post">
        <input type="hidden" name="intent" value="cardType" />
        <p>
          <label>
            Name
            <br />
            <input name="name" />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <button type="submit">Add card type</button>
      </Form>

      <h2>Card properties</h2>
      <ErrorLines field="property" errors={errors} />
      {properties.length === 0 ? (
        <p>No properties defined.</p>
      ) : (
        <ul>
          {properties.map((property) => (
            <li key={property.id}>
              {property.name} —{" "}
              {PROPERTY_KIND_LABELS[property.kind as PropertyKind] ??
                property.kind}
              {property.kind === "enumerated" ? (
                <>: {property.values.join(", ") || "(no values)"}</>
              ) : property.kind === "formula" ? (
                <>: {property.formula}</>
              ) : null}
              {property.transitionOnly ? <> — transition only</> : null}
              {property.kind === "formula" || property.kind === "aggregate" ? null : (
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="transitionOnly" />
                  <input
                    type="hidden"
                    name="propertyDefinitionId"
                    value={property.id}
                  />
                  {property.transitionOnly ? null : (
                    <input type="hidden" name="transitionOnly" value="on" />
                  )}
                  <button type="submit" style={{ marginLeft: "0.5rem" }}>
                    {property.transitionOnly
                      ? "Allow direct changes"
                      : "Restrict to transitions"}
                  </button>
                </Form>
              )}
            </li>
          ))}
        </ul>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="property" />
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
            Kind
            <br />
            <select name="kind" defaultValue="text">
              {DEFINABLE_PROPERTY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {PROPERTY_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <ErrorLines field="kind" errors={errors} />
        </p>
        <p>
          <label>
            Values (managed list only, one per line)
            <br />
            <textarea name="values" rows={4} />
          </label>
          <ErrorLines field="values" errors={errors} />
        </p>
        <p>
          <label>
            Formula (formula kind only, e.g. 'Estimate' * 2)
            <br />
            <input name="formula" />
          </label>{" "}
          <label>
            <input type="checkbox" name="nullIsZero" /> Treat unset numbers
            as 0
          </label>
          <ErrorLines field="formula" errors={errors} />
        </p>
        <p>
          <label>
            <input type="checkbox" name="transitionOnly" /> Only a transition
            may change this property
          </label>
          <ErrorLines field="transitionOnly" errors={errors} />
        </p>
        <button type="submit">Add property</button>
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
