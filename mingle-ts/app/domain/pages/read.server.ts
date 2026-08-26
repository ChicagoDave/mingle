/**
 * Wiki & Content read models — page lookups, history, and the render
 * context that resolves wiki and card links (Phase 16).
 *
 * Purpose: the read side of the Page aggregate. Everything here is
 * query-only: it never writes, and route code uses it instead of
 * reaching for tables directly. Kept apart from commands.server.ts so
 * that reading a page and writing one have one reason to change each
 * (rule 7).
 *
 * Public interface: `listPages`, `findPage`, `findPageVersion`,
 * `pageHistory`, `pageRenderContext`, `PageSummary`, `PageHistoryEntry`.
 *
 * Owner context: Wiki & Content.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import { pages, pageVersions, type PageRow, type PageVersionRow } from "~/db/schema/pages";
import { projects } from "~/db/schema/projects";
import {
  referencedPageIdentifiers,
  type PageRenderContext,
} from "~/domain/pages/content.server";
import {
  pageIdentifier,
  pageNameFromIdentifier,
} from "~/domain/pages/naming.server";

/** A page as the list and sidebar render it. */
export interface PageSummary {
  id: number;
  name: string;
  /** URL identifier — name with spaces as underscores. */
  identifier: string;
}

/** One row of a page's history panel. */
export interface PageHistoryEntry {
  version: number;
  isDeletion: boolean;
  modifiedBy: string;
  modifiedAt: Date;
}

/**
 * Lists a project's pages, ordered case-insensitively by name (legacy
 * `named_scope :order_by_name`).
 *
 * @param db - the Drizzle handle
 * @param projectId - the project whose pages to list
 */
export function listPages(
  db: BetterSQLite3Database,
  projectId: number,
): PageSummary[] {
  return db
    .select({ id: pages.id, name: pages.name })
    .from(pages)
    .where(eq(pages.projectId, projectId))
    .orderBy(sql`lower(${pages.name})`)
    .all()
    .map((row) => ({ ...row, identifier: pageIdentifier(row.name) }));
}

/**
 * Finds a page by its URL identifier, matching the name
 * case-insensitively (legacy `Page.find_by_identifier`).
 *
 * @param db - the Drizzle handle
 * @param projectId - the project to look in
 * @param identifier - the identifier from the URL
 * @returns the page row, or undefined when no such page exists
 */
export function findPage(
  db: BetterSQLite3Database,
  projectId: number,
  identifier: string,
): PageRow | undefined {
  const name = pageNameFromIdentifier(identifier);
  return db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.projectId, projectId),
        sql`lower(${pages.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
}

/**
 * Finds one version of a page.
 *
 * @param db - the Drizzle handle
 * @param pageId - the page whose trail to read
 * @param version - the 1-based version number
 * @returns the version row, or undefined when that version never existed
 */
export function findPageVersion(
  db: BetterSQLite3Database,
  pageId: number,
  version: number,
): PageVersionRow | undefined {
  return db
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.pageId, pageId), eq(pageVersions.version, version)))
    .get();
}

/**
 * A page's version trail, newest first, with the name of the user who
 * made each version.
 *
 * @param db - the Drizzle handle
 * @param pageId - the page whose trail to read
 */
export function pageHistory(
  db: BetterSQLite3Database,
  pageId: number,
): PageHistoryEntry[] {
  return db
    .select({
      version: pageVersions.version,
      isDeletion: pageVersions.isDeletion,
      modifiedBy: users.name,
      modifiedAt: pageVersions.createdAt,
    })
    .from(pageVersions)
    .innerJoin(users, eq(users.id, pageVersions.modifiedByUserId))
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.version))
    .all();
}

/**
 * Every version of a page, oldest first — the ordering the phase's
 * exit criterion is stated in, and what an export would walk.
 *
 * @param db - the Drizzle handle
 * @param pageId - the page whose trail to read
 */
export function pageVersionTrail(
  db: BetterSQLite3Database,
  pageId: number,
): PageVersionRow[] {
  return db
    .select()
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(asc(pageVersions.version))
    .all();
}

/**
 * Builds the link-resolution context for rendering a page body.
 *
 * Existence is resolved per distinct target and memoized for the life
 * of the context, so a body linking the same page twenty times costs
 * one query, and a body with no links costs none.
 *
 * @param db - the Drizzle handle
 * @param projectIdentifier - the project the page being rendered is in
 */
export function pageRenderContext(
  db: BetterSQLite3Database,
  projectIdentifier: string,
): PageRenderContext {
  const projectIds = new Map<string, number | null>();
  const knownPages = new Map<string, boolean>();
  const knownCards = new Map<string, boolean>();

  const projectIdFor = (identifier: string): number | null => {
    const cached = projectIds.get(identifier);
    if (cached !== undefined) return cached;
    const row = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.identifier, identifier))
      .get();
    const id = row?.id ?? null;
    projectIds.set(identifier, id);
    return id;
  };

  return {
    projectIdentifier,
    pageExists: (target, identifier) => {
      const key = `${target}/${identifier.toLowerCase()}`;
      const cached = knownPages.get(key);
      if (cached !== undefined) return cached;
      const projectId = projectIdFor(target);
      const exists =
        projectId !== null && findPage(db, projectId, identifier) !== undefined;
      knownPages.set(key, exists);
      return exists;
    },
    cardExists: (target, cardNumber) => {
      const key = `${target}/${cardNumber}`;
      const cached = knownCards.get(key);
      if (cached !== undefined) return cached;
      const projectId = projectIdFor(target);
      const exists =
        projectId !== null &&
        db
          .select({ id: cards.id })
          .from(cards)
          .where(and(eq(cards.projectId, projectId), eq(cards.number, cardNumber)))
          .get() !== undefined;
      knownCards.set(key, exists);
      return exists;
    },
  };
}

/**
 * The pages in a project that link TO the given page — the "what
 * points here" list the show page renders as backlinks.
 *
 * Implemented as a scan over stored bodies rather than a link table:
 * page bodies store links as literal `[[…]]` text, so a link table
 * would be a second source of truth to keep in step. The scan goes
 * through `referencedPageIdentifiers` rather than matching the raw
 * stored text, so it sees exactly what the renderer sees — entities
 * decoded, the `[[display|Page]]` form resolved to its target, and
 * references inside <code> and <pre> excluded, since those are shown
 * literally and are not links.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project to search
 * @param name - the target page's name
 */
export function pagesLinkingTo(
  db: BetterSQLite3Database,
  projectId: number,
  name: string,
): PageSummary[] {
  const target = pageIdentifier(name).toLowerCase();
  return db
    .select({ id: pages.id, name: pages.name, content: pages.content })
    .from(pages)
    .where(eq(pages.projectId, projectId))
    .orderBy(sql`lower(${pages.name})`)
    .all()
    .filter((row) =>
      referencedPageIdentifiers(row.content).some(
        (identifier) => identifier.toLowerCase() === target,
      ),
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      identifier: pageIdentifier(row.name),
    }));
}

/**
 * Resolves several page identifiers to the ones that exist, in one
 * query — for callers rendering many bodies at once.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project to look in
 * @param identifiers - candidate identifiers
 * @returns the subset that names a real page, lowercased
 */
export function existingPageIdentifiers(
  db: BetterSQLite3Database,
  projectId: number,
  identifiers: string[],
): Set<string> {
  if (identifiers.length === 0) return new Set();
  const names = identifiers.map((identifier) =>
    pageNameFromIdentifier(identifier).toLowerCase(),
  );
  const rows = db
    .select({ name: pages.name })
    .from(pages)
    .where(
      and(
        eq(pages.projectId, projectId),
        inArray(sql`lower(${pages.name})`, names),
      ),
    )
    .all();
  return new Set(rows.map((row) => pageIdentifier(row.name).toLowerCase()));
}
