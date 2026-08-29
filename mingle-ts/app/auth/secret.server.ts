/**
 * Application secret — the one server-side secret every signed or
 * sealed value derives from.
 *
 * Purpose: resolves the install's secret once. It signs the session
 * cookie (Phase 2) and the OIDC state cookie (Phase 31), and keys the
 * sealer that encrypts stored credentials — LDAP bind passwords, OIDC
 * client secrets, API signing secrets — so none of them sits in the
 * database in the clear.
 *
 * Public interface: `appSecret`.
 *
 * Owner context: infrastructure (secret resolution) for Identity &
 * Access.
 *
 * Secret handling: SESSION_SECRET env wins; otherwise a secret is
 * generated once and persisted beside the database file (chmod 600),
 * so a self-hosted install keeps sessions and sealed values across
 * restarts with zero configuration (ADR-0002's install story).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

let resolved: string | undefined;

/**
 * The install's secret: env var, else a file persisted next to the
 * database (created on first boot). Read once per process.
 */
export function appSecret(): string {
  if (resolved !== undefined) return resolved;
  if (process.env.SESSION_SECRET) {
    resolved = process.env.SESSION_SECRET;
    return resolved;
  }
  const databaseFile = resolve(process.env.DATABASE_FILE ?? "data/mingle.db");
  const secretFile = resolve(dirname(databaseFile), "session-secret");
  if (!existsSync(secretFile)) {
    mkdirSync(dirname(secretFile), { recursive: true });
    writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  resolved = readFileSync(secretFile, "utf8").trim();
  return resolved;
}
