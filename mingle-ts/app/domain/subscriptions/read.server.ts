/**
 * Collaboration read model — history subscriptions (Phase 22).
 *
 * Purpose: the queries the subscriptions page and the delivery job
 * read. Nothing here writes.
 *
 * Public interface: `listSubscriptions`, `projectSubscriptions`,
 * `projectsWithSubscriptions`.
 *
 * Owner context: Collaboration. Read-only.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { projects } from "~/db/schema/projects";
import { historySubscriptions, type HistorySubscriptionRow } from "~/db/schema/subscriptions";
import { describeFilter, filterOf } from "~/domain/subscriptions/filter.server";
import type { SubscriptionKind, SubscriptionSummary } from "~/shared/wire-types";

/**
 * One user's subscriptions in a project, oldest first, described for
 * display.
 *
 * @param db - the Drizzle handle
 * @param project - the project's id and display name
 * @param userId - the subscriber
 */
export function listSubscriptions(
  db: BetterSQLite3Database,
  project: { id: number; name: string },
  userId: number,
): SubscriptionSummary[] {
  return db
    .select()
    .from(historySubscriptions)
    .where(
      and(
        eq(historySubscriptions.projectId, project.id),
        eq(historySubscriptions.userId, userId),
      ),
    )
    .orderBy(asc(historySubscriptions.id))
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind as SubscriptionKind,
      description: describeFilter(filterOf(row), project.name),
      lastError: row.lastError,
    }));
}

/**
 * Every subscription in a project, in id order — what delivery walks.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project
 */
export function projectSubscriptions(
  db: BetterSQLite3Database,
  projectId: number,
): HistorySubscriptionRow[] {
  return db
    .select()
    .from(historySubscriptions)
    .where(eq(historySubscriptions.projectId, projectId))
    .orderBy(asc(historySubscriptions.id))
    .all();
}

/**
 * The projects that have at least one subscription — the set a full
 * delivery sweep visits.
 *
 * @param db - the Drizzle handle
 */
export function projectsWithSubscriptions(
  db: BetterSQLite3Database,
): { id: number; identifier: string; name: string }[] {
  const ids = [
    ...new Set(
      db
        .select({ projectId: historySubscriptions.projectId })
        .from(historySubscriptions)
        .all()
        .map((row) => row.projectId),
    ),
  ];
  if (ids.length === 0) return [];
  return db
    .select({ id: projects.id, identifier: projects.identifier, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, ids))
    .orderBy(asc(projects.id))
    .all();
}
