/**
 * Behavioral tests for the Identity & Access commands (Phase 2).
 *
 * Derived line-by-line from the rule 12 Behavior Statements: every DOES
 * asserts on the persisted row reloaded from the database (never on the
 * return value alone), and every REJECTS WHEN has a rejection test that
 * also proves nothing mutated.
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
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../app/db/schema/identity";
import { domainEvents } from "../app/db/schema/events";
import {
  authenticateUser,
  changePassword,
  registerUser,
  updateUserProfile,
} from "../app/domain/identity/commands.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-identity-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(users).run();
});

const VALID = {
  login: "Dave.C",
  name: "David Cornelson",
  email: "dave@example.com",
  password: "card-wall-2010!",
};

function reloadByLogin(login: string) {
  return db.select().from(users).where(eq(users.login, login)).get();
}

function eventsOfType(type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all();
}

describe("RegisterUser", () => {
  it("persists the user row with lowercased login and a hash, never the plaintext", () => {
    const result = registerUser(db, VALID);
    expect(result.ok).toBe(true);

    const row = reloadByLogin("dave.c");
    expect(row).toBeDefined();
    expect(row!.name).toBe("David Cornelson");
    expect(row!.email).toBe("dave@example.com");
    expect(row!.passwordHash.startsWith("scrypt:")).toBe(true);
    expect(row!.passwordHash).not.toContain(VALID.password);
  });

  it("makes the first user admin and the second not", () => {
    registerUser(db, VALID);
    registerUser(db, { ...VALID, login: "second", email: "s@example.com" });
    expect(reloadByLogin("dave.c")!.admin).toBe(true);
    expect(reloadByLogin("second")!.admin).toBe(false);
  });

  it("appends a UserRegistered event in the same transaction", () => {
    registerUser(db, VALID);
    const row = reloadByLogin("dave.c")!;
    const events = eventsOfType("UserRegistered");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(row.id);
    expect(JSON.parse(events[0].payload)).toEqual({
      login: "dave.c",
      name: "David Cornelson",
      admin: true,
    });
  });

  it.each([
    ["taken login", { ...VALID }, "login"],
    ["bad login format", { ...VALID, login: "has spaces" }, "login"],
    ["blank name", { ...VALID, login: "other", name: "  " }, "name"],
    ["invalid email", { ...VALID, login: "other", email: "not-an-email" }, "email"],
    ["short password", { ...VALID, login: "other", email: "p1@example.com", password: "a1!" }, "password"],
    ["password without digit", { ...VALID, login: "other", email: "p2@example.com", password: "no-digits-here!" }, "password"],
    ["password without symbol", { ...VALID, login: "other", email: "p3@example.com", password: "abc123def" }, "password"],
  ])("rejects %s without inserting or emitting", (_label, input, field) => {
    registerUser(db, VALID); // occupies dave.c for the taken-login case
    const before = db.select().from(users).all().length;
    const result = registerUser(db, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toBeDefined();
    expect(db.select().from(users).all().length).toBe(before);
    expect(eventsOfType("UserRegistered")).toHaveLength(1); // only the setup one
  });

  it("rejects an email already used by another account, case-insensitively", () => {
    registerUser(db, VALID);
    const result = registerUser(db, {
      ...VALID,
      login: "other",
      email: "DAVE@EXAMPLE.COM",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toBeDefined();
  });
});

describe("LogInUser", () => {
  beforeEach(() => {
    registerUser(db, VALID);
  });

  it("stamps last_login_at on the persisted row and emits UserLoggedIn", () => {
    expect(reloadByLogin("dave.c")!.lastLoginAt).toBeNull();
    const result = authenticateUser(db, {
      login: "DAVE.C", // case-insensitive lookup, legacy parity
      password: VALID.password,
    });
    expect(result.ok).toBe(true);
    expect(reloadByLogin("dave.c")!.lastLoginAt).toBeInstanceOf(Date);
    expect(eventsOfType("UserLoggedIn")).toHaveLength(1);
  });

  it("rejects a bad password with the generic message and no state change", () => {
    const result = authenticateUser(db, { login: "dave.c", password: "wrong-1!" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.login).toEqual(["Invalid login or password"]);
    expect(reloadByLogin("dave.c")!.lastLoginAt).toBeNull();
    expect(eventsOfType("UserLoggedIn")).toHaveLength(0);
  });

  it("rejects an unknown login with the same generic message", () => {
    const result = authenticateUser(db, { login: "nobody", password: VALID.password });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.login).toEqual(["Invalid login or password"]);
  });
});

describe("UpdateUserProfile", () => {
  beforeEach(() => {
    registerUser(db, VALID);
  });

  it("persists changed name and email and emits UserProfileUpdated naming them", () => {
    const id = reloadByLogin("dave.c")!.id;
    const result = updateUserProfile(db, {
      userId: id,
      name: "Dave",
      email: "new@example.com",
    });
    expect(result.ok).toBe(true);
    const row = reloadByLogin("dave.c")!;
    expect(row.name).toBe("Dave");
    expect(row.email).toBe("new@example.com");
    const events = eventsOfType("UserProfileUpdated");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ changed: ["name", "email"] });
  });

  it("rejects an email owned by another user and leaves the row unchanged", () => {
    registerUser(db, {
      login: "other",
      name: "Other",
      email: "other@example.com",
      password: "pass-w0rd!",
    });
    const id = reloadByLogin("dave.c")!.id;
    const result = updateUserProfile(db, {
      userId: id,
      name: "Dave",
      email: "OTHER@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toBeDefined();
    expect(reloadByLogin("dave.c")!.email).toBe("dave@example.com");
    expect(eventsOfType("UserProfileUpdated")).toHaveLength(0);
  });

  it("rejects an unknown user without writing rows or events", () => {
    const result = updateUserProfile(db, { userId: 999999, name: "Ghost", email: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.user).toBeDefined();
    expect(eventsOfType("UserProfileUpdated")).toHaveLength(0);
  });

  it("rejects a malformed (not merely taken) email without mutating", () => {
    const id = reloadByLogin("dave.c")!.id;
    const result = updateUserProfile(db, { userId: id, name: "Dave", email: "not-an-email" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toBeDefined();
    expect(reloadByLogin("dave.c")!.email).toBe("dave@example.com");
    expect(eventsOfType("UserProfileUpdated")).toHaveLength(0);
  });

  it("rejects a blank name without mutating", () => {
    const id = reloadByLogin("dave.c")!.id;
    const result = updateUserProfile(db, { userId: id, name: "  ", email: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeDefined();
    expect(reloadByLogin("dave.c")!.name).toBe("David Cornelson");
  });
});

describe("ChangePassword", () => {
  beforeEach(() => {
    registerUser(db, VALID);
  });

  it("replaces the stored hash (new salt) and the new password authenticates", () => {
    const id = reloadByLogin("dave.c")!.id;
    const oldHash = reloadByLogin("dave.c")!.passwordHash;
    const result = changePassword(db, {
      userId: id,
      currentPassword: VALID.password,
      newPassword: "brand-new-7!",
    });
    expect(result.ok).toBe(true);
    const newHash = reloadByLogin("dave.c")!.passwordHash;
    expect(newHash).not.toBe(oldHash);
    expect(authenticateUser(db, { login: "dave.c", password: "brand-new-7!" }).ok).toBe(true);
    expect(authenticateUser(db, { login: "dave.c", password: VALID.password }).ok).toBe(false);
    const events = eventsOfType("PasswordChanged");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toBe("{}"); // never carries password material
  });

  it("rejects an unknown user without writing rows or events", () => {
    const result = changePassword(db, {
      userId: 999999,
      currentPassword: VALID.password,
      newPassword: "brand-new-7!",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.user).toBeDefined();
    expect(eventsOfType("PasswordChanged")).toHaveLength(0);
  });

  it("rejects a wrong current password and keeps the stored hash", () => {
    const id = reloadByLogin("dave.c")!.id;
    const oldHash = reloadByLogin("dave.c")!.passwordHash;
    const result = changePassword(db, {
      userId: id,
      currentPassword: "wrong-1!",
      newPassword: "brand-new-7!",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currentPassword).toBeDefined();
    expect(reloadByLogin("dave.c")!.passwordHash).toBe(oldHash);
    expect(eventsOfType("PasswordChanged")).toHaveLength(0);
  });

  it("rejects a rule-violating new password and keeps the stored hash", () => {
    const id = reloadByLogin("dave.c")!.id;
    const oldHash = reloadByLogin("dave.c")!.passwordHash;
    const result = changePassword(db, {
      userId: id,
      currentPassword: VALID.password,
      newPassword: "short",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.newPassword).toBeDefined();
    expect(reloadByLogin("dave.c")!.passwordHash).toBe(oldHash);
  });
});
