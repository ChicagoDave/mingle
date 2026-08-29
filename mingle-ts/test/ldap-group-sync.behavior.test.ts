/**
 * Behavioral tests for LDAP group → Mingle group sync (P-6, Phase 10).
 *
 * Derived from app/domain/identity/ldap-group-sync.server.ts
 * (ReconcileLdapGroups: holding a mapped LDAP group adds the user to
 * the project team and the Mingle group, leaving it removes them from
 * the Mingle group only; idempotent; one LdapGroupsReconciled event
 * per change; unknown project or group skipped) and the strategy's
 * hook (reconciled on every LDAP sign-in). The directory is a real
 * `ldapjs` server in this process whose group membership is changed
 * between sign-ins, driven through the app's own `ldapts` adapter —
 * the plan's scenario: a user gaining and losing a Mingle group across
 * two logins.
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
import { and, eq } from "drizzle-orm";
import ldap from "ldapjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-ldap-groups-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "ldap-groups-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { openLdapDirectory } = await import("../app/auth/ldap-directory.server");
const { authConfigurations, externalIdentities, users } = await import("../app/db/schema/identity");
const { groupMemberships, groups, teamMemberships } = await import("../app/db/schema/membership");
const { projects } = await import("../app/db/schema/projects");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { createGroup } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { configureAuthentication, DEFAULT_LDAP_SETTINGS, loadAuthenticationConfiguration } = await import(
  "../app/domain/identity/auth-configuration.server"
);
const { authenticateViaLdap } = await import("../app/domain/identity/ldap-strategy.server");
const { parseLdapGroupMappings } = await import("../app/domain/identity/ldap-group-sync.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

// ------------------------------------------------------- the directory

const SUFFIX = "dc=example,dc=test";
const ALICE_DN = `uid=alice,ou=people,${SUFFIX}`;
const DEVS_DN = `cn=devs,ou=groups,${SUFFIX}`;
const OPS_DN = `cn=ops,ou=groups,${SUFFIX}`;
const normalize = (dn: string) => dn.replace(/\s*,\s*/g, ",").toLowerCase();

const alice = { objectclass: ["person"], uid: ["alice"], cn: ["Alice Example"], mail: ["alice@example.test"] };
/** Mutable between sign-ins: which people each directory group names. */
const directoryGroups: Record<string, string[]> = { [DEVS_DN]: [ALICE_DN], [OPS_DN]: [] };

interface SearchReq {
  dn: { toString(): string };
  filter: { matches(attributes: Record<string, string[]>): boolean };
}
interface SearchRes {
  send(entry: { dn: string; attributes: Record<string, string[]> }): void;
  end(): void;
}
type Next = (error?: unknown) => void;

const server = ldap.createServer();
server.bind(SUFFIX, (req: { dn: { toString(): string }; credentials: string }, res: { end(): void }, next: Next) => {
  if (normalize(req.dn.toString()) === normalize(ALICE_DN) && String(req.credentials) === "alice-pw!1") {
    res.end();
    return next();
  }
  return next(new ldap.InvalidCredentialsError());
});
server.search(`ou=people,${SUFFIX}`, (req: SearchReq, res: SearchRes, next: Next) => {
  if (req.filter.matches(alice)) res.send({ dn: ALICE_DN, attributes: alice });
  res.end();
  return next();
});
server.search(`ou=groups,${SUFFIX}`, (req: SearchReq, res: SearchRes, next: Next) => {
  const base = normalize(req.dn.toString());
  for (const [dn, members] of Object.entries(directoryGroups)) {
    if (normalize(dn) !== base && !base.endsWith(",ou=groups,dc=example,dc=test") && base !== normalize(`ou=groups,${SUFFIX}`)) continue;
    if (base !== normalize(`ou=groups,${SUFFIX}`) && normalize(dn) !== base) continue;
    const attributes = { objectclass: ["groupOfNames"], cn: [dn.split(",")[0].slice(3)], member: members };
    if (req.filter.matches(attributes)) res.send({ dn, attributes });
  }
  res.end();
  return next();
});

let ldapUrl = "";

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
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", () => done()));
  ldapUrl = `ldap://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number;
let projectId: number;
let developersId: number;

beforeEach(() => {
  for (const table of [domainEvents, groupMemberships, groups, teamMemberships, projects, externalIdentities, authConfigurations, users])
    db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "ldap-groups-1!" }), "admin").id;
  projectId = mustOk(createProject(db, { name: "Proj", identifier: "proj", actorUserId: adminId }), "project").id;
  developersId = mustOk(createGroup(db, { projectId, name: "Developers", actorUserId: adminId }), "Developers").id;
  mustOk(createGroup(db, { projectId, name: "Operators", actorUserId: adminId }), "Operators");
  directoryGroups[DEVS_DN] = [ALICE_DN];
  directoryGroups[OPS_DN] = [];
  db.delete(domainEvents).run();
});

const settings = (groupMappings: string) => ({
  ...DEFAULT_LDAP_SETTINGS,
  enabled: true,
  url: ldapUrl,
  baseDn: `ou=people,${SUFFIX}`,
  loginAttribute: "uid",
  objectClass: "person",
  nameAttribute: "cn",
  mailAttribute: "mail",
  autoEnroll: true,
  groupMappings,
});

async function signInAlice(groupMappings: string) {
  const config = settings(groupMappings);
  return authenticateViaLdap(db, config, await openLdapDirectory(config), { login: "alice", password: "alice-pw!1" });
}

const aliceId = () => db.select({ id: users.id }).from(users).where(eq(users.login, "alice")).get()!.id;
const onTeam = (userId: number) => db.select().from(teamMemberships).where(and(eq(teamMemberships.projectId, projectId), eq(teamMemberships.userId, userId))).get();
const inGroup = (userId: number, groupId: number) => db.select().from(groupMemberships).where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId))).get();
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

describe("LDAP group sync on sign-in", () => {
  const MAPPINGS = `${DEVS_DN} => proj/Developers\n${OPS_DN} => proj/Operators`;

  it("adds the user to the project team and the mapped Mingle group on first sign-in, and changes nothing on a repeat", async () => {
    const first = await signInAlice(MAPPINGS);
    expect(first.ok).toBe(true);
    const id = aliceId();
    expect(onTeam(id)?.role).toBe("full_member");
    expect(inGroup(id, developersId)).toBeDefined();
    const operatorsId = db.select({ id: groups.id }).from(groups).where(and(eq(groups.projectId, projectId), eq(groups.name, "Operators"))).get()!.id;
    expect(inGroup(id, operatorsId)).toBeUndefined();
    const [reconciled] = events("LdapGroupsReconciled");
    expect(JSON.parse(String(reconciled.payload))).toEqual({ addedToTeams: [projectId], addedToGroups: [developersId], removedFromGroups: [] });

    const again = await signInAlice(MAPPINGS);
    expect(again.ok).toBe(true);
    expect(events("LdapGroupsReconciled")).toHaveLength(1);
    expect(db.select().from(groupMemberships).where(eq(groupMemberships.userId, id)).all()).toHaveLength(1);
  });

  it("removes the user from the Mingle group — never from the team — once the directory group no longer holds them", async () => {
    mustOk(await signInAlice(MAPPINGS), "first sign-in");
    const id = aliceId();
    expect(inGroup(id, developersId)).toBeDefined();

    directoryGroups[DEVS_DN] = [];
    directoryGroups[OPS_DN] = [ALICE_DN];
    mustOk(await signInAlice(MAPPINGS), "second sign-in");
    expect(inGroup(id, developersId)).toBeUndefined();
    const operatorsId = db.select({ id: groups.id }).from(groups).where(and(eq(groups.projectId, projectId), eq(groups.name, "Operators"))).get()!.id;
    expect(inGroup(id, operatorsId)).toBeDefined();
    expect(onTeam(id)).toBeDefined();
    const payloads = events("LdapGroupsReconciled").map((e) => JSON.parse(String(e.payload)));
    expect(payloads[1]).toEqual({ addedToTeams: [], addedToGroups: [operatorsId], removedFromGroups: [developersId] });
    expect(events("TeamMemberRemoved")).toEqual([]);
  });

  it("skips mappings naming an unknown project or group without failing the sign-in, and refuses malformed mapping lines at configuration time", async () => {
    const result = await signInAlice(`${DEVS_DN} => nope/Developers\n${DEVS_DN} => proj/Ghosts\n# a comment\n\n${DEVS_DN} => proj/developers`);
    expect(result.ok).toBe(true);
    const id = aliceId();
    expect(inGroup(id, developersId)).toBeDefined(); // case-insensitive group name
    expect(db.select().from(groups).where(eq(groups.name, "Ghosts")).all()).toEqual([]);
    expect(db.select().from(projects).where(eq(projects.identifier, "nope")).all()).toEqual([]);

    expect(parseLdapGroupMappings("cn=x => proj/Developers\nbroken line\n").errors).toEqual(['line 2 must read "<group DN> => <project identifier>/<group name>"']);
    const configured = configureAuthentication(db, sealer, { kind: "ldap", settings: settings("broken line"), actorUserId: adminId });
    expect(configured.ok).toBe(false);
    if (!configured.ok) expect(configured.errors.groupMappings).toEqual(['line 1 must read "<group DN> => <project identifier>/<group name>"']);
    // StartTLS is an upgrade of a plain connection; asking for it on ldaps:// is refused.
    const tlsOnLdaps = configureAuthentication(db, sealer, { kind: "ldap", settings: { ...settings(MAPPINGS), url: "ldaps://127.0.0.1:636", startTls: true }, actorUserId: adminId });
    expect(tlsOnLdaps.ok).toBe(false);
    if (!tlsOnLdaps.ok) expect(tlsOnLdaps.errors.startTls).toEqual(["applies to ldap:// URLs; an ldaps:// URL is already TLS"]);
    // A valid configuration stores the mappings and reads back for the strategy.
    mustOk(configureAuthentication(db, sealer, { kind: "ldap", settings: settings(MAPPINGS), actorUserId: adminId }), "configure");
    expect(loadAuthenticationConfiguration(db, sealer).ldap.groupMappings).toBe(MAPPINGS);
  });
});
