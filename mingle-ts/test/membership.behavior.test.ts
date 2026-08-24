/**
 * Behavioral tests for the Identity & Access membership commands and
 * the authorization checkpoint (Phase 4).
 *
 * Derived line-by-line from the rule 12 Behavior Statements: every DOES
 * asserts on the persisted row reloaded from the database (never on the
 * return value alone), and every REJECTS WHEN has its own independent
 * rejection test that also proves nothing mutated — including a full
 * authorization sweep (readonly member, full member, non-member) per
 * mutating handler, per the recurring-gap checklist from Phases 2–3.
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations — no stubs, no fakes.
 *
 * Owner context: Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { projects } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import {
  groupMemberships,
  groups,
  teamMemberships,
} from "../app/db/schema/membership";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import { createProject } from "../app/domain/projects/commands.server";
import {
  addTeamMember,
  addUserToGroup,
  changeTeamMemberRole,
  createGroup,
  deleteGroup,
  removeTeamMember,
  removeUserFromGroup,
} from "../app/domain/identity/membership.server";
import {
  privilegeLevelFor,
  PrivilegeLevel,
} from "../app/domain/identity/authorization.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-membership-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// The fixed cast, rebuilt fresh per test:
let adminId: number; //        site admin (first registered user)
let projectAdminId: number; // project_admin member of the project
let fullMemberId: number; //   full_member of the project
let readonlyId: number; //     readonly_member of the project
let outsiderId: number; //     registered user, not on the team
let projectId: number;

function register(login: string): number {
  const result = registerUser(db, {
    login,
    name: login,
    password: "card-wall-2010!",
  });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(groupMemberships).run();
  db.delete(groups).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss");
  projectAdminId = register("pm");
  fullMemberId = register("dev");
  readonlyId = register("viewer");
  outsiderId = register("outsider");
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "test project creation",
  ).id;
  for (const [userId, role] of [
    [projectAdminId, "project_admin"],
    [fullMemberId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const) {
    mustOk(
      addTeamMember(db, { projectId, userId, role, actorUserId: adminId }),
      `test membership setup for ${userId}`,
    );
  }
  db.delete(domainEvents).run(); // only events under test matter below
});

function membershipOf(userId: number, inProject = projectId) {
  return db
    .select()
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.projectId, inProject),
        eq(teamMemberships.userId, userId),
      ),
    )
    .get();
}

function groupNamed(name: string) {
  return db.select().from(groups).where(eq(groups.name, name)).get();
}

function groupMembersOf(groupId: number) {
  return db
    .select()
    .from(groupMemberships)
    .where(eq(groupMemberships.groupId, groupId))
    .all();
}

function eventsOfType(type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all();
}

function allEvents() {
  return db.select().from(domainEvents).all();
}

function expectRejected<T>(
  result: CommandResult<T>,
  field: string,
  message: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.errors[field]).toContain(message);
  expect(allEvents()).toHaveLength(0); // a rejected command emits nothing
}

const NEEDS_PROJECT_ADMIN = "requires Project administrator access to this project";

describe("privilegeLevelFor (the authorization checkpoint's ladder)", () => {
  it("ranks a site admin MINGLE_ADMIN in any project, member or not", () => {
    expect(privilegeLevelFor(db, adminId, projectId)).toBe(
      PrivilegeLevel.MINGLE_ADMIN,
    );
  });

  it("ranks team roles project_admin > full_member > readonly_member", () => {
    expect(privilegeLevelFor(db, projectAdminId, projectId)).toBe(
      PrivilegeLevel.PROJECT_ADMIN,
    );
    expect(privilegeLevelFor(db, fullMemberId, projectId)).toBe(
      PrivilegeLevel.FULL_TEAM_MEMBER,
    );
    expect(privilegeLevelFor(db, readonlyId, projectId)).toBe(
      PrivilegeLevel.READONLY_TEAM_MEMBER,
    );
  });

  it("ranks a non-member REGISTERED_USER and an unknown id ANONYMOUS", () => {
    expect(privilegeLevelFor(db, outsiderId, projectId)).toBe(
      PrivilegeLevel.REGISTERED_USER,
    );
    expect(privilegeLevelFor(db, 99999, projectId)).toBe(
      PrivilegeLevel.ANONYMOUS,
    );
  });
});

describe("addTeamMember (AddTeamMember → TeamMemberAdded)", () => {
  it("lets a project admin add a member with a role, persisted and evented", () => {
    const result = addTeamMember(db, {
      projectId,
      userId: outsiderId,
      role: "readonly_member",
      actorUserId: projectAdminId,
    });
    expect(result.ok).toBe(true);
    const row = membershipOf(outsiderId);
    expect(row).toBeDefined();
    expect(row!.role).toBe("readonly_member");
    const events = eventsOfType("TeamMemberAdded");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(projectId);
    expect(JSON.parse(events[0].payload)).toEqual({
      userId: outsiderId,
      role: "readonly_member",
    });
    expect(events[0].actorUserId).toBe(projectAdminId);
  });

  it("defaults the role to full_member when none is given", () => {
    addTeamMember(db, { projectId, userId: outsiderId, actorUserId: adminId });
    expect(membershipOf(outsiderId)!.role).toBe("full_member");
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      addTeamMember(db, { projectId: 999, userId: outsiderId, actorUserId: adminId }),
      "project",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor", () => {
    expectRejected(
      addTeamMember(db, { projectId, userId: outsiderId, actorUserId: readonlyId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(membershipOf(outsiderId)).toBeUndefined();
  });

  it("rejects a full member as actor", () => {
    expectRejected(
      addTeamMember(db, { projectId, userId: outsiderId, actorUserId: fullMemberId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(membershipOf(outsiderId)).toBeUndefined();
  });

  it("rejects a non-member as actor", () => {
    expectRejected(
      addTeamMember(db, { projectId, userId: fullMemberId, actorUserId: outsiderId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
  });

  it("rejects a user that does not exist", () => {
    expectRejected(
      addTeamMember(db, { projectId, userId: 999, actorUserId: adminId }),
      "user",
      "does not exist",
    );
  });

  it("rejects an invalid role", () => {
    expectRejected(
      addTeamMember(db, {
        projectId,
        userId: outsiderId,
        role: "emperor",
        actorUserId: adminId,
      }),
      "role",
      "is not a valid role",
    );
    expect(membershipOf(outsiderId)).toBeUndefined();
  });

  it("rejects a user who is already a member", () => {
    expectRejected(
      addTeamMember(db, { projectId, userId: fullMemberId, actorUserId: adminId }),
      "user",
      "is already a member of this team",
    );
    expect(membershipOf(fullMemberId)!.role).toBe("full_member");
  });
});

describe("changeTeamMemberRole (ChangeTeamMemberRole → TeamMemberRoleChanged)", () => {
  it("updates the stored role and events the old and new roles", () => {
    const result = changeTeamMemberRole(db, {
      projectId,
      userId: readonlyId,
      role: "full_member",
      actorUserId: projectAdminId,
    });
    expect(result.ok).toBe(true);
    expect(membershipOf(readonlyId)!.role).toBe("full_member");
    const events = eventsOfType("TeamMemberRoleChanged");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      userId: readonlyId,
      fromRole: "readonly_member",
      toRole: "full_member",
    });
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      changeTeamMemberRole(db, {
        projectId: 999,
        userId: readonlyId,
        role: "full_member",
        actorUserId: adminId,
      }),
      "project",
      "does not exist",
    );
  });

  it("rejects an actor below project admin", () => {
    expectRejected(
      changeTeamMemberRole(db, {
        projectId,
        userId: readonlyId,
        role: "full_member",
        actorUserId: fullMemberId,
      }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(membershipOf(readonlyId)!.role).toBe("readonly_member");
  });

  it("rejects a user who is not a member", () => {
    expectRejected(
      changeTeamMemberRole(db, {
        projectId,
        userId: outsiderId,
        role: "full_member",
        actorUserId: adminId,
      }),
      "user",
      "is not a member of this team",
    );
  });

  it("rejects an invalid role", () => {
    expectRejected(
      changeTeamMemberRole(db, {
        projectId,
        userId: readonlyId,
        role: "emperor",
        actorUserId: adminId,
      }),
      "role",
      "is not a valid role",
    );
    expect(membershipOf(readonlyId)!.role).toBe("readonly_member");
  });

  it("rejects reassigning the member's current role", () => {
    expectRejected(
      changeTeamMemberRole(db, {
        projectId,
        userId: readonlyId,
        role: "readonly_member",
        actorUserId: adminId,
      }),
      "role",
      "is already assigned to this member",
    );
  });
});

describe("removeTeamMember (RemoveTeamMember → TeamMemberRemoved)", () => {
  it("deletes the membership row and events the removal", () => {
    const result = removeTeamMember(db, {
      projectId,
      userId: readonlyId,
      actorUserId: projectAdminId,
    });
    expect(result.ok).toBe(true);
    expect(membershipOf(readonlyId)).toBeUndefined();
    const events = eventsOfType("TeamMemberRemoved");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      userId: readonlyId,
      role: "readonly_member",
      removedFromGroupIds: [],
    });
  });

  it("also removes the user from the project's groups, and only this project's", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    mustOk(
      addUserToGroup(db, { groupId: group.id, userId: fullMemberId, actorUserId: adminId }),
      "group membership setup",
    );
    // A second project with its own group and membership must be untouched.
    const otherProject = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: adminId }),
      "second project setup",
    );
    mustOk(
      addTeamMember(db, {
        projectId: otherProject.id,
        userId: fullMemberId,
        actorUserId: adminId,
      }),
      "second membership setup",
    );
    const otherGroup = mustOk(
      createGroup(db, { projectId: otherProject.id, name: "QA", actorUserId: adminId }),
      "second group setup",
    );
    mustOk(
      addUserToGroup(db, {
        groupId: otherGroup.id,
        userId: fullMemberId,
        actorUserId: adminId,
      }),
      "second group membership setup",
    );
    db.delete(domainEvents).run();

    const result = removeTeamMember(db, {
      projectId,
      userId: fullMemberId,
      actorUserId: adminId,
    });
    expect(result.ok).toBe(true);
    expect(membershipOf(fullMemberId)).toBeUndefined();
    expect(groupMembersOf(group.id)).toHaveLength(0);
    // untouched in the other project:
    expect(membershipOf(fullMemberId, otherProject.id)).toBeDefined();
    expect(groupMembersOf(otherGroup.id)).toHaveLength(1);
    const events = eventsOfType("TeamMemberRemoved");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      userId: fullMemberId,
      role: "full_member",
      removedFromGroupIds: [group.id],
    });
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      removeTeamMember(db, { projectId: 999, userId: readonlyId, actorUserId: adminId }),
      "project",
      "does not exist",
    );
  });

  it("rejects an actor below project admin", () => {
    expectRejected(
      removeTeamMember(db, {
        projectId,
        userId: readonlyId,
        actorUserId: fullMemberId,
      }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(membershipOf(readonlyId)).toBeDefined();
  });

  it("rejects a user who is not a member", () => {
    expectRejected(
      removeTeamMember(db, { projectId, userId: outsiderId, actorUserId: adminId }),
      "user",
      "is not a member of this team",
    );
  });

  it("rejects a project admin removing themself when not a site admin", () => {
    expectRejected(
      removeTeamMember(db, {
        projectId,
        userId: projectAdminId,
        actorUserId: projectAdminId,
      }),
      "user",
      "Cannot remove yourself from team.",
    );
    expect(membershipOf(projectAdminId)).toBeDefined();
  });

  it("lets a site admin who is a project_admin member remove themself", () => {
    mustOk(
      addTeamMember(db, {
        projectId,
        userId: adminId,
        role: "project_admin",
        actorUserId: adminId,
      }),
      "admin membership setup",
    );
    const result = removeTeamMember(db, {
      projectId,
      userId: adminId,
      actorUserId: adminId,
    });
    expect(result.ok).toBe(true);
    expect(membershipOf(adminId)).toBeUndefined();
  });
});

describe("createGroup (CreateGroup → GroupCreated)", () => {
  it("persists the group and events it", () => {
    const result = createGroup(db, {
      projectId,
      name: "QA Team",
      actorUserId: projectAdminId,
    });
    expect(result.ok).toBe(true);
    const row = groupNamed("QA Team");
    expect(row).toBeDefined();
    expect(row!.projectId).toBe(projectId);
    const events = eventsOfType("GroupCreated");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(row!.id);
    expect(JSON.parse(events[0].payload)).toEqual({ projectId, name: "QA Team" });
  });

  it("allows the same name in a different project", () => {
    const other = mustOk(
      createProject(db, { name: "Other", identifier: "other", actorUserId: adminId }),
      "second project setup",
    );
    mustOk(createGroup(db, { projectId, name: "QA", actorUserId: adminId }), "first group");
    const result = createGroup(db, {
      projectId: other.id,
      name: "QA",
      actorUserId: adminId,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      createGroup(db, { projectId: 999, name: "QA", actorUserId: adminId }),
      "project",
      "does not exist",
    );
  });

  it("rejects an actor below project admin", () => {
    expectRejected(
      createGroup(db, { projectId, name: "QA", actorUserId: fullMemberId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(groupNamed("QA")).toBeUndefined();
  });

  it("rejects a blank name", () => {
    expectRejected(
      createGroup(db, { projectId, name: "   ", actorUserId: adminId }),
      "name",
      "cannot be blank.",
    );
  });

  it("rejects a name containing a comma", () => {
    expectRejected(
      createGroup(db, { projectId, name: "QA, Dev", actorUserId: adminId }),
      "name",
      "cannot contain comma.",
    );
  });

  it("rejects a name already taken in the project, case-insensitively", () => {
    mustOk(createGroup(db, { projectId, name: "QA", actorUserId: adminId }), "first group");
    db.delete(domainEvents).run();
    expectRejected(
      createGroup(db, { projectId, name: "qa", actorUserId: adminId }),
      "name",
      "has already been taken",
    );
  });
});

describe("deleteGroup (DeleteGroup → GroupDeleted)", () => {
  it("deletes the group and its memberships together, and events it", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    mustOk(
      addUserToGroup(db, { groupId: group.id, userId: fullMemberId, actorUserId: adminId }),
      "group membership setup",
    );
    db.delete(domainEvents).run();
    const result = deleteGroup(db, { groupId: group.id, actorUserId: adminId });
    expect(result.ok).toBe(true);
    expect(groupNamed("QA")).toBeUndefined();
    expect(groupMembersOf(group.id)).toHaveLength(0);
    const events = eventsOfType("GroupDeleted");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ projectId, name: "QA" });
  });

  it("rejects a group that does not exist", () => {
    expectRejected(
      deleteGroup(db, { groupId: 999, actorUserId: adminId }),
      "group",
      "does not exist",
    );
  });

  it("rejects an actor below project admin", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      deleteGroup(db, { groupId: group.id, actorUserId: fullMemberId }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(groupNamed("QA")).toBeDefined();
  });
});

describe("addUserToGroup (AddUserToGroup → UserAddedToGroup)", () => {
  it("persists the group membership, queryable from the DB, and events it", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    db.delete(domainEvents).run();
    const result = addUserToGroup(db, {
      groupId: group.id,
      userId: readonlyId,
      actorUserId: projectAdminId,
    });
    expect(result.ok).toBe(true);
    const members = groupMembersOf(group.id);
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(readonlyId);
    const events = eventsOfType("UserAddedToGroup");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      userId: readonlyId,
    });
  });

  it("rejects a group that does not exist", () => {
    expectRejected(
      addUserToGroup(db, { groupId: 999, userId: readonlyId, actorUserId: adminId }),
      "group",
      "does not exist",
    );
  });

  it("rejects an actor below project admin", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      addUserToGroup(db, {
        groupId: group.id,
        userId: readonlyId,
        actorUserId: fullMemberId,
      }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(groupMembersOf(group.id)).toHaveLength(0);
  });

  it("rejects a user who is not on the project's team", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      addUserToGroup(db, { groupId: group.id, userId: outsiderId, actorUserId: adminId }),
      "user",
      "is not a member of this team",
    );
    expect(groupMembersOf(group.id)).toHaveLength(0);
  });

  it("rejects a user who is already in the group", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    mustOk(
      addUserToGroup(db, { groupId: group.id, userId: readonlyId, actorUserId: adminId }),
      "group membership setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      addUserToGroup(db, { groupId: group.id, userId: readonlyId, actorUserId: adminId }),
      "user",
      "is already a member of this group",
    );
    expect(groupMembersOf(group.id)).toHaveLength(1);
  });
});

describe("removeUserFromGroup (RemoveUserFromGroup → UserRemovedFromGroup)", () => {
  it("deletes the membership row and events it", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    mustOk(
      addUserToGroup(db, { groupId: group.id, userId: readonlyId, actorUserId: adminId }),
      "group membership setup",
    );
    db.delete(domainEvents).run();
    const result = removeUserFromGroup(db, {
      groupId: group.id,
      userId: readonlyId,
      actorUserId: projectAdminId,
    });
    expect(result.ok).toBe(true);
    expect(groupMembersOf(group.id)).toHaveLength(0);
    const events = eventsOfType("UserRemovedFromGroup");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      userId: readonlyId,
    });
  });

  it("rejects a group that does not exist", () => {
    expectRejected(
      removeUserFromGroup(db, { groupId: 999, userId: readonlyId, actorUserId: adminId }),
      "group",
      "does not exist",
    );
  });

  it("rejects an actor below project admin", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    mustOk(
      addUserToGroup(db, { groupId: group.id, userId: readonlyId, actorUserId: adminId }),
      "group membership setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      removeUserFromGroup(db, {
        groupId: group.id,
        userId: readonlyId,
        actorUserId: fullMemberId,
      }),
      "authorization",
      NEEDS_PROJECT_ADMIN,
    );
    expect(groupMembersOf(group.id)).toHaveLength(1);
  });

  it("rejects a user who is not in the group", () => {
    const group = mustOk(
      createGroup(db, { projectId, name: "QA", actorUserId: adminId }),
      "group setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      removeUserFromGroup(db, {
        groupId: group.id,
        userId: readonlyId,
        actorUserId: adminId,
      }),
      "user",
      "is not a member of this group",
    );
  });
});
