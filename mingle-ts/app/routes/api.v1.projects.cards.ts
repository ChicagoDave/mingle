/**
 * /api/v1/projects/:identifier/cards — a project's cards (resource
 * route, JSON).
 *
 * GET  lists `ApiCard[]`, newest number first, each with its property
 *      values by name.
 * POST creates a card via CreateCard, setting any `properties` in the
 *      same transaction (app/api/card-writes.server.ts); body
 *      `ApiCreateCardBody`; 201 with `ApiCardWrite`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { desc, eq } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.cards";
import { db } from "~/db/client.server";
import { cards } from "~/db/schema/cards";
import { requireApiUser } from "~/api/auth.server";
import { createCardViaApi } from "~/api/card-writes.server";
import {
  commandResponse,
  jsonResponse,
  methodNotAllowed,
  optionalString,
  optionalStringMap,
  readJsonObject,
  requiredString,
} from "~/api/http.server";
import { cardPresenter, requireProject } from "~/api/resources.server";
import type { ApiCardWrite } from "~/shared/wire-types";

/** GET: the project's cards, highest number first. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const present = cardPresenter(db, project.id);
  const rows = db.select().from(cards).where(eq(cards.projectId, project.id)).orderBy(desc(cards.number)).all();
  return jsonResponse(rows.map(present));
}

/** POST: CreateCard plus its properties from a JSON body; 201 with the card. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = createCardViaApi(db, {
    projectId: project.id,
    name: requiredString(body, "name"),
    description: optionalString(body, "description"),
    typeName: optionalString(body, "type"),
    properties: optionalStringMap(body, "properties"),
    actorUserId: user.id,
  });
  const present = cardPresenter(db, project.id);
  return commandResponse(
    result,
    201,
    (outcome): ApiCardWrite => ({ card: present(outcome.card), appliedTransitions: outcome.appliedTransitions }),
  );
}
