/**
 * Credential strategies — the pluggable interface behind the sign-in
 * form (Phase 31 deliverable: "a pluggable auth-strategy interface").
 *
 * Purpose: the sign-in form takes a login and a password; which
 * authority checks them depends on the site's configuration. A
 * `CredentialStrategy` is one such authority. `authenticateCredentials`
 * runs the configured strategies in order and signs in on the first
 * success — legacy `Authenticator.authentication` chose exactly one
 * plugin; this keeps that shape but lets a site admin's Mingle
 * password remain valid beside LDAP, so a misconfigured directory
 * cannot lock the site's administrators out (a stated departure).
 *
 * Public interface: `CredentialStrategy`, `passwordStrategy`,
 * `ldapStrategy`, `authenticateCredentials`.
 *
 * Owner context: Identity & Access.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { UserRow } from "~/db/schema/identity";
import { type CommandResult, reject } from "~/domain/command.server";
import type { LdapSettings } from "~/domain/identity/auth-configuration.server";
import { authenticateUser, findUserByLoginOrEmail } from "~/domain/identity/commands.server";
import { authenticateViaLdap, type LdapDirectoryFactory } from "~/domain/identity/ldap-strategy.server";

/** A login+password authority. */
export interface CredentialStrategy {
  readonly kind: "password" | "ldap";
  authenticate(credentials: { login: string; password: string }): Promise<CommandResult<UserRow>>;
}

/**
 * The Mingle-password strategy (Phase 2's LogInUser). With
 * `adminsOnly`, it answers only for site administrators — the
 * lock-out safeguard when a directory is the primary authority.
 */
export function passwordStrategy(db: BetterSQLite3Database, options: { adminsOnly: boolean }): CredentialStrategy {
  return {
    kind: "password",
    async authenticate(credentials) {
      if (options.adminsOnly) {
        const user = findUserByLoginOrEmail(db, credentials.login);
        if (!user?.admin) return reject("login", "Invalid login or password");
      }
      return authenticateUser(db, credentials);
    },
  };
}

/** The LDAP strategy over the configured directory. */
export function ldapStrategy(
  db: BetterSQLite3Database,
  settings: LdapSettings,
  openDirectory: LdapDirectoryFactory,
): CredentialStrategy {
  return {
    kind: "ldap",
    async authenticate(credentials) {
      let directory;
      try {
        directory = await openDirectory(settings);
      } catch {
        return reject("login", "The directory server could not be reached");
      }
      return authenticateViaLdap(db, settings, directory, credentials);
    },
  };
}

/**
 * Runs the strategies in order; the first success signs the user in.
 *
 * @returns the first success, else the first strategy's rejection
 *   (the primary authority's answer is the one shown), or a generic
 *   rejection when no strategy is configured
 */
export async function authenticateCredentials(
  strategies: CredentialStrategy[],
  credentials: { login: string; password: string },
): Promise<CommandResult<UserRow>> {
  let first: CommandResult<UserRow> | undefined;
  for (const strategy of strategies) {
    const result = await strategy.authenticate(credentials);
    if (result.ok) return result;
    first ??= result;
  }
  return first ?? reject("login", "Invalid login or password");
}
