/**
 * Authorization checkpoint — the single place project access is decided.
 *
 * Purpose: ports the legacy privilege ladder (UserAccess::PrivilegeLevel)
 * and answers "may this user perform an action requiring this level on
 * this project (or, since Phase 26, this program)?". Established in
 * Phase 4; every later phase's mutating command reuses this checkpoint
 * rather than re-inventing role checks (plan, Phase 4 deliverable).
 * Programs sit on the same ladder: legacy gave program_admin the
 * PROJECT_ADMIN rank and program_member the FULL_TEAM_MEMBER rank. The
 * legacy LIGHT_READONLY level is omitted — light users don't exist in
 * this rewrite's schema. Since ADR-0021 the ladder is read in order:
 * the site-admin trump, then the project's access constraint on how
 * this request was authenticated (access-constraint.server.ts, judged
 * from the request principal), then the role rank — a session that
 * fails the constraint ranks ANONYMOUS and a command is refused with
 * the constraint's own message.
 *
 * Public interface: `PrivilegeLevel`, `rolePrivilegeLevel`,
 * `privilegeLevelFor`, `authorizeProjectAction`,
 * `authorizeSiteAdminAction`, `programRolePrivilegeLevel`,
 * `privilegeLevelForProgram`, `authorizeProgramAction`.
 *
 * Owner context: Identity & Access.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import { programMemberships, teamMemberships } from "~/db/schema/membership";
import {
  PROGRAM_ROLE_LABELS,
  PROJECT_ROLE_LABELS,
  type ProgramRole,
  type ProjectRole,
} from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { accessRefusal } from "~/domain/identity/access-constraint.server";
import { currentPrincipal } from "~/domain/identity/principal.server";

/**
 * The privilege ladder, highest first (legacy PrivilegeLevel ranks).
 * A site admin (`users.admin`) holds MINGLE_ADMIN everywhere; a user
 * with no team membership in the project is just a REGISTERED_USER.
 */
export const PrivilegeLevel = {
  MINGLE_ADMIN: 6,
  PROJECT_ADMIN: 5,
  FULL_TEAM_MEMBER: 4,
  READONLY_TEAM_MEMBER: 3,
  REGISTERED_USER: 1,
  ANONYMOUS: 0,
} as const;

/** A rank on the privilege ladder. */
export type PrivilegeRank = (typeof PrivilegeLevel)[keyof typeof PrivilegeLevel];

const ROLE_LEVELS: Record<ProjectRole, PrivilegeRank> = {
  project_admin: PrivilegeLevel.PROJECT_ADMIN,
  full_member: PrivilegeLevel.FULL_TEAM_MEMBER,
  readonly_member: PrivilegeLevel.READONLY_TEAM_MEMBER,
};

/**
 * Maps a stored team role to its privilege rank.
 *
 * @param role - a PROJECT_ROLES id from a team_memberships row
 */
export function rolePrivilegeLevel(role: ProjectRole): PrivilegeRank {
  return ROLE_LEVELS[role];
}

/**
 * Computes a user's privilege rank for a project (legacy
 * User#privilege_level): MINGLE_ADMIN for site admins, the team role's
 * rank for members, REGISTERED_USER for everyone else known, ANONYMOUS
 * for an unknown user id.
 *
 * @param db - the Drizzle handle
 * @param userId - the acting user
 * @param projectId - the project being acted on
 */
export function privilegeLevelFor(
  db: BetterSQLite3Database,
  userId: number,
  projectId: number,
): PrivilegeRank {
  const user = db
    .select({ admin: users.admin })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return PrivilegeLevel.ANONYMOUS;
  if (user.admin) return PrivilegeLevel.MINGLE_ADMIN;
  // ADR-0021: trump → constraint → role rank.
  if (accessRefusal(db, userId, projectId, currentPrincipal())) return PrivilegeLevel.ANONYMOUS;
  const membership = db
    .select({ role: teamMemberships.role })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.projectId, projectId),
        eq(teamMemberships.userId, userId),
      ),
    )
    .get();
  if (!membership) return PrivilegeLevel.REGISTERED_USER;
  return (
    ROLE_LEVELS[membership.role as ProjectRole] ?? PrivilegeLevel.REGISTERED_USER
  );
}

/** Human name for the weakest role that satisfies a required rank, for error messages. */
function requirementName(minimum: PrivilegeRank): string {
  if (minimum >= PrivilegeLevel.MINGLE_ADMIN) return "Mingle administrator";
  if (minimum >= PrivilegeLevel.PROJECT_ADMIN)
    return PROJECT_ROLE_LABELS.project_admin;
  if (minimum >= PrivilegeLevel.FULL_TEAM_MEMBER)
    return PROJECT_ROLE_LABELS.full_member;
  return PROJECT_ROLE_LABELS.readonly_member;
}

/**
 * The checkpoint: rejects unless the actor's privilege rank for the
 * project meets the minimum. Command handlers call this before
 * mutating; the rejection is a normal CommandResult keyed on
 * "authorization" with the unmet requirement named.
 *
 * @param db - the Drizzle handle
 * @param actorUserId - the acting user
 * @param projectId - the project being acted on
 * @param minimum - the required privilege rank
 * @returns a rejection, or null when authorized
 */
/**
 * Checkpoint for actions with no project scope that the legacy product
 * reserved for Mingle administrators (e.g. creating or deleting a
 * project).
 *
 * @param db - the Drizzle handle
 * @param actorUserId - the acting user
 * @returns a rejection, or null when the actor is a site admin
 */
export function authorizeSiteAdminAction(
  db: BetterSQLite3Database,
  actorUserId: number,
): CommandResult<never> | null {
  const user = db
    .select({ admin: users.admin })
    .from(users)
    .where(eq(users.id, actorUserId))
    .get();
  if (user?.admin) return null;
  return reject("authorization", "requires Mingle administrator access");
}

export function authorizeProjectAction(
  db: BetterSQLite3Database,
  actorUserId: number,
  projectId: number,
  minimum: PrivilegeRank,
): CommandResult<never> | null {
  if (privilegeLevelFor(db, actorUserId, projectId) >= minimum) return null;
  const refusal = accessRefusal(db, actorUserId, projectId, currentPrincipal());
  if (refusal) return reject("authorization", refusal);
  return reject(
    "authorization",
    `requires ${requirementName(minimum)} access to this project`,
  );
}

const PROGRAM_ROLE_LEVELS: Record<ProgramRole, PrivilegeRank> = {
  program_admin: PrivilegeLevel.PROJECT_ADMIN,
  program_member: PrivilegeLevel.FULL_TEAM_MEMBER,
};

/**
 * Maps a stored program role to its privilege rank (legacy
 * MembershipRole::PROGRAM_ROLES).
 *
 * @param role - a PROGRAM_ROLES id from a program_memberships row
 */
export function programRolePrivilegeLevel(role: ProgramRole): PrivilegeRank {
  return PROGRAM_ROLE_LEVELS[role];
}

/**
 * Computes a user's privilege rank for a program: MINGLE_ADMIN for site
 * admins, the program role's rank for members, REGISTERED_USER for
 * everyone else known, ANONYMOUS for an unknown user id.
 *
 * @param db - the Drizzle handle
 * @param userId - the acting user
 * @param programId - the program being acted on
 */
export function privilegeLevelForProgram(
  db: BetterSQLite3Database,
  userId: number,
  programId: number,
): PrivilegeRank {
  const user = db
    .select({ admin: users.admin })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return PrivilegeLevel.ANONYMOUS;
  if (user.admin) return PrivilegeLevel.MINGLE_ADMIN;
  const membership = db
    .select({ role: programMemberships.role })
    .from(programMemberships)
    .where(
      and(
        eq(programMemberships.programId, programId),
        eq(programMemberships.userId, userId),
      ),
    )
    .get();
  if (!membership) return PrivilegeLevel.REGISTERED_USER;
  return (
    PROGRAM_ROLE_LEVELS[membership.role as ProgramRole] ?? PrivilegeLevel.REGISTERED_USER
  );
}

/** Human name for the weakest program role that satisfies a required rank. */
function programRequirementName(minimum: PrivilegeRank): string {
  if (minimum >= PrivilegeLevel.MINGLE_ADMIN) return "Mingle administrator";
  if (minimum >= PrivilegeLevel.PROJECT_ADMIN) return PROGRAM_ROLE_LABELS.program_admin;
  return PROGRAM_ROLE_LABELS.program_member;
}

/**
 * The program checkpoint: rejects unless the actor's privilege rank for
 * the program meets the minimum. Same contract as
 * `authorizeProjectAction` — a normal CommandResult keyed on
 * "authorization" naming the unmet requirement.
 *
 * @param db - the Drizzle handle
 * @param actorUserId - the acting user
 * @param programId - the program being acted on
 * @param minimum - the required privilege rank
 * @returns a rejection, or null when authorized
 */
export function authorizeProgramAction(
  db: BetterSQLite3Database,
  actorUserId: number,
  programId: number,
  minimum: PrivilegeRank,
): CommandResult<never> | null {
  if (privilegeLevelForProgram(db, actorUserId, programId) >= minimum) return null;
  return reject(
    "authorization",
    `requires ${programRequirementName(minimum)} access to this program`,
  );
}
