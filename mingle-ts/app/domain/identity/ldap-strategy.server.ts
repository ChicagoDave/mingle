/**
 * LDAP sign-in strategy — bind-based authentication against a
 * directory (Phase 31), ported from legacy `vendor/plugins/ldap_auth`.
 *
 * Purpose: the legacy sequence, step for step: bind as the service
 * account when one is configured; search the base DN for exactly one
 * entry of the user object class whose login attribute equals the
 * login; when a group is configured, require a group entry naming the
 * user's DN; then bind as the user's DN with the given password. On
 * success the entry's name and mail attributes become the claims that
 * `signInExternalUser` maps to a Mingle account, and the configured
 * LDAP group → Mingle group mappings are reconciled for the user
 * (ldap-group-sync.server.ts, P-6).
 *
 * The directory itself is a port (`LdapDirectory`): this module never
 * opens a socket, so the protocol client is replaceable and the
 * strategy is testable against any real directory.
 *
 * Public interface: `LdapDirectory`, `LdapEntry`, `LdapDirectoryFactory`,
 * `authenticateViaLdap`, `escapeFilterValue`.
 *
 * Owner context: Identity & Access.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { UserRow } from "~/db/schema/identity";
import { type CommandResult, reject } from "~/domain/command.server";
import type { LdapSettings } from "~/domain/identity/auth-configuration.server";
import { signInExternalUser } from "~/domain/identity/external-login.server";
import { ldapGroupsHolding, parseLdapGroupMappings, reconcileLdapGroups } from "~/domain/identity/ldap-group-sync.server";

/** A directory entry as the strategy needs it. */
export interface LdapEntry {
  dn: string;
  /** Attribute values by attribute name, as strings. */
  attributes: Record<string, string[]>;
}

/** The directory operations the strategy performs — one connection's worth. */
export interface LdapDirectory {
  /** Binds as `dn`; resolves false when the credentials are refused. Rejects on transport failure. */
  bind(dn: string, password: string): Promise<boolean>;
  /** Subtree search under `baseDn` for `filter`, returning the named attributes. */
  search(baseDn: string, filter: string, attributes: string[]): Promise<LdapEntry[]>;
  /** Releases the connection. */
  close(): Promise<void>;
}

/** Opens a directory connection for the given settings. */
export type LdapDirectoryFactory = (settings: LdapSettings) => Promise<LdapDirectory>;

/**
 * Escapes a value for use inside an LDAP search filter (RFC 4515),
 * so a login such as `a*)(uid=*` cannot widen the search.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export interface LdapCredentials {
  login: string;
  password: string;
}

const INVALID = "Invalid login or password";

/**
 * AuthenticateViaLdap — verifies credentials against the directory
 * and signs the user in.
 *
 * DOES: performs the legacy bind → search → group check → user-bind
 * sequence over `directory`, then delegates to `signInExternalUser`
 * with kind "ldap", the login attribute value as subject, and the
 * mapped name/mail claims — which stamps the sign-in, links or (when
 * `autoEnroll`) creates the account, and records the events. Always
 * closes the directory.
 * REJECTS (generic message): a blank password (legacy: never bind
 * with an empty password — many directories treat that as anonymous
 * and succeed); a service bind that is refused; zero or more than one
 * matching entry; a configured group that does not name the entry;
 * a user bind that is refused; and whatever `signInExternalUser`
 * refuses. A transport failure rejects with "The directory server
 * could not be reached" — a configuration problem, not a credential
 * one.
 *
 * @returns the signed-in user row, or a rejection
 */
export async function authenticateViaLdap(
  db: BetterSQLite3Database,
  settings: LdapSettings,
  directory: LdapDirectory,
  credentials: LdapCredentials,
): Promise<CommandResult<UserRow>> {
  const login = credentials.login.trim();
  const password = credentials.password;
  if (!login || !password.trim()) return reject("login", INVALID);
  try {
    if (settings.bindDn) {
      const bound = await directory.bind(settings.bindDn, settings.bindPassword);
      if (!bound) return reject("login", INVALID);
    }
    const attributes = [settings.loginAttribute, settings.nameAttribute, settings.mailAttribute].filter(Boolean);
    const entries = await directory.search(
      settings.baseDn,
      `(&(objectClass=${escapeFilterValue(settings.objectClass)})(${settings.loginAttribute}=${escapeFilterValue(login)}))`,
      attributes,
    );
    if (entries.length !== 1) return reject("login", INVALID);
    const [entry] = entries;

    if (settings.groupDn) {
      const members = await directory.search(
        settings.groupDn,
        `(&(objectClass=${escapeFilterValue(settings.groupObjectClass)})(${settings.groupAttribute}=${escapeFilterValue(entry.dn)}))`,
        [settings.groupAttribute],
      );
      if (members.length === 0) return reject("login", INVALID);
    }

    if (!(await directory.bind(entry.dn, password))) return reject("login", INVALID);

    const first = (attribute: string): string | null => (attribute && entry.attributes[attribute]?.[0]) || null;
    const signedIn = signInExternalUser(db, {
      claims: {
        kind: "ldap",
        subject: first(settings.loginAttribute) ?? login,
        login: first(settings.loginAttribute) ?? login,
        name: first(settings.nameAttribute),
        email: first(settings.mailAttribute),
      },
      autoEnroll: settings.autoEnroll,
    });
    if (!signedIn.ok) return signedIn;
    // P-6: the directory's groups are the authority for the mapped Mingle groups, on every sign-in.
    const mappings = parseLdapGroupMappings(settings.groupMappings).mappings;
    if (mappings.length > 0) {
      const holding = await ldapGroupsHolding(directory, settings, mappings, entry.dn);
      reconcileLdapGroups(db, { userId: signedIn.value.id, mappings, holding });
    }
    return signedIn;
  } catch {
    return reject("login", "The directory server could not be reached");
  } finally {
    await directory.close().catch(() => undefined);
  }
}
