/**
 * Card Management command handlers — Project lifecycle (Phase 3).
 *
 * Purpose: the only write path for the Project aggregate and its
 * ProjectVariable value objects. Each handler validates against the
 * legacy product's rules (project.rb, identifiable.rb,
 * project_variable.rb), mutates state, and emits a past-tense domain
 * event — or rejects with typed field errors (rule 10: no silent state
 * changes). Since Phase 4, every handler also authorizes the actor
 * through the Identity & Access checkpoint at the legacy privilege
 * level: project creation is a Mingle-administrator action, settings
 * and variable changes are project-administrator actions.
 *
 * Commands → events:
 *   CreateProject          → ProjectCreated
 *   UpdateProjectSettings  → ProjectSettingsUpdated
 *   DefineProjectVariable  → ProjectVariableDefined
 *
 * Public interface: `createProject`, `updateProjectSettings`,
 * `defineProjectVariable`, `generateProjectIdentifier`.
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — this module holds no module-level infrastructure imports,
 * and tests supply their own real database.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  projects,
  projectVariables,
  type ProjectRow,
  type ProjectVariableRow,
} from "~/db/schema/projects";
import { teamMemberships } from "~/db/schema/membership";
import { cardTypes } from "~/db/schema/cards";
import { PROJECT_VARIABLE_DATA_TYPES } from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  authorizeSiteAdminAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";
import {
  generateIdentifier,
  identifierRuleError as sharedIdentifierRuleError,
} from "~/domain/identifiable.server";

// Legacy parity rules (mingle/app/models/project.rb); the slug rules
// shared with programs and objectives live in the identifier kernel.
const INTERNAL_TABLE_PREFIX = /^mi_\d{6}/;

/**
 * Names a project variable may not take — the legacy reserved property
 * values (Project::RESERVED_IDENTIFIERS), compared case-insensitively
 * with their surrounding parentheses stripped.
 */
const RESERVED_VARIABLE_NAMES = new Set([
  ":ignore",
  "any",
  "current user",
  "today",
  "user input - required",
  "user input - optional",
  "not set",
  "set",
  "no change",
]);

/** Looks a project up by its identifier. */
function findByIdentifier(
  db: BetterSQLite3Database,
  identifier: string,
): ProjectRow | undefined {
  return db
    .select()
    .from(projects)
    .where(eq(projects.identifier, identifier))
    .get();
}

/**
 * Validates an explicitly supplied identifier against the legacy rules.
 * Uniqueness is checked separately (it needs the excluded-project scope).
 *
 * @returns an error message, or null when valid
 */
function identifierRuleError(identifier: string): string | null {
  const shared = sharedIdentifierRuleError(identifier);
  if (shared) return shared;
  if (INTERNAL_TABLE_PREFIX.test(identifier))
    return "reserved for internal Mingle use";
  return null;
}

/**
 * Generates a unique identifier from a project name, mirroring the
 * legacy Project.generate_identifier: non-alphanumerics become "_",
 * lowercased, "project_" prefixed when it would start with a digit,
 * truncated to 30 chars, then suffixed with a number until unique.
 *
 * @param name - the project name to derive from
 * @param isTaken - uniqueness probe against existing identifiers
 * @returns a valid, untaken identifier
 */
export function generateProjectIdentifier(
  name: string,
  isTaken: (candidate: string) => boolean,
): string {
  return generateIdentifier(name, isTaken, { digitPrefix: "project_", fallback: "proj" });
}

/**
 * Shared name/identifier validation for create and settings-update.
 * `excludeProjectId` scopes the uniqueness checks so a project can keep
 * its own name/identifier on update.
 *
 * @returns field errors, or null when valid
 */
function projectFieldError(
  db: BetterSQLite3Database,
  name: string,
  identifier: string,
  excludeProjectId?: number,
): CommandResult<never> | null {
  if (!name) return reject("name", "can't be blank");
  if (name.length > 255)
    return reject("name", "is too long (maximum is 255 characters)");
  const nameTaken = db
    .select({ id: projects.id })
    .from(projects)
    .where(
      excludeProjectId === undefined
        ? sql`lower(${projects.name}) = ${name.toLowerCase()}`
        : sql`lower(${projects.name}) = ${name.toLowerCase()} AND ${projects.id} != ${excludeProjectId}`,
    )
    .get();
  if (nameTaken) return reject("name", "has already been taken");

  const identifierError = identifierRuleError(identifier);
  if (identifierError) return reject("identifier", identifierError);
  const existing = findByIdentifier(db, identifier);
  if (existing && existing.id !== excludeProjectId)
    return reject("identifier", "has already been taken");
  return null;
}

export interface CreateProjectInput {
  name: string;
  /** Optional; generated from the name when blank (legacy parity). */
  identifier?: string | null;
  description?: string | null;
  /** The logged-in user creating the project. */
  actorUserId: number;
}

/**
 * CreateProject — creates a project.
 *
 * DOES: inserts a `projects` row (identifier generated from the name
 * when not supplied), gives the new project the default "Card" card
 * type (legacy project.rb parity), and appends ProjectCreated and
 * CardTypeDefined events, all in one transaction.
 * REJECTS: actor not a Mingle administrator (legacy: project creation
 * is MINGLE_ADMIN-only), blank or taken name, name over 255 chars,
 * invalid identifier (format, leading digit, over 30 chars, `mi_NNNNNN`
 * internal prefix), or taken identifier.
 *
 * @returns the created project row, or field errors
 */
export function createProject(
  db: BetterSQLite3Database,
  input: CreateProjectInput,
): CommandResult<ProjectRow> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;

  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const identifier =
    input.identifier?.trim() ||
    generateProjectIdentifier(name, (candidate) =>
      Boolean(findByIdentifier(db, candidate)),
    );

  const invalid = projectFieldError(db, name, identifier);
  if (invalid) return invalid;

  return db.transaction((tx) => {
    const row = tx
      .insert(projects)
      .values({
        name,
        identifier,
        description,
        createdByUserId: input.actorUserId,
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "ProjectCreated",
      aggregateType: "Project",
      aggregateId: row.id,
      payload: { name: row.name, identifier: row.identifier },
      actorUserId: input.actorUserId,
    });
    // Every new project starts with the default "Card" type (legacy
    // project.rb: card_types.create!(:name => 'Card') if blank).
    tx.insert(cardTypes)
      .values({ projectId: row.id, name: "Card", position: 1 })
      .run();
    emitEvent(tx, {
      type: "CardTypeDefined",
      aggregateType: "Project",
      aggregateId: row.id,
      payload: { name: "Card" },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<ProjectRow>;
  });
}

export interface UpdateProjectSettingsInput {
  projectId: number;
  name: string;
  identifier: string;
  description?: string | null;
  actorUserId: number;
}

/**
 * UpdateProjectSettings — changes a project's name, identifier, and
 * description.
 *
 * DOES: updates the `projects` row (updated_at stamped) and appends a
 * ProjectSettingsUpdated event naming the changed fields.
 * REJECTS: unknown project, actor below project administrator for the
 * project (legacy: update is PROJECT_ADMIN), blank/taken/over-long
 * name, or an invalid or taken identifier (same rules as CreateProject).
 *
 * @returns the updated project row, or field errors
 */
export function updateProjectSettings(
  db: BetterSQLite3Database,
  input: UpdateProjectSettingsInput,
): CommandResult<ProjectRow> {
  const current = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!current) return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const name = input.name.trim();
  const identifier = input.identifier.trim();
  const description = input.description?.trim() || null;
  if (!identifier) return reject("identifier", "can't be blank");

  const invalid = projectFieldError(db, name, identifier, input.projectId);
  if (invalid) return invalid;

  const changed = [
    ...(name !== current.name ? ["name"] : []),
    ...(identifier !== current.identifier ? ["identifier"] : []),
    ...(description !== current.description ? ["description"] : []),
  ];
  return db.transaction((tx) => {
    const row = tx
      .update(projects)
      .set({ name, identifier, description, updatedAt: new Date() })
      .where(eq(projects.id, input.projectId))
      .returning()
      .get();
    emitEvent(tx, {
      type: "ProjectSettingsUpdated",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { changed },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<ProjectRow>;
  });
}

export interface DefineProjectVariableInput {
  projectId: number;
  name: string;
  dataType: string;
  value?: string | null;
  actorUserId: number;
}

/**
 * Validates a variable's value against its data type, mirroring the
 * legacy per-type validate methods. String and Card values are
 * unvalidated (legacy parity); User values must reference a member of
 * the project's team (tightened from any-existing-user in Phase 4, as
 * Phase 3 deferred).
 *
 * @returns an error message, or null when valid
 */
function variableValueError(
  db: BetterSQLite3Database,
  projectId: number,
  dataType: string,
  value: string,
): string | null {
  if (dataType === "NumericType" && !/^[+-]?\d+(\.\d+)?$/.test(value))
    return "is an invalid numeric value";
  if (dataType === "DateType") {
    // ISO date only for now; legacy honored the project's date format,
    // which arrives with project date settings in a later phase.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
      return "is an invalid date";
  }
  if (dataType === "UserType") {
    const membership = db
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.projectId, projectId),
          eq(teamMemberships.userId, Number(value)),
        ),
      )
      .get();
    if (!membership) return "must select a team member";
  }
  return null;
}

/**
 * DefineProjectVariable — defines a project-level variable.
 *
 * DOES: inserts a `project_variables` row and appends a
 * ProjectVariableDefined event.
 * REJECTS: unknown project, actor below project administrator for the
 * project (legacy: variable changes are PROJECT_ADMIN), blank name,
 * reserved name (legacy reserved property values), name taken within
 * the project, unknown data type, a value wrapped in parentheses, or a
 * value invalid for the data type (non-numeric NumericType, unparseable
 * DateType, non-team-member for UserType).
 *
 * @returns the created variable row, or field errors
 */
export function defineProjectVariable(
  db: BetterSQLite3Database,
  input: DefineProjectVariableInput,
): CommandResult<ProjectVariableRow> {
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const name = input.name.trim();
  const value = input.value?.trim() || null;
  if (!name) return reject("name", "can't be blank");
  if (RESERVED_VARIABLE_NAMES.has(name.toLowerCase()))
    return reject("name", "is a reserved property value");
  const nameTaken = db
    .select({ id: projectVariables.id })
    .from(projectVariables)
    .where(
      and(
        eq(projectVariables.projectId, input.projectId),
        sql`lower(${projectVariables.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
  if (nameTaken) return reject("name", "has already been taken");
  if (
    !(PROJECT_VARIABLE_DATA_TYPES as readonly string[]).includes(input.dataType)
  )
    return reject("dataType", "must be selected");
  if (value) {
    if (value.startsWith("(") && value.endsWith(")"))
      return reject("value", "cannot both start with '(' and end with ')'");
    const valueError = variableValueError(db, input.projectId, input.dataType, value);
    if (valueError) return reject("value", valueError);
  }

  return db.transaction((tx) => {
    const row = tx
      .insert(projectVariables)
      .values({
        projectId: input.projectId,
        name,
        dataType: input.dataType,
        value,
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "ProjectVariableDefined",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { name: row.name, dataType: row.dataType, value: row.value },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<ProjectVariableRow>;
  });
}
