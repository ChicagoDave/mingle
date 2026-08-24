/**
 * Identity & Access command handlers — team membership and groups
 * (Phase 4).
 *
 * Purpose: the only write path for team memberships, groups, and group
 * memberships. Each handler authorizes the actor through the Phase 4
 * checkpoint (all mutations here are project-admin actions, matching
 * the legacy team/groups controllers), validates against the legacy
 * rules (member_role.rb, group.rb, user_membership.rb), mutates state,
 * and emits a past-tense domain event — or rejects (rule 10).
 *
 * Commands → events:
 *   AddTeamMember        → TeamMemberAdded
 *   ChangeTeamMemberRole → TeamMemberRoleChanged
 *   RemoveTeamMember     → TeamMemberRemoved
 *   CreateGroup          → GroupCreated
 *   DeleteGroup          → GroupDeleted
 *   AddUserToGroup       → UserAddedToGroup
 *   RemoveUserFromGroup  → UserRemovedFromGroup
 *
 * Public interface: `addTeamMember`, `changeTeamMemberRole`,
 * `removeTeamMember`, `createGroup`, `deleteGroup`, `addUserToGroup`,
 * `removeUserFromGroup`.
 *
 * Owner context: Identity & Access. Handlers take the Drizzle handle as
 * a parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import { projects } from "~/db/schema/projects";
import {
  groupMemberships,
  groups,
  teamMemberships,
  type GroupMembershipRow,
  type GroupRow,
  type TeamMembershipRow,
} from "~/db/schema/membership";
import {
  DEFAULT_PROJECT_ROLE,
  PROJECT_ROLES,
  type ProjectRole,
} from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

/** Looks up a user's membership row in a project's team, if any. */
function findMembership(
  db: BetterSQLite3Database,
  projectId: number,
  userId: number,
): TeamMembershipRow | undefined {
  return db
    .select()
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.projectId, projectId),
        eq(teamMemberships.userId, userId),
      ),
    )
    .get();
}

/** True when the project id names an existing project. */
function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get(),
  );
}

export interface AddTeamMemberInput {
  projectId: number;
  userId: number;
  /** Defaults to full_member (legacy MembershipRole.default). */
  role?: string | null;
  actorUserId: number;
}

/**
 * AddTeamMember — adds a user to a project's team with a role.
 *
 * DOES: inserts a `team_memberships` row (role defaulting to
 * full_member) and appends a TeamMemberAdded event.
 * REJECTS: actor below project admin for the project, unknown project,
 * unknown user, invalid role, or the user already being a member.
 *
 * @returns the created membership row, or field errors
 */
export function addTeamMember(
  db: BetterSQLite3Database,
  input: AddTeamMemberInput,
): CommandResult<TeamMembershipRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const user = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!user) return reject("user", "does not exist");

  const role = input.role || DEFAULT_PROJECT_ROLE;
  if (!(PROJECT_ROLES as readonly string[]).includes(role))
    return reject("role", "is not a valid role");
  if (findMembership(db, input.projectId, input.userId))
    return reject("user", "is already a member of this team");

  return db.transaction((tx) => {
    const row = tx
      .insert(teamMemberships)
      .values({ projectId: input.projectId, userId: input.userId, role })
      .returning()
      .get();
    emitEvent(tx, {
      type: "TeamMemberAdded",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { userId: input.userId, role },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<TeamMembershipRow>;
  });
}

export interface ChangeTeamMemberRoleInput {
  projectId: number;
  userId: number;
  role: string;
  actorUserId: number;
}

/**
 * ChangeTeamMemberRole — reassigns a team member's role.
 *
 * DOES: updates the membership row's role (updated_at stamped) and
 * appends a TeamMemberRoleChanged event naming old and new roles.
 * REJECTS: actor below project admin for the project, unknown project,
 * the user not being a team member, an invalid role, or the role being
 * the member's current one (nothing to change; legacy skipped silently,
 * rule 10 makes the refusal explicit).
 *
 * @returns the updated membership row, or field errors
 */
export function changeTeamMemberRole(
  db: BetterSQLite3Database,
  input: ChangeTeamMemberRoleInput,
): CommandResult<TeamMembershipRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const membership = findMembership(db, input.projectId, input.userId);
  if (!membership) return reject("user", "is not a member of this team");
  if (!(PROJECT_ROLES as readonly string[]).includes(input.role))
    return reject("role", "is not a valid role");
  if (membership.role === input.role)
    return reject("role", "is already assigned to this member");

  return db.transaction((tx) => {
    const row = tx
      .update(teamMemberships)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(teamMemberships.id, membership.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: "TeamMemberRoleChanged",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: {
        userId: input.userId,
        fromRole: membership.role,
        toRole: input.role,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<TeamMembershipRow>;
  });
}

export interface RemoveTeamMemberInput {
  projectId: number;
  userId: number;
  actorUserId: number;
}

/**
 * RemoveTeamMember — removes a user from a project's team.
 *
 * DOES: deletes the membership row and the user's memberships in the
 * project's groups (legacy ProjectMemberDeletion cleanup), in one
 * transaction, and appends a TeamMemberRemoved event naming the groups
 * the user was cleaned out of.
 * REJECTS: actor below project admin for the project, unknown project,
 * the user not being a team member, or a project admin removing
 * themselves without being a site admin (legacy "Cannot remove
 * yourself from team.").
 *
 * @returns the removed membership row, or field errors
 */
export function removeTeamMember(
  db: BetterSQLite3Database,
  input: RemoveTeamMemberInput,
): CommandResult<TeamMembershipRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const membership = findMembership(db, input.projectId, input.userId);
  if (!membership) return reject("user", "is not a member of this team");

  if (input.userId === input.actorUserId && membership.role === "project_admin") {
    const actor = db
      .select({ admin: users.admin })
      .from(users)
      .where(eq(users.id, input.actorUserId))
      .get();
    if (!actor?.admin) return reject("user", "Cannot remove yourself from team.");
  }

  const projectGroupIds = db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.projectId, input.projectId))
    .all()
    .map((g) => g.id);

  return db.transaction((tx) => {
    let removedFromGroupIds: number[] = [];
    if (projectGroupIds.length > 0) {
      removedFromGroupIds = tx
        .delete(groupMemberships)
        .where(
          and(
            eq(groupMemberships.userId, input.userId),
            inArray(groupMemberships.groupId, projectGroupIds),
          ),
        )
        .returning({ groupId: groupMemberships.groupId })
        .all()
        .map((m) => m.groupId);
    }
    tx.delete(teamMemberships).where(eq(teamMemberships.id, membership.id)).run();
    emitEvent(tx, {
      type: "TeamMemberRemoved",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: {
        userId: input.userId,
        role: membership.role,
        removedFromGroupIds,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: membership } as CommandResult<TeamMembershipRow>;
  });
}

export interface CreateGroupInput {
  projectId: number;
  name: string;
  actorUserId: number;
}

/**
 * CreateGroup — creates a user-defined group in a project.
 *
 * DOES: inserts a `groups` row and appends a GroupCreated event.
 * REJECTS: actor below project admin for the project, unknown project,
 * a blank name, a name containing a comma, or a name already taken in
 * the project (case-insensitively) — legacy group.rb validations and
 * messages.
 *
 * @returns the created group row, or field errors
 */
export function createGroup(
  db: BetterSQLite3Database,
  input: CreateGroupInput,
): CommandResult<GroupRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const name = input.name.trim();
  if (!name) return reject("name", "cannot be blank.");
  if (name.includes(",")) return reject("name", "cannot contain comma.");
  const taken = db
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.projectId, input.projectId),
        sql`lower(${groups.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
  if (taken) return reject("name", "has already been taken");

  return db.transaction((tx) => {
    const row = tx
      .insert(groups)
      .values({ projectId: input.projectId, name })
      .returning()
      .get();
    emitEvent(tx, {
      type: "GroupCreated",
      aggregateType: "Group",
      aggregateId: row.id,
      payload: { projectId: input.projectId, name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<GroupRow>;
  });
}

export interface DeleteGroupInput {
  groupId: number;
  actorUserId: number;
}

/**
 * DeleteGroup — deletes a group and its memberships.
 *
 * DOES: deletes the `groups` row and every `group_memberships` row in
 * it, in one transaction, and appends a GroupDeleted event.
 * REJECTS: unknown group, or actor below project admin for the group's
 * project.
 *
 * @returns the deleted group row, or field errors
 */
export function deleteGroup(
  db: BetterSQLite3Database,
  input: DeleteGroupInput,
): CommandResult<GroupRow> {
  const group = db
    .select()
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .get();
  if (!group) return reject("group", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    group.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  return db.transaction((tx) => {
    tx.delete(groupMemberships)
      .where(eq(groupMemberships.groupId, group.id))
      .run();
    tx.delete(groups).where(eq(groups.id, group.id)).run();
    emitEvent(tx, {
      type: "GroupDeleted",
      aggregateType: "Group",
      aggregateId: group.id,
      payload: { projectId: group.projectId, name: group.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: group } as CommandResult<GroupRow>;
  });
}

export interface GroupMembershipInput {
  groupId: number;
  userId: number;
  actorUserId: number;
}

/**
 * AddUserToGroup — adds a project team member to a group.
 *
 * DOES: inserts a `group_memberships` row and appends a UserAddedToGroup
 * event.
 * REJECTS: unknown group, actor below project admin for the group's
 * project, the user not being a member of the project's team (legacy:
 * group members are picked from the team), or the user already being in
 * the group (legacy skipped silently, rule 10 makes the refusal
 * explicit).
 *
 * @returns the created membership row, or field errors
 */
export function addUserToGroup(
  db: BetterSQLite3Database,
  input: GroupMembershipInput,
): CommandResult<GroupMembershipRow> {
  const group = db
    .select()
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .get();
  if (!group) return reject("group", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    group.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  if (!findMembership(db, group.projectId, input.userId))
    return reject("user", "is not a member of this team");
  const existing = db
    .select({ id: groupMemberships.id })
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.groupId, input.groupId),
        eq(groupMemberships.userId, input.userId),
      ),
    )
    .get();
  if (existing) return reject("user", "is already a member of this group");

  return db.transaction((tx) => {
    const row = tx
      .insert(groupMemberships)
      .values({ groupId: input.groupId, userId: input.userId })
      .returning()
      .get();
    emitEvent(tx, {
      type: "UserAddedToGroup",
      aggregateType: "Group",
      aggregateId: input.groupId,
      payload: { projectId: group.projectId, userId: input.userId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<GroupMembershipRow>;
  });
}

/**
 * RemoveUserFromGroup — removes a user from a group.
 *
 * DOES: deletes the `group_memberships` row and appends a
 * UserRemovedFromGroup event.
 * REJECTS: unknown group, actor below project admin for the group's
 * project, or the user not being in the group. (No self-removal guard:
 * legacy only guarded removal from the internal team group, which is
 * `removeTeamMember` here.)
 *
 * @returns the removed membership row, or field errors
 */
export function removeUserFromGroup(
  db: BetterSQLite3Database,
  input: GroupMembershipInput,
): CommandResult<GroupMembershipRow> {
  const group = db
    .select()
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .get();
  if (!group) return reject("group", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    group.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const membership = db
    .select()
    .from(groupMemberships)
    .where(
      and(
        eq(groupMemberships.groupId, input.groupId),
        eq(groupMemberships.userId, input.userId),
      ),
    )
    .get();
  if (!membership) return reject("user", "is not a member of this group");

  return db.transaction((tx) => {
    tx.delete(groupMemberships)
      .where(eq(groupMemberships.id, membership.id))
      .run();
    emitEvent(tx, {
      type: "UserRemovedFromGroup",
      aggregateType: "Group",
      aggregateId: input.groupId,
      payload: { projectId: group.projectId, userId: input.userId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: membership } as CommandResult<GroupMembershipRow>;
  });
}
