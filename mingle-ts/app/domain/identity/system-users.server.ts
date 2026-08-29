/**
 * System users — accounts that act on behalf of an integration
 * (Phase 32), legacy `User.create_or_update_system_user` parity.
 *
 * Purpose: a GitHub push posts murmurs; a murmur has an author. Legacy
 * created a "github" user for that. Such a user has no password (an
 * unusable hash — it can never sign in) and, unlike legacy's, is not a
 * site admin: the integration that needs it makes it a member of the
 * project it serves, so it holds only that project's privileges.
 *
 * Commands → events:
 *   EnsureSystemUser → SystemUserCreated (first time only)
 *
 * Public interface: `ensureSystemUser`.
 *
 * Owner context: Identity & Access.
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users, type UserRow } from "~/db/schema/identity";
import { emitEvent } from "~/domain/events.server";
import { unusablePasswordHash } from "~/domain/identity/password.server";

export interface EnsureSystemUserInput {
  /** The fixed login, e.g. "github"; stored lowercase. */
  login: string;
  name: string;
  /** Who caused the account to exist, for the event. */
  actorUserId: number;
}

/**
 * EnsureSystemUser — finds or creates the named system account.
 *
 * DOES: when no user has the login, inserts a `users` row (name as
 * given, no email, unusable password hash, not an admin) and appends
 * SystemUserCreated; otherwise changes nothing. Idempotent.
 *
 * @returns the user row
 */
export function ensureSystemUser(db: BetterSQLite3Database, input: EnsureSystemUserInput): UserRow {
  const login = input.login.trim().toLowerCase();
  const existing = db.select().from(users).where(eq(users.login, login)).get();
  if (existing) return existing;
  return db.transaction((tx) => {
    const row = tx
      .insert(users)
      .values({ login, name: input.name.trim() || login, email: null, passwordHash: unusablePasswordHash(), admin: false })
      .returning()
      .get();
    emitEvent(tx, {
      type: "SystemUserCreated",
      aggregateType: "User",
      aggregateId: row.id,
      payload: { login: row.login, name: row.name },
      actorUserId: input.actorUserId,
    });
    return row;
  });
}
