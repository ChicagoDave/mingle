/**
 * Program Management read model (Phase 26).
 *
 * Purpose: the query side of programs for routes — the program list,
 * a program's overview (plan window, member projects, objectives in
 * timeline order), one objective with its version trail, the program's
 * members, and the projects that could still be added. Pure reads over
 * the Program Management and Identity tables; nothing here writes.
 *
 * Public interface: `listPrograms`, `findProgramByIdentifier`,
 * `programOverview`, `findObjectiveByNumber`, `objectiveHistory`,
 * `programMembers`, `addableProjects`.
 *
 * Owner context: Program Management.
 */
import { and, asc, count, desc, eq, notInArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import { programMemberships } from "~/db/schema/membership";
import {
  objectives,
  objectiveVersions,
  plans,
  programProjects,
  programs,
  type ObjectiveRow,
  type ProgramRow,
} from "~/db/schema/programs";
import { projects } from "~/db/schema/projects";

/** One row of the program list. */
export interface ProgramSummary {
  id: number;
  name: string;
  identifier: string;
  description: string | null;
  projectCount: number;
  objectiveCount: number;
}

/** Every program, ordered case-insensitively by name, with its member-project and objective counts. */
export function listPrograms(db: BetterSQLite3Database): ProgramSummary[] {
  const projectCounts = new Map(
    db
      .select({ programId: programProjects.programId, n: count() })
      .from(programProjects)
      .groupBy(programProjects.programId)
      .all()
      .map((row) => [row.programId, row.n]),
  );
  const objectiveCounts = new Map(
    db
      .select({ programId: objectives.programId, n: count() })
      .from(objectives)
      .groupBy(objectives.programId)
      .all()
      .map((row) => [row.programId, row.n]),
  );
  return db
    .select({
      id: programs.id,
      name: programs.name,
      identifier: programs.identifier,
      description: programs.description,
    })
    .from(programs)
    .orderBy(sql`lower(${programs.name})`)
    .all()
    .map((row) => ({
      ...row,
      projectCount: projectCounts.get(row.id) ?? 0,
      objectiveCount: objectiveCounts.get(row.id) ?? 0,
    }));
}

/** Looks a program up by its URL identifier. */
export function findProgramByIdentifier(db: BetterSQLite3Database, identifier: string): ProgramRow | undefined {
  return db.select().from(programs).where(eq(programs.identifier, identifier)).get();
}

/** A member project as the program page shows it. */
export interface ProgramProjectSummary {
  id: number;
  name: string;
  identifier: string;
}

/** An objective as the program page lists it. */
export interface ObjectiveSummary {
  id: number;
  number: number;
  name: string;
  identifier: string;
  status: string;
  startAt: string | null;
  endAt: string | null;
  verticalPosition: number;
  position: number;
  size: number;
  value: number;
  version: number;
}

/** What the program page needs: the plan window, member projects and objectives. */
export interface ProgramOverview {
  plan: { startAt: string; endAt: string; precision: number };
  projects: ProgramProjectSummary[];
  /** PLANNED first, then BACKLOG; each group in position order. */
  objectives: ObjectiveSummary[];
}

/**
 * The program's plan window, member projects (by name) and objectives
 * (by status then position); undefined when the program has no plan
 * row, which a program created through CreateProgram never lacks.
 */
export function programOverview(db: BetterSQLite3Database, programId: number): ProgramOverview | undefined {
  const plan = db
    .select({ startAt: plans.startAt, endAt: plans.endAt, precision: plans.precision })
    .from(plans)
    .where(eq(plans.programId, programId))
    .get();
  if (!plan) return undefined;
  const memberProjects = db
    .select({ id: projects.id, name: projects.name, identifier: projects.identifier })
    .from(programProjects)
    .innerJoin(projects, eq(projects.id, programProjects.projectId))
    .where(eq(programProjects.programId, programId))
    .orderBy(sql`lower(${projects.name})`)
    .all();
  const rows = db
    .select({
      id: objectives.id,
      number: objectives.number,
      name: objectives.name,
      identifier: objectives.identifier,
      status: objectives.status,
      startAt: objectives.startAt,
      endAt: objectives.endAt,
      verticalPosition: objectives.verticalPosition,
      position: objectives.position,
      size: objectives.size,
      value: objectives.value,
      version: objectives.version,
    })
    .from(objectives)
    .where(eq(objectives.programId, programId))
    .orderBy(desc(objectives.status), asc(objectives.position))
    .all();
  return { plan, projects: memberProjects, objectives: rows };
}

/** The objective with this number in the program, if it still exists. */
export function findObjectiveByNumber(
  db: BetterSQLite3Database,
  programId: number,
  number: number,
): ObjectiveRow | undefined {
  return db
    .select()
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.number, number)))
    .get();
}

/** One version of an objective as the trail shows it. */
export interface ObjectiveHistoryEntry {
  version: number;
  name: string;
  identifier: string;
  valueStatement: string | null;
  startAt: string | null;
  endAt: string | null;
  verticalPosition: number;
  size: number;
  value: number;
  status: string;
  position: number;
  isDeletion: boolean;
  modifiedBy: { id: number; name: string } | null;
  createdAt: Date;
}

/** The objective's versions, newest first (the deletion version last-written, so first). */
export function objectiveHistory(db: BetterSQLite3Database, objectiveId: number): ObjectiveHistoryEntry[] {
  return db
    .select({
      version: objectiveVersions.version,
      name: objectiveVersions.name,
      identifier: objectiveVersions.identifier,
      valueStatement: objectiveVersions.valueStatement,
      startAt: objectiveVersions.startAt,
      endAt: objectiveVersions.endAt,
      verticalPosition: objectiveVersions.verticalPosition,
      size: objectiveVersions.size,
      value: objectiveVersions.value,
      status: objectiveVersions.status,
      position: objectiveVersions.position,
      isDeletion: objectiveVersions.isDeletion,
      modifiedById: users.id,
      modifiedByName: users.name,
      createdAt: objectiveVersions.createdAt,
    })
    .from(objectiveVersions)
    .leftJoin(users, eq(users.id, objectiveVersions.modifiedByUserId))
    .where(eq(objectiveVersions.objectiveId, objectiveId))
    .orderBy(desc(objectiveVersions.version))
    .all()
    .map(({ modifiedById, modifiedByName, ...entry }) => ({
      ...entry,
      modifiedBy: modifiedById !== null && modifiedByName !== null ? { id: modifiedById, name: modifiedByName } : null,
    }));
}

/** A program member as the team page lists them. */
export interface ProgramMemberSummary {
  userId: number;
  name: string;
  login: string;
  role: string;
}

/** The program's members with their roles, ordered case-insensitively by name. */
export function programMembers(db: BetterSQLite3Database, programId: number): ProgramMemberSummary[] {
  return db
    .select({
      userId: programMemberships.userId,
      role: programMemberships.role,
      name: users.name,
      login: users.login,
    })
    .from(programMemberships)
    .innerJoin(users, eq(users.id, programMemberships.userId))
    .where(eq(programMemberships.programId, programId))
    .orderBy(sql`lower(${users.name})`)
    .all();
}

/** Projects not yet in the program, ordered case-insensitively by name — the add-project selector. */
export function addableProjects(db: BetterSQLite3Database, programId: number): ProgramProjectSummary[] {
  const memberIds = db
    .select({ projectId: programProjects.projectId })
    .from(programProjects)
    .where(eq(programProjects.programId, programId))
    .all()
    .map((row) => row.projectId);
  return db
    .select({ id: projects.id, name: projects.name, identifier: projects.identifier })
    .from(projects)
    .where(memberIds.length === 0 ? sql`1 = 1` : notInArray(projects.id, memberIds))
    .orderBy(sql`lower(${projects.name})`)
    .all();
}
