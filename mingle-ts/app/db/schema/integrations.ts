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
    /** One notifier per project (legacy mapped one channel per project). */
    projectId: integer("project_id").notNull().unique(),
    /** The incoming-webhook URL, sealed — it carries Slack's token. */
    webhookUrlSealed: text("webhook_url_sealed").notNull(),
    /** Display only, e.g. "#dev-team"; Slack decides the real channel from the URL. */
    channelLabel: text("channel_label").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
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
);

export type SlackIntegrationRow = typeof slackIntegrations.$inferSelect;

export const githubIntegrations = sqliteTable(
  "github_integrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** "owner/name", as GitHub's `repository.full_name` reports it; stored lowercase. */
    repository: text("repository").notNull(),
    /** The webhook secret GitHub signs payloads with, sealed. */
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
