/**
 * The install's sealer — encrypts stored credentials under the app
 * secret (Phase 31).
 *
 * Purpose: constructs the one `Sealer` the adapters hand to the
 * Identity commands that store or read back secrets (API signing
 * secrets, the LDAP bind password, the OIDC client secret). Keyed from
 * `appSecret()`, so values sealed by one process open in the next.
 *
 * Public interface: `sealer`.
 *
 * Owner context: infrastructure (secret handling) for Identity &
 * Access.
 */
import { appSecret } from "~/auth/secret.server";
import { createSealer, type Sealer } from "~/domain/identity/sealer.server";

/** Process-wide sealer keyed from the install's secret. */
export const sealer: Sealer = createSealer(appSecret());
