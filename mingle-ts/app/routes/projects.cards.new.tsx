/**
 * /projects/:identifier/cards/new — create a card.
 *
 * Purpose: Phase 5 card creation form (name, description, type). Posts
 * to CreateCard; authorization (full team member) is enforced by the
 * command handler, and the route surfaces its rejection. Redirects to
 * the new card on success. Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { asc, eq } from "drizzle-orm";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards.new";
import { ActionBar, ErrorLines } from "~/components/forms";
import "../styles/card-new.css";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { cardTypes } from "~/db/schema/cards";
import { createCard } from "~/domain/cards/commands.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the project's card types for the type selector. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const types = db
    .select({ id: cardTypes.id, name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, project.id))
    .orderBy(asc(cardTypes.position))
    .all();
  return {
    project: { name: project.name, identifier: project.identifier },
    cardTypes: types,
  };
}

/** Runs CreateCard; redirects to the created card or returns field errors. */
export async function action({ request, params }: Route.ActionArgs) {
  const actorUserId = await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const result = createCard(db, {
    projectId: project.id,
    name: String(form.get("name") ?? ""),
    description: form.get("description") ? String(form.get("description")) : null,
    cardTypeId: Number(form.get("cardTypeId") ?? 0),
    actorUserId,
  });
  if (!result.ok) return { errors: result.errors satisfies FieldErrors };
  throw redirect(`/projects/${params.identifier}/cards/${result.value.number}`);
}

/** New card — legacy cards/new.rhtml with cards/_form.rhtml (card top: number and name; description; card type) and _card_create_actions.rhtml. */
export default function NewCard() {
  const { project, cardTypes } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors = actionData?.errors ?? {};
  const base = `/projects/${project.identifier}/cards`;

  const actions = (
    <ActionBar>
      <button type="submit" className="primary save save-button">
        Save
      </button>
      <Link to={base} id="cancel" className="cancel">
        Cancel
      </Link>
    </ActionBar>
  );

  return (
    <Form method="post" id="card-create-form">
      {actions}
      <ErrorLines field="authorization" errors={errors} />
      <div id="edit-contents">
        <div id="card">
          <div id="card-top">
            <h1 id="card-index">New card</h1>
            <div id="card-edit-title-container">
              <div id="card-edit-title">
                <ErrorLines field="name" errors={errors} prefix="Name" />
                <input id="card_name" name="name" placeholder="Card name" required />
              </div>
            </div>
            <div className="clear_float" />
          </div>
          <div id="card-description-container">
            <ErrorLines field="description" errors={errors} />
            <textarea id="card_description" name="description" rows={12} placeholder="Description" />
          </div>
          <div className="clear-both" />
          <div id="card-bottom">
            <div className="card-type-editor">
              <label htmlFor="card_card_type_id" className="inline">
                <b>Type:</b>
              </label>{" "}
              <select id="card_card_type_id" name="cardTypeId">
                {cardTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
              <ErrorLines field="cardType" errors={errors} />
            </div>
          </div>
        </div>
      </div>
      {actions}
    </Form>
  );
}
