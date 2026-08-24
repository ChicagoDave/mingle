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

/** New card form. Styling is deliberately minimal until the UX-harvest phases. */
export default function NewCard() {
  const { project, cardTypes } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors = actionData?.errors ?? {};

  return (
    <main style={{ maxWidth: 560, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>New card in {project.name}</h1>
      <p>
        <Link to={`/projects/${project.identifier}/cards`}>All cards</Link>
      </p>
      <ErrorLines field="authorization" errors={errors} />
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
            Type
            <br />
            <select name="cardTypeId">
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
            <textarea name="description" rows={6} />
          </label>
        </p>
        <button type="submit">Create card</button>
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
