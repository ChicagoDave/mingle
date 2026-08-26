/**
 * /projects/:identifier/wiki/new — create a wiki page (Phase 16).
 *
 * Purpose: the legacy PagesController#new/#create pair (pages/new.rhtml
 * over pages/_form.rhtml) — a name field and the body editor, posting
 * to the CreatePage command and redirecting to the new page on success.
 * A `?name=` query pre-fills the name, which is how a link to a page
 * that does not exist yet leads into creating it.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Wiki & Content (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.wiki.new";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import { PageEditor } from "~/components/page-editor";
import { createPage } from "~/domain/pages/commands.server";
import { pageIdentifier, pageNameFromIdentifier } from "~/domain/pages/naming.server";

/** Loads the project and the name to pre-fill, if the caller supplied one. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const requested = new URL(request.url).searchParams.get("name") ?? "";
  return {
    project: { name: project.name, identifier: project.identifier },
    suggestedName: pageNameFromIdentifier(requested),
  };
}

/** Dispatches CreatePage; redirects to the new page, or re-renders errors. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const name = String(form.get("name") ?? "");
  const result = createPage(db, {
    projectId: project.id,
    name,
    content: String(form.get("content") ?? ""),
    actorUserId: userId,
  });
  if (!result.ok)
    return data(
      { ok: false as const, errors: result.errors, name, content: String(form.get("content") ?? "") },
      { status: 400 },
    );

  throw redirect(
    `/projects/${project.identifier}/wiki/${encodeURIComponent(pageIdentifier(result.value.name))}`,
  );
}

/** New page form (legacy pages/new.rhtml). */
export default function NewWikiPage() {
  const { project, suggestedName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;

  return (
    <main id="new-wiki-page" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to={`${base}/wiki`}>All pages</Link> ·{" "}
        <Link to={`${base}/cards`}>Cards</Link>
      </p>
      <h1>New page</h1>
      {errors.length > 0 && (
        <ul className="page-errors" style={{ color: "#b00020" }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <Form method="post" id="page_form">
        <p>
          <label htmlFor="page-name">Name</label>
          <br />
          <input
            type="text"
            id="page-name"
            name="name"
            defaultValue={(actionData && !actionData.ok ? actionData.name : suggestedName) ?? ""}
            maxLength={255}
            style={{ width: "100%", fontSize: 16 }}
          />
        </p>
        <PageEditor
          defaultValue={actionData && !actionData.ok ? actionData.content : ""}
        />
        <p>
          <button type="submit" className="save">
            Save
          </button>{" "}
          <Link to={`${base}/wiki`} id="cancel" className="cancel">
            Cancel
          </Link>
        </p>
      </Form>
    </main>
  );
}
