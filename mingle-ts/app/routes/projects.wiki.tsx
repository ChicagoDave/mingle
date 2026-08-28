/**
 * /projects/:identifier/wiki — the project's page list (Phase 16).
 *
 * Purpose: the legacy PagesController#list surface (pages/list.rhtml) —
 * every page in the project, ordered case-insensitively by name, with
 * the legacy empty-state message and a link to create the first one.
 *
 * Public interface: `loader`, default component.
 *
 * Owner context: Wiki & Content (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.wiki";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import { listPages } from "~/domain/pages/read.server";
import {
  PrivilegeLevel,
  privilegeLevelFor,
} from "~/domain/identity/authorization.server";

/** Lists the project's pages and whether the viewer may add one. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  return {
    project: { name: project.name, identifier: project.identifier },
    pages: listPages(db, project.id),
    canEdit:
      privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
  };
}

/** Page list (legacy pages/list.rhtml). */
export default function WikiPages() {
  const { project, pages, canEdit } = useLoaderData<typeof loader>();
  const base = `/projects/${project.identifier}`;

  return (
    <main id="wiki-pages" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {project.name} pages <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/settings`}>Settings</Link> ·{" "}
        <Link to={`${base}/murmurs`}>Murmurs</Link> ·{" "}
        <Link to={`${base}/history`}>History</Link> ·{" "}
        <Link to={`${base}/team`}>Team</Link>
      </p>

      {pages.length === 0 ? (
        <p className="info-box">
          No <strong>pages</strong> have been added to {project.name}.
        </p>
      ) : (
        <ul id="page-list">
          {pages.map((page) => (
            <li key={page.id} id={page.identifier}>
              <Link to={`${base}/wiki/${encodeURIComponent(page.identifier)}`}>
                {page.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <p>
          <Link to={`${base}/wiki/new`}>Create a page</Link>
        </p>
      )}
    </main>
  );
}
