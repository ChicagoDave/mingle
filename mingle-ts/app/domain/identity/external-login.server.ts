/**
 * External sign-in — mapping an identity asserted by LDAP or an OIDC
 * provider to a Mingle user (Phase 31).
 *
 * Purpose: the one place an external source's "this is <subject>"
 * becomes a `users` row. Matching order (legacy auto-enroll parity,
 * made stable): the `external_identities` row for (kind, subject);
 * else the existing user with that login, which is then linked; else,
 * when the source auto-enrolls, a new account with no Mingle password.
 *
 * Commands → events:
 *   SignInExternalUser → UserLoggedIn, plus UserEnrolled when an
 *   account was created and ExternalIdentityLinked when an existing
 *   account was linked.
 *
 * Public interface: `ExternalIdentityClaims`, `signInExternalUser`.
 *
 * Owner context: Identity & Access. Protocol work (LDAP binds, OIDC
 * token exchange) happens in the adapters; this module trusts the
 * claims it is handed.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { externalIdentities, users, type UserRow } from "~/db/schema/identity";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { unusablePasswordHash } from "~/domain/identity/password.server";
import type { AuthSourceKind } from "~/shared/wire-types";

// Legacy parity rules (mingle/app/models/user.rb), as in commands.server.ts.
const LOGIN_FORMAT = /^[.+@_\w-]+$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What an external source asserts about the person signing in. */
export interface ExternalIdentityClaims {
  kind: AuthSourceKind;
  /** The source's stable identifier (OIDC `sub`; LDAP login attribute value). */
  subject: string;
  /** The Mingle login to use or create. */
  login: string;
  /** Display name; the login when the source has none. */
  name?: string | null;
  email?: string | null;
}

export interface SignInExternalUserInput {
  claims: ExternalIdentityClaims;
  /** Create an account for an unknown subject and login (legacy auto_enroll). */
  autoEnroll: boolean;
}

/** The generic refusal — the sign-in page shows the same line for every cause. */
const INVALID = "Invalid login or password";

/**
 * SignInExternalUser — resolves asserted claims to a user and records
 * the sign-in.
 *
 * DOES: finds the user linked to (kind, subject), or links the user
 * whose login matches (ExternalIdentityLinked), or — when
 * `autoEnroll` — inserts a `users` row (login lowercased, name from
 * the claims or the login, email when valid and free, an unusable
 * password hash, never an admin — legacy dropped
 * `auto_enroll_as_mingle_admin`) plus its identity row (UserEnrolled);
 * then stamps `last_login_at` on the user and the identity and
 * appends UserLoggedIn carrying the login and kind, all in one
 * transaction.
 * REJECTS (generic message, no enumeration): a deactivated account;
 * an unknown subject whose login is unknown when the source does not
 * auto-enroll; an enrollment whose login is invalid or whose email is
 * already taken by another account.
 *
 * @returns the signed-in user row, or a generic rejection
 */
export function signInExternalUser(
  db: BetterSQLite3Database,
  input: SignInExternalUserInput,
): CommandResult<UserRow> {
  const { claims } = input;
  const subject = claims.subject.trim();
  const login = claims.login.trim().toLowerCase();
  if (!subject || !login) return reject("login", INVALID);

  return db.transaction((tx) => {
    const linked = tx
      .select({ userId: externalIdentities.userId })
      .from(externalIdentities)
      .where(and(eq(externalIdentities.kind, claims.kind), eq(externalIdentities.subject, subject)))
      .get();
    let user = linked ? tx.select().from(users).where(eq(users.id, linked.userId)).get() : undefined;

    if (!user) {
      user = tx.select().from(users).where(eq(users.login, login)).get();
      if (user) {
        // Checked before linking: a rejection returned from inside the
        // transaction commits what preceded it, so nothing may be written first.
        if (!user.activated) return reject<UserRow>("login", INVALID);
        tx.insert(externalIdentities).values({ kind: claims.kind, subject, userId: user.id }).run();
        emitEvent(tx, {
          type: "ExternalIdentityLinked",
          aggregateType: "User",
          aggregateId: user.id,
          payload: { login: user.login, kind: claims.kind },
          actorUserId: user.id,
        });
      } else {
        if (!input.autoEnroll) return reject<UserRow>("login", INVALID);
        if (login.length > 255 || !LOGIN_FORMAT.test(login)) return reject<UserRow>("login", INVALID);
        const email = claims.email?.trim() || null;
        const emailUsable =
          email !== null &&
          email.length <= 255 &&
          EMAIL_FORMAT.test(email) &&
          !tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).get();
        user = tx
          .insert(users)
          .values({
            login,
            name: claims.name?.trim() || login,
            email: emailUsable ? email : null,
            passwordHash: unusablePasswordHash(),
            admin: false,
          })
          .returning()
          .get();
        tx.insert(externalIdentities).values({ kind: claims.kind, subject, userId: user.id }).run();
        emitEvent(tx, {
          type: "UserEnrolled",
          aggregateType: "User",
          aggregateId: user.id,
          payload: { login: user.login, name: user.name, kind: claims.kind },
          actorUserId: user.id,
        });
      }
    }
    if (!user.activated) return reject<UserRow>("login", INVALID);

    const now = new Date();
    const row = tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).returning().get();
    tx.update(externalIdentities)
      .set({ lastLoginAt: now })
      .where(and(eq(externalIdentities.kind, claims.kind), eq(externalIdentities.subject, subject)))
      .run();
    emitEvent(tx, {
      type: "UserLoggedIn",
      aggregateType: "User",
      aggregateId: user.id,
      payload: { login: user.login, kind: claims.kind },
      actorUserId: user.id,
    });
    return { ok: true, value: row } as CommandResult<UserRow>;
  });
}
