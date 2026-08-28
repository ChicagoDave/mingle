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

/** Project list page. Styling is deliberately minimal until the UX-harvest phases. */
export default function Projects() {
  const { projects: rows } = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Projects</h1>
      {rows.length === 0 ? (
        <p>There are no projects yet.</p>
      ) : (
        <ul>
          {rows.map((project) => (
            <li key={project.id}>
              <strong>{project.name}</strong> <small>({project.identifier})</small>
              {project.description ? <> — {project.description}</> : null}{" "}
              <Link to={`/projects/${project.identifier}/settings`}>settings</Link>
            </li>
          ))}
        </ul>
      )}
      <p>
        <Link to="/projects/new">Create a project</Link> · <Link to="/programs">Programs</Link>
      </p>
    </main>
  );
}
