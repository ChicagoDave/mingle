/**
 * /projects/:identifier/cards/:number — card show, edit, delete, and
 * version history.
 *
 * Purpose: the single-card page (Phases 5–6). Forms post to one action
 * discriminated by `intent`: "update" runs UpdateCard, "delete" runs
 * DeleteCard (redirecting to the list), "attach" saves the uploaded
 * bytes then runs AddCardAttachment (deleting the bytes again on
 * rejection), "remove-attachment" runs RemoveCardAttachment then
 * deletes the bytes, and "checklist-add"/"checklist-mark"/
 * "checklist-remove" run the checklist commands. The append-only
 * version trail renders newest-first. Authorization is enforced by the
 * command handlers; the route surfaces rejections. Requires a
 * logged-in session.
 *
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
import { users } from "~/db/schema/identity";
import { deleteCard, updateCard } from "~/domain/cards/commands.server";
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
import { requireUserId } from "~/auth/session.server";

/** Loads the card, its project's card types, and its version trail (newest first). */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
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
    versions,
    attachments: cardAttachments,
    checklist,
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
  throw new Response("Unknown intent", { status: 400 });
}

/** Card page with edit form and version history. Minimal styling until UX harvest. */
export default function CardPage() {
  const { project, card, cardTypes, versions, attachments, checklist } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData;

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        #{card.number} {card.name} <small>(v{card.version})</small>
      </h1>
      <p>
        <Link to={`/projects/${project.identifier}/cards`}>All cards</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="card" errors={errors} />

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

      <h2>History</h2>
      <ul>
        {versions.map((v) => (
          <li key={v.version}>
            v{v.version} — {v.name} ({v.cardTypeName}) by {v.modifiedBy} at{" "}
            {new Date(v.createdAt).toISOString()}
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
