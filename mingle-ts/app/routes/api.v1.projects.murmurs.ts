/**
 * /api/v1/projects/:identifier/murmurs — a project's murmur stream
 * (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiMurmur>` newest first (`?limit=`,
 *      `?cursor=`).
 * POST posts a murmur via PostMurmur — `@` mentions and `#123` card
 *      references are resolved once, at post time, by the command
 *      (ADR-0017) and reported back as `mentions` and `cards`; body
 *      `ApiPostMurmurBody`; 201 with `ApiMurmur`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Collaboration.
 */
import type { Route } from "./+types/api.v1.projects.murmurs";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { commandResponse, jsonResponse, methodNotAllowed, readJsonObject, requiredString } from "~/api/http.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";
import { listMurmurRows, murmurPresenter, requireProject } from "~/api/resources.server";
import { postMurmur } from "~/domain/murmurs/commands.server";

/** GET: one page of the stream, newest first. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const page = readPageParams(new URL(request.url));
  const paged = keysetPage(listMurmurRows(db, project.id), page, (row) => [-row.id]);
  const present = murmurPresenter(db, project.id);
  return jsonResponse({ items: paged.items.map(present), nextCursor: paged.nextCursor });
}

/** POST: PostMurmur from a JSON body; 201 with the murmur. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = postMurmur(db, { projectId: project.id, body: requiredString(body, "body"), actorUserId: user.id });
  const present = murmurPresenter(db, project.id);
  return commandResponse(result, 201, (row) => present(listMurmurRows(db, project.id, row.id)[0]));
}
