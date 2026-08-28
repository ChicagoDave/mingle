/**
 * /projects/:identifier/history — the in-app project history feed
 * (Phase 21).
 *
 * Purpose: the human half of what legacy's `FeedsController#events`
 * served as XML — every card version, page version, and murmur in the
 * project, newest first, over the same projection the Atom route reads.
 * Both routes call `projectHistory`; neither has its own idea of what
 * happened.
 *
 * Public interface: `loader`, default component.
 *
 * Owner context: Collaboration (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.history";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import {
  HISTORY_PAGE_SIZE,
  projectHistory,
  projectHistoryCount,
} from "~/domain/history/read.server";

/** Loads one page of the project's history. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const requested = Number(new URL(request.url).searchParams.get("page"));
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  const total = projectHistoryCount(db, project.id);

  return {
    project: { name: project.name, identifier: project.identifier },
    entries: projectHistory(db, project, { page }),
    page,
    totalPages: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
  };
}

/** Project history (legacy history/index, feed half). */
export default function ProjectHistory() {
  const { project, entries, page, totalPages } = useLoaderData<typeof loader>();
  const base = `/projects/${project.identifier}`;

  return (
    <main id="project-history" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {project.name} history <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/wiki`}>Pages</Link> ·{" "}
        <Link to={`${base}/murmurs`}>Murmurs</Link> ·{" "}
        <a href={`${base}/feed.atom`}>Atom feed</a>
      </p>

      {entries.length === 0 ? (
        <p className="info-box">Nothing has happened in {project.name} yet.</p>
      ) : (
        <ul id="history-entries">
          {entries.map((entry) => (
            <li key={entry.id} id={entry.id} className={`history-${entry.kind}`}>
              <Link to={entry.href}>{entry.title}</Link> {entry.action} by{" "}
              {entry.authorName} at {new Date(entry.occurredAt).toISOString()}
              {entry.text ? <> — {entry.text}</> : null}
            </li>
          ))}
        </ul>
      )}

      <p>
        {page > 1 && <Link to={`${base}/history?page=${page - 1}`}>Newer</Link>}{" "}
        {page < totalPages && (
          <Link to={`${base}/history?page=${page + 1}`}>Older</Link>
        )}{" "}
        <small>
          page {page} of {totalPages}
        </small>
      </p>
    </main>
  );
}
