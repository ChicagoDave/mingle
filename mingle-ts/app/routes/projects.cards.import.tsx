/**
 * /projects/:identifier/cards/import — imports cards from a CSV/TSV
 * file or paste, with a mapping preview (Phase 29; legacy
 * CardsImportController's preview → confirm flow).
 *
 * Purpose: a team member uploads a file (`file`) or pastes text
 * (`text`), sees each column's suggested target with a selector to
 * change it and every row's outcome (`intent=preview`), then imports
 * (`intent=import`). Both intents carry the text and the chosen
 * mapping (`mapping[<column index>]`). Errors name the row.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Import/Export (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards.import";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";
import {
  importCards,
  previewCardImport,
  settableProperties,
} from "~/domain/import-export/card-import.server";
import { formatColumnTarget, parseColumnTarget, type ColumnTarget } from "~/shared/wire-types";
import { findProjectByIdentifier } from "~/domain/import-export/lookup.server";

/** Loads the project, the properties a column may target, and whether the viewer may import. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = findProjectByIdentifier(db, params.identifier);
  if (!project) throw new Response("Not Found", { status: 404 });
  return {
    project: { name: project.name, identifier: project.identifier },
    properties: settableProperties(db, project.id).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    canImport: privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
  };
}

/** The text from the upload when present, else the pasted text. */
async function importText(form: FormData): Promise<string> {
  const upload = form.get("file");
  if (upload instanceof File && upload.size > 0) return upload.text();
  return String(form.get("text") ?? "");
}

/** The posted mapping (`mapping[i]` fields) as targets, or null when none was posted. */
function postedMapping(form: FormData): ColumnTarget[] | null {
  const entries: [number, string][] = [];
  for (const [key, value] of form.entries()) {
    const match = /^mapping\[(\d+)\]$/.exec(key);
    if (match) entries.push([Number(match[1]), String(value)]);
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => a[0] - b[0]);
  return entries.map(([, value]) => parseColumnTarget(value) ?? { kind: "ignore" });
}

/** Dispatches `preview` and `import`; both echo the text and mapping back for the form. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = findProjectByIdentifier(db, params.identifier);
  if (!project) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const text = await importText(form);
  const mapping = postedMapping(form);
  if (!text.trim()) return data({ ok: false as const, text, errors: { text: ["Import file must be uploaded or pasted"] } }, { status: 400 });

  if (intent === "preview") {
    const result = previewCardImport(db, { projectId: project.id, text, mapping, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, text, errors: result.errors }, { status: 400 });
    return data({ ok: true as const, text, preview: result.value, mapping: result.value.mapping.map(formatColumnTarget) });
  }
  if (intent === "import") {
    const result = importCards(db, { projectId: project.id, text, mapping, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, text, errors: result.errors }, { status: 400 });
    throw redirect(`/projects/${project.identifier}/cards?imported=${result.value.created.length + result.value.updated.length}`);
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Import page: upload/paste, then a mapping-and-rows preview with an import button. */
export default function CardImportPage() {
  const { project, properties, canImport } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const base = `/projects/${project.identifier}`;
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const preview = actionData && actionData.ok ? actionData.preview : null;
  const text = actionData?.text ?? "";

  return (
    <main id="card-import" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/projects">All projects</Link> · <Link to={`${base}/cards`}>{project.name} cards</Link>
      </p>
      <h1>Import cards</h1>
      {!canImport ? (
        <p className="info-box">Only team members can import cards.</p>
      ) : (
        <>
          {errors.length > 0 && (
            <ul className="error-box">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="preview" />
            <p>
              <label>
                File (CSV or tab-separated) <input name="file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" />
              </label>
            </p>
            <p>
              <label>
                …or paste <textarea name="text" rows={8} cols={80} defaultValue={text} />
              </label>
            </p>
            <button type="submit">Preview</button>
          </Form>

          {preview && (
            <Form method="post" id="preview">
              <input type="hidden" name="text" value={text} />
              <h2>Columns</h2>
              <table>
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.header.map((cell, index) => (
                    <tr key={index}>
                      <td>{cell}</td>
                      <td>
                        <select name={`mapping[${index}]`} defaultValue={formatColumnTarget(preview.mapping[index])}>
                          <option value="ignore">(ignore)</option>
                          <option value="number">Number</option>
                          <option value="name">Name</option>
                          <option value="description">Description</option>
                          <option value="type">Card type</option>
                          {properties.map((p) => (
                            <option key={p.id} value={`property:${p.id}`}>
                              {p.name} ({p.kind})
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="submit" name="intent" value="preview">
                Re-preview with this mapping
              </button>
              <h2>Rows</h2>
              <p>
                {preview.creates} to create · {preview.updates} to update · {preview.errorCount} with errors
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Action</th>
                    <th>#</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Values</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.row} className={row.action === "error" ? "error-box" : undefined}>
                      <td>{row.row}</td>
                      <td>{row.action}</td>
                      <td>{row.number ?? "—"}</td>
                      <td>{row.name ?? "—"}</td>
                      <td>{row.cardType ?? "—"}</td>
                      <td>{row.values.map((v) => `${v.property} = ${v.value ?? "(not set)"}`).join("; ")}</td>
                      <td>{row.errors.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="submit" name="intent" value="import" disabled={preview.errorCount > 0}>
                Import {preview.creates + preview.updates} cards
              </button>
            </Form>
          )}
        </>
      )}
    </main>
  );
}
