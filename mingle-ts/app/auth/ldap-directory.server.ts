/**
 * LDAP directory adapter — the `LdapDirectory` port over a real LDAP
 * connection (Phase 31), using `ldapts`.
 *
 * Purpose: gives the domain's LDAP strategy a directory to bind and
 * search against. Supports ldap:// and ldaps:// URLs (legacy
 * ldapusessl) and, since P-7, StartTLS on an ldap:// connection
 * (legacy ldapusetls): the connection is upgraded before the first
 * bind, verified against `tlsCaCert` when one is configured, else the
 * system trust store. A refused bind is an answer (`false`); every other failure
 * (unreachable host, timeout, bad base DN) propagates, which the
 * strategy reports as a directory problem rather than bad credentials.
 *
 * Public interface: `openLdapDirectory` (an `LdapDirectoryFactory`).
 *
 * Owner context: infrastructure (LDAP protocol adapter) for Identity
 * & Access.
 */
import { Client, InvalidCredentialsError } from "ldapts";
import type { LdapDirectory, LdapDirectoryFactory, LdapEntry } from "~/domain/identity/ldap-strategy.server";

/** Normalizes ldapts attribute values (string | Buffer | arrays) to string[]. */
function stringValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => (Buffer.isBuffer(item) ? item.toString("utf8") : String(item)));
}

/** Opens a connection for the configured directory URL. */
export const openLdapDirectory: LdapDirectoryFactory = async (settings) => {
  const tlsOptions = settings.tlsCaCert ? { ca: settings.tlsCaCert } : undefined;
  // ldapts reads any constructor `tlsOptions` as "connect with TLS from the
  // start" (LDAPS), so they go there only for ldaps:// URLs; for StartTLS
  // the same options go to the upgrade instead.
  const ldaps = /^ldaps:/i.test(settings.url);
  const client = new Client({
    url: settings.url,
    timeout: 15_000,
    connectTimeout: 5_000,
    ...(ldaps && tlsOptions ? { tlsOptions } : {}),
  });
  // StartTLS upgrades the plain connection before any bind or search (P-7);
  // a failed upgrade (refused by the server, untrusted certificate) is a
  // transport failure, which the strategy reports as an unreachable directory.
  if (settings.startTls && !ldaps) await client.startTLS(tlsOptions ?? {});
  const directory: LdapDirectory = {
    async bind(dn, password) {
      try {
        await client.bind(dn, password);
        return true;
      } catch (error) {
        if (error instanceof InvalidCredentialsError) return false;
        throw error;
      }
    },
    async search(baseDn, filter, attributes) {
      const { searchEntries } = await client.search(baseDn, { scope: "sub", filter, attributes, sizeLimit: 10 });
      return searchEntries.map((entry): LdapEntry => {
        const { dn, ...rest } = entry;
        const mapped: Record<string, string[]> = {};
        for (const [name, value] of Object.entries(rest)) mapped[name] = stringValues(value);
        return { dn, attributes: mapped };
      });
    },
    async close() {
      if (client.isConnected) await client.unbind();
    },
  };
  return directory;
};
