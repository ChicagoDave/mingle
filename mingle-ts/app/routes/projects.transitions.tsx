/**
 * /projects/:identifier/transitions — card transitions administration.
 *
 * Purpose: the Phase 14 "Card transitions" page (legacy
 * transitions/list.rhtml + _form.rhtml). Lists every transition as
 * legacy did — "If a card has these properties" → "Provide a transition
 * to set these properties" — and offers one define form: name, card
 * type, a "requires" selector per property (any / (set) / a specific
 * value), a "sets" selector per property (no change / (not set) /
 * (user input - required) / (user input - optional) / a value), and
 * "Used by" (all team members / selected members / selected groups).
 * Two intents post to one action: "create" runs DefineTransition and
 * "delete" runs DeleteTransition. Authorization is enforced by the
 * command handlers (project-admin, legacy parity); the route surfaces
 * rejections. Requires a logged-in session.
 *
 * Wire shape of the create form: `requires[<definitionId>]` and
 * `sets[<definitionId>]` carry a literal value or one of
 * TRANSITION_SPECIAL_VALUES; an empty string means no requirement / no
 * action. `usedBy` is all | members | groups with `userIds[]` /
 * `groupIds[]` alongside.
 *
 * Since Phase 15 the page also carries the workflow generator: picking
 * a card type and a managed list property previews the "Move <Type> to
 * <Value>" chain that would be generated (a GET that puts the choice in
 * the URL, so the preview is linkable), and generating writes the whole
 * chain in one transaction.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { asc, eq, sql } from "drizzle-orm";
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.transitions";
import { ActionBar, FormItem, ErrorLines, FlashBox, AdminPage } from "~/components/forms";
import "../styles/transitions.css";
import {
  TRANSITION_SPECIAL_VALUES,
  type FieldErrors,
  type TransitionActionInputMode,
} from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { cardTypes } from "~/db/schema/cards";
import { enumerationValues, propertyDefinitions } from "~/db/schema/properties";
import { users } from "~/db/schema/identity";
import { groups, teamMemberships } from "~/db/schema/membership";
import {
  defineTransition,
  deleteTransition,
  describeAction,
  describePrerequisite,
  loadTransitionNames,
  loadTransitions,
  type TransitionActionInput,
  type TransitionPrerequisiteInput,
} from "~/domain/cards/transitions.server";
import {
  generateTransitionWorkflow,
  previewTransitionWorkflow,
} from "~/domain/cards/transition-workflows.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the project's transitions (described in legacy wording) and the form's option data. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const names = loadTransitionNames(db, project.id);
  const transitionList = loadTransitions(db, project.id).map((detail) => ({
    id: detail.transition.id,
    name: detail.transition.name,
    cardTypeName: detail.transition.cardTypeId
      ? db
          .select({ name: cardTypes.name })
          .from(cardTypes)
          .where(eq(cardTypes.id, detail.transition.cardTypeId))
          .get()?.name ?? null
      : null,
    requires: detail.prerequisites.map((p) => describePrerequisite(p, names)),
    sets: detail.actions.map((a) => describeAction(a, names)),
  }));
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
    })
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .orderBy(asc(propertyDefinitions.position))
    .all()
    .filter((definition) => definition.kind !== "formula" && definition.kind !== "aggregate");
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
  const teamMembers = db
    .select({ id: users.id, name: users.name })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, project.id))
    .orderBy(sql`lower(${users.name})`)
    .all();
  const projectGroups = db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(eq(groups.projectId, project.id))
    .orderBy(sql`lower(${groups.name})`)
    .all();
  // The workflow generator's preview: a GET selection, so it is
  // linkable and survives a reload before anything is written.
  const workflowCardTypeId = Number(url.searchParams.get("workflow_card_type") ?? 0);
  const workflowPropertyId = Number(url.searchParams.get("workflow_property") ?? 0);
  const preview =
    workflowCardTypeId > 0 && workflowPropertyId > 0
      ? previewTransitionWorkflow(
          db,
          project.id,
          workflowCardTypeId,
          workflowPropertyId,
        )
      : null;

  return {
    project: { name: project.name, identifier: project.identifier },
    transitions: transitionList,
    workflow: {
      cardTypeId: workflowCardTypeId > 0 ? workflowCardTypeId : null,
      propertyDefinitionId: workflowPropertyId > 0 ? workflowPropertyId : null,
      preview: preview?.ok ? preview.value : null,
      errors: preview && !preview.ok ? preview.errors : ({} as FieldErrors),
    },
    cardTypes: types,
    properties: definitions.map((definition) => ({
      ...definition,
      allowedValues: allowedValues
        .filter((row) => row.propertyDefinitionId === definition.id)
        .map((row) => row.value),
    })),
    teamMembers,
    groups: projectGroups,
  };
}

/** Translates a posted "sets" field into an action input, or null for "no change". */
function actionFromField(
  propertyDefinitionId: number,
  posted: string,
): TransitionActionInput | null {
  if (posted === "") return null;
  const modes: Record<string, TransitionActionInputMode> = {
    [TRANSITION_SPECIAL_VALUES.USER_INPUT_REQUIRED]: "user_input_required",
    [TRANSITION_SPECIAL_VALUES.USER_INPUT_OPTIONAL]: "user_input_optional",
  };
  if (posted in modes)
    return { propertyDefinitionId, inputMode: modes[posted], value: null };
  return {
    propertyDefinitionId,
    inputMode: "fixed",
    value: posted === TRANSITION_SPECIAL_VALUES.NOT_SET ? null : posted,
  };
}

/** Translates a posted "requires" field into a prerequisite input, or null for "any". */
function prerequisiteFromField(
  propertyDefinitionId: number,
  posted: string,
): TransitionPrerequisiteInput | null {
  if (posted === "") return null;
  if (posted === TRANSITION_SPECIAL_VALUES.SET)
    return { kind: "has_set_value", propertyDefinitionId };
  // "(not set)" is the nil-valued specific-value requirement — the one a
  // generated workflow puts on its first step (Phase 15).
  if (posted === TRANSITION_SPECIAL_VALUES.NOT_SET)
    return { kind: "has_specific_value", propertyDefinitionId, value: null };
  return { kind: "has_specific_value", propertyDefinitionId, value: posted };
}

/** Dispatches the posted form by `intent` to DefineTransition or DeleteTransition. */
export async function action({ request, params }: Route.ActionArgs) {
  const actorUserId = await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "create") {
    const prerequisites: TransitionPrerequisiteInput[] = [];
    const actions: TransitionActionInput[] = [];
    for (const [key, raw] of form.entries()) {
      const value = String(raw);
      const requires = /^requires\[(\d+)\]$/.exec(key);
      if (requires) {
        const prerequisite = prerequisiteFromField(Number(requires[1]), value);
        if (prerequisite) prerequisites.push(prerequisite);
      }
      const sets = /^sets\[(\d+)\]$/.exec(key);
      if (sets) {
        const action = actionFromField(Number(sets[1]), value);
        if (action) actions.push(action);
      }
    }
    const usedBy = String(form.get("usedBy") ?? "all");
    if (usedBy === "members") {
      const userIds = form.getAll("userIds[]").map(Number);
      if (userIds.length === 0)
        return {
          errors: {
            prerequisites: ["Please select at least one team member"],
          } satisfies FieldErrors,
        };
      for (const userId of userIds) prerequisites.push({ kind: "is_user", userId });
    } else if (usedBy === "groups") {
      const groupIds = form.getAll("groupIds[]").map(Number);
      if (groupIds.length === 0)
        return {
          errors: { prerequisites: ["Please select at least one group"] } satisfies FieldErrors,
        };
      for (const groupId of groupIds) prerequisites.push({ kind: "in_group", groupId });
    }
    const cardTypeId = form.get("cardTypeId") ? Number(form.get("cardTypeId")) : null;
    const result = defineTransition(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      cardTypeId,
      prerequisites,
      actions,
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "delete") {
    const result = deleteTransition(db, {
      projectId: project.id,
      transitionId: Number(form.get("transitionId") ?? 0),
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "generate-workflow") {
    const result = generateTransitionWorkflow(db, {
      projectId: project.id,
      cardTypeId: Number(form.get("cardTypeId") ?? 0),
      propertyDefinitionId: Number(form.get("propertyDefinitionId") ?? 0),
      actorUserId,
    });
    return result.ok
      ? {
          generated: {
            cardTypeName: result.value.cardTypeName,
            propertyName: result.value.propertyName,
            names: result.value.transitions.map((entry) => entry.name),
          },
        }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Card transitions — legacy transitions/list.rhtml with _transition.rhtml and _action_bar.rhtml, plus transitions/new.rhtml's form and the transition-workflow generator, beside the admin nav. */
export default function TransitionsPage() {
  const {
    project,
    transitions,
    cardTypes,
    properties,
    teamMembers,
    groups,
    workflow,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData;
  const generated =
    actionData && "generated" in actionData ? actionData.generated : null;
  const listProperties = properties.filter(
    (property) => property.kind === "enumerated",
  );

  return (
    <AdminPage identifier={project.identifier} current="transitions">
      <ActionBar>
        <a href="#new-transition" className="add-transition link_as_button primary">
          Create new card transition
        </a>
        <a href="#transition-workflow" className="add-transition-workflow">
          Create new transition workflow
        </a>
      </ActionBar>
      <h1>Card transitions</h1>
      {saved ? <FlashBox kind="success">Transition was successfully saved.</FlashBox> : null}
      {generated ? (
        <FlashBox kind="success">
          Generated {generated.names.length} transition{generated.names.length === 1 ? "" : "s"} for{" "}
          {generated.cardTypeName} / {generated.propertyName}: {generated.names.join(", ")}.
        </FlashBox>
      ) : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="transition" errors={errors} />

      <div id="content-simple">
        {transitions.length === 0 ? (
          <div id="no-transition-message" className="no-transition-message">
            There are currently no transitions to list. You can <a href="#new-transition">create a new transition</a> or{" "}
            <a href="#transition-workflow">generate a new transition workflow</a>.
          </div>
        ) : null}
        <div id="all-transitions">
          {transitions.map((transition) => (
            <div className="transition-container" id={`transition-${transition.id}`} key={transition.id}>
              <h3>{transition.name}</h3>
              <div className="transition-detail">
                <table className="reset-table">
                  <thead>
                    <tr>
                      <th>
                        If a card <b>has</b> these properties:
                      </th>
                      <th>&nbsp;</th>
                      <th>
                        Provide a transition to <b>set</b> these properties:
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="transition-from">
                        {transition.cardTypeName ? (
                          <p className="card-type">
                            <span className="property-name">Type:</span>{" "}
                            <span className="property-value">{transition.cardTypeName}</span>
                          </p>
                        ) : null}
                        {transition.requires.length === 0 && !transition.cardTypeName ? "Any value for any property" : null}
                        {transition.requires.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </td>
                      <td className="align-center">
                        <span className="transition-arrow-glyph" aria-label="Transition from this to this">
                          →
                        </span>
                      </td>
                      <td className="transition-to">
                        {transition.sets.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="inline-forms">
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="transitionId" value={transition.id} />
                  <button type="submit" className="delete-transition" id={`delete_${transition.id}`}>
                    Delete
                  </button>
                </Form>
              </p>
            </div>
          ))}
        </div>
      </div>

      <h2 id="transition-workflow">Generate a transition workflow</h2>
      <p className="notes">
        Generates one transition per value of a managed list property — each moving a card from the previous value
        to the next. Pair it with the property's <em>Only a transition may change this property</em> setting so cards
        move along the workflow instead of jumping between values.
      </p>
      <ErrorLines field="cardType" errors={errors} />
      <ErrorLines field="property" errors={errors} />
      <ErrorLines field="name" errors={workflow.errors} />
      <ErrorLines field="cardType" errors={workflow.errors} />
      <ErrorLines field="property" errors={workflow.errors} />
      {listProperties.length === 0 ? (
        <p className="italic-light">No managed list properties yet — a workflow needs one to order its steps.</p>
      ) : (
        <div className="transition-workflow-container">
          <Form method="get">
            <ul className="transition-actions inline-list">
              <li>
                <label htmlFor="workflow_card_type">Card type:</label>{" "}
                <select
                  id="workflow_card_type"
                  name="workflow_card_type"
                  className="card-type-selection"
                  defaultValue={workflow.cardTypeId ?? ""}
                >
                  <option value="">Select…</option>
                  {cardTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </li>
              <li>
                <label htmlFor="workflow_property">Property:</label>{" "}
                <select
                  id="workflow_property"
                  name="workflow_property"
                  className="property-definition-selection"
                  defaultValue={workflow.propertyDefinitionId ?? ""}
                >
                  <option value="">Select…</option>
                  {listProperties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </li>
              <li>
                <button type="submit" className="inline">
                  Preview workflow
                </button>
              </li>
            </ul>
          </Form>
          {workflow.preview ? (
            <>
              {workflow.preview.existingTransitionsCount > 0 ? (
                <FlashBox kind="warning">
                  {workflow.preview.existingTransitionsCount} existing transition
                  {workflow.preview.existingTransitionsCount === 1 ? "" : "s"} for {workflow.preview.cardTypeName}{" "}
                  already use {workflow.preview.propertyName}. Generating adds to them rather than replacing them.
                </FlashBox>
              ) : null}
              <ol className="workflow-preview">
                {workflow.preview.steps.map((step) => (
                  <li key={step.name}>
                    <strong>{step.name}</strong> — requires {workflow.preview?.propertyName} to be{" "}
                    {step.from === null ? "(not set)" : step.from}, sets it to {step.to}
                  </li>
                ))}
              </ol>
              <Form method="post">
                <input type="hidden" name="intent" value="generate-workflow" />
                <input type="hidden" name="cardTypeId" value={workflow.cardTypeId ?? ""} />
                <input type="hidden" name="propertyDefinitionId" value={workflow.propertyDefinitionId ?? ""} />
                <ActionBar>
                  <button type="submit" className="primary">
                    Generate {workflow.preview.steps.length} transition
                    {workflow.preview.steps.length === 1 ? "" : "s"}
                  </button>
                </ActionBar>
              </Form>
            </>
          ) : null}
        </div>
      )}

      <h2 id="new-transition">Create a new transition</h2>
      <Form method="post" id="transition-form">
        <input type="hidden" name="intent" value="create" />
        <div className="form_contents">
          <div className="form_section">
            <FormItem label="Name:" htmlFor="transition_name" required field="name" errors={errors}>
              <input id="transition_name" name="name" />
            </FormItem>
            <FormItem label="Card type:" htmlFor="transition_card_type" field="cardType" errors={errors}>
              <select id="transition_card_type" name="cardTypeId" className="card-type-selection" defaultValue="">
                <option value="">(any)</option>
                {cardTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </FormItem>
          </div>

          <div id="content-simple">
            {properties.length === 0 ? (
              <p className="italic-light">No properties defined. Define them in project settings.</p>
            ) : (
              <table className="reset-table transition-properties">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>
                      If a card <b>has</b>:
                    </th>
                    <th>
                      Transition <b>sets</b> to:
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {properties.map((property) => (
                    <tr key={property.id}>
                      <td className="property-name">{property.name}</td>
                      <td className="transition-from">
                        <ValueField
                          name={`requires[${property.id}]`}
                          property={property}
                          teamMembers={teamMembers}
                          specials={[
                            { value: "", label: "(any)" },
                            { value: TRANSITION_SPECIAL_VALUES.SET, label: "(set)" },
                            {
                              value: TRANSITION_SPECIAL_VALUES.NOT_SET,
                              label: "(not set)",
                            },
                          ]}
                        />
                      </td>
                      <td className="transition-to">
                        <ValueField
                          name={`sets[${property.id}]`}
                          property={property}
                          teamMembers={teamMembers}
                          specials={[
                            { value: "", label: "(no change)" },
                            { value: TRANSITION_SPECIAL_VALUES.NOT_SET, label: "(not set)" },
                            {
                              value: TRANSITION_SPECIAL_VALUES.USER_INPUT_REQUIRED,
                              label: TRANSITION_SPECIAL_VALUES.USER_INPUT_REQUIRED,
                            },
                            {
                              value: TRANSITION_SPECIAL_VALUES.USER_INPUT_OPTIONAL,
                              label: TRANSITION_SPECIAL_VALUES.USER_INPUT_OPTIONAL,
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ErrorLines field="prerequisites" errors={errors} />
            <ErrorLines field="actions" errors={errors} />
            <ErrorLines field="value" errors={errors} />
          </div>

          <div className="form_section last used-by">
            <h4>Used by:</h4>
            <ul className="vertical-neighbors">
              <li>
                <label className="inline">
                  <input type="radio" name="usedBy" value="all" defaultChecked /> All team members
                </label>
              </li>
              <li>
                <label className="inline">
                  <input type="radio" name="usedBy" value="members" /> Only selected team members
                </label>
                {teamMembers.length === 0 ? (
                  <div className="notes">There are no team members in the project.</div>
                ) : (
                  <ul className="vertical-neighbors selected-members">
                    {teamMembers.map((member) => (
                      <li key={member.id}>
                        <label className="inline">
                          <input type="checkbox" name="userIds[]" value={member.id} /> {member.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
              <li>
                <label className="inline">
                  <input type="radio" name="usedBy" value="groups" /> Only team members of selected user groups
                </label>
                {groups.length === 0 ? (
                  <div className="notes">There are no groups in the project.</div>
                ) : (
                  <ul className="vertical-neighbors selected-groups">
                    {groups.map((group) => (
                      <li key={group.id}>
                        <label className="inline">
                          <input type="checkbox" name="groupIds[]" value={group.id} /> {group.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            </ul>
          </div>
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Create transition
          </button>
        </ActionBar>
      </Form>
    </AdminPage>
  );
}

/**
 * A "requires"/"sets" field for one property: a select when the property
 * has a closed value set (enumerated, user), otherwise a free-text input
 * with the special values offered by a datalist.
 */
function ValueField({
  name,
  property,
  teamMembers,
  specials,
}: {
  name: string;
  property: { id: number; kind: string; allowedValues: string[] };
  teamMembers: { id: number; name: string }[];
  specials: { value: string; label: string }[];
}) {
  if (property.kind === "enumerated" || property.kind === "user") {
    const options =
      property.kind === "enumerated"
        ? property.allowedValues.map((value) => ({ value, label: value }))
        : teamMembers.map((member) => ({ value: String(member.id), label: member.name }));
    return (
      <select name={name} defaultValue="">
        {specials.map((special) => (
          <option key={special.label} value={special.value}>
            {special.label}
          </option>
        ))}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  const listId = `${name}-specials`;
  return (
    <>
      <input name={name} list={listId} placeholder={specials[0].label} />
      <datalist id={listId}>
        {specials
          .filter((special) => special.value !== "")
          .map((special) => (
            <option key={special.value} value={special.value} />
          ))}
      </datalist>
    </>
  );
}
