/**
 * POST /projects/:identifier/github/webhook — GitHub push receiver
 * (resource route, Phase 32; legacy `github#receive`).
 *
 * Purpose: the payload URL a project admin registers on GitHub. No
 * session: the request authenticates by GitHub's `X-Hub-Signature-256`
 * over the raw body, checked against every enabled registration of
 * the project for the payload's repository. A `ping` event answers
 * 200 without side effects; a `push` runs ReceiveGithubPush.
 *
 * Responses: 200 with the counts; 400 malformed body; 401 no or
 * wrong signature; 404 unknown project or unregistered repository;
 * 405 non-POST.
 *
 * Public interface: `action`.
 * Owner context: External Integrations (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import type { Route } from "./+types/projects.github.webhook";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { sealer } from "~/auth/sealer.server";
import { parsePushPayload, receiveGithubPush, verifyGithubSignature } from "~/domain/integrations/github.server";
import { findGithubIntegrations } from "~/domain/integrations/read.server";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/** POST: verify the signature, then record the push. */
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const project = params.identifier
    ? db.select({ id: projects.id }).from(projects).where(eq(projects.identifier, params.identifier)).get()
    : undefined;
  if (!project) return json({ error: "No such project" }, 404);

  const rawBody = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
  const fullName = (body as { repository?: { full_name?: unknown } })?.repository?.full_name;
  if (typeof fullName !== "string") return json({ error: "Payload names no repository" }, 400);

  const candidates = findGithubIntegrations(db, project.id, fullName);
  if (candidates.length === 0) return json({ error: "Repository is not registered for this project" }, 404);
  const signature = request.headers.get("X-Hub-Signature-256");
  const integration = candidates.find((row) => {
    try {
      return verifyGithubSignature(sealer.open(row.secretSealed), rawBody, signature);
    } catch {
      return false;
    }
  });
  if (!integration) return json({ error: "Invalid signature" }, 401);

  const event = request.headers.get("X-GitHub-Event") ?? "push";
  if (event === "ping") return json({ ok: true, event: "ping" }, 200);
  if (event !== "push") return json({ ok: true, event, ignored: true }, 200);

  const payload = parsePushPayload(body);
  if (!payload) return json({ error: "Payload is not a push event" }, 400);
  const result = receiveGithubPush(db, { integrationId: integration.id, payload });
  return result.ok ? json({ ok: true, ...result.value }, 200) : json({ error: "Push refused", errors: result.errors }, 422);
}
