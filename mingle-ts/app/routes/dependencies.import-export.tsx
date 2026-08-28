/**
 * /dependencies/import-export — export the dependencies of chosen
 * projects, or import a dependencies bundle with a preview (Phase 29;
 * legacy DependenciesImportExportController).
 *
 * Purpose: site administrators only. `intent=export` with `project_id`
 * checkboxes downloads `dependencies.json`; `intent=preview` with a
 * file (`file`) or pasted text (`text`) shows what each dependency
 * would attach to, with an input to remap a missing raising card
 * (`raising_card[<source number>]`); `intent=import` runs the import
 * and returns here with the count.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Import/Export (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/dependencies.import-export";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import { parseDependenciesBundle } from "~/domain/import-export/dependencies-bundle.server";
import { exportDependencies, projectsForDependencyExport } from "~/domain/import-export/dependency-export.server";
import {
  importDependencies,
  previewDependencyImport,
  type RaisingCardOverrides,
} from "~/domain/import-export/dependency-import.server";

/** Lists the projects with their dependency counts and whether the viewer is a site admin. */
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const imported = new URL(request.url).searchParams.get("imported");
  return {
    canManage: authorizeSiteAdminAction(db, userId) === null,
    projects: projectsForDependencyExport(db),
    imported: imported === null ? null : Number(imported),
  };
}

async function bundleText(form: FormData): Promise<string> {
  const upload = form.get("file");
  if (upload instanceof File && upload.size > 0) return upload.text();
  return String(form.get("text") ?? "");
}

function overrides(form: FormData): RaisingCardOverrides {
  const result: RaisingCardOverrides = {};
  for (const [key, value] of form.entries()) {
    const match = /^raising_card\[(\d+)\]$/.exec(key);
    const number = Number(String(value).trim().replace(/^#/, ""));
    if (match && Number.isInteger(number) && number > 0) result[Number(match[1])] = number;
  }
  return result;
}

/** Dispatches `export`, `preview` and `import`. */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "export") {
    const projectIds = form.getAll("project_id").map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
    const result = exportDependencies(db, { projectIds, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, text: "", errors: result.errors }, { status: 400 });
    return new Response(JSON.stringify(result.value, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="dependencies.json"' },
    });
  }

  const text = await bundleText(form);
  if (!text.trim()) return data({ ok: false as const, text, errors: { bundle: ["Export file must be uploaded"] } }, { status: 400 });
  const parsed = parseDependenciesBundle(text);
  if (!parsed.ok) return data({ ok: false as const, text, errors: parsed.errors }, { status: 400 });
  const input = { bundle: parsed.value, raisingCardOverrides: overrides(form), actorUserId: userId };

  if (intent === "preview") {
    const result = previewDependencyImport(db, input);
    if (!result.ok) return data({ ok: false as const, text, errors: result.errors }, { status: 400 });
    return data({ ok: true as const, text, preview: result.value });
  }
  if (intent === "import") {
    const result = importDependencies(db, input);
    if (!result.ok) return data({ ok: false as const, text, errors: result.errors }, { status: 400 });
    throw redirect(`/dependencies/import-export?imported=${result.value.imported.length}`);
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Export checklist, import upload/paste, and the import preview with raising-card remapping. */
export default function DependenciesImportExportPage() {
  const { canManage, projects, imported } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.entries(actionData.errors) : [];
  const preview = actionData && actionData.ok ? actionData.preview : null;
  const text = actionData?.text ?? "";

  return (
    <main id="dependencies-import-export" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/projects">Projects</Link>
      </p>
      <h1>Dependencies import / export</h1>
      {imported !== null && <p style={{ color: "seagreen" }}>Imported {imported} dependencies.</p>}
      {!canManage ? (
        <p className="info-box">Only a Mingle administrator can export or import dependencies.</p>
      ) : (
        <>
          {errors.length > 0 && (
            <ul className="error-box">
              {errors.map(([field, messages]) => (
                <li key={field}>
                  <code>{field}</code> {messages.join("; ")}
                </li>
              ))}
            </ul>
          )}
          <section id="export">
            <h2>Export</h2>
            <Form method="post">
              <input type="hidden" name="intent" value="export" />
              <ul>
                {projects.map((p) => (
                  <li key={p.id}>
                    <label>
                      <input type="checkbox" name="project_id" value={p.id} /> {p.name} ({p.dependencyCount})
                    </label>
                  </li>
                ))}
              </ul>
              <button type="submit">Export selected</button>
            </Form>
          </section>
          <section id="import">
            <h2>Import</h2>
            <Form method="post" encType="multipart/form-data">
              <input type="hidden" name="intent" value="preview" />
              <p>
                <label>
                  Dependencies file <input name="file" type="file" accept="application/json,.json" />
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
                <p>
                  {preview.importable} importable · {preview.errorCount} with errors
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Name</th>
                      <th>Raising</th>
                      <th>Raising card</th>
                      <th>Resolving</th>
                      <th>Resolving cards</th>
                      <th>Problems</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.entries.map((e) => (
                      <tr key={e.sourceNumber} className={e.errors.length ? "error-box" : undefined}>
                        <td>D{e.sourceNumber}</td>
                        <td>{e.name}</td>
                        <td>{e.raisingProject.identifier}{e.raisingProject.found ? "" : " (missing)"}</td>
                        <td>
                          #{e.raisingCard.number} {e.raisingCard.name ?? ""}
                          {!e.raisingCard.found && e.raisingProject.found && (
                            <>
                              {" "}
                              <input name={`raising_card[${e.sourceNumber}]`} type="text" size={6} placeholder="card #" />
                            </>
                          )}
                        </td>
                        <td>{e.resolvingProject.identifier}{e.resolvingProject.found ? "" : " (missing)"}</td>
                        <td>{e.resolvingCards.map((c) => `#${c.number}${c.found ? "" : " (missing)"}`).join(", ")}</td>
                        <td>{[...e.errors, ...e.warnings].join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="submit" name="intent" value="preview">
                  Re-check
                </button>{" "}
                <button type="submit" name="intent" value="import" disabled={preview.errorCount > 0}>
                  Import {preview.importable} dependencies
                </button>
              </Form>
            )}
          </section>
        </>
      )}
    </main>
  );
}
