/**
 * /projects/:identifier/wiki/:pagename — show a wiki page (Phase 16).
 *
 * Purpose: the legacy PagesController#show surface (pages/show.rhtml) —
 * the rendered body with its wiki and card links resolved, the version
 * line, the history panel, and the pages that link here. `?version=n`
 * shows an earlier version read-only (legacy version_info). A page that
 * does not exist renders the legacy "does not exist" prompt offering to
 * create it, rather than a 404, because a wiki link to a page nobody
 * has written yet is how pages get made. Deletion posts here.
 *
 * The rendered body is injected as HTML. It is safe to do so because
 * `renderPageContent` builds its output from an allowlist — see that
 * module; never inject a body that has not been through it.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Wiki & Content (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.wiki.page";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import { deletePage } from "~/domain/pages/commands.server";
import { renderPageContent } from "~/domain/pages/content.server";
import { pageMacroExpansion } from "~/domain/pages/macros-registry.server";
import "../styles/macros.css";
import { pageNameFromIdentifier } from "~/domain/pages/naming.server";
import {
  findPage,
  findPageVersion,
  pageHistory,
  pageRenderContext,
  pagesLinkingTo,
} from "~/domain/pages/read.server";
import {
  PrivilegeLevel,
  privilegeLevelFor,
} from "~/domain/identity/authorization.server";

/**
 * Loads the page (or the requested version of it) with its body
 * rendered, its history, and its backlinks.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const privilege = privilegeLevelFor(db, userId, project.id);
  const identifier = params.pagename;
  const page = findPage(db, project.id, identifier);
  const shell = {
    project: { name: project.name, identifier: project.identifier },
    identifier,
    name: pageNameFromIdentifier(identifier),
    canEdit: privilege >= PrivilegeLevel.FULL_TEAM_MEMBER,
    canDelete: privilege >= PrivilegeLevel.PROJECT_ADMIN,
  };
  if (!page) return { ...shell, exists: false as const };

  const requested = new URL(request.url).searchParams.get("version");
  const version = requested === null ? null : Number(requested);
  const shown =
    version === null || version === page.version
      ? { version: page.version, content: page.content }
      : findPageVersion(db, page.id, version);
  if (!shown) throw new Response("Not Found", { status: 404 });

  return {
    ...shell,
    exists: true as const,
    name: page.name,
    content: renderPageContent(
      shown.content,
      pageRenderContext(db, project.identifier),
      pageMacroExpansion({
        projectIdentifier: project.identifier,
        projectId: project.id,
        db,
        currentUserId: userId,
      }),
    ),
    version: shown.version,
    currentVersion: page.version,
    history: pageHistory(db, page.id),
    linkedFrom: pagesLinkingTo(db, project.id, page.name),
  };
}

/** Dispatches DeletePage; redirects to the page list on success. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "delete")
    throw new Response("Unknown intent", { status: 400 });

  const result = deletePage(db, {
    projectId: project.id,
    identifier: params.pagename,
    actorUserId: userId,
  });
  if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
  throw redirect(`/projects/${project.identifier}/wiki`);
}

/** Page view (legacy pages/show.rhtml). */
export default function WikiPage() {
  const loaded = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const base = `/projects/${loaded.project.identifier}`;
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];

  if (!loaded.exists) {
    return (
      <main id="page-missing" style={{ fontFamily: "sans-serif", padding: 16 }}>
        <p>
          <Link to={`${base}/wiki`}>All pages</Link>
        </p>
        <h1 id="page-name">{loaded.name}</h1>
        <p className="info-box">This page does not exist yet.</p>
        {loaded.canEdit && (
          <p>
            <Link
              to={`${base}/wiki/new?name=${encodeURIComponent(loaded.identifier)}`}
              id="create-page"
            >
              Create this page
            </Link>
          </p>
        )}
      </main>
    );
  }

  const historical = loaded.version !== loaded.currentVersion;

  return (
    <main id="wiki-page" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to={`${base}/wiki`}>All pages</Link> ·{" "}
        <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/settings`}>Settings</Link>
      </p>
      {errors.length > 0 && (
        <ul className="page-errors" style={{ color: "#b00020" }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      <h1 id="page-name">{loaded.name}</h1>
      <p id="version-info" className="version-info">
        Version {loaded.version} of {loaded.currentVersion}
        {historical && (
          <>
            {" — "}
            <Link to={`${base}/wiki/${encodeURIComponent(loaded.identifier)}`}>
              Show latest version
            </Link>
          </>
        )}
      </p>

      <div id="content" className="wiki">
        <div
          id="page-content"
          // Safe: built by renderPageContent from an allowlist.
          dangerouslySetInnerHTML={{ __html: loaded.content }}
        />
      </div>

      <p>
        {loaded.canEdit && !historical && (
          <Link to={`${base}/wiki/${encodeURIComponent(loaded.identifier)}/edit`} className="edit">
            Edit
          </Link>
        )}
        {loaded.canDelete && (
          <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
            <input type="hidden" name="intent" value="delete" />
            <button type="submit" className="delete">
              Delete
            </button>
          </Form>
        )}
      </p>

      {loaded.linkedFrom.length > 0 && (
        <section id="linked-from">
          <h3>Pages that link here</h3>
          <ul>
            {loaded.linkedFrom.map((page) => (
              <li key={page.id}>
                <Link to={`${base}/wiki/${encodeURIComponent(page.identifier)}`}>
                  {page.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="history">
        <h3>History</h3>
        <ul>
          {loaded.history.map((entry) => (
            <li key={entry.version}>
              <Link
                to={`${base}/wiki/${encodeURIComponent(loaded.identifier)}?version=${entry.version}`}
              >
                Version {entry.version}
              </Link>{" "}
              — {entry.modifiedBy}
              {entry.isDeletion ? " (deleted)" : ""}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
