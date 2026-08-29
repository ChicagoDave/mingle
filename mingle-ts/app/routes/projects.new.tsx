/**
 * /projects/new — project creation.
 *
 * Purpose: the CreateProject form (name, optional identifier,
 * description) with legacy's "Pre-defined templates" picker (P-5;
 * projects/_new_form.rhtml + _thumbnail.rhtml): a radio per shipped
 * template under `templates/` plus Blank. A template creates the
 * project through ImportProject with the entered name and identifier
 * overriding the bundle's own; Blank runs CreateProject as before.
 * Both paths enforce site-administrator access through CreateProject's
 * own checkpoint. On success, a blank project redirects to its
 * settings page and a templated one to its overview, as legacy did.
 * Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Projects (HTTP adapter).
 */
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.new";
import { ActionBar, ErrorLines, FormItem } from "~/components/forms";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { createProject } from "~/domain/projects/commands.server";
import { importProject } from "~/domain/import-export/import.server";
import { listTemplates, loadTemplate } from "~/files/templates.server";
import { requireUserId } from "~/auth/session.server";
import "../styles/project-new.css";

/** The radio value for a project with no template. */
const BLANK = "blank";

/** Requires a logged-in session; lists the shipped templates. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  return { templates: listTemplates() };
}

/**
 * Runs CreateProject (Blank) or ImportProject (a template); redirects
 * to the project's settings or, from a template, its overview.
 */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const template = String(form.get("template") ?? BLANK);
  const name = String(form.get("name") ?? "");
  const identifier = form.get("identifier") ? String(form.get("identifier")) : null;
  const description = form.get("description") ? String(form.get("description")) : null;

  if (template === BLANK || template === "") {
    const result = createProject(db, { name, identifier, description, actorUserId: userId });
    if (!result.ok) return { errors: result.errors satisfies FieldErrors };
    throw redirect(`/projects/${result.value.identifier}/settings`);
  }

  const bundle = loadTemplate(template);
  if (!bundle) return { errors: { template: ["is not one of the available templates"] } satisfies FieldErrors };
  const result = importProject(db, {
    bundle: { ...bundle, source: { ...bundle.source, description: description ?? bundle.source.description } },
    name,
    identifier,
    actorUserId: userId,
  });
  if (!result.ok) return { errors: result.errors satisfies FieldErrors };
  throw redirect(`/projects/${result.value.identifier}/wiki/Overview_Page`);
}

/** Project creation page — legacy projects/new.rhtml with projects/_new_form.rhtml. */
export default function NewProject() {
  const { templates } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors = actionData?.errors ?? {};
  return (
    <Form method="post">
      <h1>New project</h1>
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="project" errors={errors} />
      <div id="project-settings" className="form_contents">
        <div id="basic-options-content" className="options-content">
          <h2>Project details</h2>
          <div className="form_section">
            <FormItem label="Name:" htmlFor="project_name" required field="name" errors={errors}>
              <input id="project_name" name="name" className="width-large" required />
            </FormItem>
            <FormItem
              label="Identifier:"
              htmlFor="project_identifier"
              notes="optional — generated from the name; lowercase letters, digits and underscores, up to 30 characters"
              field="identifier"
              errors={errors}
            >
              <input id="project_identifier" name="identifier" className="width-large" maxLength={30} />
            </FormItem>
            <FormItem
              label="Description:"
              htmlFor="project_description"
              notes="this will appear under the project name in the project list"
              field="description"
              errors={errors}
            >
              <textarea id="project_description" name="description" rows={6} />
            </FormItem>
          </div>
          <h2>Pre-defined templates</h2>
          <ErrorLines field="template" errors={errors} />
          <div className="form_section last">
            <div id="template-list" className="templates">
              {templates.map((template) => (
                <label key={template.identifier} className={`template yml_${template.identifier}`}>
                  <input type="radio" name="template" value={template.identifier} />
                  <span className="name">{template.name}</span>
                  {template.description ? <span className="description">{template.description}</span> : null}
                </label>
              ))}
              <label className="template blank">
                <input type="radio" name="template" value={BLANK} defaultChecked />
                <span className="name">Blank</span>
                <span className="description">Start with one card type and no properties.</span>
              </label>
            </div>
          </div>
        </div>
      </div>
      <ActionBar>
        <button type="submit" id="create_project" className="primary">
          Create project
        </button>
        <Link to="/projects" className="cancel">
          Cancel
        </Link>
      </ActionBar>
    </Form>
  );
}
