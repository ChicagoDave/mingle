/**
 * /projects/:identifier/wiki/:pagename/edit — edit a wiki page
 * (Phase 16).
 *
 * Purpose: the legacy PagesController#edit/#update pair
 * (pages/edit.rhtml over pages/_form.rhtml) — the body editor loaded
 * with the page's current source, posting to the UpdatePage command
 * and returning to the page on success. A page's name is not editable,
 * as in legacy: the name is the page's address and every `[[…]]` link
 * to it is stored as text.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Wiki & Content (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.wiki.page.edit";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import { PageEditor } from "~/components/page-editor";
import { updatePage } from "~/domain/pages/commands.server";
import { findPage } from "~/domain/pages/read.server";

/** Loads the page's current source for editing. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const page = findPage(db, project.id, params.pagename);
  if (!page) throw new Response("Not Found", { status: 404 });

  return {
    project: { name: project.name, identifier: project.identifier },
    identifier: params.pagename,
    name: page.name,
    content: page.content,
    version: page.version,
  };
}

/** Dispatches UpdatePage; returns to the page, or re-renders errors. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const content = String(form.get("content") ?? "");
  const result = updatePage(db, {
    projectId: project.id,
    identifier: params.pagename,
    content,
    actorUserId: userId,
  });
  if (!result.ok)
    return data({ ok: false as const, errors: result.errors, content }, { status: 400 });

  throw redirect(
    `/projects/${project.identifier}/wiki/${encodeURIComponent(params.pagename)}`,
  );
}

/** Edit page form (legacy pages/edit.rhtml). */
export default function EditWikiPage() {
  const { project, identifier, name, content, version } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;
  const showUrl = `${base}/wiki/${encodeURIComponent(identifier)}`;

  return (
    <main id="edit-wiki-page" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to={`${base}/wiki`}>All pages</Link> · <Link to={showUrl}>{name}</Link>
      </p>
      <h1>{name}</h1>
      <p id="version-info" className="version-info">
        Version {version}
      </p>
      {errors.length > 0 && (
        <ul className="page-errors" style={{ color: "#b00020" }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <Form method="post" id="page_form">
        <PageEditor
          defaultValue={actionData && !actionData.ok ? actionData.content : content}
        />
        <p>
          <button type="submit" className="save">
            Save
          </button>{" "}
          <Link to={showUrl} id="cancel" className="cancel">
            Cancel
          </Link>
        </p>
      </Form>
    </main>
  );
}
