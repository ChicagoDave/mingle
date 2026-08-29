/**
 * /api/v1/projects/:identifier/pages/:pagename — one wiki page
 * (resource route, JSON).
 *
 * GET answers the `ApiWikiPage` for the URL identifier (the page name
 *     with underscores for spaces, matched case-insensitively as the
 *     wiki does), or 404. `content` is the stored sanitized HTML.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`.
 * Owner context: Public API (HTTP adapter) for Wiki & Content.
 */
import type { Route } from "./+types/api.v1.projects.pages.page";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { apiError, jsonResponse } from "~/api/http.server";
import { requireProject, wikiPagePresenter } from "~/api/resources.server";
import { findPage } from "~/domain/pages/read.server";

/** GET: the page, or 404. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const page = findPage(db, project.id, params.pagename ?? "");
  if (!page) throw apiError(404, "page not found");
  return jsonResponse(wikiPagePresenter(db)(page));
}
