/**
 * /projects/:identifier/cards/:number — card show, edit, delete, and
 * version history.
 *
 * Purpose: the single-card page (Phases 5–6). Forms post to one action
 * discriminated by `intent`: "update" runs UpdateCard, "delete" runs
 * DeleteCard (redirecting to the list), "attach" saves the uploaded
 * bytes then runs AddCardAttachment (deleting the bytes again on
 * rejection), "remove-attachment" runs RemoveCardAttachment then
 * deletes the bytes, "checklist-add"/"checklist-mark"/
 * "checklist-remove" run the checklist commands, "set-property"
 * runs SetCardPropertyValue (blank value clears), and "transition" runs
 * ExecuteTransition with `input[<definitionId>]` fields for the
 * transition's user-input actions (Phase 14; the loader offers only the
 * transitions available to this card and user, legacy
 * _card_transitions_button). The append-only
 * version trail renders newest-first with each version's property
 * snapshot. Authorization is enforced by the
 * command handlers; the route surfaces rejections. Requires a
 * logged-in session.
 *
 *
 * Since Phase 15 the property editor posts through the auto-transition
 * dispatcher, so setting a transition-only property runs the transition
 * that produces the value instead of writing it directly.
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards.card";
import type { FieldErrors } from "~/shared/wire-types";
import { randomBytes } from "node:crypto";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { cards, cardTypes, cardVersions } from "~/db/schema/cards";
import { attachments, cardChecklistItems } from "~/db/schema/card-content";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
} from "~/db/schema/properties";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import { deleteCard, updateCard } from "~/domain/cards/commands.server";
import { applyCardPropertyValue } from "~/domain/cards/transition-workflows.server";
import {
  availableTransitions,
  executeTransition,
} from "~/domain/cards/transitions.server";
import {
  addCardAttachment,
  removeCardAttachment,
} from "~/domain/cards/attachments.server";
import {
  addChecklistItem,
  markChecklistItem,
  removeChecklistItem,
} from "~/domain/cards/checklist.server";
import {
  deleteAttachmentFile,
  sanitizeFileName,
  saveAttachmentFile,
} from "~/files/attachment-storage.server";
import { addCardComment } from "~/domain/murmurs/commands.server";
import { cardDiscussion } from "~/domain/murmurs/read.server";
import { MurmurBody } from "~/components/murmur-body";
import { requireUserId } from "~/auth/session.server";

/** Loads the card, its project's card types, and its version trail (newest first). */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const card = db
    .select()
    .from(cards)
    .where(
      and(eq(cards.projectId, project.id), eq(cards.number, Number(params.number))),
    )
    .get();
  if (!card) throw new Response("Not Found", { status: 404 });
  const types = db
    .select({ id: cardTypes.id, name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, project.id))
    .orderBy(asc(cardTypes.position))
    .all();
  const versions = db
    .select({
      version: cardVersions.version,
      name: cardVersions.name,
      cardTypeName: cardVersions.cardTypeName,
      propertyValues: cardVersions.propertyValues,
      comment: cardVersions.comment,
      modifiedBy: users.name,
      createdAt: cardVersions.createdAt,
    })
    .from(cardVersions)
    .innerJoin(users, eq(users.id, cardVersions.modifiedByUserId))
    .where(eq(cardVersions.cardId, card.id))
    .orderBy(desc(cardVersions.version))
    .all();
  const cardAttachments = db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      size: attachments.size,
    })
    .from(attachments)
    .where(eq(attachments.cardId, card.id))
    .orderBy(asc(attachments.fileName))
    .all();
  const checklist = db
    .select({
      id: cardChecklistItems.id,
      text: cardChecklistItems.text,
      completed: cardChecklistItems.completed,
      position: cardChecklistItems.position,
    })
    .from(cardChecklistItems)
    .where(eq(cardChecklistItems.cardId, card.id))
    .orderBy(asc(cardChecklistItems.completed), asc(cardChecklistItems.position))
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
  const currentValues = db
    .select({
      propertyDefinitionId: cardPropertyValues.propertyDefinitionId,
      value: cardPropertyValues.value,
    })
    .from(cardPropertyValues)
    .where(eq(cardPropertyValues.cardId, card.id))
    .all();
  const teamMembers = db
    .select({ id: users.id, name: users.name })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, project.id))
    .orderBy(asc(users.name))
    .all();
  const properties = definitions.map((definition) => ({
    ...definition,
    value:
      currentValues.find((row) => row.propertyDefinitionId === definition.id)
        ?.value ?? null,
    allowedValues: allowedValues
      .filter((row) => row.propertyDefinitionId === definition.id)
      .map((row) => row.value),
  }));
  // Snapshots are keyed by definition id (ADR-0004); display joins the
  // current names, matching legacy's history-shows-current-name behavior.
  const propertyNameById = new Map(
    definitions.map((definition) => [String(definition.id), definition.name]),
  );
  const versionsWithProperties = versions.map(
    ({ propertyValues: snapshot, ...version }) => ({
      ...version,
      propertySummary: Object.entries(
        JSON.parse(snapshot) as Record<string, string>,
      )
        .map(([id, value]) => `${propertyNameById.get(id) ?? `#${id}`}: ${value}`)
        .join(", "),
    }),
  );
  return {
    project: { name: project.name, identifier: project.identifier },
    card: {
      number: card.number,
      name: card.name,
      description: card.description,
      cardTypeId: card.cardTypeId,
      version: card.version,
    },
    cardTypes: types,
    versions: versionsWithProperties,
    attachments: cardAttachments,
    checklist,
    properties,
    teamMembers,
    transitions: availableTransitions(db, project.id, card.number, userId),
    discussion: cardDiscussion(db, project.id, card.id),
  };
}

/**
 * Dispatches the posted form by `intent` to UpdateCard or DeleteCard;
 * returns field errors, or redirects to the card list after a delete.
 */
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
  const cardNumber = Number(params.number);

  if (intent === "update") {
    const result = updateCard(db, {
      projectId: project.id,
      cardNumber,
      name: String(form.get("name") ?? ""),
      description: form.get("description") ? String(form.get("description")) : null,
      cardTypeId: Number(form.get("cardTypeId") ?? 0),
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "delete") {
    const keys = db
      .select({ fileKey: attachments.fileKey })
      .from(attachments)
      .innerJoin(cards, eq(cards.id, attachments.cardId))
      .where(and(eq(cards.projectId, project.id), eq(cards.number, cardNumber)))
      .all();
    const result = deleteCard(db, { projectId: project.id, cardNumber, actorUserId });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    for (const { fileKey } of keys) deleteAttachmentFile(fileKey);
    throw redirect(`/projects/${params.identifier}/cards`);
  }
  if (intent === "attach") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      return { errors: { file: ["can't be blank"] } satisfies FieldErrors };
    const fileName = sanitizeFileName(file.name);
    const fileKey = saveAttachmentFile(
      new Uint8Array(await file.arrayBuffer()),
      fileName,
    );
    const result = addCardAttachment(db, {
      projectId: project.id,
      cardNumber,
      fileName,
      fileKey,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      uniqueSuffix: randomBytes(3).toString("hex"),
      actorUserId,
    });
    if (!result.ok) {
      deleteAttachmentFile(fileKey); // command rejected: don't strand the bytes
      return { errors: result.errors satisfies FieldErrors };
    }
    return { saved: true as const };
  }
  if (intent === "remove-attachment") {
    const result = removeCardAttachment(db, {
      projectId: project.id,
      cardNumber,
      attachmentId: Number(form.get("attachmentId") ?? 0),
      actorUserId,
    });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    deleteAttachmentFile(result.value.fileKey);
    return { saved: true as const };
  }
  if (intent === "checklist-add") {
    const result = addChecklistItem(db, {
      projectId: project.id,
      cardNumber,
      text: String(form.get("text") ?? ""),
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "checklist-mark") {
    const result = markChecklistItem(db, {
      projectId: project.id,
      cardNumber,
      itemId: Number(form.get("itemId") ?? 0),
      completed: String(form.get("completed")) === "true",
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "checklist-remove") {
    const result = removeChecklistItem(db, {
      projectId: project.id,
      cardNumber,
      itemId: Number(form.get("itemId") ?? 0),
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "set-property") {
    // Phase 15: goes through the auto-transition dispatcher, so a
    // transition-only property moves by running the transition that
    // produces the value rather than being overwritten.
    const result = applyCardPropertyValue(db, {
      projectId: project.id,
      cardNumber,
      propertyDefinitionId: Number(form.get("propertyDefinitionId") ?? 0),
      value: form.get("value") ? String(form.get("value")) : null,
      actorUserId,
    });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    switch (result.value.kind) {
      case "value_set":
      case "unchanged":
        return { saved: true as const };
      case "transition_applied":
        return { applied: result.value.transition.name };
      case "require_user_input":
        return {
          errors: {
            property: [
              `${result.value.transition.name} sets that value, but needs you to fill it in — use the Transitions section below.`,
            ],
          } satisfies FieldErrors,
        };
      case "multi_transitions_matched":
        return {
          errors: {
            property: [
              `More than one transition sets that value (${result.value.transitions
                .map((transition) => transition.name)
                .join(", ")}) — choose one in the Transitions section below.`,
            ],
          } satisfies FieldErrors,
        };
      case "no_transition_matched":
        return {
          errors: {
            property: [
              "That value can only be reached by a transition, and none is available for this card right now.",
            ],
          } satisfies FieldErrors,
        };
    }
  }
  if (intent === "transition") {
    const userInput: Record<string, string> = {};
    for (const [key, raw] of form.entries()) {
      const match = /^input\[(\d+)\]$/.exec(key);
      if (match) userInput[match[1]] = String(raw);
    }
    const result = executeTransition(db, {
      projectId: project.id,
      cardNumber,
      transitionId: Number(form.get("transitionId") ?? 0),
      userInput,
      actorUserId,
    });
    return result.ok
      ? { saved: true as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "comment") {
    const result = addCardComment(db, {
      projectId: project.id,
      cardNumber,
      body: String(form.get("body") ?? ""),
      actorUserId,
    });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    return { saved: true as const };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Card page with edit form and version history. Minimal styling until UX harvest. */
export default function CardPage() {
  const {
    project,
    card,
    cardTypes,
    versions,
    attachments,
    checklist,
    properties,
    teamMembers,
    transitions,
    discussion,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData;
  // Phase 15: a property change on a transition-only property is
  // reported as the transition that carried it out, not as a bare save.
  const applied =
    actionData && "applied" in actionData ? actionData.applied : null;

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        #{card.number} {card.name} <small>(v{card.version})</small>
      </h1>
      <p>
        <Link to={`/projects/${project.identifier}/cards`}>All cards</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}
      {applied ? (
        <p style={{ color: "seagreen" }}>
          <strong>{applied}</strong> successfully applied.
        </p>
      ) : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="card" errors={errors} />

      {transitions.length > 0 ? (
        <section>
          <h2>Transitions</h2>
          <ErrorLines field="transition" errors={errors} />
          {transitions.map((transition) => (
            <Form method="post" key={transition.id} style={{ marginBottom: "0.5rem" }}>
              <input type="hidden" name="intent" value="transition" />
              <input type="hidden" name="transitionId" value={transition.id} />
              {transition.inputs.map((input) => (
                <label key={input.propertyDefinitionId} style={{ marginRight: "0.5rem" }}>
                  {input.propertyName}
                  {input.required ? " *" : ""}{" "}
                  {input.kind === "enumerated" ? (
                    <select name={`input[${input.propertyDefinitionId}]`} defaultValue="">
                      <option value="">{input.required ? "" : "(no change)"}</option>
                      {(properties.find((p) => p.id === input.propertyDefinitionId)
                        ?.allowedValues ?? []).map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  ) : input.kind === "user" ? (
                    <select name={`input[${input.propertyDefinitionId}]`} defaultValue="">
                      <option value="">{input.required ? "" : "(no change)"}</option>
                      {teamMembers.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      name={`input[${input.propertyDefinitionId}]`}
                      type={input.kind === "date" ? "date" : "text"}
                    />
                  )}
                </label>
              ))}
              <button type="submit">{transition.name}</button>
            </Form>
          ))}
        </section>
      ) : null}

      <h2>Edit</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="update" />
        <p>
          <label>
            Name
            <br />
            <input name="name" defaultValue={card.name} />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <p>
          <label>
            Type
            <br />
            <select name="cardTypeId" defaultValue={card.cardTypeId}>
              {cardTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <ErrorLines field="cardType" errors={errors} />
        </p>
        <p>
          <label>
            Description
            <br />
            <textarea
              name="description"
              rows={6}
              defaultValue={card.description ?? ""}
            />
          </label>
        </p>
        <button type="submit">Save card</button>
      </Form>

      <Form method="post">
        <input type="hidden" name="intent" value="delete" />
        <button type="submit">Delete card</button>
      </Form>

      <Form method="post" action={`/projects/${project.identifier}/subscriptions`}>
        <input type="hidden" name="intent" value="subscribe" />
        <input type="hidden" name="kind" value="card" />
        <input type="hidden" name="card_number" value={card.number} />
        <input
          type="hidden"
          name="returnTo"
          value={`/projects/${project.identifier}/cards/${card.number}`}
        />
        <button type="submit">Subscribe via email</button>
      </Form>

      <h2>Properties</h2>
      <ErrorLines field="property" errors={errors} />
      <ErrorLines field="value" errors={errors} />
      {properties.length === 0 ? (
        <p>No properties defined. Define them in project settings.</p>
      ) : (
        properties.map((property) =>
          property.kind === "formula" ? (
            <p key={property.id}>
              {property.name}: {property.value ?? "(not set)"}{" "}
              <small>(formula)</small>
            </p>
          ) : property.kind === "tree_relationship" ? (
            // Placement is structural (ancestors inherited, descendants
            // revised), so it is changed on the tree page, not here.
            <p key={property.id} className="tree-relationship">
              {property.name}:{" "}
              {property.value === null ? (
                "(not set)"
              ) : (
                <Link to={`/projects/${project.identifier}/cards/${property.value}`}>#{property.value}</Link>
              )}{" "}
              <small>
                (tree relationship — <Link to={`/projects/${project.identifier}/trees`}>trees</Link>)
              </small>
            </p>
          ) : (
          <Form method="post" key={property.id}>
            <input type="hidden" name="intent" value="set-property" />
            <input
              type="hidden"
              name="propertyDefinitionId"
              value={property.id}
            />
            <p>
              <label>
                {property.name}
                <br />
                {property.kind === "enumerated" ? (
                  <select name="value" defaultValue={property.value ?? ""}>
                    <option value="">(not set)</option>
                    {property.allowedValues.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                ) : property.kind === "user" ? (
                  <select name="value" defaultValue={property.value ?? ""}>
                    <option value="">(not set)</option>
                    {teamMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    name="value"
                    type={property.kind === "date" ? "date" : "text"}
                    defaultValue={property.value ?? ""}
                  />
                )}{" "}
                <button type="submit">Set</button>
              </label>
            </p>
          </Form>
          ),
        )
      )}

      <h2>Checklist</h2>
      <ErrorLines field="item" errors={errors} />
      {checklist.length === 0 ? (
        <p>No checklist items.</p>
      ) : (
        <ul>
          {checklist.map((item) => (
            <li key={item.id}>
              {item.completed ? <s>{item.text}</s> : item.text}{" "}
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="checklist-mark" />
                <input type="hidden" name="itemId" value={item.id} />
                <input
                  type="hidden"
                  name="completed"
                  value={item.completed ? "false" : "true"}
                />
                <button type="submit">
                  {item.completed ? "Reopen" : "Complete"}
                </button>
              </Form>{" "}
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="checklist-remove" />
                <input type="hidden" name="itemId" value={item.id} />
                <button type="submit">Remove</button>
              </Form>
            </li>
          ))}
        </ul>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="checklist-add" />
        <input name="text" placeholder="New checklist item" />{" "}
        <button type="submit">Add item</button>
        <ErrorLines field="text" errors={errors} />
      </Form>

      <h2>Attachments</h2>
      <ErrorLines field="attachment" errors={errors} />
      <ErrorLines field="file" errors={errors} />
      {attachments.length === 0 ? (
        <p>No attachments.</p>
      ) : (
        <ul>
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={`/projects/${project.identifier}/cards/${card.number}/attachments/${attachment.id}`}
              >
                {attachment.fileName}
              </a>{" "}
              ({attachment.size} bytes){" "}
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="remove-attachment" />
                <input type="hidden" name="attachmentId" value={attachment.id} />
                <button type="submit">Remove</button>
              </Form>
            </li>
          ))}
        </ul>
      )}
      <Form method="post" encType="multipart/form-data">
        <input type="hidden" name="intent" value="attach" />
        <input type="file" name="file" />{" "}
        <button type="submit">Attach file</button>
      </Form>

      <h2>Discussion</h2>
      <ErrorLines field="body" errors={errors} />
      {discussion.length === 0 ? (
        <p>No murmurs about this card.</p>
      ) : (
        <ul id="card-discussion">
          {discussion.map((murmur) => (
            <li key={murmur.id} id={`murmur-${murmur.id}`}>
              <strong>{murmur.authorName}</strong>{" "}
              <MurmurBody
                segments={murmur.body}
                projectIdentifier={project.identifier}
              />
              {murmur.originCardNumber === null && (
                <>
                  {" "}
                  <small>(mentioned this card)</small>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="comment" />
        <textarea name="body" rows={3} cols={60} placeholder="Add a comment" />
        <br />
        <button type="submit">Add comment</button>
      </Form>

      <h2>History</h2>
      <ul>
        {versions.map((v) => (
          <li key={v.version}>
            v{v.version} — {v.name} ({v.cardTypeName}) by {v.modifiedBy} at{" "}
            {new Date(v.createdAt).toISOString()}
            {v.propertySummary ? <> — {v.propertySummary}</> : null}
            {v.comment ? <> — commented: {v.comment}</> : null}
          </li>
        ))}
      </ul>
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
