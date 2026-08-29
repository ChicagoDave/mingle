/**
 * GET /projects/:identifier/export — downloads the project's
 * configuration as a template bundle (Phase 28; legacy
 * ProjectExportsController#create with export_as_template).
 *
 * Purpose: a resource route (no page) that streams the JSON bundle as
 * an attachment named `<identifier>-template.json`. Project
 * administrators only; anyone else gets 403.
 *
 * Public interface: `loader`.
 *
 * Owner context: Import/Export (HTTP adapter).
 */
import type { Route } from "./+types/projects.export";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { exportProject } from "~/domain/import-export/export.server";
import { findProjectByIdentifier } from "~/domain/import-export/lookup.server";

/** Builds and returns the bundle as a JSON attachment. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = findProjectByIdentifier(db, params.identifier);
  if (!project) throw new Response("Not Found", { status: 404 });
  // `?content=1` asks for the content sections too (ADR-0024 Decision 3).
  const includeContent = new URL(request.url).searchParams.get("content") === "1";
  const result = exportProject(db, { projectId: project.id, actorUserId: userId, includeContent });
  if (!result.ok) throw new Response("Forbidden", { status: 403 });
  return new Response(JSON.stringify(result.value, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${project.identifier}-template${includeContent ? "-with-content" : ""}.json"`,
    },
  });
}
