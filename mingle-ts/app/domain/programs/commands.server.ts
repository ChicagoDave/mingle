/**
 * Program Management command handlers — Program lifecycle and member
 * projects (Phase 26).
 *
 * Purpose: the only write path for the Program aggregate (legacy
 * `Program`, a `Deliverable` alongside projects) and for which projects
 * belong to it (legacy `program_projects`). Creating a program is a
 * Mingle-administrator action (legacy ProgramsController `create`);
 * it also creates the program's plan, and makes the creator a program
 * administrator (legacy `initialize_plan!`,
 * `add_current_user_as_team_member`). Settings and project membership
 * are program-administrator actions; deletion is a Mingle-administrator
 * action that takes the plan, projects, members and objectives with it
 * (legacy `dependent: :destroy`, objectives keeping their deletion
 * versions).
 *
 * Commands → events:
 *   CreateProgram            → ProgramCreated
 *   UpdateProgramSettings    → ProgramSettingsUpdated
 *   DeleteProgram            → ProgramDeleted
 *   AddProgramProject        → ProjectAddedToProgram
 *   RemoveProgramProject     → ProjectRemovedFromProgram
 *
 * Public interface: `createProgram`, `updateProgramSettings`,
 * `deleteProgram`, `addProgramProject`, `removeProgramProject`.
 *
 * Owner context: Program Management. Handlers take the Drizzle handle
 * as a parameter — no module-level infrastructure imports.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { programMemberships } from "~/db/schema/membership";
import { plans, programProjects, programs, type ProgramProjectRow, type ProgramRow } from "~/db/schema/programs";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { generateIdentifier, identifierRuleError } from "~/domain/identifiable.server";
import {
  authorizeProgramAction,
  authorizeSiteAdminAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";
import { todayIso } from "~/domain/programs/dates.server";
import { eraseProgramObjectives } from "~/domain/programs/objectives.server";
import { defaultPlanWindow } from "~/domain/programs/plan.server";

/** Legacy validates_length_of :name, :maximum => 255. */
const NAME_MAX_LENGTH = 255;

function findProgram(db: BetterSQLite3Database, programId: number): ProgramRow | undefined {
  return db.select().from(programs).where(eq(programs.id, programId)).get();
}

function findByIdentifier(db: BetterSQLite3Database, identifier: string): ProgramRow | undefined {
  return db.select().from(programs).where(eq(programs.identifier, identifier)).get();
}

function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get());
}

function findProgramProject(
  db: BetterSQLite3Database,
  programId: number,
  projectId: number,
): ProgramProjectRow | undefined {
  return db
    .select()
    .from(programProjects)
    .where(and(eq(programProjects.programId, programId), eq(programProjects.projectId, projectId)))
    .get();
}

/** Legacy auto_strip_attributes squish: trimmed, inner whitespace collapsed. */
function squish(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Shared name/identifier validation for create and settings-update;
 * `excludeProgramId` lets a program keep its own name and identifier.
 */
function programFieldError(
  db: BetterSQLite3Database,
  name: string,
  identifier: string,
  excludeProgramId?: number,
): CommandResult<never> | null {
  if (!name) return reject("name", "can't be blank");
  if (name.length > NAME_MAX_LENGTH) return reject("name", `is too long (maximum is ${NAME_MAX_LENGTH} characters)`);
  const nameTaken = db
    .select({ id: programs.id })
    .from(programs)
    .where(sql`lower(${programs.name}) = ${name.toLowerCase()}`)
    .get();
  if (nameTaken && nameTaken.id !== excludeProgramId) return reject("name", "has already been taken");
  if (!identifier) return reject("identifier", "can't be blank");
  const ruleError = identifierRuleError(identifier);
  if (ruleError) return reject("identifier", ruleError);
  const existing = findByIdentifier(db, identifier);
  if (existing && existing.id !== excludeProgramId) return reject("identifier", "has already been taken");
  return null;
}

export interface CreateProgramInput {
  name: string;
  /** Optional; generated from the name when blank (legacy parity). */
  identifier?: string | null;
  description?: string | null;
  actorUserId: number;
  /** ISO date the plan's default window is computed from; defaults to today. */
  today?: string;
}

/**
 * CreateProgram — creates a program with its plan.
 *
 * DOES: inserts a `programs` row (identifier generated from the name
 * when not supplied), its `plans` row with the default window (a month
 * ago to eleven months out), a `program_memberships` row making the
 * actor a program administrator, and appends a ProgramCreated event —
 * all in one transaction.
 * WHEN: the actor is a Mingle administrator, the name is non-blank,
 * at most 255 characters and unused (case-insensitively) among
 * programs, and the identifier is a valid, unused slug.
 * BECAUSE: a program is planned on a timeline from the moment it
 * exists, and whoever creates it must be able to administer it.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function createProgram(db: BetterSQLite3Database, input: CreateProgramInput): CommandResult<ProgramRow> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;
  const name = squish(input.name);
  const description = input.description?.trim() || null;
  const identifier =
    input.identifier?.trim() ||
    generateIdentifier(name, (candidate) => Boolean(findByIdentifier(db, candidate)), {
      digitPrefix: "program_",
      fallback: "program",
    });
  const invalid = programFieldError(db, name, identifier);
  if (invalid) return invalid;
  const window = defaultPlanWindow(input.today ?? todayIso());

  return db.transaction((tx) => {
    const row = tx
      .insert(programs)
      .values({ name, identifier, description, createdByUserId: input.actorUserId })
      .returning()
      .get();
    tx.insert(plans).values({ programId: row.id, ...window }).run();
    tx.insert(programMemberships)
      .values({ programId: row.id, userId: input.actorUserId, role: "program_admin" })
      .run();
    emitEvent(tx, {
      type: "ProgramCreated",
      aggregateType: "Program",
      aggregateId: row.id,
      payload: { name: row.name, identifier: row.identifier, plan: window },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface UpdateProgramSettingsInput {
  programId: number;
  name: string;
  identifier: string;
  description?: string | null;
  actorUserId: number;
}

/**
 * UpdateProgramSettings — changes a program's name, identifier and
 * description.
 *
 * DOES: updates the `programs` row (updated_at stamped) and appends a
 * ProgramSettingsUpdated event naming the changed fields. Submitting
 * the stored values changes nothing and emits nothing.
 * WHEN: the program exists, the actor is a program administrator, and
 * the name and identifier pass the CreateProgram rules (the program
 * may keep its own).
 * BECAUSE: legacy ProgramSettingsController is PROJECT_ADMIN-ranked.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function updateProgramSettings(
  db: BetterSQLite3Database,
  input: UpdateProgramSettingsInput,
): CommandResult<ProgramRow> {
  const current = findProgram(db, input.programId);
  if (!current) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const name = squish(input.name);
  const identifier = input.identifier.trim();
  const description = input.description?.trim() || null;
  const invalid = programFieldError(db, name, identifier, input.programId);
  if (invalid) return invalid;

  const changed = [
    ...(name !== current.name ? ["name"] : []),
    ...(identifier !== current.identifier ? ["identifier"] : []),
    ...(description !== current.description ? ["description"] : []),
  ];
  if (changed.length === 0) return { ok: true, value: current };

  return db.transaction((tx) => {
    const row = tx
      .update(programs)
      .set({ name, identifier, description, updatedAt: new Date() })
      .where(eq(programs.id, input.programId))
      .returning()
      .get();
    emitEvent(tx, {
      type: "ProgramSettingsUpdated",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { changed },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface DeleteProgramInput {
  programId: number;
  actorUserId: number;
}

/**
 * DeleteProgram — removes a program and everything that hangs off it.
 *
 * DOES: appends a deletion version for each of the program's
 * objectives and deletes them, deletes the program's `plans`,
 * `program_projects` and `program_memberships` rows and the
 * `programs` row, and appends a ProgramDeleted event — in one
 * transaction. Member projects themselves are untouched.
 * WHEN: the program exists and the actor is a Mingle administrator
 * (legacy ProgramsController `confirm_delete` is MINGLE_ADMIN).
 * BECAUSE: a program is a container; removing it must not orphan
 * plan, membership or link rows, while objective history is kept.
 * REJECTS WHEN: the program is unknown or the actor is not a site
 * admin — nothing written.
 */
export function deleteProgram(
  db: BetterSQLite3Database,
  input: DeleteProgramInput,
): CommandResult<{ identifier: string }> {
  const program = findProgram(db, input.programId);
  if (!program) return reject("program", "does not exist");
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;

  return db.transaction((tx) => {
    const objectiveNumbers = eraseProgramObjectives(tx, program.id, input.actorUserId);
    tx.delete(plans).where(eq(plans.programId, program.id)).run();
    tx.delete(programProjects).where(eq(programProjects.programId, program.id)).run();
    tx.delete(programMemberships).where(eq(programMemberships.programId, program.id)).run();
    tx.delete(programs).where(eq(programs.id, program.id)).run();
    emitEvent(tx, {
      type: "ProgramDeleted",
      aggregateType: "Program",
      aggregateId: program.id,
      payload: { name: program.name, identifier: program.identifier, objectiveNumbers },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { identifier: program.identifier } };
  });
}

export interface ProgramProjectInput {
  programId: number;
  projectId: number;
  actorUserId: number;
}

/**
 * AddProgramProject — makes a project a member of a program.
 *
 * DOES: inserts a `program_projects` row and appends a
 * ProjectAddedToProgram event.
 * WHEN: the program and project exist, the actor is a program
 * administrator, and the project is not already a member.
 * BECAUSE: which projects a program plans across is a program
 * administrator's decision (legacy program_projects are managed from
 * program settings).
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function addProgramProject(
  db: BetterSQLite3Database,
  input: ProgramProjectInput,
): CommandResult<ProgramProjectRow> {
  if (!findProgram(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  if (findProgramProject(db, input.programId, input.projectId))
    return reject("project", "is already a member of this program");

  return db.transaction((tx) => {
    const row = tx
      .insert(programProjects)
      .values({ programId: input.programId, projectId: input.projectId })
      .returning()
      .get();
    emitEvent(tx, {
      type: "ProjectAddedToProgram",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { projectId: input.projectId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

/**
 * RemoveProgramProject — takes a project out of a program.
 *
 * DOES: deletes the `program_projects` row and appends a
 * ProjectRemovedFromProgram event.
 * WHEN: the program exists, the actor is a program administrator, and
 * the project is currently a member.
 * BECAUSE: see AddProgramProject.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function removeProgramProject(
  db: BetterSQLite3Database,
  input: ProgramProjectInput,
): CommandResult<{ projectId: number }> {
  if (!findProgram(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const link = findProgramProject(db, input.programId, input.projectId);
  if (!link) return reject("project", "is not a member of this program");

  return db.transaction((tx) => {
    tx.delete(programProjects).where(eq(programProjects.id, link.id)).run();
    emitEvent(tx, {
      type: "ProjectRemovedFromProgram",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { projectId: input.projectId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { projectId: input.projectId } };
  });
}
