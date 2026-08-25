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
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { asc, eq, sql } from "drizzle-orm";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.transitions";
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
import { requireUserId } from "~/auth/session.server";

/** Loads the project's transitions (described in legacy wording) and the form's option data. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
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
    .filter((definition) => definition.kind !== "formula");
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
  return {
    project: { name: project.name, identifier: project.identifier },
    transitions: transitionList,
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
  throw new Response("Unknown intent", { status: 400 });
}

/** Card transitions page: the list and the define form. Minimal styling until UX harvest. */
export default function TransitionsPage() {
  const { project, transitions, cardTypes, properties, teamMembers, groups } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData;

  return (
    <main style={{ maxWidth: 760, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Card transitions</h1>
      <p>
        <Link to={`/projects/${project.identifier}/cards`}>{project.name}</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="transition" errors={errors} />

      {transitions.length === 0 ? (
        <p>There are currently no transitions to list.</p>
      ) : (
        transitions.map((transition) => (
          <section
            key={transition.id}
            style={{ border: "1px solid #ccc", padding: "0.5rem 1rem", marginBottom: "1rem" }}
          >
            <h3>{transition.name}</h3>
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>
                    If a card <b>has</b> these properties:
                  </th>
                  <th style={{ textAlign: "left" }}>
                    Provide a transition to <b>set</b> these properties:
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ verticalAlign: "top" }}>
                    <div>
                      Type: {transition.cardTypeName ?? "(any)"}
                    </div>
                    {transition.requires.length === 0 && !transition.cardTypeName ? (
                      <div>Any value for any property</div>
                    ) : (
                      transition.requires.map((line) => <div key={line}>{line}</div>)
                    )}
                  </td>
                  <td style={{ verticalAlign: "top" }}>
                    {transition.sets.map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </td>
                </tr>
              </tbody>
            </table>
            <Form method="post">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="transitionId" value={transition.id} />
              <button type="submit">Delete</button>
            </Form>
          </section>
        ))
      )}

      <h2>Create a new transition</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="create" />
        <p>
          <label>
            Name:
            <br />
            <input name="name" />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <p>
          <label>
            Card type:
            <br />
            <select name="cardTypeId" defaultValue="">
              <option value="">(any)</option>
              {cardTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <ErrorLines field="cardType" errors={errors} />
        </p>

        {properties.length === 0 ? (
          <p>No properties defined. Define them in project settings.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Property</th>
                <th style={{ textAlign: "left" }}>
                  If a card <b>has</b>:
                </th>
                <th style={{ textAlign: "left" }}>
                  Transition <b>sets</b> to:
                </th>
              </tr>
            </thead>
            <tbody>
              {properties.map((property) => (
                <tr key={property.id}>
                  <td>{property.name}</td>
                  <td>
                    <ValueField
                      name={`requires[${property.id}]`}
                      property={property}
                      teamMembers={teamMembers}
                      specials={[
                        { value: "", label: "(any)" },
                        { value: TRANSITION_SPECIAL_VALUES.SET, label: "(set)" },
                      ]}
                    />
                  </td>
                  <td>
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

        <fieldset style={{ marginTop: "1rem" }}>
          <legend>Used by:</legend>
          <label>
            <input type="radio" name="usedBy" value="all" defaultChecked /> All team members
          </label>
          <br />
          <label>
            <input type="radio" name="usedBy" value="members" /> Only selected team members
          </label>
          {teamMembers.length === 0 ? (
            <div>There are no team members in the project.</div>
          ) : (
            <div style={{ marginLeft: "1.5rem" }}>
              {teamMembers.map((member) => (
                <label key={member.id} style={{ display: "block" }}>
                  <input type="checkbox" name="userIds[]" value={member.id} /> {member.name}
                </label>
              ))}
            </div>
          )}
          <label>
            <input type="radio" name="usedBy" value="groups" /> Only team members of selected
            user groups
          </label>
          {groups.length === 0 ? (
            <div>There are no groups in the project.</div>
          ) : (
            <div style={{ marginLeft: "1.5rem" }}>
              {groups.map((group) => (
                <label key={group.id} style={{ display: "block" }}>
                  <input type="checkbox" name="groupIds[]" value={group.id} /> {group.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <p>
          <button type="submit">Create transition</button>
        </p>
      </Form>
    </main>
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

function ErrorLines({ field, errors }: { field: string; errors: FieldErrors }) {
  const messages = errors[field];
  if (!messages?.length) return null;
  return (
    <ul style={{ color: "crimson", margin: "0.25rem 0" }}>
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}
