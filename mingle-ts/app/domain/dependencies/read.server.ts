/**
 * Cross-Project Dependencies read model (Phase 25).
 *
 * Purpose: what the dependency pages show — a project's dependencies
 * from either side (legacy `DependencyView` with its raising/resolving
 * filter), one dependency in full, a card's dependencies for the card
 * page, and a dependency's version trail. Every summary resolves both
 * projects by name and identifier so a page in project A can link
 * into project B, and resolves card names where the cards still
 * exist — a resolving card that has since been deleted keeps its
 * number and loses its name, as legacy fell back to the card version.
 *
 * Public interface: `DependencySummary`, `DependencyVersionView`,
 * `listDependencies`, `findDependencyForProject`, `cardDependencies`,
 * `dependencyHistory`, `prefixedDependencyNumber`.
 *
 * Owner context: Cross-Project Dependencies. Read-only — nothing here
 * writes.
 */
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import {
  dependencies,
  dependencyResolvingCards,
  dependencyVersions,
  type DependencyRow,
} from "~/db/schema/dependencies";
import { users } from "~/db/schema/identity";
import { projects } from "~/db/schema/projects";
import type { DependencyListFilter, DependencyStatus } from "~/shared/wire-types";

/** A project as a dependency names it. */
export interface DependencyProjectRef {
  id: number;
  identifier: string;
  name: string;
}

/** A card as a dependency names it; `name` is null once the card is deleted. */
export interface DependencyCardRef {
  number: number;
  name: string | null;
}

/** One dependency as the list and show pages present it. */
export interface DependencySummary {
  id: number;
  number: number;
  /** `D<number>` (legacy prefixed_number). */
  prefixedNumber: string;
  name: string;
  description: string | null;
  desiredEndDate: string;
  status: DependencyStatus;
  version: number;
  raisingProject: DependencyProjectRef;
  resolvingProject: DependencyProjectRef;
  raisingCard: DependencyCardRef;
  raisingUserName: string;
  resolvingCards: DependencyCardRef[];
  createdAt: Date;
}

/** One row of a dependency's version trail. */
export interface DependencyVersionView {
  version: number;
  name: string;
  description: string | null;
  desiredEndDate: string;
  status: DependencyStatus;
  resolvingCardNumbers: number[];
  isDeletion: boolean;
  modifiedByUserId: number;
  modifiedByName: string;
  createdAt: Date;
}

/** `D<number>` — how a dependency is written everywhere it is named. */
export function prefixedDependencyNumber(number: number): string {
  return `D${number}`;
}

/** Names for a set of cards in a project, by number; missing cards are absent. */
function cardNames(db: BetterSQLite3Database, projectId: number, numbers: number[]): Map<number, string> {
  if (numbers.length === 0) return new Map();
  return new Map(
    db
      .select({ number: cards.number, name: cards.name })
      .from(cards)
      .where(and(eq(cards.projectId, projectId), inArray(cards.number, numbers)))
      .all()
      .map((row) => [row.number, row.name] as const),
  );
}

/** Shapes dependency rows into summaries, resolving projects, users and cards in bulk. */
function summarize(db: BetterSQLite3Database, rows: DependencyRow[]): DependencySummary[] {
  if (rows.length === 0) return [];
  const projectIds = [...new Set(rows.flatMap((row) => [row.raisingProjectId, row.resolvingProjectId]))];
  const projectById = new Map(
    db
      .select({ id: projects.id, identifier: projects.identifier, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, projectIds))
      .all()
      .map((row) => [row.id, row] as const),
  );
  const userIds = [...new Set(rows.map((row) => row.raisingUserId))];
  const userNameById = new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds))
      .all()
      .map((row) => [row.id, row.name] as const),
  );
  const links = db
    .select()
    .from(dependencyResolvingCards)
    .where(inArray(dependencyResolvingCards.dependencyId, rows.map((row) => row.id)))
    .orderBy(asc(dependencyResolvingCards.cardNumber))
    .all();

  // Card names, one query per project involved on either side.
  const numbersByProject = new Map<number, Set<number>>();
  const want = (projectId: number, number: number) => {
    const set = numbersByProject.get(projectId) ?? new Set<number>();
    set.add(number);
    numbersByProject.set(projectId, set);
  };
  for (const row of rows) want(row.raisingProjectId, row.raisingCardNumber);
  for (const link of links) want(link.projectId, link.cardNumber);
  const namesByProject = new Map(
    [...numbersByProject].map(([projectId, numbers]) => [projectId, cardNames(db, projectId, [...numbers])] as const),
  );
  const cardRef = (projectId: number, number: number): DependencyCardRef => ({
    number,
    name: namesByProject.get(projectId)?.get(number) ?? null,
  });
  const unknownProject = (id: number): DependencyProjectRef => ({ id, identifier: "", name: "(deleted project)" });

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    prefixedNumber: prefixedDependencyNumber(row.number),
    name: row.name,
    description: row.description,
    desiredEndDate: row.desiredEndDate,
    status: row.status as DependencyStatus,
    version: row.version,
    raisingProject: projectById.get(row.raisingProjectId) ?? unknownProject(row.raisingProjectId),
    resolvingProject: projectById.get(row.resolvingProjectId) ?? unknownProject(row.resolvingProjectId),
    raisingCard: cardRef(row.raisingProjectId, row.raisingCardNumber),
    raisingUserName: userNameById.get(row.raisingUserId) ?? "(unknown user)",
    resolvingCards: links
      .filter((link) => link.dependencyId === row.id)
      .map((link) => cardRef(link.projectId, link.cardNumber)),
    createdAt: row.createdAt,
  }));
}

/**
 * A project's dependencies from one side, by number ascending: the
 * ones it raised, or the ones it is asked to resolve.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project whose list this is
 * @param filter - `raising` or `resolving`
 */
export function listDependencies(
  db: BetterSQLite3Database,
  projectId: number,
  filter: DependencyListFilter,
): DependencySummary[] {
  const side = filter === "raising" ? dependencies.raisingProjectId : dependencies.resolvingProjectId;
  return summarize(
    db,
    db.select().from(dependencies).where(eq(side, projectId)).orderBy(asc(dependencies.number)).all(),
  );
}

/**
 * One dependency as seen from a project — only when that project is
 * its raising or resolving side (a dependency is not visible from a
 * project it does not involve).
 *
 * @param db - the Drizzle handle
 * @param projectId - the viewing project
 * @param number - the dependency's global number
 */
export function findDependencyForProject(
  db: BetterSQLite3Database,
  projectId: number,
  number: number,
): DependencySummary | undefined {
  const row = db
    .select()
    .from(dependencies)
    .where(
      and(
        eq(dependencies.number, number),
        or(eq(dependencies.raisingProjectId, projectId), eq(dependencies.resolvingProjectId, projectId)),
      ),
    )
    .get();
  return row ? summarize(db, [row])[0] : undefined;
}

/**
 * The dependencies a card raised and the ones it resolves (legacy
 * `Card#raised_dependencies` / `Card#dependencies_resolving`).
 *
 * @param db - the Drizzle handle
 * @param projectId - the card's project
 * @param cardNumber - the card's number
 */
export function cardDependencies(
  db: BetterSQLite3Database,
  projectId: number,
  cardNumber: number,
): { raised: DependencySummary[]; resolving: DependencySummary[] } {
  const raised = db
    .select()
    .from(dependencies)
    .where(and(eq(dependencies.raisingProjectId, projectId), eq(dependencies.raisingCardNumber, cardNumber)))
    .orderBy(asc(dependencies.number))
    .all();
  const resolvingIds = db
    .select({ dependencyId: dependencyResolvingCards.dependencyId })
    .from(dependencyResolvingCards)
    .where(and(eq(dependencyResolvingCards.projectId, projectId), eq(dependencyResolvingCards.cardNumber, cardNumber)))
    .all()
    .map((row) => row.dependencyId);
  const resolving =
    resolvingIds.length === 0
      ? []
      : db.select().from(dependencies).where(inArray(dependencies.id, resolvingIds)).orderBy(asc(dependencies.number)).all();
  return { raised: summarize(db, raised), resolving: summarize(db, resolving) };
}

/**
 * A dependency's version trail, newest first, with each version's
 * author resolved.
 *
 * @param db - the Drizzle handle
 * @param dependencyId - the dependency's row id (kept on versions after deletion)
 */
export function dependencyHistory(db: BetterSQLite3Database, dependencyId: number): DependencyVersionView[] {
  const rows = db
    .select({
      version: dependencyVersions.version,
      name: dependencyVersions.name,
      description: dependencyVersions.description,
      desiredEndDate: dependencyVersions.desiredEndDate,
      status: dependencyVersions.status,
      resolvingCardNumbers: dependencyVersions.resolvingCardNumbers,
      isDeletion: dependencyVersions.isDeletion,
      modifiedByUserId: dependencyVersions.modifiedByUserId,
      modifiedByName: users.name,
      createdAt: dependencyVersions.createdAt,
    })
    .from(dependencyVersions)
    .leftJoin(users, eq(users.id, dependencyVersions.modifiedByUserId))
    .where(eq(dependencyVersions.dependencyId, dependencyId))
    .orderBy(desc(dependencyVersions.version))
    .all();
  return rows.map((row) => ({
    ...row,
    status: row.status as DependencyStatus,
    resolvingCardNumbers: JSON.parse(row.resolvingCardNumbers) as number[],
    modifiedByName: row.modifiedByName ?? "(unknown user)",
  }));
}
