/**
 * Behavioral tests for Phase 31's Identity additions that need no
 * external server: the sealer, ConfigureAuthentication and its views,
 * SignInExternalUser's matching/enrolment rules, the credential
 * strategy composition, and the /admin/authentication route.
 *
 * Derived from the rule 12 Behavior Statements: every DOES asserts on
 * rows reloaded from the database, every REJECTS WHEN proves nothing
 * mutated, and the secret invariant is asserted directly — no bind
 * password or client secret appears unsealed in any row, event, or
 * view.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-auth-config-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "auth-config-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { createUserSession } = await import("../app/auth/session.server");
const adminRoute = await import("../app/routes/admin.authentication");
const { authConfigurations, externalIdentities, users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser, authenticateUser } = await import("../app/domain/identity/commands.server");
const { createSealer, SEALED_PREFIX } = await import("../app/domain/identity/sealer.server");
const { authenticationView, configureAuthentication, DEFAULT_LDAP_SETTINGS, DEFAULT_OIDC_SETTINGS, loadAuthenticationConfiguration } =
  await import("../app/domain/identity/auth-configuration.server");
const { signInExternalUser } = await import("../app/domain/identity/external-login.server");
const { authenticateCredentials, passwordStrategy } = await import("../app/domain/identity/strategy.server");
const { verifyPassword } = await import("../app/domain/identity/password.server");

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

beforeEach(() => {
  for (const table of [domainEvents, externalIdentities, authConfigurations, users]) db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "auth-config-1!" }), "admin").id;
  devId = mustOk(registerUser(db, { login: "dev", name: "Dev", password: "auth-config-1!" }), "dev").id;
  db.delete(domainEvents).run();
});

const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
const rowFor = (kind: string) => db.select().from(authConfigurations).where(eq(authConfigurations.kind, kind)).get();

// --------------------------------------------------------------- sealer

describe("sealer", () => {
  it("round-trips a secret under the same key material and refuses another key or a tampered value", () => {
    const a = createSealer("key-a");
    const sealed = a.seal("hunter2");
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealed).not.toContain("hunter2");
    expect(a.seal("hunter2")).not.toBe(sealed); // fresh IV each time
    expect(a.open(sealed)).toBe("hunter2");
    expect(createSealer("key-a").open(sealed)).toBe("hunter2");
    expect(() => createSealer("key-b").open(sealed)).toThrow();
    expect(() => a.open(sealed.slice(0, -2) + "zz")).toThrow();
    expect(() => a.open("plain")).toThrow();
    expect(() => createSealer("")).toThrow();
  });
});

// ------------------------------------------------ ConfigureAuthentication

const ldapInput = (overrides: Partial<typeof DEFAULT_LDAP_SETTINGS> = {}) => ({
  ...DEFAULT_LDAP_SETTINGS,
  enabled: true,
  url: "ldap://127.0.0.1:1389",
  bindDn: "cn=svc,dc=example,dc=test",
  bindPassword: "svc-secret",
  baseDn: "ou=people,dc=example,dc=test",
  ...overrides,
});

const oidcInput = (overrides: Partial<typeof DEFAULT_OIDC_SETTINGS> = {}) => ({
  ...DEFAULT_OIDC_SETTINGS,
  enabled: true,
  issuer: "http://127.0.0.1:9999",
  clientId: "mingle",
  clientSecret: "client-secret",
  ...overrides,
});

describe("ConfigureAuthentication", () => {
  it("persists LDAP settings with the bind password sealed and records an event without the settings", () => {
    const result = configureAuthentication(db, sealer, { kind: "ldap", settings: ldapInput({ url: "  ldap://127.0.0.1:1389 " }), actorUserId: adminId });
    expect(result.ok).toBe(true);
    const row = rowFor("ldap")!;
    expect(row.enabled).toBe(true);
    expect(row.updatedByUserId).toBe(adminId);
    const stored = JSON.parse(row.settings) as Record<string, unknown>;
    expect(stored.url).toBe("ldap://127.0.0.1:1389");
    expect(stored.bindDn).toBe("cn=svc,dc=example,dc=test");
    expect(String(stored.bindPassword).startsWith(SEALED_PREFIX)).toBe(true);
    expect(row.settings).not.toContain("svc-secret");
    expect(stored.enabled).toBeUndefined();

    const [event] = events("AuthenticationConfigured");
    expect(JSON.parse(event.payload)).toEqual({ kind: "ldap", enabled: true });
    expect(event.actorUserId).toBe(adminId);

    const loaded = loadAuthenticationConfiguration(db, sealer);
    expect(loaded.ldap.bindPassword).toBe("svc-secret");
    expect(loaded.ldap.enabled).toBe(true);
    const view = authenticationView(db);
    expect(view.ldap.bindPasswordSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("svc-secret");
    expect("bindPassword" in view.ldap).toBe(false);
  });

  it("keeps the stored secret when a blank one is posted, and replaces it when a new one is", () => {
    mustOk(configureAuthentication(db, sealer, { kind: "oidc", settings: oidcInput(), actorUserId: adminId }), "first");
    mustOk(configureAuthentication(db, sealer, { kind: "oidc", settings: oidcInput({ clientSecret: "", displayName: "Corp SSO" }), actorUserId: adminId }), "second");
    let loaded = loadAuthenticationConfiguration(db, sealer);
    expect(loaded.oidc.clientSecret).toBe("client-secret");
    expect(loaded.oidc.displayName).toBe("Corp SSO");
    expect(db.select().from(authConfigurations).all()).toHaveLength(1);

    mustOk(configureAuthentication(db, sealer, { kind: "oidc", settings: oidcInput({ clientSecret: "rotated" }), actorUserId: adminId }), "third");
    loaded = loadAuthenticationConfiguration(db, sealer);
    expect(loaded.oidc.clientSecret).toBe("rotated");
    expect(events("AuthenticationConfigured")).toHaveLength(3);
  });

  it("rejects an enabled source with missing or malformed required fields — nothing written", () => {
    const ldap = configureAuthentication(db, sealer, { kind: "ldap", settings: ldapInput({ url: "http://nope", baseDn: "", groupDn: "cn=g" }), actorUserId: adminId });
    expect(ldap.ok).toBe(false);
    if (!ldap.ok) {
      expect(ldap.errors.url).toEqual(["must be an ldap:// or ldaps:// URL"]);
      expect(ldap.errors.baseDn).toEqual(["can't be blank"]);
      expect(ldap.errors.groupDn?.[0]).toContain("together");
    }
    const oidc = configureAuthentication(db, sealer, { kind: "oidc", settings: oidcInput({ clientSecret: "", scopes: "profile" }), actorUserId: adminId });
    expect(oidc.ok).toBe(false);
    if (!oidc.ok) {
      expect(oidc.errors.clientSecret).toEqual(["can't be blank"]);
      expect(oidc.errors.scopes).toEqual(["must include openid"]);
    }
    expect(db.select().from(authConfigurations).all()).toHaveLength(0);
    expect(events("AuthenticationConfigured")).toHaveLength(0);
  });

  it("lets a disabled source be saved half-filled, and refuses a non-admin", () => {
    mustOk(configureAuthentication(db, sealer, { kind: "ldap", settings: { ...DEFAULT_LDAP_SETTINGS, url: "ldap://x" }, actorUserId: adminId }), "draft");
    expect(rowFor("ldap")!.enabled).toBe(false);
    expect(loadAuthenticationConfiguration(db, sealer).ldap.url).toBe("ldap://x");

    const denied = configureAuthentication(db, sealer, { kind: "ldap", settings: ldapInput(), actorUserId: devId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.errors.authorization).toEqual(["requires Mingle administrator access"]);
    expect(rowFor("ldap")!.enabled).toBe(false);
  });

  it("reads a secret sealed under another install secret as blank rather than failing", () => {
    mustOk(configureAuthentication(db, sealer, { kind: "oidc", settings: oidcInput(), actorUserId: adminId }), "save");
    const other = loadAuthenticationConfiguration(db, createSealer("some-other-install"));
    expect(other.oidc.clientSecret).toBe("");
    expect(other.oidc.clientId).toBe("mingle");
  });
});

// ----------------------------------------------------- SignInExternalUser

describe("SignInExternalUser", () => {
  const claims = { kind: "oidc" as const, subject: "sub-123", login: "Alice", name: "Alice Example", email: "alice@example.test" };

  it("enrols an unknown subject: a user with no usable password, an identity row, UserEnrolled + UserLoggedIn", () => {
    const user = mustOk(signInExternalUser(db, { claims, autoEnroll: true }), "enrol");
    const row = db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(row).toMatchObject({ login: "alice", name: "Alice Example", email: "alice@example.test", admin: false, activated: true });
    expect(row.lastLoginAt).not.toBeNull();
    expect(verifyPassword("", row.passwordHash)).toBe(false);
    expect(verifyPassword("external:no-password", row.passwordHash)).toBe(false);
    expect(authenticateUser(db, { login: "alice", password: "anything-1!" }).ok).toBe(false);
    const identity = db.select().from(externalIdentities).where(eq(externalIdentities.userId, user.id)).get()!;
    expect(identity).toMatchObject({ kind: "oidc", subject: "sub-123" });
    expect(identity.lastLoginAt).not.toBeNull();
    expect(events("UserEnrolled").map((e) => JSON.parse(e.payload))).toEqual([{ login: "alice", name: "Alice Example", kind: "oidc" }]);
    expect(events("UserLoggedIn").map((e) => JSON.parse(e.payload))).toEqual([{ login: "alice", kind: "oidc" }]);
  });

  it("matches a returning subject even after the login changed, and links a known login on first sight", () => {
    const first = mustOk(signInExternalUser(db, { claims, autoEnroll: true }), "first");
    const again = mustOk(signInExternalUser(db, { claims: { ...claims, login: "alice.renamed" }, autoEnroll: false }), "again");
    expect(again.id).toBe(first.id);
    expect(db.select().from(users).all().map((u) => u.login).sort()).toEqual(["admin", "alice", "dev"]);

    const linked = mustOk(signInExternalUser(db, { claims: { kind: "ldap", subject: "dev", login: "DEV", name: "Dev From Ldap" }, autoEnroll: false }), "link");
    expect(linked.id).toBe(devId);
    expect(db.select().from(users).where(eq(users.id, devId)).get()!.name).toBe("Dev"); // existing profile untouched
    expect(db.select().from(externalIdentities).where(eq(externalIdentities.userId, devId)).get()).toMatchObject({ kind: "ldap", subject: "dev" });
    expect(events("ExternalIdentityLinked")).toHaveLength(1);
    expect(events("UserEnrolled")).toHaveLength(1);
  });

  it("refuses an unknown subject without auto-enrol, a deactivated account, and an invalid login — nothing written", () => {
    const refused = signInExternalUser(db, { claims, autoEnroll: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.login).toEqual(["Invalid login or password"]);

    db.update(users).set({ activated: false }).where(eq(users.id, devId)).run();
    const inactive = signInExternalUser(db, { claims: { kind: "ldap", subject: "dev", login: "dev" }, autoEnroll: true });
    expect(inactive.ok).toBe(false);

    const badLogin = signInExternalUser(db, { claims: { ...claims, subject: "s2", login: "no spaces allowed" }, autoEnroll: true });
    expect(badLogin.ok).toBe(false);

    expect(db.select().from(users).all()).toHaveLength(2);
    expect(db.select().from(externalIdentities).all()).toHaveLength(0);
    expect(events("UserLoggedIn")).toHaveLength(0);
  });

  it("enrols without the email when another account already holds it", () => {
    db.update(users).set({ email: "alice@example.test" }).where(eq(users.id, devId)).run();
    const user = mustOk(signInExternalUser(db, { claims, autoEnroll: true }), "enrol");
    expect(db.select().from(users).where(eq(users.id, user.id)).get()!.email).toBeNull();
  });
});

// ------------------------------------------------------------ strategies

describe("credential strategies", () => {
  it("the password strategy in adminsOnly mode answers only for site admins; composition takes the first success", async () => {
    const adminsOnly = passwordStrategy(db, { adminsOnly: true });
    expect((await adminsOnly.authenticate({ login: "dev", password: "auth-config-1!" })).ok).toBe(false);
    expect((await adminsOnly.authenticate({ login: "admin", password: "auth-config-1!" })).ok).toBe(true);

    const refusing = { kind: "ldap" as const, authenticate: async () => ({ ok: false as const, errors: { login: ["primary said no"] } }) };
    const composed = await authenticateCredentials([refusing, passwordStrategy(db, { adminsOnly: false })], { login: "dev", password: "auth-config-1!" });
    expect(composed.ok).toBe(true);
    const allRefused = await authenticateCredentials([refusing, adminsOnly], { login: "dev", password: "auth-config-1!" });
    expect(allRefused.ok).toBe(false);
    if (!allRefused.ok) expect(allRefused.errors.login).toEqual(["primary said no"]); // the primary's answer is shown
    expect((await authenticateCredentials([], { login: "dev", password: "x" })).ok).toBe(false);
  });
});

// ---------------------------------------------------- admin route

describe("/admin/authentication (real route module)", () => {
  async function post(userId: number, fields: Record<string, string>) {
    const cookie = (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
    const request = new Request("http://localhost/admin/authentication", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    try {
      return { status: 200, data: (await adminRoute.action({ request, params: {}, context: {} } as never)) as Record<string, unknown> };
    } catch (thrown) {
      if (thrown instanceof Response) return { status: thrown.status, data: null };
      throw thrown;
    }
  }

  it("saves OIDC settings for a site admin and refuses everyone else with 403", async () => {
    const saved = await post(adminId, { intent: "oidc", enabled: "on", displayName: "Corp", issuer: "http://127.0.0.1:9999", clientId: "mingle", clientSecret: "s3", scopes: "openid email", autoEnroll: "on" });
    expect(saved.data?.saved).toBe("oidc");
    const loaded = loadAuthenticationConfiguration(db, sealer);
    expect(loaded.oidc).toMatchObject({ enabled: true, displayName: "Corp", clientSecret: "s3", scopes: "openid email", autoEnroll: true });

    const refused = await post(devId, { intent: "oidc", enabled: "on", issuer: "http://x", clientId: "c", clientSecret: "s", displayName: "d", scopes: "openid" });
    expect(refused.status).toBe(403);
    expect(loadAuthenticationConfiguration(db, sealer).oidc.displayName).toBe("Corp");

    const cookie = (await createUserSession(devId, "/")).headers.get("Set-Cookie")!;
    await expect(adminRoute.loader({ request: new Request("http://localhost/admin/authentication", { headers: { Cookie: cookie } }), params: {}, context: {} } as never))
      .rejects.toMatchObject({ status: 403 });
  });

  it("returns the command's field errors for an invalid enabled LDAP form", async () => {
    const outcome = await post(adminId, { intent: "ldap", enabled: "on", url: "ldap://h", loginAttribute: "uid", objectClass: "person" });
    expect((outcome.data?.errors as Record<string, string[]>).baseDn).toEqual(["can't be blank"]);
    expect(rowFor("ldap")).toBeUndefined();
  });
});
