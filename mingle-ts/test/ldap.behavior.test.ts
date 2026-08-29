/**
 * Real-path tests for LDAP sign-in (Phase 31): the domain strategy
 * (`authenticateViaLdap`) and the sign-in form route, driven through
 * the app's own `ldapts` directory adapter against a real LDAP server
 * (`ldapjs`) listening on a TCP port in this process.
 *
 * The directory is EXTERNAL under rule 13a (a customer's directory is
 * not something this repo ships); the ldapjs server stands in for it
 * the way a local HTTP receiver stands in for Slack. Nothing on the
 * app side is stubbed: real binds, real searches, real wire protocol.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import ldap from "ldapjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-ldap-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "ldap-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { openLdapDirectory } = await import("../app/auth/ldap-directory.server");
const loginRoute = await import("../app/routes/login");
const { authConfigurations, externalIdentities, users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { configureAuthentication, DEFAULT_LDAP_SETTINGS } = await import("../app/domain/identity/auth-configuration.server");
const { authenticateViaLdap } = await import("../app/domain/identity/ldap-strategy.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

// ------------------------------------------------------- the directory

const SUFFIX = "dc=example,dc=test";
const SERVICE_DN = `cn=svc,${SUFFIX}`;
const SERVICE_PASSWORD = "svc-secret";
interface Person {
  dn: string;
  password: string;
  attributes: Record<string, string[]>;
}
const people: Person[] = [
  {
    dn: `uid=alice,ou=people,${SUFFIX}`,
    password: "alice-pw!1",
    attributes: { objectclass: ["person"], uid: ["alice"], cn: ["Alice Example"], mail: ["alice@example.test"] },
  },
  {
    dn: `uid=bob,ou=people,${SUFFIX}`,
    password: "bob-pw!1",
    attributes: { objectclass: ["person"], uid: ["bob"], cn: ["Bob Outsider"], mail: ["bob@example.test"] },
  },
];
const group = {
  dn: `cn=mingle,ou=groups,${SUFFIX}`,
  attributes: { objectclass: ["groupOfNames"], cn: ["mingle"], member: [`uid=alice,ou=people,${SUFFIX}`] },
};

const normalize = (dn: string) => dn.replace(/\s*,\s*/g, ",").toLowerCase();
/** The parts of ldapjs's search request/response the fake directory uses (its typings leave handlers untyped). */
interface SearchReq {
  filter: { matches(attributes: Record<string, string[]>): boolean };
}
interface SearchRes {
  send(entry: { dn: string; attributes: Record<string, string[]> }): void;
  end(): void;
}
type Next = (error?: unknown) => void;
interface BindReq {
  dn: { toString(): string };
  credentials: string;
}
const server = ldap.createServer();
server.bind(SUFFIX, (req: BindReq, res: { end(): void }, next: Next) => {
  const dn = normalize(req.dn.toString());
  const password = String(req.credentials);
  const person = people.find((p) => normalize(p.dn) === dn);
  if ((dn === normalize(SERVICE_DN) && password === SERVICE_PASSWORD) || (person && person.password === password)) {
    res.end();
    return next();
  }
  return next(new ldap.InvalidCredentialsError());
});
server.search(`ou=people,${SUFFIX}`, (req: SearchReq, res: SearchRes, next: Next) => {
  for (const person of people)
    if (req.filter.matches(person.attributes)) res.send({ dn: person.dn, attributes: person.attributes });
  res.end();
  return next();
});
server.search(`ou=groups,${SUFFIX}`, (req: SearchReq, res: SearchRes, next: Next) => {
  if (req.filter.matches(group.attributes)) res.send(group);
  res.end();
  return next();
});

let ldapUrl = "";
let closedPortUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  ldapUrl = `ldap://127.0.0.1:${port}`;
  closedPortUrl = `ldap://127.0.0.1:${await freePort()}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ fixtures

let adminId: number;
let devId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

const settings = (overrides: Partial<typeof DEFAULT_LDAP_SETTINGS> = {}) => ({
  ...DEFAULT_LDAP_SETTINGS,
  enabled: true,
  url: ldapUrl,
  bindDn: SERVICE_DN,
  bindPassword: SERVICE_PASSWORD,
  baseDn: `ou=people,${SUFFIX}`,
  loginAttribute: "uid",
  objectClass: "person",
  nameAttribute: "cn",
  mailAttribute: "mail",
  ...overrides,
});

beforeEach(() => {
  for (const table of [domainEvents, externalIdentities, authConfigurations, users]) db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "ldap-suite-1!" }), "admin").id;
  devId = mustOk(registerUser(db, { login: "dev", name: "Dev", password: "ldap-suite-1!" }), "dev").id;
  db.delete(domainEvents).run();
});

const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
const userByLogin = (login: string) => db.select().from(users).where(eq(users.login, login)).get();

async function viaLdap(config: ReturnType<typeof settings>, login: string, password: string) {
  return authenticateViaLdap(db, config, await openLdapDirectory(config), { login, password });
}

// ------------------------------------------------------------ strategy

describe("authenticateViaLdap against a real directory", () => {
  it("binds, searches, binds as the user, and enrols the account with the mapped name and mail", async () => {
    const user = mustOk(await viaLdap(settings(), "alice", "alice-pw!1"), "alice");
    const row = userByLogin("alice")!;
    expect(row.id).toBe(user.id);
    expect(row).toMatchObject({ name: "Alice Example", email: "alice@example.test", admin: false });
    expect(row.lastLoginAt).not.toBeNull();
    expect(db.select().from(externalIdentities).where(eq(externalIdentities.userId, row.id)).get()).toMatchObject({ kind: "ldap", subject: "alice" });
    expect(events("UserEnrolled")).toHaveLength(1);
    expect(events("UserLoggedIn").map((e) => JSON.parse(e.payload))).toEqual([{ login: "alice", kind: "ldap" }]);

    // A second sign-in finds the same account.
    const again = mustOk(await viaLdap(settings(), "alice", "alice-pw!1"), "again");
    expect(again.id).toBe(row.id);
    expect(db.select().from(users).all()).toHaveLength(3);
  });

  it("refuses a wrong password, an unknown login, a blank password, and a filter-injection attempt — no account created", async () => {
    for (const [login, password] of [
      ["alice", "wrong"],
      ["carol", "carol-pw"],
      ["alice", "   "],
      ["alice)(uid=*", "alice-pw!1"],
      ["*", "alice-pw!1"],
    ]) {
      const result = await viaLdap(settings(), login, password);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.login).toEqual(["Invalid login or password"]);
    }
    expect(db.select().from(users).all()).toHaveLength(2);
    expect(events("UserLoggedIn")).toHaveLength(0);
  });

  it("enforces the required group, refuses when the service bind fails, and reports an unreachable directory", async () => {
    const grouped = settings({ groupDn: `ou=groups,${SUFFIX}`, groupObjectClass: "groupOfNames", groupAttribute: "member" });
    expect((await viaLdap(grouped, "alice", "alice-pw!1")).ok).toBe(true);
    const bob = await viaLdap(grouped, "bob", "bob-pw!1");
    expect(bob.ok).toBe(false);
    expect(userByLogin("bob")).toBeUndefined();

    const badService = await viaLdap(settings({ bindPassword: "nope" }), "alice", "alice-pw!1");
    expect(badService.ok).toBe(false);

    const unreachable = await viaLdap(settings({ url: closedPortUrl }), "alice", "alice-pw!1");
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) expect(unreachable.errors.login).toEqual(["The directory server could not be reached"]);
  });

  it("without auto-enrol, signs in only logins that already exist in Mingle (linking them)", async () => {
    const stranger = await viaLdap(settings({ autoEnroll: false }), "alice", "alice-pw!1");
    expect(stranger.ok).toBe(false);
    expect(userByLogin("alice")).toBeUndefined();

    people.push({ dn: `uid=dev,ou=people,${SUFFIX}`, password: "dev-ldap-pw", attributes: { objectclass: ["person"], uid: ["dev"], cn: ["Dev Person"], mail: [] } });
    try {
      const known = mustOk(await viaLdap(settings({ autoEnroll: false }), "dev", "dev-ldap-pw"), "dev");
      expect(known.id).toBe(devId);
      expect(events("ExternalIdentityLinked")).toHaveLength(1);
    } finally {
      people.pop();
    }
  });
});

// --------------------------------------------------------- login route

describe("/login with LDAP enabled (real route module)", () => {
  async function post(login: string, password: string) {
    const request = new Request("http://localhost/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login, password }),
    });
    return loginRoute.action({ request, params: {}, context: {} } as never) as Promise<Response | { errors: Record<string, string[]> }>;
  }

  it("signs a directory user in with a session cookie, keeps a site admin's Mingle password valid, and refuses a local non-admin's", async () => {
    mustOk(configureAuthentication(db, sealer, { kind: "ldap", settings: settings(), actorUserId: adminId }), "configure");

    const alice = (await post("alice", "alice-pw!1")) as Response;
    expect(alice.status).toBe(302);
    expect(alice.headers.get("Location")).toBe("/profile");
    expect(alice.headers.get("Set-Cookie")).toContain("mingle_session=");
    expect(userByLogin("alice")).toBeDefined();

    const admin = (await post("admin", "ldap-suite-1!")) as Response;
    expect(admin.status).toBe(302);

    const dev = (await post("dev", "ldap-suite-1!")) as { errors: Record<string, string[]> };
    expect(dev.errors.login).toEqual(["Invalid login or password"]);
    expect(events("UserLoggedIn").map((e) => JSON.parse(e.payload).login)).toEqual(["alice", "admin"]);
  });

  it("with LDAP disabled the Mingle password works for everyone", async () => {
    mustOk(configureAuthentication(db, sealer, { kind: "ldap", settings: settings({ enabled: false }), actorUserId: adminId }), "configure");
    const dev = (await post("dev", "ldap-suite-1!")) as Response;
    expect(dev.status).toBe(302);
  });
});
