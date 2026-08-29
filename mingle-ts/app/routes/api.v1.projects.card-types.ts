/**
 * /api/v1/projects/:identifier/card_types — a project's card types
 * (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiCardType>` (`?limit=`, `?cursor=`) in
 *      display order, so a client can name a type when creating a card.
 * POST defines a card type via DefineCardType — the same validation
 *      the project settings page applies (blank or taken name is
 *      422); body `ApiDefineCardTypeBody`; 201 with `ApiCardType`.
 *      Deleting is on `/card_types/:id`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import type { Route } from "./+types/api.v1.projects.card-types";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { commandResponse, jsonResponse, methodNotAllowed, readJsonObject, requiredString } from "~/api/http.server";
import { defineCardType } from "~/domain/cards/commands.server";
import { cardTypeResource, listCardTypes, requireProject } from "~/api/resources.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";

/** GET: the project's card types in display order. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const page = readPageParams(new URL(request.url));
  const paged = keysetPage(listCardTypes(db, project.id), page, (row) => [row.position, row.id]);
  return jsonResponse({ items: paged.items.map(cardTypeResource), nextCursor: paged.nextCursor });
}

/** POST: DefineCardType from a JSON body; 201 with the card type. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = defineCardType(db, { projectId: project.id, name: requiredString(body, "name"), actorUserId: user.id });
  return commandResponse(result, 201, cardTypeResource);
}
