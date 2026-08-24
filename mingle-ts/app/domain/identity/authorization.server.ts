/**
 * Authorization checkpoint — the single place project access is decided.
 *
 * Purpose: ports the legacy privilege ladder (UserAccess::PrivilegeLevel)
 * and answers "may this user perform an action requiring this level on
 * this project?". Established in Phase 4; every later phase's mutating
 * command reuses this checkpoint rather than re-inventing role checks
 * (plan, Phase 4 deliverable). The legacy LIGHT_READONLY level is
 * omitted — light users don't exist in this rewrite's schema.
 *
 * Public interface: `PrivilegeLevel`, `rolePrivilegeLevel`,
 * `privilegeLevelFor`, `authorizeProjectAction`,
 * `authorizeSiteAdminAction`.
 *
 * Owner context: Identity & Access.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import { PROJECT_ROLE_LABELS, type ProjectRole } from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";

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
  return reject(
    "authorization",
    `requires ${requirementName(minimum)} access to this project`,
  );
}
