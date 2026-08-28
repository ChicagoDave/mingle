/**
 * /projects/:identifier/feed.atom — the project history as Atom
 * (Phase 21).
 *
 * Purpose: legacy's `FeedsController#events`, serving the same
 * projection the in-app history page renders. This is a resource route
 * — it returns a Response with an Atom body and no component — so the
 * feed is the document itself rather than a page that happens to
 * contain one.
 *
 * Access is authenticated like every other project route. Legacy served
 * feeds to API clients with their own credential scheme; this rewrite
 * has one session mechanism, and a feed reader that cannot log in
 * cannot read a project's history — which is the conservative side to
 * be on until an API credential exists.
 *
 * Public interface: `loader`.
 *
 * Owner context: Collaboration (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import type { Route } from "./+types/projects.feed.atom";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import {
  ATOM_CONTENT_TYPE,
  renderAtomFeed,
} from "~/domain/history/atom.server";
import {
  HISTORY_PAGE_SIZE,
  projectHistory,
  projectHistoryCount,
} from "~/domain/history/read.server";

/** Serves one page of the project's history as an Atom document. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("page"));
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  const total = projectHistoryCount(db, project.id);

  const body = renderAtomFeed(projectHistory(db, project, { page }), {
    siteUrl: url.origin,
    projectIdentifier: project.identifier,
    projectName: project.name,
    projectCreatedAt: project.createdAt,
    page,
    totalPages: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": ATOM_CONTENT_TYPE },
  });
}
