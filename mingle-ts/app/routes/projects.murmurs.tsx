/**
 * /projects/:identifier/murmurs — the project murmur stream (Phase 20).
 *
 * Purpose: the legacy MurmursController#index/#create surface — the
 * project's murmurs newest first with a box to add one, plus the
 * "mentioning me" view the stored mention rows make possible (legacy
 * could only answer that by re-scanning bodies). Posting is a plain
 * form POST, so the stream works with scripting off.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Collaboration (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.murmurs";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import { MurmurBody } from "~/components/murmur-body";
import {
  PrivilegeLevel,
  privilegeLevelFor,
} from "~/domain/identity/authorization.server";
import { postMurmur } from "~/domain/murmurs/commands.server";
import {
  listProjectMurmurs,
  murmursMentioning,
} from "~/domain/murmurs/read.server";

/** Loads the stream (or the viewer's mentions) and whether they may post. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const mentionsOnly = url.searchParams.get("filter") === "mentions";
  const beforeParam = Number(url.searchParams.get("before"));
  const beforeId = Number.isSafeInteger(beforeParam) && beforeParam > 0
    ? beforeParam
    : undefined;

  const murmurs = mentionsOnly
    ? murmursMentioning(db, project.id, userId)
    : listProjectMurmurs(db, project.id, { beforeId });

  return {
    project: { name: project.name, identifier: project.identifier },
    murmurs,
    mentionsOnly,
    canPost:
      privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
  };
}

/** Dispatches PostMurmur; re-renders the stream with errors on rejection. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const result = postMurmur(db, {
    projectId: project.id,
    body: String(form.get("body") ?? ""),
    actorUserId: userId,
  });
  if (!result.ok) return data({ errors: result.errors }, { status: 400 });
  return { errors: null };
}

/** The murmur stream (legacy murmurs/index). */
export default function ProjectMurmurs() {
  const { project, murmurs, mentionsOnly, canPost } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const base = `/projects/${project.identifier}`;
  const oldest = murmurs.at(-1)?.id;

  return (
    <main id="project-murmurs" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {project.name} murmurs <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/wiki`}>Pages</Link> ·{" "}
        <Link to={`${base}/team`}>Team</Link> ·{" "}
        <Link to={`${base}/history`}>History</Link>
      </p>

      <p>
        {mentionsOnly ? (
          <Link to={`${base}/murmurs`}>All murmurs</Link>
        ) : (
          <Link to={`${base}/murmurs?filter=mentions`}>Mentioning me</Link>
        )}
      </p>

      {canPost && (
        <Form method="post" id="murmur-form">
          <p>
            <label htmlFor="murmur-body">Murmur</label>
            <br />
            <textarea id="murmur-body" name="body" rows={3} cols={60} />
          </p>
          {actionData?.errors?.body && (
            <p className="error">Murmur {actionData.errors.body.join(", ")}</p>
          )}
          <p>
            <button type="submit">Murmur</button>
          </p>
        </Form>
      )}

      {murmurs.length === 0 ? (
        <p className="info-box">
          {mentionsOnly
            ? "No murmurs mention you yet."
            : `No murmurs have been added to ${project.name}.`}
        </p>
      ) : (
        <ul id="murmur-list">
          {murmurs.map((murmur) => (
            <li key={murmur.id} id={`murmur-${murmur.id}`}>
              <strong>{murmur.authorName}</strong>{" "}
              <MurmurBody
                segments={murmur.body}
                projectIdentifier={project.identifier}
              />
              {murmur.originCardNumber !== null && (
                <>
                  {" "}
                  <small>
                    from{" "}
                    {murmur.originCardDeleted ? (
                      <span>deleted card #{murmur.originCardNumber}</span>
                    ) : (
                      <Link to={`${base}/cards/${murmur.originCardNumber}`}>
                        #{murmur.originCardNumber}
                      </Link>
                    )}
                  </small>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!mentionsOnly && oldest !== undefined && (
        <p>
          <Link to={`${base}/murmurs?before=${oldest}`}>Older murmurs</Link>
        </p>
      )}
    </main>
  );
}
