/**
 * /projects — the project list.
 *
 * Purpose: lists every project (ordered by name, legacy order_by_name
 * parity) with links to each project's settings and to project
 * creation. Requires a logged-in session.
 *
 * Public interface: `loader`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { sql } from "drizzle-orm";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/projects";
import { ActionBar } from "~/components/forms";
import "../styles/projects-list.css";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";

/** Loads all projects, ordered case-insensitively by name. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const rows = db
    .select({
      id: projects.id,
      name: projects.name,
      identifier: projects.identifier,
      description: projects.description,
    })
    .from(projects)
    .orderBy(sql`lower(${projects.name})`)
    .all();
  return { projects: rows };
}

/** Project list — legacy projects/list.rhtml with projects/_projects.rhtml. */
export default function Projects() {
  const { projects: rows } = useLoaderData<typeof loader>();

  return (
    <div id="projects-list-page">
      <ActionBar>
        <Link to="/projects/new" className="project-new link_as_button primary">
          New project
        </Link>
        <Link to="/projects/import" className="project-import link_as_button">
          Import project
        </Link>
      </ActionBar>
      <div className="projects_list">
        {rows.length === 0 ? (
          <p className="italic-light">There are currently no projects to list.</p>
        ) : (
          rows.map((project) => (
            <div className="project" key={project.id} id={`project_${project.identifier}`}>
              <Link to={`/projects/${project.identifier}/cards`} className="project-icon-link">
                <div className="project-icon-holder">
                  <span className="project-initial">{project.name.charAt(0).toUpperCase()}</span>
                </div>
              </Link>
              <div className="project-description">
                <h2>
                  <Link to={`/projects/${project.identifier}/cards`}>{project.name}</Link>
                </h2>
                <p>{project.description ?? ""}</p>
                <Link to={`/projects/${project.identifier}/settings`} className="link-with-icon">
                  Project admin
                </Link>
              </div>
              <div className="clear_float" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
