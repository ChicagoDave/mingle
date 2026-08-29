/**
 * External Integrations read model — what the integrations page and
 * the card page show (Phase 32).
 *
 * Public interface: `slackIntegrationView`, `githubIntegrationViews`,
 * `commitLinksForCard`, `recentCommitLinks`, `findGithubIntegrations`.
 *
 * Owner context: External Integrations. Reads only; never exposes a
 * sealed secret.
 */
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { commitLinks, githubIntegrations, slackIntegrations, type GithubIntegrationRow } from "~/db/schema/integrations";
import type { CommitLinkView, GithubIntegrationView, SlackIntegrationView } from "~/shared/wire-types";

/** The project's Slack notifier, or the "not configured" view. */
export function slackIntegrationView(db: BetterSQLite3Database, projectId: number): SlackIntegrationView {
  const row = db.select().from(slackIntegrations).where(eq(slackIntegrations.projectId, projectId)).get();
  if (!row) return { configured: false, enabled: false, channelLabel: "", lastDeliveredAt: null, lastError: null };
  return {
    configured: true,
    enabled: row.enabled,
    channelLabel: row.channelLabel,
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    lastError: row.lastError,
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
      repository: row.repository,
      enabled: row.enabled,
      lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    }));
}

/** The enabled integrations of a project for one repository name (lowercase), for signature checks. */
export function findGithubIntegrations(db: BetterSQLite3Database, projectId: number, repository: string): GithubIntegrationRow[] {
  return db
    .select()
    .from(githubIntegrations)
    .where(and(eq(githubIntegrations.projectId, projectId), eq(githubIntegrations.repository, repository.toLowerCase()), eq(githubIntegrations.enabled, true)))
    .all();
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
