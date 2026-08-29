/**
 * Behavioral tests for HMAC-signed API requests (Phase 31): the
 * signing helpers, `verifySignedRequest`, and the /api/v1 adapter
 * accepting a correctly signed request and refusing every incorrect
 * one — the phase's exit criterion for the API side.
 *
 * Every accepted request is proven by the state it changes (a project
 * row created, a key's last_used_at stamped); every refusal by 401 and
 * unchanged state. The signing-secret invariant is asserted directly:
 * only its sealed form is stored.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Public API / Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, ApiProject } from "../app/shared/wire-types";

const dir = mkdtempSync(join(tmpdir(), "mingle-api-hmac-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "api-hmac-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const projectsRoute = await import("../app/routes/api.v1.projects");
const { apiKeys, users } = await import("../app/db/schema/identity");
const { projects } = await import("../app/db/schema/projects");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { generateApiKey, revokeApiKey, verifySignedRequest } = await import("../app/domain/identity/api-keys.server");
const { bodySha256, canonicalRequest, DATE_HEADER, HMAC_SCHEME, signCanonical, signRequest, signaturesMatch } = await import(
  "../app/domain/identity/api-signing.server"
);
const { SEALED_PREFIX } = await import("../app/domain/identity/sealer.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let adminSecret: string;
let adminKeyId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  for (const table of [domainEvents, projects, apiKeys, users]) db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "Admin", name: "Admin", password: "api-hmac-1!" }), "admin").id;
  const minted = mustOk(generateApiKey(db, sealer, { userId: adminId, actorUserId: adminId }), "key");
  adminSecret = minted.signingSecret;
  adminKeyId = minted.row.id;
});

/** Runs the projects route with the given headers and body. */
async function call<T>(method: string, headers: Record<string, string>, body?: string) {
  const request = new Request("http://localhost/api/v1/projects", { method, headers, body });
  const fn = method === "GET" ? projectsRoute.loader : projectsRoute.action;
  let response: Response;
  try {
    response = (await fn({ request, params: {}, context: {} } as never)) as Response;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as T };
}

const lastUsed = () => db.select().from(apiKeys).where(eq(apiKeys.id, adminKeyId)).get()!.lastUsedAt;

describe("signing helpers", () => {
  it("build a deterministic canonical string and a verifiable signature", () => {
    const canonical = canonicalRequest({ method: "post", pathWithQuery: "/api/v1/projects?x=1", date: "2026-08-28T12:00:00.000Z", bodySha256: bodySha256("{}") });
    expect(canonical).toBe(`POST\n/api/v1/projects?x=1\n2026-08-28T12:00:00.000Z\n${bodySha256("{}")}`);
    const signature = signCanonical("s", canonical);
    expect(signaturesMatch(signature, signature)).toBe(true);
    expect(signaturesMatch(signature, signCanonical("t", canonical))).toBe(false);
    expect(signaturesMatch(signature, "")).toBe(false);
    const headers = signRequest({ login: "admin", secret: "s", method: "POST", url: "http://h/api/v1/projects?x=1", body: "{}", date: new Date("2026-08-28T12:00:00.000Z") });
    expect(headers.Authorization).toBe(`${HMAC_SCHEME} admin:${signature}`);
    expect(headers[DATE_HEADER]).toBe("2026-08-28T12:00:00.000Z");
  });

  it("GenerateApiKey stores the signing secret only sealed", () => {
    const row = db.select().from(apiKeys).where(eq(apiKeys.id, adminKeyId)).get()!;
    expect(row.signingSecretSealed!.startsWith(SEALED_PREFIX)).toBe(true);
    expect(row.signingSecretSealed).not.toContain(adminSecret);
    expect(sealer.open(row.signingSecretSealed!)).toBe(adminSecret);
    expect(JSON.stringify(db.select().from(domainEvents).all())).not.toContain(adminSecret);
  });
});

describe("verifySignedRequest", () => {
  const signed = (secret: string, date = new Date()) => {
    const dateText = date.toISOString();
    const canonical = canonicalRequest({ method: "GET", pathWithQuery: "/api/v1/projects", date: dateText, bodySha256: bodySha256("") });
    return { login: "admin", canonical, signature: signCanonical(secret, canonical), date: dateText };
  };

  it("resolves a correct signature to the user (login matched case-insensitively) and stamps last_used_at", () => {
    expect(verifySignedRequest(db, sealer, { ...signed(adminSecret), login: "ADMIN" })?.id).toBe(adminId);
    expect(lastUsed()).not.toBeNull();
  });

  it("refuses a wrong secret, a stale or unparseable date, an unknown login, a revoked key, a key without a secret, and a deactivated user", () => {
    expect(verifySignedRequest(db, sealer, signed("wrong-secret"))).toBeNull();
    expect(verifySignedRequest(db, sealer, signed(adminSecret, new Date(Date.now() - 16 * 60 * 1000)))).toBeNull();
    expect(verifySignedRequest(db, sealer, { ...signed(adminSecret), date: "yesterday" })).toBeNull();
    expect(verifySignedRequest(db, sealer, { ...signed(adminSecret), login: "nobody" })).toBeNull();
    expect(lastUsed()).toBeNull();

    const legacy = db.insert(apiKeys).values({ userId: adminId, keyHash: "x".repeat(64), keyPrefix: "mgl_legacy00" }).returning().get();
    mustOk(revokeApiKey(db, { apiKeyId: adminKeyId, actorUserId: adminId }), "revoke");
    expect(verifySignedRequest(db, sealer, signed(adminSecret))).toBeNull();
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, legacy.id)).get()!.lastUsedAt).toBeNull();

    const fresh = mustOk(generateApiKey(db, sealer, { userId: adminId, actorUserId: adminId }), "fresh");
    db.update(users).set({ activated: false }).where(eq(users.id, adminId)).run();
    expect(verifySignedRequest(db, sealer, signed(fresh.signingSecret))).toBeNull();
  });
});

describe("/api/v1 with Mingle-HMAC-SHA256", () => {
  it("accepts a signed POST and persists what it asked for; the signature covers the body", async () => {
    const body = JSON.stringify({ name: "Signed Project", identifier: "signed" });
    const headers = { ...signRequest({ login: "admin", secret: adminSecret, method: "POST", url: "http://localhost/api/v1/projects", body }), "Content-Type": "application/json" };
    const created = await call<ApiProject>("POST", headers, body);
    expect(created.status).toBe(201);
    expect(db.select().from(projects).where(eq(projects.identifier, "signed")).get()!.createdByUserId).toBe(adminId);
    expect(lastUsed()).not.toBeNull();

    const tampered = await call<ApiErrorBody>("POST", headers, JSON.stringify({ name: "Other", identifier: "other" }));
    expect(tampered.status).toBe(401);
    expect(tampered.body.error).toBe("Invalid request signature");
    expect(tampered.headers.get("WWW-Authenticate")).toContain(HMAC_SCHEME);
    expect(db.select().from(projects).all()).toHaveLength(1);
  });

  it("accepts a signed GET and refuses a wrong secret, a stale date, a missing date, and a signature for another path", async () => {
    const url = "http://localhost/api/v1/projects";
    const ok = await call<ApiProject[]>("GET", signRequest({ login: "admin", secret: adminSecret, method: "GET", url }));
    expect(ok.status).toBe(200);

    const wrongSecret = await call<ApiErrorBody>("GET", signRequest({ login: "admin", secret: "nope", method: "GET", url }));
    expect(wrongSecret.status).toBe(401);

    const stale = await call<ApiErrorBody>("GET", signRequest({ login: "admin", secret: adminSecret, method: "GET", url, date: new Date(Date.now() - 20 * 60 * 1000) }));
    expect(stale.status).toBe(401);

    const { [DATE_HEADER]: _dropped, ...withoutDate } = signRequest({ login: "admin", secret: adminSecret, method: "GET", url });
    const missingDate = await call<ApiErrorBody>("GET", withoutDate);
    expect(missingDate.status).toBe(401);
    expect(missingDate.body.error).toContain(DATE_HEADER);

    const otherPath = await call<ApiErrorBody>("GET", signRequest({ login: "admin", secret: adminSecret, method: "GET", url: "http://localhost/api/v1/projects/other" }));
    expect(otherPath.status).toBe(401);

    const unknownScheme = await call<ApiErrorBody>("GET", { Authorization: "Digest abc" });
    expect(unknownScheme.status).toBe(401);
    expect(unknownScheme.body.error).toBe("Unsupported Authorization scheme");
  });
});
