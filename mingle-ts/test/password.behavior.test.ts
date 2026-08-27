/**
 * Behavioral tests for password hashing and verification
 * (app/domain/identity/password.server.ts).
 *
 * `verifyPassword` promises in its own doc comment that it returns false —
 * never throws — for malformed or unknown stored formats. That promise is
 * the whole defence for a corrupted or hand-edited `users.password_hash`:
 * if it broke, a 500 on the login path would say more about the stored row
 * than the login form ever should. The mutation audit of 2026-08-27 found
 * both of its rejection branches unreached by any test, so they are driven
 * here directly against the real scrypt implementation — no stubs.
 *
 * Owner context: Identity & Access verification.
 */
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../app/domain/identity/password.server";

/** Byte length `hashPassword` derives; the floor verification enforces. */
const KEY_LENGTH = 64;

const PASSWORD = "card-wall-2010!";
const stored = hashPassword(PASSWORD);

/** Rebuilds a stored hash with one field replaced, leaving the rest real. */
function withField(index: number, value: string): string {
  const parts = stored.split(":");
  parts[index] = value;
  return parts.join(":");
}

describe("hashPassword", () => {
  it("produces a self-describing hash that verifies against its own password", () => {
    expect(stored.split(":").slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    expect(verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it("salts each hash, so the same password never hashes to the same string", () => {
    const again = hashPassword(PASSWORD);
    expect(again).not.toBe(stored);
    expect(verifyPassword(PASSWORD, again)).toBe(true);
  });
});

describe("verifyPassword — rejection", () => {
  it("rejects the wrong password against a real hash", () => {
    expect(verifyPassword("card-wall-2011!", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("rejects a stored value with the wrong number of fields", () => {
    expect(verifyPassword(PASSWORD, stored.split(":").slice(0, 5).join(":"))).toBe(false);
    expect(verifyPassword(PASSWORD, stored + ":extra")).toBe(false);
    expect(verifyPassword(PASSWORD, "")).toBe(false);
  });

  it("rejects a stored value naming an algorithm it does not implement", () => {
    expect(verifyPassword(PASSWORD, withField(0, "sha1"))).toBe(false);
  });

  it("rejects — rather than throwing — when the stored cost parameters are illegal", () => {
    // N must be a power of two greater than 1; scryptSync throws on 3.
    expect(() => verifyPassword(PASSWORD, withField(1, "3"))).not.toThrow();
    expect(verifyPassword(PASSWORD, withField(1, "3"))).toBe(false);
    expect(verifyPassword(PASSWORD, withField(1, "not-a-number"))).toBe(false);
  });

  it("rejects a stored value whose hash field is empty, rather than matching every password", () => {
    // A zero-length hash makes scrypt derive zero bytes, and two empty
    // buffers compare equal — so this must be refused before the compare.
    expect(verifyPassword(PASSWORD, withField(5, ""))).toBe(false);
    expect(verifyPassword("any password at all", withField(5, ""))).toBe(false);
  });

  it("rejects a stored value whose hash field is short of the full key", () => {
    const short = stored.split(":")[5].slice(0, (KEY_LENGTH - 1) * 2);
    expect(verifyPassword(PASSWORD, withField(5, short))).toBe(false);
  });

  it("rejects hex fields that are truncated or not hex at all", () => {
    for (const bad of ["zzzz", stored.split(":")[4].slice(0, 31)]) {
      expect(verifyPassword(PASSWORD, withField(4, bad))).toBe(false);
      expect(verifyPassword(PASSWORD, withField(5, bad))).toBe(false);
    }
  });
});
