/**
 * /api/v1/projects/:identifier/cards/:number — one card (resource
 * route, JSON).
 *
 * GET    answers `ApiCard`, or 404.
 * PATCH  changes the fields present in `ApiUpdateCardBody` — name,
 *        description, type through UpdateCard; `properties` through
 *        ApplyCardPropertyValue (ADR-0008) — on one transaction
 *        (app/api/card-writes.server.ts); 200 with `ApiCardWrite`.
 * DELETE deletes the card via DeleteCard (project admin, as in the
 *        UI), then removes its attachment bytes; 204.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.cards.card";
import { db } from "~/db/client.server";
import { attachments } from "~/db/schema/card-content";
import { deleteCard } from "~/domain/cards/commands.server";
import { deleteAttachmentFile } from "~/files/attachment-storage.server";
import { requireApiUser } from "~/api/auth.server";
import { updateCardViaApi } from "~/api/card-writes.server";
import {
  commandResponse,
  jsonResponse,
  methodNotAllowed,
  optionalString,
  optionalStringMap,
  readJsonObject,
  rejectionResponse,
} from "~/api/http.server";
import { cardPresenter, requireCard, requireProject } from "~/api/resources.server";
import type { ApiCardWrite } from "~/shared/wire-types";

/** GET: the card, or 404. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  return jsonResponse(cardPresenter(db, project.id)(card));
}

/** PATCH: update fields and properties; DELETE: delete the card. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  const scope = { projectId: project.id, cardNumber: card.number, actorUserId: user.id };

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const name = optionalString(body, "name");
    const result = updateCardViaApi(db, {
      ...scope,
      name: name ?? undefined,
      description: optionalString(body, "description"),
      typeName: optionalString(body, "type"),
      properties: optionalStringMap(body, "properties"),
    });
    const present = cardPresenter(db, project.id);
    return commandResponse(
      result,
      200,
      (outcome): ApiCardWrite => ({ card: present(outcome.card), appliedTransitions: outcome.appliedTransitions }),
    );
  }
  if (request.method === "DELETE") {
    // Same sequence as the card page's delete intent: collect the
    // attachment keys first, delete the card, then drop the bytes.
    const keys = db.select({ fileKey: attachments.fileKey }).from(attachments).where(eq(attachments.cardId, card.id)).all();
    const result = deleteCard(db, scope);
    if (!result.ok) return rejectionResponse(result.errors);
    for (const { fileKey } of keys) deleteAttachmentFile(fileKey);
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
