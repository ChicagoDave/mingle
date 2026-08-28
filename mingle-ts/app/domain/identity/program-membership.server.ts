/**
 * Identity & Access command handlers — program membership (Phase 26).
 *
 * Purpose: the only write path for `program_memberships`, the program
 * counterpart of the Phase 4 team commands (legacy `HasManyMembers` on
 * `Deliverable`, which served projects and programs alike, and
 * `Api::ProgramMembershipsController`). Roles are the legacy
 * MembershipRole::PROGRAM_ROLES; adding and removing members are
 * program-administrator actions. Each handler mutates state and emits a
 * past-tense event, or rejects with field errors (rule 10).
 *
 * Commands → events:
 *   AddProgramMember     → ProgramMemberAdded
 *   RemoveProgramMember  → ProgramMemberRemoved
 *
 * Public interface: `addProgramMember`, `removeProgramMember`.
 *
 * Owner context: Identity & Access. Handlers take the Drizzle handle as
 * a parameter — no module-level infrastructure imports.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import { programMemberships, type ProgramMembershipRow } from "~/db/schema/membership";
import { programs } from "~/db/schema/programs";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProgramAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { DEFAULT_PROGRAM_ROLE, PROGRAM_ROLES } from "~/shared/wire-types";

function programExists(db: BetterSQLite3Database, programId: number): boolean {
  return Boolean(db.select({ id: programs.id }).from(programs).where(eq(programs.id, programId)).get());
}

function findMembership(
  db: BetterSQLite3Database,
  programId: number,
  userId: number,
): ProgramMembershipRow | undefined {
  return db
    .select()
    .from(programMemberships)
    .where(and(eq(programMemberships.programId, programId), eq(programMemberships.userId, userId)))
    .get();
}

export interface AddProgramMemberInput {
  programId: number;
  userId: number;
  /** Defaults to program_member. */
  role?: string | null;
  actorUserId: number;
}

/**
 * AddProgramMember — adds a user to a program with a role.
 *
 * DOES: inserts a `program_memberships` row (role defaulting to
 * program_member) and appends a ProgramMemberAdded event.
 * WHEN: the program exists, the actor is a program administrator (or
 * site admin), the user exists, the role is a PROGRAM_ROLES id, and the
 * user is not already a member.
 * BECAUSE: who may plan a program is decided by its administrators
 * (legacy `create` is PROJECT_ADMIN-ranked).
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function addProgramMember(
  db: BetterSQLite3Database,
  input: AddProgramMemberInput,
): CommandResult<ProgramMembershipRow> {
  if (!programExists(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get();
  if (!user) return reject("user", "does not exist");
  const role = input.role || DEFAULT_PROGRAM_ROLE;
  if (!(PROGRAM_ROLES as readonly string[]).includes(role)) return reject("role", "is not a valid role");
  if (findMembership(db, input.programId, input.userId)) return reject("user", "is already a member of this program");

  return db.transaction((tx) => {
    const row = tx
      .insert(programMemberships)
      .values({ programId: input.programId, userId: input.userId, role })
      .returning()
      .get();
    emitEvent(tx, {
      type: "ProgramMemberAdded",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { userId: input.userId, role },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface RemoveProgramMemberInput {
  programId: number;
  userId: number;
  actorUserId: number;
}

/**
 * RemoveProgramMember — removes a user from a program.
 *
 * DOES: deletes the user's `program_memberships` row and appends a
 * ProgramMemberRemoved event.
 * WHEN: the program exists, the actor is a program administrator (or
 * site admin), the user is a member, and the actor is not removing
 * themself unless they are a site admin (legacy "Cannot remove
 * yourself from program.").
 * BECAUSE: a program must not lose its last administrator by that
 * administrator's own hand.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function removeProgramMember(
  db: BetterSQLite3Database,
  input: RemoveProgramMemberInput,
): CommandResult<{ userId: number }> {
  if (!programExists(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const membership = findMembership(db, input.programId, input.userId);
  if (!membership) return reject("user", "is not a member of this program");
  if (input.userId === input.actorUserId) {
    const actor = db.select({ admin: users.admin }).from(users).where(eq(users.id, input.actorUserId)).get();
    if (!actor?.admin) return reject("user", "Cannot remove yourself from program.");
  }

  return db.transaction((tx) => {
    tx.delete(programMemberships).where(eq(programMemberships.id, membership.id)).run();
    emitEvent(tx, {
      type: "ProgramMemberRemoved",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { userId: input.userId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { userId: input.userId } };
  });
}
