/**
 * Sign-in composition — which credential strategies the sign-in form
 * runs, per the site's authentication configuration (Phase 31).
 *
 * Purpose: the one place the form's login+password is routed. With
 * LDAP enabled the directory is the authority, and a site admin's
 * Mingle password stays valid behind it (strategy.server.ts explains
 * why); otherwise Mingle passwords alone.
 *
 * Public interface: `signInWithCredentials`.
 *
 * Owner context: infrastructure (HTTP adapter composition) for
 * Identity & Access.
 */
import { db } from "~/db/client.server";
import { openLdapDirectory } from "~/auth/ldap-directory.server";
import { sealer } from "~/auth/sealer.server";
import type { CommandResult } from "~/domain/command.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";
import { authenticateCredentialsDetailed, type AuthenticatedCredentials, ldapStrategy, passwordStrategy } from "~/domain/identity/strategy.server";

/**
 * Authenticates the sign-in form's credentials through the configured
 * strategies.
 *
 * @returns the signed-in user and the strategy kind that vouched for
 *   them (recorded on the session), or the primary strategy's rejection
 */
export async function signInWithCredentials(credentials: { login: string; password: string }): Promise<CommandResult<AuthenticatedCredentials>> {
  const { ldap } = loadAuthenticationConfiguration(db, sealer);
  const strategies = ldap.enabled
    ? [ldapStrategy(db, ldap, openLdapDirectory), passwordStrategy(db, { adminsOnly: true })]
    : [passwordStrategy(db, { adminsOnly: false })];
  return authenticateCredentialsDetailed(strategies, credentials);
}
