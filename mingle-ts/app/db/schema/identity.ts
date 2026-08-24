/**
 * Identity & Access schema — the `users` table.
 *
 * Purpose: persistence shape for the User aggregate (Phase 2). Mirrors
 * the legacy model's rules: login is stored lowercase (the original
 * looked logins up case-insensitively), email is optional but unique
 * when present, and the password is stored only as a salted hash.
 *
 * Public interface: `users` (Drizzle table). Enforcement of the write
 * rules lives in app/domain/identity — never insert into this table
 * from route code directly.
 *
 * Owner context: Identity & Access.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Lowercased at write; unique. Format enforced in the domain layer. */
    login: text("login").notNull().unique(),
    /** Display name (legacy: validates_presence_of :name). */
    name: text("name").notNull(),
    /** Optional; unique case-insensitively when present (legacy parity). */
    email: text("email"),
    /** scrypt output, self-describing: scrypt:N:r:p:<salt-hex>:<hash-hex>. */
    passwordHash: text("password_hash").notNull(),
    /** First registered user becomes admin (legacy install flow parity). */
    admin: integer("admin", { mode: "boolean" }).notNull().default(false),
    activated: integer("activated", { mode: "boolean" })
      .notNull()
      .default(true),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Case-insensitive uniqueness for optional email, matching the legacy
    // validates_uniqueness_of :email, :case_sensitive => false.
    uniqueIndex("users_email_ci_unique")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL`),
    index("users_last_login_idx").on(t.lastLoginAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
