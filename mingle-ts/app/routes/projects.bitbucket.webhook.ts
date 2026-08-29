/**
 * POST /projects/:identifier/bitbucket/webhook — Bitbucket Cloud push
 * receiver (resource route, P-12).
 *
 * Purpose: the URL a project admin registers as a Bitbucket repository
 * webhook (Repository push, secret = the secret shown once at
 * registration). No session: the request authenticates by Bitbucket's
 * `X-Hub-Signature` (`sha256=<hex>` HMAC over the raw body), checked
 * against every enabled Bitbucket registration of the project for the
 * payload's `repository.full_name`. A `repo:push` runs
 * ReceiveGithubPush on the normalized payload; other event keys answer
 * 200 and are ignored.
 *
 * Responses: 200 with the counts; 400 malformed body; 401 no or wrong
 * signature; 404 unknown project or unregistered repository; 405
 * non-POST.
 *
 * Public interface: `action`.
 * Owner context: External Integrations (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import type { Route } from "./+types/projects.bitbucket.webhook";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { sealer } from "~/auth/sealer.server";
import { receiveGithubPush } from "~/domain/integrations/github.server";
import { findGithubIntegrations } from "~/domain/integrations/read.server";
import { parseBitbucketPushPayload, verifyBitbucketSignature } from "~/domain/integrations/scm-receivers.server";

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
  const candidates = findGithubIntegrations(db, project.id, fullName, "bitbucket");
  if (candidates.length === 0) return json({ error: "Repository is not registered for this project" }, 404);
  const signature = request.headers.get("X-Hub-Signature");
  const integration = candidates.find((row) => {
    try {
      return verifyBitbucketSignature(sealer.open(row.secretSealed), rawBody, signature);
    } catch {
      return false;
    }
  });
  if (!integration) return json({ error: "Invalid signature" }, 401);
  const event = request.headers.get("X-Event-Key") ?? "repo:push";
  if (event !== "repo:push") return json({ ok: true, event, ignored: true }, 200);
  const payload = parseBitbucketPushPayload(body);
  if (!payload) return json({ error: "Payload is not a push event" }, 400);
  const result = receiveGithubPush(db, { integrationId: integration.id, payload });
  return result.ok ? json({ ok: true, ...result.value }, 200) : json({ error: "Push refused", errors: result.errors }, 422);
}
