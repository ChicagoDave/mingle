/**
 * /api/v1/projects/:identifier/card_types/:id — one card type
 * (resource route, JSON).
 *
 * GET    answers the `ApiCardType`, or 404.
 * DELETE deletes it via DeleteCardType (project admin) — refused with
 *        422 and legacy's message when it is the last type, a live
 *        card carries it, or a tree includes it; transitions restricted
 *        to the type go with it (legacy `dependent: destroy`). 204.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.card-types.card-type";
import { db } from "~/db/client.server";
import { cardTypes, type CardTypeRow } from "~/db/schema/cards";
import { requireApiUser } from "~/api/auth.server";
import { apiError, jsonResponse, methodNotAllowed, rejectionResponse } from "~/api/http.server";
import { cardTypeResource, requireProject } from "~/api/resources.server";
import { deleteCardType } from "~/domain/cards/commands.server";

/** Resolves the `:id` segment to the project's card type, or throws 404. */
function requireCardType(projectId: number, idParam: string | undefined): CardTypeRow {
  const id = /^\d+$/.test(idParam ?? "") ? Number(idParam) : NaN;
  const row = Number.isNaN(id)
    ? undefined
    : db.select().from(cardTypes).where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.id, id))).get();
  if (!row) throw apiError(404, "card type not found");
  return row;
}

/** GET: the card type. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  return jsonResponse(cardTypeResource(requireCardType(project.id, params.id)));
}

/** DELETE: DeleteCardType; 204, or the command's rejection. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const cardType = requireCardType(project.id, params.id);
  if (request.method !== "DELETE") return methodNotAllowed(["GET", "DELETE"]);
  const result = deleteCardType(db, { projectId: project.id, cardTypeId: cardType.id, actorUserId: user.id });
  if (!result.ok) return rejectionResponse(result.errors);
  return new Response(null, { status: 204 });
}
