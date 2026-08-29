/**
 * /api/v1/projects/:identifier/pages — a project's wiki pages
 * (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiWikiPage>` by name (`?limit=`, `?cursor=`).
 * POST creates a page via CreatePage — the body is sanitized on the
 *      way in exactly as the editor's is (ADR-0011: the command
 *      sanitizes, this route never touches the HTML); body
 *      `ApiCreateWikiPageBody`; 201 with `ApiWikiPage`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Wiki & Content.
 */
import { asc, eq, sql } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.pages";
import { db } from "~/db/client.server";
import { pages } from "~/db/schema/pages";
import { requireApiUser } from "~/api/auth.server";
import { commandResponse, jsonResponse, methodNotAllowed, optionalString, readJsonObject, requiredString } from "~/api/http.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";
import { requireProject, wikiPagePresenter } from "~/api/resources.server";
import { createPage } from "~/domain/pages/commands.server";

/** GET: one page of the project's wiki pages, by name. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const page = readPageParams(new URL(request.url));
  const rows = db
    .select()
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(sql`lower(${pages.name})`, asc(pages.id))
    .all();
  const paged = keysetPage(rows, page, (row) => [row.name.toLowerCase(), row.id]);
  const present = wikiPagePresenter(db);
  return jsonResponse({ items: paged.items.map(present), nextCursor: paged.nextCursor });
}

/** POST: CreatePage from a JSON body; 201 with the page. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = createPage(db, {
    projectId: project.id,
    name: requiredString(body, "name"),
    content: optionalString(body, "content"),
    actorUserId: user.id,
  });
  return commandResponse(result, 201, wikiPagePresenter(db));
}
