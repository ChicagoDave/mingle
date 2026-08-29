/**
 * /projects/:identifier/integrations — Slack notifier and GitHub
 * repositories (Phase 32).
 *
 * Purpose: the project admin's page for external integrations, the
 * successor of legacy's Slack settings and `github#new`. Forms post to
 * one action by `intent`: "slack" (ConfigureSlackIntegration; the
 * webhook URL is write-only), "slack-remove", "github-add"
 * (ConfigureGithubIntegration — the secret is shown once with the
 * payload URL to paste into GitHub), "github-remove".
 *
 * Public interface: `loader`, `action`, default component.
 * Owner context: External Integrations (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.integrations";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { sealer } from "~/auth/sealer.server";
import { requireUserId } from "~/auth/session.server";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";
import { configureGithubIntegration, removeGithubIntegration } from "~/domain/integrations/github.server";
import { githubIntegrationViews, recentCommitLinks, slackIntegrationView } from "~/domain/integrations/read.server";
import { configureSlackIntegration, removeSlackIntegration } from "~/domain/integrations/slack.server";

/** The project, for a project admin; 404 unknown, 403 below admin. */
function requireProjectAdmin(userId: number, identifier: string | undefined) {
  const project = identifier ? db.select().from(projects).where(eq(projects.identifier, identifier)).get() : undefined;
  if (!project) throw new Response("Not Found", { status: 404 });
  if (privilegeLevelFor(db, userId, project.id) < PrivilegeLevel.PROJECT_ADMIN) throw new Response("Forbidden", { status: 403 });
  return project;
}

/** Loads the Slack view, the repositories, and the recent commit links. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = requireProjectAdmin(userId, params.identifier);
  return {
    project: { name: project.name, identifier: project.identifier },
    slack: slackIntegrationView(db, project.id),
    github: githubIntegrationViews(db, project.id),
    payloadUrl: new URL(`/projects/${project.identifier}/github/webhook`, request.url).toString(),
    commits: recentCommitLinks(db, project.id),
  };
}

/** Dispatches by intent to the integration commands. */
export async function action({ request, params }: Route.ActionArgs) {
  const actorUserId = await requireUserId(request);
  const project = requireProjectAdmin(actorUserId, params.identifier);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const text = (field: string) => String(form.get(field) ?? "");
  const done = <T,>(result: { ok: true; value: T } | { ok: false; errors: FieldErrors }, saved: string) =>
    result.ok ? { saved, intent } : { intent, errors: result.errors };

  if (intent === "slack")
    return done(
      configureSlackIntegration(db, sealer, {
        projectId: project.id,
        webhookUrl: text("webhookUrl"),
        channelLabel: text("channelLabel"),
        enabled: form.get("enabled") === "on",
        actorUserId,
      }),
      "slack",
    );
  if (intent === "slack-remove") return done(removeSlackIntegration(db, { projectId: project.id, actorUserId }), "slack-remove");
  if (intent === "github-add") {
    const result = configureGithubIntegration(db, sealer, { projectId: project.id, repository: text("repository"), actorUserId });
    return result.ok
      ? { saved: "github-add", intent, secret: result.value.secret, repository: result.value.row.repository }
      : { intent, errors: result.errors };
  }
  if (intent === "github-remove")
    return done(
      removeGithubIntegration(db, { projectId: project.id, integrationId: Number(form.get("integrationId") ?? 0), actorUserId }),
      "github-remove",
    );
  throw new Response("Unknown intent", { status: 400 });
}

/** Integrations page. Styling is deliberately minimal until the UX-harvest phases. */
export default function ProjectIntegrations() {
  const { project, slack, github, payloadUrl, commits } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errorsFor = (intent: string): FieldErrors =>
    actionData && "errors" in actionData && actionData.intent === intent ? (actionData.errors ?? {}) : {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const secret = actionData && "secret" in actionData ? actionData : null;

  return (
    <main style={{ maxWidth: 720, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Integrations — {project.name}</h1>
      <p>
        <Link to={`/projects/${project.identifier}/settings`}>Settings</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/cards`}>Cards</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}

      <h2>Slack</h2>
      <p>
        <small>
          Every history entry of this project (cards, pages, murmurs, dependencies) is posted to a Slack incoming
          webhook. Create one in Slack and paste its URL here; it is stored encrypted and never shown again.
        </small>
      </p>
      {slack.configured ? (
        <p>
          Configured{slack.channelLabel ? ` for ${slack.channelLabel}` : ""}, {slack.enabled ? "enabled" : "disabled"}.
          {slack.lastDeliveredAt ? ` Last delivered ${slack.lastDeliveredAt.slice(0, 19).replace("T", " ")}.` : " Nothing delivered yet."}
          {slack.lastError ? <span style={{ color: "crimson" }}> Last error: {slack.lastError}</span> : null}
        </p>
      ) : (
        <p>Not configured.</p>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="slack" />
        <p>
          <label>
            Webhook URL{slack.configured ? " (set — leave blank to keep)" : ""}
            <br />
            <input name="webhookUrl" type="password" autoComplete="off" style={{ width: "100%" }} />
          </label>
          <ErrorLines field="webhookUrl" errors={errorsFor("slack")} />
        </p>
        <p>
          <label>
            Channel label (display only)
            <br />
            <input name="channelLabel" defaultValue={slack.channelLabel} />
          </label>
        </p>
        <p>
          <label>
            <input type="checkbox" name="enabled" defaultChecked={!slack.configured || slack.enabled} /> Enabled
          </label>
        </p>
        <ErrorLines field="authorization" errors={errorsFor("slack")} />
        <button type="submit">Save Slack settings</button>
      </Form>
      {slack.configured ? (
        <Form method="post">
          <input type="hidden" name="intent" value="slack-remove" />
          <button type="submit">Remove Slack integration</button>
        </Form>
      ) : null}

      <h2>GitHub</h2>
      <p>
        <small>
          Register a repository, then add a webhook on GitHub for push events with content type <code>application/json</code>,
          payload URL <code>{payloadUrl}</code>, and the secret shown once below. Commits whose message mentions a card
          (<code>#123</code>) are linked to it and murmured into the project.
        </small>
      </p>
      {secret ? (
        <p style={{ background: "#fff8dc", padding: "0.5rem" }}>
          Webhook secret for <strong>{secret.repository}</strong> — copy it now, it will not be shown again:
          <br />
          <code data-testid="github-secret">{secret.secret}</code>
        </p>
      ) : null}
      {github.length === 0 ? (
        <p>No repositories registered.</p>
      ) : (
        <ul>
          {github.map((repo) => (
            <li key={repo.id}>
              <code>{repo.repository}</code>
              {repo.lastReceivedAt ? ` — last push ${repo.lastReceivedAt.slice(0, 19).replace("T", " ")}` : " — no pushes yet"}{" "}
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="github-remove" />
                <input type="hidden" name="integrationId" value={repo.id} />
                <button type="submit">Remove</button>
              </Form>
            </li>
          ))}
        </ul>
      )}
      <Form method="post">
        <input type="hidden" name="intent" value="github-add" />
        <p>
          <label>
            Repository (owner/name)
            <br />
            <input name="repository" placeholder="acme/widgets" />
          </label>
          <ErrorLines field="repository" errors={errorsFor("github-add")} />
          <ErrorLines field="authorization" errors={errorsFor("github-add")} />
        </p>
        <button type="submit">Register repository</button>
      </Form>

      <h2>Recent commits</h2>
      {commits.length === 0 ? (
        <p>No commits linked yet.</p>
      ) : (
        <ul id="recent-commits">
          {commits.map((commit) => (
            <li key={`${commit.sha}-${commit.cardNumber}`}>
              <a href={commit.url}>{commit.shortSha}</a> on{" "}
              <Link to={`/projects/${project.identifier}/cards/${commit.cardNumber}`}>#{commit.cardNumber}</Link> by{" "}
              {commit.authorName}: {commit.message.split("\n")[0]}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Renders a field's error messages, if any. */
function ErrorLines({ field, errors }: { field: string; errors: FieldErrors }) {
  return (
    <>
      {errors[field]?.map((message) => (
        <span key={message} style={{ color: "crimson", display: "block" }}>
          {message}
        </span>
      ))}
    </>
  );
}
