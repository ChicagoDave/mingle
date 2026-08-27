/**
 * Password hashing — scrypt with per-user salt.
 *
 * Purpose: the only module that creates or verifies password hashes.
 * Mirrors the legacy intent (per-user salt, server-side verification —
 * user.rb's sha_password) with a modern KDF instead of its 2007-era
 * salted SHA.
 *
 * Public interface: `hashPassword`, `verifyPassword`. The stored format
 * is self-describing (`scrypt:N:r:p:<salt-hex>:<hash-hex>`) so cost
 * parameters can be raised later without invalidating existing hashes.
 *
 * Owner context: Identity & Access (domain service).
 *
 * INVARIANT — plaintext passwords never leave this module's call frames:
 * not stored, not logged, not placed in domain-event payloads.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * Hashes a plaintext password with a fresh random salt.
 *
 * @param password - plaintext; caller has already validated format rules
 * @returns self-describing hash string for the users.password_hash column
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Decodes one hex field of a stored hash.
 *
 * `Buffer.from(s, "hex")` stops silently at the first character it cannot
 * read, so a corrupted field would otherwise decode to a short buffer —
 * or an empty one — instead of announcing itself. This refuses anything
 * that is not complete, even-length hex.
 *
 * @param hex - the field as stored
 * @returns the decoded bytes, or null if the field is not whole hex
 */
function decodeHexField(hex: string): Buffer | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Verifies a plaintext password against a stored hash string.
 *
 * Fails closed on every malformed input. The length floor matters as much
 * as the comparison: `scryptSync` honours the key length it is given, so a
 * stored hash truncated to zero bytes would derive zero bytes and compare
 * equal to itself for *any* password. Deriving the length from the stored
 * value is what lets cost parameters be raised later, so the floor — not
 * the derivation — is what keeps that from becoming a bypass.
 *
 * @param password - plaintext candidate
 * @param stored - value from users.password_hash
 * @returns true only on a timing-safe match; false for wrong passwords
 *          and for malformed/unknown stored formats (never throws)
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = decodeHexField(saltHex);
  const expected = decodeHexField(hashHex);
  if (salt === null || expected === null || expected.length < KEY_LENGTH) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
