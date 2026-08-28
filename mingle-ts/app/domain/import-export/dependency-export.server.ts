/**
 * Import/Export — dependencies export (Phase 29; legacy
 * DependenciesImportExportController#create / DependenciesExporter).
 *
 * Purpose: renders the dependencies that touch a chosen set of
 * projects — raised by them or asked of them — as a
 * `DependenciesBundle`. A site-administrator read; changes nothing,
 * emits no event.
 *
 * Public interface: `exportDependencies`, `projectsForDependencyExport`.
 *
 * Owner context: Import/Export (depends inward on Dependencies).
 */
import { asc, eq, inArray, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { dependencies } from "~/db/schema/dependencies";
import { projects } from "~/db/schema/projects";
import { users } from "~/db/schema/identity";
import { type CommandResult, reject } from "~/domain/command.server";
import { listDependencies, type DependencySummary } from "~/domain/dependencies/read.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import {
  DEPENDENCIES_FORMAT,
  DEPENDENCIES_VERSION,
  type DependenciesBundle,
} from "~/domain/import-export/dependencies-bundle.server";

/** A project as the export page lists it, with how many dependencies touch it. */
export interface ExportableProject {
  id: number;
  name: string;
  identifier: string;
  dependencyCount: number;
}

/** Every project, by name, with the count of dependencies it raises or resolves. */
export function projectsForDependencyExport(db: BetterSQLite3Database): ExportableProject[] {
  const rows = db
    .select({ id: projects.id, name: projects.name, identifier: projects.identifier })
    .from(projects)
    .orderBy(sql`lower(${projects.name})`)
    .all();
  const touching = db
    .select({ raising: dependencies.raisingProjectId, resolving: dependencies.resolvingProjectId })
    .from(dependencies)
    .all();
  return rows.map((p) => ({
    ...p,
    dependencyCount: touching.filter((d) => d.raising === p.id || d.resolving === p.id).length,
  }));
}

export interface ExportDependenciesInput {
  projectIds: number[];
  actorUserId: number;
  now?: Date;
}

/**
 * Builds the bundle for the dependencies raised by or asked of any of
 * the given projects (each once, by number).
 *
 * @returns the bundle, or a rejection when the actor is not a site
 *   administrator, no project is chosen, or a project is unknown
 */
export function exportDependencies(db: BetterSQLite3Database, input: ExportDependenciesInput): CommandResult<DependenciesBundle> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;
  if (input.projectIds.length === 0) return reject("projects", "must be selected");
  const known = db.select({ id: projects.id }).from(projects).where(inArray(projects.id, input.projectIds)).all().map((p) => p.id);
  const unknown = input.projectIds.filter((id) => !known.includes(id));
  if (unknown.length > 0) return reject("projects", `unknown project id ${unknown.join(", ")}`);

  const byNumber = new Map<number, DependencySummary>();
  for (const projectId of input.projectIds)
    for (const filter of ["raising", "resolving"] as const)
      for (const summary of listDependencies(db, projectId, filter)) byNumber.set(summary.number, summary);
  const ordered = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const raisingUsers = new Map(
    ordered.length
      ? db
          .select({ number: dependencies.number, login: users.login })
          .from(dependencies)
          .innerJoin(users, eq(users.id, dependencies.raisingUserId))
          .where(or(...input.projectIds.map((id) => eq(dependencies.raisingProjectId, id)), ...input.projectIds.map((id) => eq(dependencies.resolvingProjectId, id))))
          .orderBy(asc(dependencies.number))
          .all()
          .map((r) => [r.number, r.login])
      : [],
  );

  return {
    ok: true,
    value: {
      format: DEPENDENCIES_FORMAT,
      version: DEPENDENCIES_VERSION,
      exportedAt: (input.now ?? new Date()).toISOString(),
      dependencies: ordered.map((d) => ({
        number: d.number,
        name: d.name,
        description: d.description,
        desiredEndDate: d.desiredEndDate,
        status: d.status,
        raisingProject: d.raisingProject.identifier,
        raisingCard: { number: d.raisingCard.number, name: d.raisingCard.name },
        raisingUser: raisingUsers.get(d.number) ?? "",
        resolvingProject: d.resolvingProject.identifier,
        resolvingCards: d.resolvingCards.map((c) => ({ number: c.number, name: c.name })),
      })),
    },
  };
}
