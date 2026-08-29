/**
 * Behavioral tests for API keys (Phase 30): the Identity & Access
 * commands GenerateApiKey / RevokeApiKey, the `authenticateApiKey`
 * query, and the profile route's generate/revoke intents.
 *
 * Derived from the rule 12 Behavior Statements: every DOES asserts on
 * the `api_keys` row reloaded from the database (never on the return
 * value alone), and every REJECTS WHEN proves nothing mutated. The
 * key-material invariant is asserted directly: the plaintext key never
 * appears in any row or event payload.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Identity & Access verification.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-api-keys-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "api-keys-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const { sealer } = await import("../app/auth/sealer.server");
const profileRoute = await import("../app/routes/profile");
const { apiKeys, users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { API_KEY_PREFIX, authenticateApiKey, generateApiKey, listApiKeys, revokeApiKey } = await import(
  "../app/domain/identity/api-keys.server"
);

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let devId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function register(login: string): number {
  return mustOk(registerUser(db, { login, name: login, password: "api-keys-1!" }), login).id;
}

beforeEach(() => {
  for (const table of [domainEvents, apiKeys, users]) db.delete(table).run();
  adminId = register("admin"); // first user → site admin
  devId = register("dev");
  db.delete(domainEvents).run();
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const keyRows = (userId: number) => db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).all();
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

// ------------------------------------------------------------ generate

describe("GenerateApiKey", () => {
  it("persists only the hash and prefix of a fresh mgl_ key and records ApiKeyGenerated without the key", () => {
    const { key, row } = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "generate");
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThan(40);

    const [stored] = keyRows(devId);
    expect(stored.id).toBe(row.id);
    expect(stored.keyHash).toBe(sha256(key));
    expect(stored.keyPrefix).toBe(key.slice(0, 12));
    expect(stored.revokedAt).toBeNull();
    expect(stored.lastUsedAt).toBeNull();
    // Key-material invariant: the plaintext is nowhere in the database.
    const dump = JSON.stringify(sqlite.prepare("SELECT * FROM api_keys").all()) + JSON.stringify(events("ApiKeyGenerated"));
    expect(dump).not.toContain(key);

    const [event] = events("ApiKeyGenerated");
    expect(event.aggregateId).toBe(devId);
    expect(event.actorUserId).toBe(devId);
    expect(JSON.parse(event.payload)).toEqual({ apiKeyId: row.id, keyPrefix: stored.keyPrefix });
  });

  it("leaves earlier keys valid — a user may hold several", () => {
    const first = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "first").key;
    const second = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "second").key;
    expect(first).not.toBe(second);
    expect(authenticateApiKey(db, first)?.id).toBe(devId);
    expect(authenticateApiKey(db, second)?.id).toBe(devId);
    expect(listApiKeys(db, devId)).toHaveLength(2);
  });

  it("lets a site admin generate a key for another user, but not an ordinary user", () => {
    const byAdmin = generateApiKey(db, sealer, { userId: devId, actorUserId: adminId });
    expect(byAdmin.ok).toBe(true);
    expect(keyRows(devId)).toHaveLength(1);

    const byDev = generateApiKey(db, sealer, { userId: adminId, actorUserId: devId });
    expect(byDev.ok).toBe(false);
    if (!byDev.ok) expect(byDev.errors.authorization).toEqual(["requires Mingle administrator access"]);
    expect(keyRows(adminId)).toHaveLength(0);
    expect(events("ApiKeyGenerated")).toHaveLength(1);
  });

  it("rejects an unknown or deactivated user with nothing written", () => {
    const unknown = generateApiKey(db, sealer, { userId: 9999, actorUserId: adminId });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.user).toEqual(["does not exist"]);

    db.update(users).set({ activated: false }).where(eq(users.id, devId)).run();
    const deactivated = generateApiKey(db, sealer, { userId: devId, actorUserId: devId });
    expect(deactivated.ok).toBe(false);
    if (!deactivated.ok) expect(deactivated.errors.user).toEqual(["is deactivated"]);
    expect(db.select().from(apiKeys).all()).toHaveLength(0);
    expect(events("ApiKeyGenerated")).toHaveLength(0);
  });
});

// -------------------------------------------------------- authenticate

describe("authenticateApiKey", () => {
  it("resolves a live key to its user and stamps last_used_at", () => {
    const { key, row } = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "generate");
    const before = Date.now();
    const user = authenticateApiKey(db, key);
    expect(user?.id).toBe(devId);
    expect(user?.login).toBe("dev");
    const stored = db.select().from(apiKeys).where(eq(apiKeys.id, row.id)).get()!;
    expect(stored.lastUsedAt).not.toBeNull();
    expect(stored.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Authentication is a query: it records no event.
    expect(db.select().from(domainEvents).all().filter((e) => e.type !== "ApiKeyGenerated")).toHaveLength(0);
  });

  it("returns null for a wrong prefix, an unknown key, a revoked key, or a deactivated owner — never stamping", () => {
    const { key, row } = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "generate");
    expect(authenticateApiKey(db, key.replace(API_KEY_PREFIX, "xx_"))).toBeNull();
    expect(authenticateApiKey(db, API_KEY_PREFIX + "not-a-real-key")).toBeNull();
    expect(authenticateApiKey(db, "")).toBeNull();

    mustOk(revokeApiKey(db, { apiKeyId: row.id, actorUserId: devId }), "revoke");
    expect(authenticateApiKey(db, key)).toBeNull();

    const { key: adminKey, row: adminRow } = mustOk(generateApiKey(db, sealer, { userId: adminId, actorUserId: adminId }), "admin key");
    db.update(users).set({ activated: false }).where(eq(users.id, adminId)).run();
    expect(authenticateApiKey(db, adminKey)).toBeNull();

    for (const id of [row.id, adminRow.id])
      expect(db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()!.lastUsedAt).toBeNull();
  });
});

// -------------------------------------------------------------- revoke

describe("RevokeApiKey", () => {
  it("stamps revoked_at, keeps the row, records ApiKeyRevoked, and drops the key from the live list", () => {
    const { key, row } = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "generate");
    const revoked = mustOk(revokeApiKey(db, { apiKeyId: row.id, actorUserId: devId }), "revoke");
    expect(revoked.id).toBe(row.id);

    const stored = db.select().from(apiKeys).where(eq(apiKeys.id, row.id)).get()!;
    expect(stored.revokedAt).not.toBeNull();
    expect(stored.keyHash).toBe(sha256(key));
    expect(listApiKeys(db, devId)).toEqual([]);
    const [event] = events("ApiKeyRevoked");
    expect(JSON.parse(event.payload)).toEqual({ apiKeyId: row.id, keyPrefix: row.keyPrefix });
    expect(event.actorUserId).toBe(devId);
  });

  it("rejects an unknown key, a second revocation, and a non-owner non-admin — revoked_at untouched", () => {
    const { row } = mustOk(generateApiKey(db, sealer, { userId: adminId, actorUserId: adminId }), "admin key");

    const unknown = revokeApiKey(db, { apiKeyId: 9999, actorUserId: adminId });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.apiKey).toEqual(["does not exist"]);

    const foreign = revokeApiKey(db, { apiKeyId: row.id, actorUserId: devId });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.errors.authorization).toEqual(["requires Mingle administrator access"]);
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, row.id)).get()!.revokedAt).toBeNull();

    mustOk(revokeApiKey(db, { apiKeyId: row.id, actorUserId: adminId }), "revoke");
    const firstStamp = db.select().from(apiKeys).where(eq(apiKeys.id, row.id)).get()!.revokedAt;
    const again = revokeApiKey(db, { apiKeyId: row.id, actorUserId: adminId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors.apiKey).toEqual(["has already been revoked"]);
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, row.id)).get()!.revokedAt).toEqual(firstStamp);
    expect(events("ApiKeyRevoked")).toHaveLength(1);
  });

  it("lets a site admin revoke another user's key", () => {
    const { key, row } = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "generate");
    mustOk(revokeApiKey(db, { apiKeyId: row.id, actorUserId: adminId }), "revoke by admin");
    expect(authenticateApiKey(db, key)).toBeNull();
  });
});

// ------------------------------------------------------ profile route

describe("/profile API-key intents (real route module)", () => {
  async function post(userId: number, fields: Record<string, string>) {
    const cookie = (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
    const request = new Request("http://localhost/profile", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    return (await profileRoute.action({ request, params: {}, context: {} } as never)) as Record<string, unknown>;
  }

  async function load(userId: number) {
    const cookie = (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
    const request = new Request("http://localhost/profile", { headers: { Cookie: cookie } });
    return (await profileRoute.loader({ request, params: {}, context: {} } as never)) as {
      apiKeys: { id: number; keyPrefix: string; lastUsedAt: string | null }[];
    };
  }

  it("generate-api-key persists a key for the logged-in user and returns the plaintext once", async () => {
    const data = await post(devId, { intent: "generate-api-key" });
    expect(data.saved).toBe("api-key");
    const key = data.generatedKey as string;
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    const [stored] = keyRows(devId);
    expect(stored.keyHash).toBe(sha256(key));
    expect(authenticateApiKey(db, key)?.id).toBe(devId);

    const shown = await load(devId);
    expect(shown.apiKeys.map((k) => k.keyPrefix)).toEqual([stored.keyPrefix]);
    expect(shown.apiKeys[0].lastUsedAt).not.toBeNull();
  });

  it("revoke-api-key revokes the named key; a key belonging to someone else is refused", async () => {
    const mine = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "mine");
    const theirs = mustOk(generateApiKey(db, sealer, { userId: adminId, actorUserId: adminId }), "theirs");

    const refused = await post(devId, { intent: "revoke-api-key", apiKeyId: String(theirs.row.id) });
    expect((refused.errors as Record<string, string[]>).authorization).toEqual(["requires Mingle administrator access"]);
    expect(authenticateApiKey(db, theirs.key)?.id).toBe(adminId);

    const done = await post(devId, { intent: "revoke-api-key", apiKeyId: String(mine.row.id) });
    expect(done.saved).toBe("api-key-revoked");
    expect(authenticateApiKey(db, mine.key)).toBeNull();
    expect((await load(devId)).apiKeys).toEqual([]);
  });
});
