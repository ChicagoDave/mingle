/**
 * /projects/:identifier/integrations — Slack notifier and GitHub
 * repositories (Phase 32).
 *
 * Purpose: the project admin's page for external integrations, the
 * successor of legacy's Slack settings and `github#new`. Forms post to
 * one action by `intent`: "slack" (ConfigureSlackIntegration — the
 * default webhook, or `integrationId`; the URL is write-only),
 * "slack-add" (AddSlackWebhook), "slack-default"
 * (SetDefaultSlackWebhook), "slack-routes" (RouteSlackEvents, one
 * `route[<event type>]` field per type: "default", "suppressed", or a
 * webhook id), "slack-remove" (`integrationId`), "github-add"
 * (ConfigureGithubIntegration — the secret is shown once with the
 * payload URL to paste into GitHub), "github-remove".
 *
 * Public interface: `loader`, `action`, default component.
 * Owner context: External Integrations (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.integrations";
import { ActionBar, FormItem, ErrorLines, FlashBox, AdminPage } from "~/components/forms";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { sealer } from "~/auth/sealer.server";
import { requireUserId } from "~/auth/session.server";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";
import { configureGithubIntegration, removeGithubIntegration } from "~/domain/integrations/github.server";
import { githubIntegrationViews, recentCommitLinks, slackIntegrationView } from "~/domain/integrations/read.server";
import {
  addSlackWebhook,
  configureSlackIntegration,
  removeSlackIntegration,
  routeSlackEvents,
  setDefaultSlackWebhook,
} from "~/domain/integrations/slack.server";
import {
  SCM_PROVIDERS,
  SCM_PROVIDER_LABELS,
  SLACK_EVENT_TYPES,
  SLACK_EVENT_TYPE_LABELS,
  type ScmProvider,
  type SlackEventType,
  type SlackRouteTarget,
} from "~/shared/wire-types";

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
    payloadUrls: Object.fromEntries(
      SCM_PROVIDERS.map((provider) => [provider, new URL(`/projects/${project.identifier}/${provider}/webhook`, request.url).toString()]),
    ) as Record<ScmProvider, string>,
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

  const integrationId = form.get("integrationId") ? Number(form.get("integrationId")) : null;
  if (intent === "slack")
    return done(
      configureSlackIntegration(db, sealer, {
        projectId: project.id,
        integrationId,
        webhookUrl: text("webhookUrl"),
        channelLabel: text("channelLabel"),
        enabled: form.get("enabled") === "on",
        actorUserId,
      }),
      "slack",
    );
  if (intent === "slack-add")
    return done(
      addSlackWebhook(db, sealer, {
        projectId: project.id,
        webhookUrl: text("webhookUrl"),
        channelLabel: text("channelLabel"),
        enabled: form.get("enabled") === "on",
        actorUserId,
      }),
      "slack-add",
    );
  if (intent === "slack-default")
    return done(setDefaultSlackWebhook(db, { projectId: project.id, integrationId: integrationId ?? 0, actorUserId }), "slack-default");
  if (intent === "slack-routes") {
    const routes: Partial<Record<SlackEventType, SlackRouteTarget>> = {};
    for (const type of SLACK_EVENT_TYPES) {
      const posted = form.get(`route[${type}]`);
      if (posted === null) continue;
      const value = String(posted);
      routes[type] = value === "default" || value === "suppressed" ? value : Number(value);
    }
    return done(routeSlackEvents(db, { projectId: project.id, routes, actorUserId }), "slack-routes");
  }
  if (intent === "slack-remove") return done(removeSlackIntegration(db, { projectId: project.id, integrationId, actorUserId }), "slack-remove");
  if (intent === "github-add") {
    const posted = text("provider") || "github";
    const provider = (SCM_PROVIDERS as readonly string[]).includes(posted) ? (posted as ScmProvider) : "github";
    const result = configureGithubIntegration(db, sealer, { projectId: project.id, repository: text("repository"), provider, actorUserId });
    return result.ok
      ? { saved: "github-add", intent, secret: result.value.secret, repository: result.value.row.repository, provider }
      : { intent, errors: result.errors };
  }
  if (intent === "github-remove")
    return done(
      removeGithubIntegration(db, { projectId: project.id, integrationId: Number(form.get("integrationId") ?? 0), actorUserId }),
      "github-remove",
    );
  throw new Response("Unknown intent", { status: 400 });
}

/** Integrations — no legacy counterpart (Phase 32); reuses the legacy settings-page structure (form sections, action bars, highlightable tables) beside the admin nav. */
export default function ProjectIntegrations() {
  const { project, slack, github, payloadUrl, payloadUrls, commits } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errorsFor = (intent: string): FieldErrors =>
    actionData && "errors" in actionData && actionData.intent === intent ? (actionData.errors ?? {}) : {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const secret = actionData && "secret" in actionData ? actionData : null;

  return (
    <AdminPage identifier={project.identifier} current="integrations">
      <h1>Integrations</h1>
      {saved ? <FlashBox kind="success">Integration settings were successfully saved.</FlashBox> : null}

      <h2 id="slack">Slack</h2>
      <p className="notes">
        Every history entry of this project (cards, pages, murmurs, dependencies) is posted to Slack incoming webhooks.
        An incoming webhook is bound to its channel when Slack creates it, so a channel is a webhook URL: register one
        per channel, pick the default, and route or suppress event types below. URLs are stored encrypted and never
        shown again.
      </p>
      <table id="slack-webhooks" className="highlightable-table">
        <thead>
          <tr className="table-top">
            <th>Channel</th>
            <th>Enabled</th>
            <th>Default</th>
            <th>Last delivered</th>
            <th className="align-right last">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {slack.webhooks.length === 0 ? (
            <tr>
              <td colSpan={5} className="italic-light align-center last">
                No webhooks registered.
              </td>
            </tr>
          ) : (
            slack.webhooks.map((webhook, index) => (
              <tr key={webhook.id} className={index % 2 === 0 ? "odd" : "even"}>
                <td>{webhook.channelLabel || <span className="italic-light">(unlabelled)</span>}</td>
                <td>{webhook.enabled ? "yes" : "no"}</td>
                <td className="inline-forms">
                  {webhook.isDefault ? (
                    "default"
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="slack-default" />
                      <input type="hidden" name="integrationId" value={webhook.id} />
                      <button type="submit" className="inline">
                        Make default
                      </button>
                    </Form>
                  )}
                </td>
                <td>
                  {webhook.lastDeliveredAt ? webhook.lastDeliveredAt.slice(0, 19).replace("T", " ") : "never"}
                  {webhook.lastError ? <span className="field_error"> Last error: {webhook.lastError}</span> : null}
                </td>
                <td className="align-right last inline-forms">
                  <Form method="post">
                    <input type="hidden" name="intent" value="slack-remove" />
                    <input type="hidden" name="integrationId" value={webhook.id} />
                    <button type="submit" className="inline delete">
                      Remove
                    </button>
                  </Form>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <Form method="post" className="form_contents" id="slack-add">
        <input type="hidden" name="intent" value="slack-add" />
        <h3>Add a webhook</h3>
        <div className="form_section last">
          <FormItem label="Webhook URL:" htmlFor="slack_webhook_url" required field="webhookUrl" errors={errorsFor("slack-add")}>
            <input id="slack_webhook_url" name="webhookUrl" type="password" autoComplete="off" className="width-full" />
          </FormItem>
          <FormItem label="Channel label:" htmlFor="slack_channel_label" notes="display only">
            <input id="slack_channel_label" name="channelLabel" className="width-large" />
          </FormItem>
          <div className="checkbox_row">
            <input type="checkbox" id="slack_enabled" name="enabled" defaultChecked />{" "}
            <label htmlFor="slack_enabled" className="inline">
              Enabled
            </label>
          </div>
          <ErrorLines field="authorization" errors={errorsFor("slack-add")} />
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Add webhook
          </button>
        </ActionBar>
      </Form>
      {slack.configured ? (
        <Form method="post" className="form_contents" id="slack-routes">
          <input type="hidden" name="intent" value="slack-routes" />
          <h3>Event routing</h3>
          <p className="notes">
            Each event type goes to the default webhook unless routed to another one or suppressed.
          </p>
          <ErrorLines field="routes" errors={errorsFor("slack-routes")} />
          <ErrorLines field="authorization" errors={errorsFor("slack-routes")} />
          <table id="slack-event-routes" className="highlightable-table">
            <thead>
              <tr className="table-top">
                <th>Event</th>
                <th className="last">Goes to</th>
              </tr>
            </thead>
            <tbody>
              {SLACK_EVENT_TYPES.map((type, index) => (
                <tr key={type} className={index % 2 === 0 ? "odd" : "even"}>
                  <td>{SLACK_EVENT_TYPE_LABELS[type]}</td>
                  <td className="last">
                    <select name={`route[${type}]`} defaultValue={String(slack.routes[type])}>
                      <option value="default">Default webhook</option>
                      {slack.webhooks
                        .filter((webhook) => !webhook.isDefault)
                        .map((webhook) => (
                          <option key={webhook.id} value={String(webhook.id)}>
                            {webhook.channelLabel || `webhook #${webhook.id}`}
                          </option>
                        ))}
                      <option value="suppressed">Suppressed (not posted)</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ActionBar>
            <button type="submit" className="save">
              Save routing
            </button>
          </ActionBar>
        </Form>
      ) : null}

      <h2 id="github">Source repositories</h2>
      <p className="notes">
        Register a repository on GitHub, GitLab, or Bitbucket, then add a webhook there with the payload URL for its
        host and the secret shown once below. Commits whose message mentions a card (<code>#123</code>) are linked to
        it and murmured into the project; on GitHub, pull requests mentioning a card are linked too, and commit
        statuses are shown beside the commits.
      </p>
      <ul className="notes" id="payload-urls">
        <li>
          GitHub — push, pull_request and status events, content type <code>application/json</code>, payload URL{" "}
          <code>{payloadUrl}</code>, secret = the registration secret (signed as <code>X-Hub-Signature-256</code>).
        </li>
        <li>
          GitLab — push events, URL <code>{payloadUrls.gitlab}</code>, secret token = the registration secret (sent as{" "}
          <code>X-Gitlab-Token</code>).
        </li>
        <li>
          Bitbucket Cloud — repository push, URL <code>{payloadUrls.bitbucket}</code>, secret = the registration secret
          (signed as <code>X-Hub-Signature</code>).
        </li>
      </ul>
      {secret ? (
        <FlashBox kind="info">
          Webhook secret for <strong>{secret.repository}</strong> on {SCM_PROVIDER_LABELS[secret.provider as ScmProvider]} — copy it
          now, it will not be shown again:
          <br />
          <code data-testid="github-secret">{secret.secret}</code>
        </FlashBox>
      ) : null}
      <table id="github-repositories" className="highlightable-table">
        <thead>
          <tr className="table-top">
            <th>Host</th>
            <th>Repository</th>
            <th>Last push</th>
            <th className="align-right last">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {github.length === 0 ? (
            <tr>
              <td colSpan={4} className="italic-light align-center last">
                No repositories registered.
              </td>
            </tr>
          ) : (
            github.map((repo, index) => (
              <tr key={repo.id} className={index % 2 === 0 ? "odd" : "even"}>
                <td>{SCM_PROVIDER_LABELS[repo.provider]}</td>
                <td>
                  <code>{repo.repository}</code>
                </td>
                <td>{repo.lastReceivedAt ? repo.lastReceivedAt.slice(0, 19).replace("T", " ") : "no pushes yet"}</td>
                <td className="align-right last inline-forms">
                  <Form method="post">
                    <input type="hidden" name="intent" value="github-remove" />
                    <input type="hidden" name="integrationId" value={repo.id} />
                    <button type="submit" className="inline delete">
                      Remove
                    </button>
                  </Form>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="github-add" />
        <div className="form_section last">
          <FormItem label="Host:" htmlFor="scm_provider" required field="provider" errors={errorsFor("github-add")}>
            <select id="scm_provider" name="provider" defaultValue="github">
              {SCM_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {SCM_PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
          </FormItem>
          <FormItem
            label="Repository:"
            htmlFor="github_repository"
            required
            notes="owner/name"
            field="repository"
            errors={errorsFor("github-add")}
          >
            <input id="github_repository" name="repository" className="width-large" placeholder="acme/widgets" />
          </FormItem>
          <ErrorLines field="authorization" errors={errorsFor("github-add")} />
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Register repository
          </button>
        </ActionBar>
      </Form>

      <h2 id="recent-commits-heading">Recent commits</h2>
      {commits.length === 0 ? (
        <p className="italic-light">No commits linked yet.</p>
      ) : (
        <table id="recent-commits" className="highlightable-table">
          <thead>
            <tr className="table-top">
              <th>Commit</th>
              <th>Card</th>
              <th>Author</th>
              <th className="last">Message</th>
            </tr>
          </thead>
          <tbody>
            {commits.map((commit, index) => (
              <tr key={`${commit.sha}-${commit.cardNumber}`} className={index % 2 === 0 ? "odd" : "even"}>
                <td>
                  <a href={commit.url}>{commit.shortSha}</a>
                </td>
                <td>
                  <Link to={`/projects/${project.identifier}/cards/${commit.cardNumber}`}>#{commit.cardNumber}</Link>
                </td>
                <td>{commit.authorName}</td>
                <td className="last">{commit.message.split("\n")[0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminPage>
  );
}
