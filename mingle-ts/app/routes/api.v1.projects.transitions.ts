/**
 * /api/v1/projects/:identifier/transitions — a project's transition
 * definitions (resource route, JSON).
 *
 * GET lists `ApiTransition[]` with legacy one-line prerequisite and
 * action descriptions. Executing a transition on a card is the card's
 * own transitions resource (api.v1.projects.cards.card.transitions).
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`.
 * Owner context: Public API (HTTP adapter) for Workflow.
 */
import type { Route } from "./+types/api.v1.projects.transitions";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { jsonResponse } from "~/api/http.server";
import { requireProject, transitionResources } from "~/api/resources.server";

/** GET: every transition of the project, ordered by name. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  return jsonResponse(transitionResources(db, project.id));
}
