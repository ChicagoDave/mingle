/**
 * External Integrations schema — Slack notifiers, GitHub repositories,
 * and the commit→card links they produce (Phase 32).
 *
 * Purpose: persistence for the External Integrations context. Legacy's
 * Slack integration lived in a SaaS-only AWS service; here a project
 * has at most one Slack incoming-webhook notifier. Legacy's `githubs`
 * table (username, repository, project_id, webhook_id) becomes
 * `github_integrations`, verifying inbound pushes with a per-repository
 * secret instead of the github system user's API key. `commit_links`
 * is new: legacy recorded a commit only as a murmur; the plan asks for
 * a persisted link record.
 *
 * Secrets (the webhook URL, which embeds Slack's token; the GitHub
 * webhook secret) are stored sealed by
 * app/domain/identity/sealer.server.ts, never in the clear (ADR-0020).
 *
 * Public interface: `slackIntegrations`, `githubIntegrations`,
 * `githubCommits`, `commitLinks` (Drizzle tables). Written only through
 * app/domain/integrations/*.
 *
 * Owner context: External Integrations.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const slackIntegrations = sqliteTable(
  "slack_integrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * The project; since P-10 a project may hold several webhooks (an
     * incoming webhook is bound to its channel, so channel routing is
     * URL routing). Exactly one of a project's webhooks is the default.
     */
    projectId: integer("project_id").notNull(),
    /** The incoming-webhook URL, sealed — it carries Slack's token. */
    webhookUrlSealed: text("webhook_url_sealed").notNull(),
    /** Display only, e.g. "#dev-team"; Slack decides the real channel from the URL. */
    channelLabel: text("channel_label").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** The webhook that receives every event type without a route of its own (P-10). */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** JSON HistoryCursor — the last entry per trail already posted. */
    cursor: text("cursor").notNull(),
    lastDeliveredAt: integer("last_delivered_at", { mode: "timestamp_ms" }),
    /** The most recent failed post's message, for the settings page. */
    lastError: text("last_error"),
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("slack_integrations_project_idx").on(t.projectId)],
);

export type SlackIntegrationRow = typeof slackIntegrations.$inferSelect;

/**
 * Per-project routing of history event types to webhooks (P-10). A row
 * with a null webhook suppresses the event type; an event type with no
 * row goes to the project's default webhook.
 */
export const slackEventRoutes = sqliteTable(
  "slack_event_routes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** A SLACK_EVENT_TYPES value, e.g. "card.created". Validity enforced in the domain layer. */
    eventType: text("event_type").notNull(),
    /** The webhook to post to; null = suppressed. */
    slackIntegrationId: integer("slack_integration_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("slack_event_routes_type_unique").on(t.projectId, t.eventType)],
);

export type SlackEventRouteRow = typeof slackEventRoutes.$inferSelect;

export const githubIntegrations = sqliteTable(
  "github_integrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /**
     * Which SCM host sends the webhooks (P-12): "github", "gitlab", or
     * "bitbucket" — SCM_PROVIDERS. The table keeps its Phase 32 name;
     * every provider's registration lives here.
     */
    provider: text("provider").notNull().default("github"),
    /** "owner/name", as the host's push payload reports it; stored lowercase. */
    repository: text("repository").notNull(),
    /** The webhook secret the host signs (GitHub, Bitbucket) or sends (GitLab) with, sealed. */
    secretSealed: text("secret_sealed").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastReceivedAt: integer("last_received_at", { mode: "timestamp_ms" }),
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("github_integrations_repository_unique").on(t.projectId, t.repository),
    index("github_integrations_project_idx").on(t.projectId),
  ],
);

export type GithubIntegrationRow = typeof githubIntegrations.$inferSelect;

/**
 * Every commit SHA a repository has delivered, so a redelivered push
 * (GitHub retries on timeouts and offers manual redelivery) is skipped
 * whole — links and murmurs alike — rather than murmured again.
 */
export const githubCommits = sqliteTable(
  "github_commits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    githubIntegrationId: integer("github_integration_id").notNull(),
    sha: text("sha").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("github_commits_sha_unique").on(t.githubIntegrationId, t.sha)],
);

export type GithubCommitRow = typeof githubCommits.$inferSelect;

export const commitLinks = sqliteTable(
  "commit_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    cardId: integer("card_id").notNull(),
    githubIntegrationId: integer("github_integration_id").notNull(),
    /** "owner/name" at the time of the push. */
    repository: text("repository").notNull(),
    /** The full commit SHA. */
    sha: text("sha").notNull(),
    url: text("url").notNull(),
    authorName: text("author_name").notNull(),
    authorLogin: text("author_login"),
    /** The commit message, as pushed. */
    message: text("message").notNull(),
    committedAt: integer("committed_at", { mode: "timestamp_ms" }).notNull(),
    /** The latest GitHub `status` event for this SHA (P-11): its state, context, description, target URL, and when. */
    statusState: text("status_state"),
    statusContext: text("status_context"),
    statusDescription: text("status_description"),
    statusUrl: text("status_url"),
    statusAt: integer("status_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // A redelivered push must not link the same commit to the same card twice.
    uniqueIndex("commit_links_card_sha_unique").on(t.cardId, t.sha),
    index("commit_links_project_idx").on(t.projectId),
  ],
);

export type CommitLinkRow = typeof commitLinks.$inferSelect;

/**
 * A pull request linked to a card by a `#123` reference in its title or
 * body (P-11). One row per (integration, PR number, card); the state
 * follows the PR's later events.
 */
export const pullRequestLinks = sqliteTable(
  "pull_request_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    cardId: integer("card_id").notNull(),
    githubIntegrationId: integer("github_integration_id").notNull(),
    repository: text("repository").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    /** "open", "closed", or "merged". */
    state: text("state").notNull(),
    authorLogin: text("author_login"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("pull_request_links_unique").on(t.githubIntegrationId, t.number, t.cardId),
    index("pull_request_links_card_idx").on(t.cardId),
  ],
);

export type PullRequestLinkRow = typeof pullRequestLinks.$inferSelect;
