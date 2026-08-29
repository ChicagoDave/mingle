/**
 * /api/v1/projects — the project collection (resource route, JSON).
 *
 * GET  lists every project (as the project list page does for any
 *      logged-in user), ordered by name.
 * POST creates a project via CreateProject (site admin only, as in
 *      the UI); body `ApiCreateProjectBody`; 201 with `ApiProject`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { sql } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { createProject } from "~/domain/projects/commands.server";
import { requireApiUser } from "~/api/auth.server";
import { commandResponse, jsonResponse, methodNotAllowed, optionalString, readJsonObject, requiredString } from "~/api/http.server";
import { projectResource } from "~/api/resources.server";

/** GET: every project, ordered by name. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireApiUser(request);
  const rows = db.select().from(projects).orderBy(sql`lower(${projects.name})`).all();
  return jsonResponse(rows.map(projectResource));
}

/** POST: CreateProject from a JSON body; 201 with the project. */
export async function action({ request }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = createProject(db, {
    name: requiredString(body, "name"),
    identifier: optionalString(body, "identifier"),
    description: optionalString(body, "description"),
    actorUserId: user.id,
  });
  return commandResponse(result, 201, projectResource);
}
