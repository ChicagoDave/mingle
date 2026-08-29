/**
 * Identity & Access schema — the `users` table.
 *
 * Purpose: persistence shape for the User aggregate (Phase 2). Mirrors
 * the legacy model's rules: login is stored lowercase (the original
 * looked logins up case-insensitively), email is optional but unique
 * when present, and the password is stored only as a salted hash.
 *
 * Public interface: `users`, `apiKeys`, `externalIdentities`,
 * `authConfigurations` (Drizzle tables). Enforcement of the write
 * rules lives in app/domain/identity — never insert into these tables
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

/**
 * API keys — bearer credentials for the public HTTP API (Phase 30).
 *
 * One user may hold several live keys. Only a SHA-256 hash of the key
 * is stored; the plaintext is shown once at generation and can never be
 * recovered (unlike legacy's plaintext `users.api_key` column). A key
 * is revoked by stamping `revoked_at`, never deleted, so its prefix
 * stays attributable in the event trail.
 *
 * Written only through app/domain/identity/api-keys.server.ts.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    /** Hex SHA-256 of the full plaintext key; the lookup column. */
    keyHash: text("key_hash").notNull().unique(),
    /** The first characters of the key, for display and attribution only. */
    keyPrefix: text("key_prefix").notNull(),
    /**
     * The HMAC signing secret paired with the key (Phase 31), sealed by
     * app/domain/identity/sealer.server.ts — the server must read it
     * back to verify signatures. Null for keys minted before signing
     * existed; those authenticate as bearer keys only.
     */
    signingSecretSealed: text("signing_secret_sealed"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * External identities — the link between a user and the account an
 * external authentication source knows them by (Phase 31).
 *
 * `kind` names the source ("ldap" | "oidc"); `subject` is the source's
 * stable identifier (the OIDC `sub` claim, the LDAP login attribute
 * value). A user signing in through a source is matched by this row
 * first, so a renamed login or email does not create a second account.
 *
 * Written only through app/domain/identity/external-login.server.ts.
 */
export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    userId: integer("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("external_identities_subject_unique").on(t.kind, t.subject),
    index("external_identities_user_idx").on(t.userId),
  ],
);

export type ExternalIdentityRow = typeof externalIdentities.$inferSelect;

/**
 * Authentication configuration — one row per strategy kind (Phase 31),
 * the successor of legacy `auth_config.yml`'s `ldap_settings` and
 * `authentication:` sections, site-wide as legacy's was.
 *
 * `settings` is JSON in the shape app/domain/identity/auth-configuration
 * declares for the kind; secret fields inside it (bind password, client
 * secret) are stored sealed, never in the clear.
 *
 * Written only through app/domain/identity/auth-configuration.server.ts.
 */
export const authConfigurations = sqliteTable(
  "auth_configurations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "ldap" | "oidc". */
    kind: text("kind").notNull().unique(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    settings: text("settings").notNull().default("{}"),
    updatedByUserId: integer("updated_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
);

export type AuthConfigurationRow = typeof authConfigurations.$inferSelect;
