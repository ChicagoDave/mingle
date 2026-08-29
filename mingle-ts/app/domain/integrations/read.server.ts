/**
 * External Integrations read model — what the integrations page and
 * the card page show (Phase 32).
 *
 * Public interface: `slackIntegrationView`, `githubIntegrationViews`,
 * `commitLinksForCard`, `recentCommitLinks`, `findGithubIntegrations`,
 * `pullRequestLinksForCard`.
 *
 * Owner context: External Integrations. Reads only; never exposes a
 * sealed secret.
 */
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { commitLinks, githubIntegrations, pullRequestLinks, slackEventRoutes, slackIntegrations, type GithubIntegrationRow } from "~/db/schema/integrations";
import {
  SLACK_EVENT_TYPES,
  type CommitLinkView,
  type GithubIntegrationView,
  type PullRequestLinkView,
  type ScmProvider,
  type SlackEventType,
  type SlackIntegrationView,
  type SlackRouteTarget,
} from "~/shared/wire-types";

/** The project's webhooks (default first, then by id) and its event routing, or the "not configured" view. */
export function slackIntegrationView(db: BetterSQLite3Database, projectId: number): SlackIntegrationView {
  const rows = db
    .select()
    .from(slackIntegrations)
    .where(eq(slackIntegrations.projectId, projectId))
    .orderBy(desc(slackIntegrations.isDefault), slackIntegrations.id)
    .all();
  const routes = Object.fromEntries(SLACK_EVENT_TYPES.map((type) => [type, "default" as SlackRouteTarget])) as Record<
    SlackEventType,
    SlackRouteTarget
  >;
  for (const route of db.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, projectId)).all()) {
    if ((SLACK_EVENT_TYPES as readonly string[]).includes(route.eventType))
      routes[route.eventType as SlackEventType] = route.slackIntegrationId ?? "suppressed";
  }
  return {
    configured: rows.length > 0,
    webhooks: rows.map((row) => ({
      id: row.id,
      channelLabel: row.channelLabel,
      enabled: row.enabled,
      isDefault: row.isDefault,
      lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
      lastError: row.lastError,
    })),
    routes,
  };
}

/** The repositories registered for the project, oldest first. */
export function githubIntegrationViews(db: BetterSQLite3Database, projectId: number): GithubIntegrationView[] {
  return db
    .select()
    .from(githubIntegrations)
    .where(eq(githubIntegrations.projectId, projectId))
    .orderBy(githubIntegrations.id)
    .all()
    .map((row) => ({
      id: row.id,
      provider: row.provider as ScmProvider,
      repository: row.repository,
      enabled: row.enabled,
      lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    }));
}

/** The enabled integrations of a project for one repository name (lowercase) on one host, for signature checks. */
export function findGithubIntegrations(db: BetterSQLite3Database, projectId: number, repository: string, provider: ScmProvider = "github"): GithubIntegrationRow[] {
  return db
    .select()
    .from(githubIntegrations)
    .where(
      and(
        eq(githubIntegrations.projectId, projectId),
        eq(githubIntegrations.provider, provider),
        eq(githubIntegrations.repository, repository.toLowerCase()),
        eq(githubIntegrations.enabled, true),
      ),
    )
    .all();
}

/** The pull requests linked to a card, most recently updated first. */
export function pullRequestLinksForCard(db: BetterSQLite3Database, cardId: number, cardNumber: number): PullRequestLinkView[] {
  return db
    .select()
    .from(pullRequestLinks)
    .where(eq(pullRequestLinks.cardId, cardId))
    .orderBy(desc(pullRequestLinks.updatedAt), desc(pullRequestLinks.id))
    .all()
    .map((row) => ({
      number: row.number,
      title: row.title,
      url: row.url,
      repository: row.repository,
      state: row.state,
      authorLogin: row.authorLogin,
      updatedAt: row.updatedAt.toISOString(),
      cardNumber,
    }));
}

function view(row: typeof commitLinks.$inferSelect, cardNumber: number): CommitLinkView {
  return {
    sha: row.sha,
    shortSha: row.sha.slice(0, 7),
    url: row.url,
    repository: row.repository,
    authorName: row.authorName,
    message: row.message,
    committedAt: row.committedAt.toISOString(),
    cardNumber,
    status:
      row.statusState && row.statusAt
        ? {
            state: row.statusState,
            context: row.statusContext ?? "default",
            description: row.statusDescription ?? "",
            url: row.statusUrl,
            reportedAt: row.statusAt.toISOString(),
          }
        : null,
  };
}

/** The commits linked to a card, newest first. */
export function commitLinksForCard(db: BetterSQLite3Database, cardId: number, cardNumber: number): CommitLinkView[] {
  return db
    .select()
    .from(commitLinks)
    .where(eq(commitLinks.cardId, cardId))
    .orderBy(desc(commitLinks.committedAt), desc(commitLinks.id))
    .all()
    .map((row) => view(row, cardNumber));
}

/** The project's most recently linked commits. */
export function recentCommitLinks(db: BetterSQLite3Database, projectId: number, limit = 20): CommitLinkView[] {
  return db
    .select({ link: commitLinks, cardNumber: cards.number })
    .from(commitLinks)
    .innerJoin(cards, eq(cards.id, commitLinks.cardId))
    .where(eq(commitLinks.projectId, projectId))
    .orderBy(desc(commitLinks.committedAt), desc(commitLinks.id))
    .limit(limit)
    .all()
    .map((row) => view(row.link, row.cardNumber));
}
