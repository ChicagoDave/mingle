/**
 * /api/v1/projects/:identifier/card_types — a project's card types
 * (resource route, JSON).
 *
 * GET lists `ApiCardType[]` in display order, so a client can name a
 * type when creating a card.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import type { Route } from "./+types/api.v1.projects.card-types";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { jsonResponse } from "~/api/http.server";
import { cardTypeResource, listCardTypes, requireProject } from "~/api/resources.server";

/** GET: the project's card types in display order. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  return jsonResponse(listCardTypes(db, project.id).map(cardTypeResource));
}
