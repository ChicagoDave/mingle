/**
 * Identity & Access command handlers (Phase 2).
 *
 * Purpose: the only write path for the User aggregate. Each handler
 * validates against the legacy product's rules (user.rb), mutates state,
 * and emits a past-tense domain event — or rejects with typed field
 * errors (rule 10: no silent state changes).
 *
 * Commands → events:
 *   RegisterUser        → UserRegistered
 *   LogInUser           → UserLoggedIn
 *   UpdateUserProfile   → UserProfileUpdated
 *   ChangePassword      → PasswordChanged
 *
 * Public interface: `registerUser`, `authenticateUser`,
 * `updateUserProfile`, `changePassword`. (`CommandResult` lives in
 * ~/domain/command.server — the cross-context kernel.)
 *
 * Owner context: Identity & Access. Handlers take the Drizzle handle as
 * a parameter — this module holds no module-level infrastructure imports,
 * and tests supply their own real database.
 *
 * INVARIANT — password material (plaintext or hash) never appears in
 * event payloads, rejection messages, or return values' error text.
 */
import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users, type UserRow } from "~/db/schema/identity";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { hashPassword, verifyPassword } from "~/domain/identity/password.server";

// Legacy parity rules (mingle/app/models/user.rb):
const LOGIN_FORMAT = /^[.+@_\w-]+$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates a candidate password against the legacy rules: 5–40 chars,
 * at least one digit, at least one non-alphanumeric symbol.
 *
 * @returns an error message, or null when valid
 */
function passwordRuleError(password: string): string | null {
  if (password.length < 5 || password.length > 40)
    return "must be between 5 and 40 characters";
  if (!/\d/.test(password)) return "needs at least one digit";
  if (!/[\W_]/.test(password))
    return 'needs at least one non-character symbol (e.g. ".", "," or "-")';
  return null;
}

/**
 * Looks a user up by login, case-insensitively (logins are stored
 * lowercase; legacy looked them up with login.downcase).
 */
function findByLogin(
  db: BetterSQLite3Database,
  login: string,
): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(eq(users.login, login.trim().toLowerCase()))
    .get();
}

export interface RegisterUserInput {
  login: string;
  name: string;
  email?: string | null;
  password: string;
}

/**
 * RegisterUser — creates a user account.
 *
 * DOES: inserts a `users` row (login lowercased, password stored as an
 * scrypt hash; the first user in an empty install becomes admin) and
 * appends a UserRegistered event.
 * REJECTS: invalid login format/length, taken login, missing name,
 * invalid or taken email, password rule violations.
 *
 * @returns the created user row, or field errors
 */
export function registerUser(
  db: BetterSQLite3Database,
  input: RegisterUserInput,
): CommandResult<UserRow> {
  const login = input.login.trim().toLowerCase();
  const name = input.name.trim();
  const email = input.email?.trim() || null;

  if (login.length < 1 || login.length > 255)
    return reject("login", "must be between 1 and 255 characters");
  if (!LOGIN_FORMAT.test(login)) return reject("login", "is invalid");
  if (findByLogin(db, login)) return reject("login", "has already been taken");
  if (!name) return reject("name", "can't be blank");
  if (email) {
    if (email.length < 3 || email.length > 255 || !EMAIL_FORMAT.test(email))
      return reject("email", "is invalid");
    const emailTaken = db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .get();
    if (emailTaken) return reject("email", "has already been taken");
  }
  const passwordError = passwordRuleError(input.password);
  if (passwordError) return reject("password", passwordError);

  return db.transaction((tx) => {
    const anyUser = tx.select({ id: users.id }).from(users).limit(1).get();
    const row = tx
      .insert(users)
      .values({
        login,
        name,
        email,
        passwordHash: hashPassword(input.password),
        admin: !anyUser, // first user of a fresh install administers it
      })
      .returning()
      .get();
    emitEvent(tx, {
      type: "UserRegistered",
      aggregateType: "User",
      aggregateId: row.id,
      payload: { login: row.login, name: row.name, admin: row.admin },
      actorUserId: row.id,
    });
    return { ok: true, value: row } as CommandResult<UserRow>;
  });
}

export interface AuthenticateUserInput {
  login: string;
  password: string;
}

/**
 * LogInUser — verifies credentials against the stored hash.
 *
 * DOES: on success, stamps `last_login_at` and appends a UserLoggedIn
 * event.
 * REJECTS: unknown login, wrong password, or deactivated account — all
 * with the same generic message (no account enumeration).
 *
 * @returns the authenticated user row, or a generic credentials error
 */
export function authenticateUser(
  db: BetterSQLite3Database,
  input: AuthenticateUserInput,
): CommandResult<UserRow> {
  const invalid = () =>
    reject<UserRow>("login", "Invalid login or password");

  const user = findByLogin(db, input.login);
  if (!user) return invalid();
  if (!verifyPassword(input.password, user.passwordHash)) return invalid();
  if (!user.activated) return invalid();

  return db.transaction((tx) => {
    const row = tx
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: "UserLoggedIn",
      aggregateType: "User",
      aggregateId: user.id,
      payload: { login: user.login },
      actorUserId: user.id,
    });
    return { ok: true, value: row } as CommandResult<UserRow>;
  });
}

export interface UpdateUserProfileInput {
  userId: number;
  name: string;
  email?: string | null;
}

/**
 * UpdateUserProfile — changes display name and email.
 *
 * DOES: updates the `users` row (name, email, updated_at) and appends a
 * UserProfileUpdated event naming the changed fields.
 * REJECTS: unknown user, blank name, invalid email, or an email already
 * used by a different account.
 *
 * @returns the updated user row, or field errors
 */
export function updateUserProfile(
  db: BetterSQLite3Database,
  input: UpdateUserProfileInput,
): CommandResult<UserRow> {
  const current = db
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!current) return reject("user", "does not exist");

  const name = input.name.trim();
  const email = input.email?.trim() || null;
  if (!name) return reject("name", "can't be blank");
  if (email) {
    if (email.length < 3 || email.length > 255 || !EMAIL_FORMAT.test(email))
      return reject("email", "is invalid");
    const emailTaken = db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()} AND ${users.id} != ${input.userId}`)
      .get();
    if (emailTaken) return reject("email", "has already been taken");
  }

  const changed = [
    ...(name !== current.name ? ["name"] : []),
    ...(email !== current.email ? ["email"] : []),
  ];
  return db.transaction((tx) => {
    const row = tx
      .update(users)
      .set({ name, email, updatedAt: new Date() })
      .where(eq(users.id, input.userId))
      .returning()
      .get();
    emitEvent(tx, {
      type: "UserProfileUpdated",
      aggregateType: "User",
      aggregateId: input.userId,
      payload: { changed },
      actorUserId: input.userId,
    });
    return { ok: true, value: row } as CommandResult<UserRow>;
  });
}

export interface ChangePasswordInput {
  userId: number;
  currentPassword: string;
  newPassword: string;
}

/**
 * ChangePassword — replaces the stored password hash.
 *
 * DOES: verifies the current password, stores a fresh scrypt hash of the
 * new one (updated_at stamped), and appends a PasswordChanged event
 * (payload carries no password material).
 * REJECTS: unknown user, wrong current password, or a new password that
 * violates the password rules.
 *
 * @returns the updated user row, or field errors
 */
export function changePassword(
  db: BetterSQLite3Database,
  input: ChangePasswordInput,
): CommandResult<UserRow> {
  const current = db
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .get();
  if (!current) return reject("user", "does not exist");
  if (!verifyPassword(input.currentPassword, current.passwordHash))
    return reject("currentPassword", "is incorrect");
  const passwordError = passwordRuleError(input.newPassword);
  if (passwordError) return reject("newPassword", passwordError);

  return db.transaction((tx) => {
    const row = tx
      .update(users)
      .set({ passwordHash: hashPassword(input.newPassword), updatedAt: new Date() })
      .where(eq(users.id, input.userId))
      .returning()
      .get();
    emitEvent(tx, {
      type: "PasswordChanged",
      aggregateType: "User",
      aggregateId: input.userId,
      payload: {},
      actorUserId: input.userId,
    });
    return { ok: true, value: row } as CommandResult<UserRow>;
  });
}
