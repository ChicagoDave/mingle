/**
 * Behavioral tests for HMAC signing-secret rotation (P-8, Phase 8).
 *
 * Derived from `rotateSigningSecret` and the rotation-aware
 * `verifySignedRequest` in app/domain/identity/api-keys.server.ts: the
 * new secret seals into the key row, the replaced secret moves to the
 * previous slot with an expiry `SIGNING_SECRET_OVERLAP_MS` after the
 * rotation instant, requests signed with the previous secret verify
 * just inside that boundary and are refused just after it, only the
 * owner may rotate, and the profile page's `rotate-signing-secret`
 * intent runs the command and hands the secret back once.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations, and the real
 * sealer — no stubs.
 *
 * Owner context: Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-secret-rotation-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "secret-rotation-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { createUserSession } = await import("../app/auth/session.server");
const profileRoute = await import("../app/routes/profile");
const { apiKeys, users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { generateApiKey, rotateSigningSecret, verifySignedRequest, SIGNING_SECRET_OVERLAP_MS } = await import(
  "../app/domain/identity/api-keys.server"
);
const { canonicalRequest, bodySha256, signCanonical } = await import("../app/domain/identity/api-signing.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let ownerId: number;
let otherId: number;
let keyId: number;
let originalSecret: string;
const rotatedAt = new Date("2026-08-29T12:00:00.000Z");

beforeEach(() => {
  for (const table of [domainEvents, apiKeys, users]) db.delete(table).run();
  ownerId = mustOk(registerUser(db, { login: "owner", name: "Owner", password: "rotate-me-1!" }), "owner").id;
  otherId = mustOk(registerUser(db, { login: "other", name: "Other", password: "rotate-me-1!" }), "other").id;
  const generated = mustOk(generateApiKey(db, sealer, { userId: ownerId, actorUserId: ownerId }), "key");
  keyId = generated.row.id;
  originalSecret = generated.signingSecret;
  db.delete(domainEvents).run();
});

/** A request signed with `secret` as of `at`, verified with the server clock also at `at`. */
function verify(secret: string, at: Date) {
  const date = at.toISOString();
  const canonical = canonicalRequest({ method: "GET", pathWithQuery: "/api/v1/projects", date, bodySha256: bodySha256("") });
  return verifySignedRequest(db, sealer, { login: "owner", canonical, signature: signCanonical(secret, canonical), date, now: at });
}

const keyRow = () => db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get()!;
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

describe("RotateSigningSecret", () => {
  it("seals a new secret, keeps the old one with its expiry, and emits ApiKeySigningSecretRotated — the bearer key unchanged", () => {
    const before = keyRow();
    const result = mustOk(rotateSigningSecret(db, sealer, { apiKeyId: keyId, actorUserId: ownerId, now: rotatedAt }), "rotate");
    expect(result.signingSecret).not.toBe(originalSecret);
    expect(result.previousSecretExpiresAt.getTime()).toBe(rotatedAt.getTime() + SIGNING_SECRET_OVERLAP_MS);
    const after = keyRow();
    expect(after.keyHash).toBe(before.keyHash);
    expect(sealer.open(after.signingSecretSealed!)).toBe(result.signingSecret);
    expect(sealer.open(after.previousSigningSecretSealed!)).toBe(originalSecret);
    expect(after.previousSecretExpiresAt?.getTime()).toBe(result.previousSecretExpiresAt.getTime());
    const [event] = events("ApiKeySigningSecretRotated");
    expect(event).toBeDefined();
    const payload = JSON.parse(String(event.payload)) as Record<string, unknown>;
    expect(payload).toMatchObject({ apiKeyId: keyId, previousSecretExpiresAt: result.previousSecretExpiresAt.toISOString() });
    expect(JSON.stringify(payload)).not.toContain(result.signingSecret);
    expect(JSON.stringify(payload)).not.toContain(originalSecret);
  });

  it("accepts the previous secret just inside the overlap window and refuses it just after; the new secret works throughout", () => {
    const { signingSecret } = mustOk(rotateSigningSecret(db, sealer, { apiKeyId: keyId, actorUserId: ownerId, now: rotatedAt }), "rotate");
    const justInside = new Date(rotatedAt.getTime() + SIGNING_SECRET_OVERLAP_MS - 1000);
    const justAfter = new Date(rotatedAt.getTime() + SIGNING_SECRET_OVERLAP_MS + 1000);
    expect(verify(originalSecret, new Date(rotatedAt.getTime() + 1000))?.id).toBe(ownerId);
    expect(verify(originalSecret, justInside)?.id).toBe(ownerId);
    expect(verify(originalSecret, justAfter)).toBeNull();
    expect(verify(signingSecret, new Date(rotatedAt.getTime() + 1000))?.id).toBe(ownerId);
    expect(verify(signingSecret, justAfter)?.id).toBe(ownerId);
    expect(verify("not-a-secret", justInside)).toBeNull();
  });

  it("keeps only one previous secret: a second rotation inside the window retires the original at once", () => {
    const first = mustOk(rotateSigningSecret(db, sealer, { apiKeyId: keyId, actorUserId: ownerId, now: rotatedAt }), "first");
    const later = new Date(rotatedAt.getTime() + 60_000);
    const second = mustOk(rotateSigningSecret(db, sealer, { apiKeyId: keyId, actorUserId: ownerId, now: later }), "second");
    const at = new Date(later.getTime() + 1000);
    expect(verify(originalSecret, at)).toBeNull();
    expect(verify(first.signingSecret, at)?.id).toBe(ownerId);
    expect(verify(second.signingSecret, at)?.id).toBe(ownerId);
    expect(keyRow().previousSecretExpiresAt?.getTime()).toBe(later.getTime() + SIGNING_SECRET_OVERLAP_MS);
  });

  it("refuses anyone but the owner, and an unknown or revoked key, changing nothing", () => {
    const before = keyRow();
    const notOwner = rotateSigningSecret(db, sealer, { apiKeyId: keyId, actorUserId: otherId });
    expect(notOwner.ok).toBe(false);
    if (!notOwner.ok) expect(notOwner.errors.authorization).toEqual(["only the key's owner may rotate its signing secret"]);
    const unknown = rotateSigningSecret(db, sealer, { apiKeyId: 999, actorUserId: ownerId });
    expect(unknown.ok).toBe(false);
    expect(keyRow()).toEqual(before);
    expect(events("ApiKeySigningSecretRotated")).toEqual([]);
    expect(verify(originalSecret, new Date())?.id).toBe(ownerId);
  });

  it("is driven from the profile page: the intent rotates the caller's key and returns the secret once", async () => {
    const cookie = (await createUserSession(ownerId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const form = new URLSearchParams({ intent: "rotate-signing-secret", apiKeyId: String(keyId) });
    const request = new Request("http://localhost/profile", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const outcome = (await profileRoute.action({ request, params: {}, context: {} } as never)) as {
      saved?: string;
      rotatedKeyId?: number;
      rotatedSigningSecret?: string;
      previousSecretExpiresAt?: string;
    };
    expect(outcome.saved).toBe("signing-secret-rotated");
    expect(outcome.rotatedKeyId).toBe(keyId);
    expect(sealer.open(keyRow().signingSecretSealed!)).toBe(outcome.rotatedSigningSecret);
    expect(keyRow().previousSecretExpiresAt?.toISOString()).toBe(outcome.previousSecretExpiresAt);
    // The page lists the window while it is open.
    const listed = (await profileRoute.loader({ request: new Request("http://localhost/profile", { headers: { Cookie: cookie } }), params: {}, context: {} } as never)) as {
      apiKeys: { id: number; previousSecretExpiresAt: string | null }[];
    };
    expect(listed.apiKeys.find((k) => k.id === keyId)?.previousSecretExpiresAt).toBe(outcome.previousSecretExpiresAt);

    // Another user's cookie cannot rotate this key.
    const otherCookie = (await createUserSession(otherId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const refused = (await profileRoute.action({
      request: new Request("http://localhost/profile", { method: "POST", headers: { Cookie: otherCookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form }),
      params: {},
      context: {},
    } as never)) as { errors?: Record<string, string[]> };
    expect(refused.errors?.authorization).toBeDefined();
  });
});
