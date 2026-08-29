/**
 * /api/v1/projects/:identifier/transitions/:id — one transition
 * definition (resource route, JSON).
 *
 * GET    answers the `ApiTransition`, or 404.
 * DELETE deletes it via DeleteTransition (project admin). Editing a
 *        transition is delete-and-recreate (ADR-0007) — there is no
 *        PATCH. 204.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Workflow.
 */
import type { Route } from "./+types/api.v1.projects.transitions.transition";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { apiError, jsonResponse, methodNotAllowed, rejectionResponse } from "~/api/http.server";
import { requireProject, transitionResources } from "~/api/resources.server";
import { deleteTransition } from "~/domain/cards/transitions.server";
import type { ApiTransition } from "~/shared/wire-types";

/** Resolves the `:id` segment to one of the project's transitions, or throws 404. */
function requireTransition(projectId: number, idParam: string | undefined): ApiTransition {
  const id = /^\d+$/.test(idParam ?? "") ? Number(idParam) : NaN;
  const found = Number.isNaN(id) ? undefined : transitionResources(db, projectId).find((t) => t.id === id);
  if (!found) throw apiError(404, "transition not found");
  return found;
}

/** GET: the transition definition. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  return jsonResponse(requireTransition(project.id, params.id));
}

/** DELETE: DeleteTransition; 204, or the command's rejection. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const transition = requireTransition(project.id, params.id);
  if (request.method !== "DELETE") return methodNotAllowed(["GET", "DELETE"]);
  const result = deleteTransition(db, { projectId: project.id, transitionId: transition.id, actorUserId: user.id });
  if (!result.ok) return rejectionResponse(result.errors);
  return new Response(null, { status: 204 });
}
