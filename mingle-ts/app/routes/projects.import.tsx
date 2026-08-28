/**
 * /projects/import — creates a project from an uploaded or pasted
 * template bundle (Phase 28; legacy ProjectImportController).
 *
 * Purpose: the import page. A site administrator uploads a bundle
 * file (`bundle` file field) or pastes its JSON (`bundle_text`),
 * optionally overriding the project name and identifier, and lands on
 * the new project's settings page. Errors name the bundle path that
 * failed.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Import/Export (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.import";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import { parseBundle } from "~/domain/import-export/bundle.server";
import { importProject } from "~/domain/import-export/import.server";

/** Reports whether the viewer may import (site administrators only). */
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  return { canImport: authorizeSiteAdminAction(db, userId) === null };
}

/** The bundle text from the upload when present, else the pasted text. */
async function bundleText(form: FormData): Promise<string> {
  const upload = form.get("bundle");
  if (upload instanceof File && upload.size > 0) return upload.text();
  return String(form.get("bundle_text") ?? "");
}

/** Parses the bundle and runs ImportProject; redirects to the new project's settings. */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const text = await bundleText(form);
  if (!text.trim()) return data({ ok: false as const, errors: { bundle: ["Export file must be uploaded"] } }, { status: 400 });
  const parsed = parseBundle(text);
  if (!parsed.ok) return data({ ok: false as const, errors: parsed.errors }, { status: 400 });
  const result = importProject(db, {
    bundle: parsed.value,
    name: String(form.get("name") ?? ""),
    identifier: String(form.get("identifier") ?? ""),
    actorUserId: userId,
  });
  if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
  throw redirect(`/projects/${result.value.identifier}/settings`);
}

/** Import page: file upload or pasted JSON, with optional name/identifier overrides. */
export default function ImportProjectPage() {
  const { canImport } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.entries(actionData.errors) : [];

  return (
    <main id="import-project" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/projects">Projects</Link>
      </p>
      <h1>Import a project</h1>
      {!canImport ? (
        <p className="info-box">Only a Mingle administrator can import projects.</p>
      ) : (
        <Form method="post" encType="multipart/form-data">
          {errors.length > 0 && (
            <ul className="error-box">
              {errors.map(([field, messages]) => (
                <li key={field}>
                  <code>{field}</code> {messages.join("; ")}
                </li>
              ))}
            </ul>
          )}
          <p>
            <label>
              Template file <input name="bundle" type="file" accept="application/json,.json" />
            </label>
          </p>
          <p>
            <label>
              …or paste the template JSON <textarea name="bundle_text" rows={10} cols={80} />
            </label>
          </p>
          <p>
            <label>
              Project name (optional) <input name="name" type="text" size={40} />
            </label>{" "}
            <label>
              Identifier (optional) <input name="identifier" type="text" size={30} />
            </label>
          </p>
          <button type="submit">Import</button>
        </Form>
      )}
    </main>
  );
}
