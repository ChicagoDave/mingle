/**
 * /projects/:identifier/favorites/:favoriteId — open a favorite
 * (Phase 11).
 *
 * Purpose: the legacy favorites#show — resolves a favorite by id and
 * redirects into the view it reopens: the list or grid route with the
 * favorite's stored filters, columns or group-by, and `favorite_id`.
 * Personal favorites open only for their owner.
 *
 * Public interface: `loader`.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { and, eq } from "drizzle-orm";
import { redirect } from "react-router";
import type { Route } from "./+types/projects.favorites.show";
import { db } from "~/db/client.server";
import { favorites } from "~/db/schema/favorites";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import { favoriteHref } from "~/domain/cards/favorites.server";

/** Redirects to the favorite's canonical view URL. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const favorite = db
    .select()
    .from(favorites)
    .where(
      and(eq(favorites.projectId, project.id), eq(favorites.id, Number(params.favoriteId))),
    )
    .get();
  if (!favorite || (favorite.userId !== null && favorite.userId !== userId))
    throw new Response("Not Found", { status: 404 });
  throw redirect(favoriteHref(project.identifier, favorite));
}
