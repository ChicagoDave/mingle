/**
 * /api/v1/projects/:identifier/murmurs/:id — one murmur (resource
 * route, JSON).
 *
 * GET answers the `ApiMurmur`, or 404.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`.
 * Owner context: Public API (HTTP adapter) for Collaboration.
 */
import type { Route } from "./+types/api.v1.projects.murmurs.murmur";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { apiError, jsonResponse } from "~/api/http.server";
import { listMurmurRows, murmurPresenter, requireProject } from "~/api/resources.server";

/** GET: the murmur, or 404. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const id = /^\d+$/.test(params.id ?? "") ? Number(params.id) : NaN;
  const row = Number.isNaN(id) ? undefined : listMurmurRows(db, project.id, id)[0];
  if (!row) throw apiError(404, "murmur not found");
  return jsonResponse(murmurPresenter(db, project.id)(row));
}
