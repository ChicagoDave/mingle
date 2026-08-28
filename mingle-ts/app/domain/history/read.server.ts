/**
 * Collaboration read model — the project history feed (Phase 21).
 *
 * Purpose: one time-ordered stream of everything that happened in a
 * project, projected over the four trails that already record it —
 * `card_versions` (Phase 5), `page_versions` (Phase 16), `murmurs`
 * (Phase 20), and `dependency_versions` (Phase 25 — read from either
 * side, so a dependency's changes appear in the raising AND the
 * resolving project's history, as legacy scoped its events to both).
 * Legacy built the same stream from an `events` table whose
 * rows were generated from versions; this reads the versions directly,
 * which is the same information one dereference shorter.
 *
 * It deliberately does NOT read `domain_events`. That table records
 * what a COMMAND did — `{projectId, number, changed}` for a card
 * update — and carries no snapshot of what the thing looked like at the
 * time. Rendering a feed from it would mean joining back to the current
 * `cards` row, which shows every past entry under the card's name
 * TODAY: a card renamed last week would rewrite its own history. The
 * version trails carry the historical values (ADR-0004), so the feed
 * reads them and history stays fixed.
 *
 * Ordering is a query concern (ADR-0016): the four sources are unioned
 * and ordered in SQL, never merged and sorted in JavaScript, so paging
 * is correct rather than correct-per-page.
 *
 * Public interface: `HistoryEntry`, `HistoryEntryKind`, `HISTORY_PAGE_SIZE`,
 * `projectHistory`, `projectHistoryCount`, and for notification
 * delivery (Phase 22) `HistoryCursor`, `historyCursor`,
 * `historyEntriesAfter`.
 *
 * Owner context: Collaboration. Read-only — nothing here writes.
 */
import { inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardVersions } from "~/db/schema/cards";
import { dependencyVersions } from "~/db/schema/dependencies";
import { users } from "~/db/schema/identity";
import { murmurs } from "~/db/schema/murmurs";
import { pageVersions } from "~/db/schema/pages";
import { pageIdentifier } from "~/domain/pages/naming.server";

/** Which trail an entry came from. */
export type HistoryEntryKind = "card" | "page" | "murmur" | "dependency";

/**
 * What happened, in the vocabulary the feed presents. Derived from the
 * source row rather than stored: version 1 is a creation, the flagged
 * final version is a deletion, a version carrying comment text is a
 * comment, and anything else is a change.
 */
export type HistoryEntryAction =
  | "created"
  | "changed"
  | "commented"
  | "deleted"
  | "murmured";

/** One entry in the project history feed. */
export interface HistoryEntry {
  /**
   * Stable across pages and across requests: the trail plus the source
   * row's own id. Atom needs a durable entry id, and the four trails
   * have independent id spaces, so neither half alone would do.
   */
  id: string;
  kind: HistoryEntryKind;
  /** The source row's own id within its trail — the cursor unit. */
  sourceId: number;
  action: HistoryEntryAction;
  occurredAt: Date;
  authorUserId: number;
  authorName: string;
  /** Human title, e.g. "Card #12 Fix login" or "Page Roadmap". */
  title: string;
  /** Atom categories — the kind, then the action. */
  categories: string[];
  /** Path to the thing this entry is about, relative to the site root. */
  href: string;
  /** The card's number, for card entries; null otherwise. */
  cardNumber: number | null;
  /** The dependency's global number, for dependency entries; null otherwise. */
  dependencyNumber: number | null;
  /** The page's URL identifier (historical name), for page entries; null otherwise. */
  pageIdentifier: string | null;
  /** The version this entry records, for card, page and dependency entries. */
  version: number | null;
  /** The comment or murmur text this entry carried, when it had one. */
  text: string | null;
}

/** How many entries one page of the feed holds (legacy per-page size). */
export const HISTORY_PAGE_SIZE = 25;

/** The raw shape the union query returns, before authors are joined. */
interface HistoryRow {
  kind: HistoryEntryKind;
  source_id: number;
  occurred_at: number;
  actor_user_id: number;
  number: number | null;
  name: string | null;
  version: number | null;
  is_deletion: number;
  text: string | null;
}

/**
 * The union of the four trails, newest first.
 *
 * Written as one compound SELECT so the ordering and the page window
 * are decided by SQL over the whole stream. Merging three separately
 * paged queries in JavaScript would produce a page that is internally
 * ordered and globally wrong — the second page would re-show rows the
 * first had already passed.
 *
 * The four trails have independent id spaces and no shared sequence,
 * so two entries written in the SAME millisecond have no true relative
 * order to recover. `kind` then `source_id` breaks that tie: arbitrary,
 * but TOTAL and STABLE, which is what paging needs — an unstable tie
 * would let an entry appear on two pages or on none. Legacy had a
 * single `events` table and therefore a real insertion sequence; this
 * is the cost of projecting over the trails instead of duplicating
 * them into a fourth table.
 */
function historyRows(
  db: BetterSQLite3Database,
  projectId: number,
  limit: number,
  offset: number,
): HistoryRow[] {
  return db.all<HistoryRow>(sql`
    SELECT 'card' AS kind, id AS source_id, created_at AS occurred_at,
           modified_by_user_id AS actor_user_id, number AS number,
           name AS name, version AS version, is_deletion AS is_deletion,
           comment AS text
      FROM ${cardVersions} WHERE project_id = ${projectId}
    UNION ALL
    SELECT 'page', id, created_at, modified_by_user_id, NULL,
           name, version, is_deletion, NULL
      FROM ${pageVersions} WHERE project_id = ${projectId}
    UNION ALL
    SELECT 'murmur', id, created_at, author_user_id, NULL,
           NULL, NULL, 0, body
      FROM ${murmurs} WHERE project_id = ${projectId}
    UNION ALL
    SELECT 'dependency', id, created_at, modified_by_user_id, number,
           name, version, is_deletion, NULL
      FROM ${dependencyVersions}
     WHERE raising_project_id = ${projectId} OR resolving_project_id = ${projectId}
    ORDER BY occurred_at DESC, kind ASC, source_id DESC
    LIMIT ${limit} OFFSET ${offset}`);
}

/** What happened, read off the source row. */
function actionOf(row: HistoryRow): HistoryEntryAction {
  if (row.kind === "murmur") return "murmured";
  if (row.is_deletion) return "deleted";
  if (row.version === 1) return "created";
  if (row.kind === "card" && row.text) return "commented";
  return "changed";
}

/** The entry's human title, in the historical name (never today's). */
function titleOf(row: HistoryRow, projectName: string): string {
  if (row.kind === "card") return `Card #${row.number} ${row.name}`;
  if (row.kind === "page") return `Page ${row.name}`;
  if (row.kind === "dependency") return `Dependency D${row.number} ${row.name}`;
  return `Murmur in ${projectName}`;
}

/** Where the entry points. */
function hrefOf(row: HistoryRow, projectIdentifier: string): string {
  const base = `/projects/${projectIdentifier}`;
  if (row.kind === "card") return `${base}/cards/${row.number}`;
  if (row.kind === "page")
    return `${base}/wiki/${encodeURIComponent(pageIdentifier(row.name ?? ""))}`;
  if (row.kind === "dependency") return `${base}/dependencies/${row.number}`;
  return `${base}/murmurs`;
}

/**
 * One page of a project's history, newest first.
 *
 * @param db - the Drizzle handle
 * @param project - the project's id, identifier (for links) and name
 * @param options.page - 1-based page number, defaulting to 1
 * @param options.limit - page size, defaulting to HISTORY_PAGE_SIZE
 * @returns the page's entries, newest first
 */
export function projectHistory(
  db: BetterSQLite3Database,
  project: { id: number; identifier: string; name: string },
  options: { page?: number; limit?: number } = {},
): HistoryEntry[] {
  const limit = options.limit ?? HISTORY_PAGE_SIZE;
  const page = Math.max(1, options.page ?? 1);
  return entriesFrom(db, historyRows(db, project.id, limit, (page - 1) * limit), project);
}

/** Resolves author names and shapes raw union rows into entries. */
function entriesFrom(
  db: BetterSQLite3Database,
  rows: HistoryRow[],
  project: { identifier: string; name: string },
): HistoryEntry[] {
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((row) => row.actor_user_id))];
  const nameByUserId = new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, authorIds))
      .all()
      .map((row) => [row.id, row.name] as const),
  );

  return rows.map((row) => {
    const action = actionOf(row);
    return {
      id: `${row.kind}-${row.source_id}`,
      kind: row.kind,
      sourceId: row.source_id,
      action,
      occurredAt: new Date(row.occurred_at),
      authorUserId: row.actor_user_id,
      // Users are never hard-deleted, but a missing name must not blank
      // an entire feed page.
      authorName: nameByUserId.get(row.actor_user_id) ?? "(unknown user)",
      title: titleOf(row, project.name),
      categories: [row.kind, action],
      href: hrefOf(row, project.identifier),
      cardNumber: row.kind === "card" ? row.number : null,
      dependencyNumber: row.kind === "dependency" ? row.number : null,
      pageIdentifier: row.kind === "page" ? pageIdentifier(row.name ?? "") : null,
      version: row.version,
      text: row.text,
    };
  });
}

/**
 * A position in each of the four trails: the highest source id
 * already seen per kind. Zero means "from the beginning".
 */
export interface HistoryCursor {
  cardVersionId: number;
  pageVersionId: number;
  murmurId: number;
  dependencyVersionId: number;
}

/**
 * The current end of each trail for the project — the cursor a new
 * subscriber starts from, so history that predates the subscription
 * is never delivered as if it had just happened.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project to read
 */
export function historyCursor(db: BetterSQLite3Database, projectId: number): HistoryCursor {
  const row = db.get<{ card: number; page: number; murmur: number; dependency: number }>(sql`
    SELECT
      (SELECT coalesce(max(id), 0) FROM ${cardVersions} WHERE project_id = ${projectId}) AS card,
      (SELECT coalesce(max(id), 0) FROM ${pageVersions} WHERE project_id = ${projectId}) AS page,
      (SELECT coalesce(max(id), 0) FROM ${murmurs} WHERE project_id = ${projectId}) AS murmur,
      (SELECT coalesce(max(id), 0) FROM ${dependencyVersions}
        WHERE raising_project_id = ${projectId} OR resolving_project_id = ${projectId}) AS dependency`);
  return {
    cardVersionId: row?.card ?? 0,
    pageVersionId: row?.page ?? 0,
    murmurId: row?.murmur ?? 0,
    dependencyVersionId: row?.dependency ?? 0,
  };
}

/**
 * Every entry written after a cursor, OLDEST first — the order a
 * notifier delivers in. Same union, same tie-break as the feed, so a
 * subscriber is told about exactly the entries the feed shows.
 *
 * @param db - the Drizzle handle
 * @param project - the project's id, identifier (for links) and name
 * @param cursor - the highest source id already seen, per trail
 * @param limit - at most this many entries; defaults to 500
 * @returns the fresh entries, oldest first
 */
export function historyEntriesAfter(
  db: BetterSQLite3Database,
  project: { id: number; identifier: string; name: string },
  cursor: HistoryCursor,
  limit = 500,
): HistoryEntry[] {
  const rows = db.all<HistoryRow>(sql`
    SELECT 'card' AS kind, id AS source_id, created_at AS occurred_at,
           modified_by_user_id AS actor_user_id, number AS number,
           name AS name, version AS version, is_deletion AS is_deletion,
           comment AS text
      FROM ${cardVersions}
     WHERE project_id = ${project.id} AND id > ${cursor.cardVersionId}
    UNION ALL
    SELECT 'page', id, created_at, modified_by_user_id, NULL,
           name, version, is_deletion, NULL
      FROM ${pageVersions}
     WHERE project_id = ${project.id} AND id > ${cursor.pageVersionId}
    UNION ALL
    SELECT 'murmur', id, created_at, author_user_id, NULL,
           NULL, NULL, 0, body
      FROM ${murmurs}
     WHERE project_id = ${project.id} AND id > ${cursor.murmurId}
    UNION ALL
    SELECT 'dependency', id, created_at, modified_by_user_id, number,
           name, version, is_deletion, NULL
      FROM ${dependencyVersions}
     WHERE (raising_project_id = ${project.id} OR resolving_project_id = ${project.id})
       AND id > ${cursor.dependencyVersionId}
    ORDER BY occurred_at ASC, kind DESC, source_id ASC
    LIMIT ${limit}`);
  return entriesFrom(db, rows, project);
}

/**
 * How many entries the project's history holds in total, for paging.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project to count within
 */
export function projectHistoryCount(
  db: BetterSQLite3Database,
  projectId: number,
): number {
  const row = db.get<{ total: number }>(sql`
    SELECT
      (SELECT count(*) FROM ${cardVersions} WHERE project_id = ${projectId}) +
      (SELECT count(*) FROM ${pageVersions} WHERE project_id = ${projectId}) +
      (SELECT count(*) FROM ${murmurs} WHERE project_id = ${projectId}) +
      (SELECT count(*) FROM ${dependencyVersions}
        WHERE raising_project_id = ${projectId} OR resolving_project_id = ${projectId})
      AS total`);
  return row?.total ?? 0;
}
