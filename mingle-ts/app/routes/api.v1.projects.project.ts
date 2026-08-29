/**
 * /api/v1/projects/:identifier — one project (resource route, JSON).
 *
 * GET answers `ApiProject`, or 404 when the identifier names no project.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import type { Route } from "./+types/api.v1.projects.project";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { jsonResponse } from "~/api/http.server";
import { projectResource, requireProject } from "~/api/resources.server";

/** GET: the project, or 404. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  return jsonResponse(projectResource(requireProject(db, params.identifier)));
}
