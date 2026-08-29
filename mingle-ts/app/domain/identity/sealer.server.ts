/**
 * Sealer — authenticated encryption for credentials the server must
 * be able to read back (Phase 31).
 *
 * Purpose: a password hash is enough for something the server only
 * verifies, but an LDAP bind password, an OIDC client secret, or an
 * API signing secret has to be *used*, so it must be recoverable. A
 * sealer keeps such values encrypted at rest under a key derived from
 * the install's secret; the plaintext exists only in memory while it
 * is used.
 *
 * Public interface: `Sealer`, `createSealer`, `SEALED_PREFIX`.
 *
 * Owner context: Identity & Access (domain service). The key material
 * is a parameter — this module never reads the environment or the
 * filesystem; the adapter that knows where the install's secret lives
 * (app/auth/secret.server.ts) constructs the sealer.
 *
 * Format: `sealed:v1:<iv>:<tag>:<ciphertext>` (base64url), AES-256-GCM
 * with a 12-byte random IV per value.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Every sealed value starts with this, so a stored value is recognizably sealed. */
export const SEALED_PREFIX = "sealed:v1:";

/** Encrypts and decrypts secrets under one key. */
export interface Sealer {
  /** Encrypts a plaintext secret for storage. */
  seal(plaintext: string): string;
  /**
   * Decrypts a stored value.
   * @throws Error when the value is not a sealed value or was sealed under another key
   */
  open(sealed: string): string;
}

/**
 * Builds a sealer keyed from the given material (the install's
 * secret). The same material always yields the same key, so values
 * sealed in one process open in another.
 *
 * @param keyMaterial - any non-empty string; hashed to a 256-bit key
 */
export function createSealer(keyMaterial: string): Sealer {
  if (!keyMaterial) throw new Error("sealer key material must not be empty");
  const key = createHash("sha256").update(keyMaterial).digest();
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${SEALED_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
    },
    open(sealed) {
      if (!sealed.startsWith(SEALED_PREFIX)) throw new Error("value is not sealed");
      const [ivText, tagText, bodyText, ...rest] = sealed.slice(SEALED_PREFIX.length).split(":");
      if (!ivText || !tagText || bodyText === undefined || rest.length > 0) throw new Error("malformed sealed value");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
