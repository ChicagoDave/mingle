/**
 * POST /projects/:identifier/gitlab/webhook — GitLab push receiver
 * (resource route, P-12).
 *
 * Purpose: the URL a project admin registers as a GitLab project
 * webhook (push events, secret token = the secret shown once at
 * registration). No session: the request authenticates by the
 * `X-Gitlab-Token` header matching an enabled GitLab registration of
 * the project for the payload's `project.path_with_namespace`. A
 * `Push Hook` runs ReceiveGithubPush on the normalized payload; other
 * hooks answer 200 and are ignored.
 *
 * Responses: 200 with the counts; 400 malformed body; 401 no or wrong
 * token; 404 unknown project or unregistered repository; 405 non-POST.
 *
 * Public interface: `action`.
 * Owner context: External Integrations (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import type { Route } from "./+types/projects.gitlab.webhook";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { sealer } from "~/auth/sealer.server";
import { receiveGithubPush } from "~/domain/integrations/github.server";
import { findGithubIntegrations } from "~/domain/integrations/read.server";
import { parseGitlabPushPayload, verifyGitlabToken } from "~/domain/integrations/scm-receivers.server";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/** POST: verify the token, then record the push. */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const project = params.identifier
    ? db.select({ id: projects.id }).from(projects).where(eq(projects.identifier, params.identifier)).get()
    : undefined;
  if (!project) return json({ error: "No such project" }, 404);
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  const path = (body as { project?: { path_with_namespace?: unknown } })?.project?.path_with_namespace;
  if (typeof path !== "string") return json({ error: "Payload names no repository" }, 400);
  const candidates = findGithubIntegrations(db, project.id, path, "gitlab");
  if (candidates.length === 0) return json({ error: "Repository is not registered for this project" }, 404);
  const token = request.headers.get("X-Gitlab-Token");
  const integration = candidates.find((row) => {
    try {
      return verifyGitlabToken(sealer.open(row.secretSealed), token);
    } catch {
      return false;
    }
  });
  if (!integration) return json({ error: "Invalid token" }, 401);
  const event = request.headers.get("X-Gitlab-Event") ?? "Push Hook";
  if (event !== "Push Hook") return json({ ok: true, event, ignored: true }, 200);
  const payload = parseGitlabPushPayload(body);
  if (!payload) return json({ error: "Payload is not a push event" }, 400);
  const result = receiveGithubPush(db, { integrationId: integration.id, payload });
  return result.ok ? json({ ok: true, ...result.value }, 200) : json({ error: "Push refused", errors: result.errors }, 422);
}
