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
import { ActionBar, FormItem, ErrorLines, FlashBox, AdminPage } from "~/components/forms";
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
  setProjectAuthenticationConstraint,
  updateProjectSettings,
} from "~/domain/projects/commands.server";
import { parsePermittedStrategyKinds } from "~/domain/identity/access-constraint.server";
import { STRATEGY_KINDS, STRATEGY_KIND_LABELS } from "~/shared/wire-types";
import { defineCardType } from "~/domain/cards/commands.server";
import { listCardDefaults, setCardDefaults } from "~/domain/cards/card-defaults.server";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import { CURRENT_USER_MARKER, DEFAULTABLE_PROPERTY_KINDS } from "~/shared/wire-types";
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
  const members = db
    .select({ id: users.id, name: users.name })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, project.id))
    .orderBy(sql`lower(${users.name})`)
    .all();
  return {
    project: {
      name: project.name,
      identifier: project.identifier,
      description: project.description,
      permittedStrategyKinds: parsePermittedStrategyKinds(project.permittedStrategyKinds),
    },
    variables,
    cardTypes: types,
    properties,
    cardDefaults: listCardDefaults(db, project.id),
    members,
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
  if (intent === "authentication") {
    const result = setProjectAuthenticationConstraint(db, {
      projectId: project.id,
      permittedStrategyKinds: form.getAll("kinds[]").map(String),
      actorUserId: userId,
    });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    return { saved: "authentication" as const };
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
  if (intent === "cardDefaults") {
    // One field per defaultable property, `default_<definition id>`; the
    // command takes names, so the ids are resolved here.
    const names = new Map(
      db
        .select({ id: propertyDefinitions.id, name: propertyDefinitions.name })
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.projectId, project.id))
        .all()
        .map((row) => [String(row.id), row.name]),
    );
    const defaults: Record<string, string | null> = {};
    for (const [key, value] of form.entries()) {
      if (!key.startsWith("default_")) continue;
      const name = names.get(key.slice("default_".length));
      if (name) defaults[name] = String(value);
    }
    const result = setCardDefaults(db, {
      projectId: project.id,
      cardTypeId: Number(form.get("cardTypeId") ?? 0),
      defaults,
      actorUserId: userId,
    });
    return result.ok
      ? { saved: "cardDefaults" as const }
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

/** Project settings — legacy projects/edit.rhtml with projects/_form.rhtml, plus the project variables, card types, and card properties admin lists (project_variables/list, card_types/list, property_definitions/index) beside the admin nav. */
export default function ProjectSettings() {
  const { project, variables, cardTypes, properties, cardDefaults, members } =
    useLoaderData<typeof loader>();
  const defaultable = properties.filter((property) =>
    (DEFAULTABLE_PROPERTY_KINDS as readonly string[]).includes(property.kind),
  );
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const savedMessage =
    saved === "settings"
      ? "Project was successfully updated."
      : saved === "variable"
        ? "Project variable was successfully created."
        : saved === "cardType"
          ? "Card type was successfully created."
          : saved === "cardDefaults"
            ? "Card defaults were successfully updated."
          : saved === "property"
            ? "Property was successfully updated."
            : saved === "authentication"
              ? "Authentication settings were successfully updated."
              : null;
  const base = `/projects/${project.identifier}`;

  return (
    <AdminPage identifier={project.identifier} current="settings">
      <h1>Project settings</h1>
      {savedMessage ? <FlashBox kind="success">{savedMessage}</FlashBox> : null}
      <div id="edit-project-settings" className="form_contents">
        <Form method="post" id="project-properties">
          <input type="hidden" name="intent" value="settings" />
          <p className="instructions">
            <span className="required">*</span> indicates a required field
          </p>
          <h2>Basic information</h2>
          <div id="basic-options-content" className="options-content">
            <div className="form_section">
              <FormItem label="Name:" htmlFor="project_name" required field="name" errors={errors}>
                <input id="project_name" name="name" className="width-large" defaultValue={project.name} />
              </FormItem>
              <FormItem
                label="Identifier:"
                htmlFor="project_identifier"
                required
                notes="should not be blank and must be less than 30 characters"
                field="identifier"
                errors={errors}
              >
                <input
                  id="project_identifier"
                  name="identifier"
                  className="width-large"
                  maxLength={30}
                  defaultValue={project.identifier}
                />
              </FormItem>
              <FormItem
                label="Description:"
                htmlFor="project_description"
                notes="this will appear under the project name in the project list"
                field="description"
                errors={errors}
              >
                <textarea id="project_description" name="description" rows={6} defaultValue={project.description ?? ""} />
              </FormItem>
            </div>
          </div>
          <ActionBar>
            <button type="submit" className="save">
              Save
            </button>
            <Link to={`${base}/cards`} className="cancel">
              Cancel
            </Link>
            <a href={`${base}/export`} download className="link_as_button">
              Export project as template
            </a>
            <a href={`${base}/export?content=1`} download className="link_as_button">
              Export with content
            </a>
          </ActionBar>
        </Form>
      </div>

      <h2 id="authentication">Authentication</h2>
      <p className="notes">
        Sign-in strategies are configured site-wide by a Mingle administrator; this project can restrict access to
        sessions opened through some of them. Members who signed in another way keep their membership and are refused
        until they sign in through a permitted strategy; API keys qualify by the linked identities of their owner.
        Mingle administrators always have access, as they do under LDAP.
      </p>
      <Form method="post" className="form_contents" id="project-authentication">
        <input type="hidden" name="intent" value="authentication" />
        <div className="form_section last">
          <ErrorLines field="permittedStrategyKinds" errors={errors} />
          <ErrorLines field="authorization" errors={errors} />
          {STRATEGY_KINDS.map((kind) => (
            <div className="checkbox_row" key={kind}>
              <input
                type="checkbox"
                id={`permitted_${kind}`}
                name="kinds[]"
                value={kind}
                defaultChecked={project.permittedStrategyKinds.includes(kind)}
              />{" "}
              <label htmlFor={`permitted_${kind}`} className="inline">
                Admit sessions signed in through {STRATEGY_KIND_LABELS[kind]}
              </label>
            </div>
          ))}
          <p className="notes">Leave every box unchecked to admit any sign-in the site allows.</p>
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Save
          </button>
        </ActionBar>
      </Form>

      <h2 id="project-variables">Project variables</h2>
      <table id="project_variables" className="highlightable-table">
        <thead>
          <tr className="table-top">
            <th>Name</th>
            <th>Type</th>
            <th className="last">Value</th>
          </tr>
        </thead>
        <tbody>
          {variables.length === 0 ? (
            <tr>
              <td colSpan={3} className="italic-light align-center last">
                There are currently no project variables to list.
              </td>
            </tr>
          ) : (
            variables.map((variable, index) => (
              <tr key={variable.id} className={index % 2 === 0 ? "odd" : "even"}>
                <td>({variable.name})</td>
                <td>
                  {PROJECT_VARIABLE_DATA_TYPE_LABELS[
                    variable.dataType as keyof typeof PROJECT_VARIABLE_DATA_TYPE_LABELS
                  ] ?? variable.dataType}
                </td>
                <td className="last">{variable.value != null ? variable.value : <span className="italic-light">(not set)</span>}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="variable" />
        <h3>Create project variable</h3>
        <div className="form_section last">
          <FormItem label="Name:" htmlFor="variable_name" required field="name" errors={errors}>
            <input id="variable_name" name="name" className="width-large" />
          </FormItem>
          <FormItem label="Type:" htmlFor="variable_data_type" required field="dataType" errors={errors}>
            <select id="variable_data_type" name="dataType" defaultValue="StringType">
              {PROJECT_VARIABLE_DATA_TYPES.map((dataType) => (
                <option key={dataType} value={dataType}>
                  {PROJECT_VARIABLE_DATA_TYPE_LABELS[dataType]}
                </option>
              ))}
            </select>
          </FormItem>
          <FormItem label="Value:" htmlFor="variable_value" field="value" errors={errors}>
            <input id="variable_value" name="value" className="width-large" />
          </FormItem>
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Create
          </button>
        </ActionBar>
      </Form>

      <h2 id="card-types">Card types</h2>
      <table id="card_types" className="highlightable-table">
        <thead>
          <tr className="table-top">
            <th className="last">Name</th>
          </tr>
        </thead>
        <tbody>
          {cardTypes.map((type, index) => (
            <tr key={type.id} className={index % 2 === 0 ? "odd" : "even"}>
              <td className="last">{type.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cardTypes.map((type) => {
        const stored = cardDefaults.find((entry) => entry.cardTypeId === type.id)?.values ?? {};
        return (
          <Form method="post" key={type.id} className="form_contents card-defaults" id={`card-defaults-${type.id}`}>
            <input type="hidden" name="intent" value="cardDefaults" />
            <input type="hidden" name="cardTypeId" value={type.id} />
            <h3>Edit '{type.name}' defaults</h3>
            <ErrorLines field="cardType" errors={errors} />
            {defaultable.length === 0 ? (
              <p className="instructions">Define a card property to give this type defaults.</p>
            ) : (
              <div className="form_section last">
                {defaultable.map((property) => {
                  const field = `default_${property.id}`;
                  const current = stored[String(property.id)] ?? "";
                  return (
                    <FormItem
                      key={property.id}
                      label={`${property.name}:`}
                      htmlFor={`${field}_${type.id}`}
                      field={`defaults.${property.name}`}
                      errors={errors}
                    >
                      {property.kind === "enumerated" ? (
                        <select id={`${field}_${type.id}`} name={field} defaultValue={current}>
                          <option value="">(not set)</option>
                          {property.values.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      ) : property.kind === "user" ? (
                        <select id={`${field}_${type.id}`} name={field} defaultValue={current}>
                          <option value="">(not set)</option>
                          <option value={CURRENT_USER_MARKER}>{CURRENT_USER_MARKER}</option>
                          {members.map((member) => (
                            <option key={member.id} value={String(member.id)}>
                              {member.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input id={`${field}_${type.id}`} name={field} defaultValue={current} className="width-large" />
                      )}
                    </FormItem>
                  );
                })}
              </div>
            )}
            <ActionBar>
              <button type="submit" className="save">
                Save defaults
              </button>
            </ActionBar>
          </Form>
        );
      })}
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="cardType" />
        <h3>Create new card type</h3>
        <div className="form_section last">
          <FormItem label="Name:" htmlFor="card_type_name" required field="name" errors={errors}>
            <input id="card_type_name" name="name" className="width-large" />
          </FormItem>
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Create
          </button>
        </ActionBar>
      </Form>

      <h2 id="card-properties">Card properties</h2>
      <ErrorLines field="property" errors={errors} />
      <table id="property_definitions" className="highlightable-table">
        <thead>
          <tr className="table-top">
            <th>Name</th>
            <th>Type</th>
            <th>Values / formula</th>
            <th>Transition only</th>
            <th className="align-right last">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {properties.length === 0 ? (
            <tr>
              <td colSpan={5} className="italic-light align-center last">
                There are currently no properties to list.
              </td>
            </tr>
          ) : (
            properties.map((property, index) => (
              <tr key={property.id} className={index % 2 === 0 ? "odd" : "even"}>
                <td>{property.name}</td>
                <td>{PROPERTY_KIND_LABELS[property.kind as PropertyKind] ?? property.kind}</td>
                <td>
                  {property.kind === "enumerated"
                    ? property.values.join(", ") || <span className="italic-light">(no values)</span>
                    : property.kind === "formula"
                      ? property.formula
                      : ""}
                </td>
                <td className="align-center">{property.transitionOnly ? "Yes" : "No"}</td>
                <td className="align-right last inline-forms">
                  {property.kind === "formula" || property.kind === "aggregate" ? null : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="transitionOnly" />
                      <input type="hidden" name="propertyDefinitionId" value={property.id} />
                      {property.transitionOnly ? null : <input type="hidden" name="transitionOnly" value="on" />}
                      <button type="submit" className="inline">
                        {property.transitionOnly ? "Allow direct changes" : "Restrict to transitions"}
                      </button>
                    </Form>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="property" />
        <h3>Create new card property</h3>
        <div className="form_section last">
          <FormItem label="Name:" htmlFor="property_name" required field="name" errors={errors}>
            <input id="property_name" name="name" className="width-large" />
          </FormItem>
          <FormItem label="Type:" htmlFor="property_kind" required field="kind" errors={errors}>
            <select id="property_kind" name="kind" defaultValue="text">
              {DEFINABLE_PROPERTY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {PROPERTY_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </FormItem>
          <FormItem
            label="Values:"
            htmlFor="property_values"
            notes="managed list only, one per line"
            field="values"
            errors={errors}
          >
            <textarea id="property_values" name="values" rows={4} />
          </FormItem>
          <FormItem
            label="Formula:"
            htmlFor="property_formula"
            notes="formula kind only, e.g. 'Estimate' * 2"
            field="formula"
            errors={errors}
          >
            <input id="property_formula" name="formula" className="width-large" />
            <div className="checkbox_row">
              <input type="checkbox" id="property_null_is_zero" name="nullIsZero" />{" "}
              <label htmlFor="property_null_is_zero" className="inline">
                Treat unset numbers as 0
              </label>
            </div>
          </FormItem>
          <div className="checkbox_row">
            <input type="checkbox" id="property_transition_only" name="transitionOnly" />{" "}
            <label htmlFor="property_transition_only" className="inline">
              Only a transition may change this property
            </label>
            <ErrorLines field="transitionOnly" errors={errors} />
          </div>
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Create
          </button>
        </ActionBar>
      </Form>
    </AdminPage>
  );
}
