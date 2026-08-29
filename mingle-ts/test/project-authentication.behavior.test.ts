/**
 * Behavioral tests for per-project authentication constraints (P-5,
 * Phase 7 — ADR-0021).
 *
 * Derived from app/domain/identity/access-constraint.server.ts (the
 * predicate), authorization.server.ts (trump → constraint → role rank),
 * app/domain/projects/commands.server.ts
 * (SetProjectAuthenticationConstraint: settings write, no membership
 * change), app/root.tsx (the read-side gate in root middleware),
 * app/api/auth.server.ts (API principals judged by linked identities)
 * and app/auth/session.server.ts (sessions record their strategy
 * kind). Each scenario the plan names has a test: a refused session, a
 * refused API key, the same user passing after an SSO sign-in, the
 * site-admin bypass, no membership event on set, and fall-through when
 * no constraint is set — plus a session with no recorded kind, which
 * satisfies no constraint.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-project-auth-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "project-auth-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { createUserSession, getSessionPrincipal } = await import("../app/auth/session.server");
const root = await import("../app/root");
const cardsRoute = await import("../app/routes/projects.cards");
const apiCardsRoute = await import("../app/routes/api.v1.projects.cards");
const settingsRoute = await import("../app/routes/projects.settings");
const teamRoute = await import("../app/routes/projects.team");
const { projects } = await import("../app/db/schema/projects");
const { users, externalIdentities, apiKeys } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { generateApiKey } = await import("../app/domain/identity/api-keys.server");
const { signInExternalUser } = await import("../app/domain/identity/external-login.server");
const { createProject, setProjectAuthenticationConstraint } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { authorizeProjectAction, privilegeLevelFor, PrivilegeLevel } = await import("../app/domain/identity/authorization.server");
const { runWithPrincipal } = await import("../app/domain/identity/principal.server");
const { accessRefusal, identitySatisfiesConstraint } = await import("../app/domain/identity/access-constraint.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number;
let devId: number;
let projectId: number;
const identifier = "gated";

beforeEach(() => {
  for (const table of [jobs, domainEvents, cardVersions, cards, cardTypes, teamMemberships, projects, externalIdentities, apiKeys, users])
    db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "project-auth-1!" }), "admin").id;
  devId = mustOk(registerUser(db, { login: "dev", name: "Dev", password: "project-auth-1!" }), "dev").id;
  projectId = mustOk(createProject(db, { name: "Gated", identifier, actorUserId: adminId }), "project").id;
  mustOk(addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }), "dev membership");
  db.delete(domainEvents).run();
});

const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
const storedConstraint = () => db.select({ permitted: projects.permittedStrategyKinds }).from(projects).where(eq(projects.id, projectId)).get()!.permitted;
const membershipRows = () => db.select().from(teamMemberships).where(eq(teamMemberships.projectId, projectId)).all();
const constrainTo = (kinds: string[]) => mustOk(setProjectAuthenticationConstraint(db, { projectId, permittedStrategyKinds: kinds, actorUserId: adminId }), "constrain");

async function cookieFor(userId: number, kind: "password" | "ldap" | "oidc" | null): Promise<string> {
  return (await createUserSession(userId, "/", kind)).headers.get("Set-Cookie")!.split(";")[0];
}

/** Drives the root middleware for a path with a cookie; resolves to what `next` produced, or the thrown Response. */
async function throughMiddleware(path: string, cookie: string | null): Promise<Response> {
  const request = new Request(`http://localhost${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  let reached = false;
  try {
    const response = await root.middleware[0]({ request, params: {}, context: {} } as never, async () => {
      reached = true;
      return new Response("page", { status: 200 });
    });
    return response as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  } finally {
    if (reached) expect(reached).toBe(true);
  }
}

describe("SetProjectAuthenticationConstraint", () => {
  it("records the permitted kinds on the project and emits its event — no membership command runs, no membership event fires", () => {
    const before = membershipRows();
    const result = setProjectAuthenticationConstraint(db, { projectId, permittedStrategyKinds: ["oidc", "password", "oidc"], actorUserId: adminId });
    expect(result.ok).toBe(true);
    expect(JSON.parse(storedConstraint())).toEqual(["password", "oidc"]);
    expect(events("ProjectAuthenticationConstraintSet")).toHaveLength(1);
    expect(events("TeamMemberRemoved")).toEqual([]);
    expect(events("TeamMemberAdded")).toEqual([]);
    expect(membershipRows()).toEqual(before);
    // Tightening keeps the members, too.
    constrainTo(["oidc"]);
    expect(membershipRows()).toEqual(before);
    expect(events("TeamMemberRemoved")).toEqual([]);
  });

  it("rejects a non-admin and an unknown kind, writing nothing", () => {
    const forbidden = setProjectAuthenticationConstraint(db, { projectId, permittedStrategyKinds: ["oidc"], actorUserId: devId });
    expect(forbidden.ok).toBe(false);
    const unknown = setProjectAuthenticationConstraint(db, { projectId, permittedStrategyKinds: ["carrier-pigeon"], actorUserId: adminId });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.permittedStrategyKinds).toEqual(["'carrier-pigeon' is not a sign-in strategy"]);
    expect(storedConstraint()).toBe("[]");
    expect(events("ProjectAuthenticationConstraintSet")).toEqual([]);
  });

  it("is set from the project settings page by a project admin", async () => {
    const form = new URLSearchParams();
    form.set("intent", "authentication");
    form.append("kinds[]", "oidc");
    const request = new Request(`http://localhost/projects/${identifier}/settings`, {
      method: "POST",
      headers: { Cookie: await cookieFor(adminId, "password"), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const outcome = await settingsRoute.action({ request, params: { identifier }, context: {} } as never);
    expect(outcome).toEqual({ saved: "authentication" });
    expect(JSON.parse(storedConstraint())).toEqual(["oidc"]);
  });
});

describe("the checkpoint: trump → constraint → role rank", () => {
  it("falls through to the role rank when no constraint is set, whatever the session's kind", () => {
    for (const kind of ["password", "ldap", null] as const) {
      runWithPrincipal({ via: "session", userId: devId, strategyKind: kind }, () => {
        expect(privilegeLevelFor(db, devId, projectId)).toBe(PrivilegeLevel.FULL_TEAM_MEMBER);
        expect(authorizeProjectAction(db, devId, projectId, PrivilegeLevel.FULL_TEAM_MEMBER)).toBeNull();
      });
    }
    runWithPrincipal({ via: "api" }, () => expect(privilegeLevelFor(db, devId, projectId)).toBe(PrivilegeLevel.FULL_TEAM_MEMBER));
  });

  it("refuses a password session on an SSO-only project with the constraint's message, and a command through it writes nothing", () => {
    constrainTo(["oidc"]);
    runWithPrincipal({ via: "session", userId: devId, strategyKind: "password" }, () => {
      expect(privilegeLevelFor(db, devId, projectId)).toBe(PrivilegeLevel.ANONYMOUS);
      const denied = authorizeProjectAction(db, devId, projectId, PrivilegeLevel.READONLY_TEAM_MEMBER);
      expect(denied).toEqual({ ok: false, errors: { authorization: ["this project only admits sessions signed in through single sign-on (OpenID Connect)"] } });
      const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
      const created = createCard(db, { projectId, name: "Nope", cardTypeId: typeId, actorUserId: devId });
      expect(created.ok).toBe(false);
    });
    expect(db.select().from(cards).where(eq(cards.projectId, projectId)).all()).toEqual([]);
  });

  it("refuses a session with no recorded strategy kind — a cookie from before kinds were recorded satisfies no constraint", () => {
    constrainTo(["password"]);
    runWithPrincipal({ via: "session", userId: devId, strategyKind: null }, () => {
      expect(accessRefusal(db, devId, projectId, { via: "session", userId: devId, strategyKind: null })).toMatch(/Mingle password/);
      expect(privilegeLevelFor(db, devId, projectId)).toBe(PrivilegeLevel.ANONYMOUS);
    });
  });

  it("lets a site admin through regardless of how they signed in (Decision 7)", () => {
    constrainTo(["oidc"]);
    runWithPrincipal({ via: "session", userId: adminId, strategyKind: "password" }, () => {
      expect(privilegeLevelFor(db, adminId, projectId)).toBe(PrivilegeLevel.MINGLE_ADMIN);
      expect(authorizeProjectAction(db, adminId, projectId, PrivilegeLevel.PROJECT_ADMIN)).toBeNull();
    });
    runWithPrincipal({ via: "session", userId: adminId, strategyKind: null }, () => {
      expect(privilegeLevelFor(db, adminId, projectId)).toBe(PrivilegeLevel.MINGLE_ADMIN);
    });
  });

  it("is not applied to in-process work outside a request (no principal)", () => {
    constrainTo(["oidc"]);
    expect(privilegeLevelFor(db, devId, projectId)).toBe(PrivilegeLevel.FULL_TEAM_MEMBER);
  });
});

describe("the read-side gate and the session's recorded kind", () => {
  it("records the strategy kind on the session cookie", async () => {
    const request = (cookie: string) => new Request("http://localhost/projects", { headers: { Cookie: cookie } });
    expect(await getSessionPrincipal(request(await cookieFor(devId, "ldap")))).toEqual({ via: "session", userId: devId, strategyKind: "ldap" });
    expect(await getSessionPrincipal(request(await cookieFor(devId, null)))).toEqual({ via: "session", userId: devId, strategyKind: null });
    expect(await getSessionPrincipal(new Request("http://localhost/projects"))).toEqual({ via: "anonymous" });
  });

  it("refuses a project page with 403 for a session the constraint rejects, and passes one it admits, an admin, and an unconstrained project", async () => {
    constrainTo(["oidc"]);
    const refused = await throughMiddleware(`/projects/${identifier}/cards`, await cookieFor(devId, "password"));
    expect(refused.status).toBe(403);
    expect(refused.statusText).toContain("single sign-on");
    const legacyCookie = await throughMiddleware(`/projects/${identifier}/cards`, await cookieFor(devId, null));
    expect(legacyCookie.status).toBe(403);
    const admitted = await throughMiddleware(`/projects/${identifier}/cards`, await cookieFor(devId, "oidc"));
    expect(admitted.status).toBe(200);
    const admin = await throughMiddleware(`/projects/${identifier}/settings`, await cookieFor(adminId, "password"));
    expect(admin.status).toBe(200);
    // Other projects and non-project pages are untouched.
    mustOk(createProject(db, { name: "Open", identifier: "open", actorUserId: adminId }), "open");
    expect((await throughMiddleware("/projects/open/cards", await cookieFor(devId, "password"))).status).toBe(200);
    expect((await throughMiddleware("/projects", await cookieFor(devId, "password"))).status).toBe(200);
    expect((await throughMiddleware("/projects/new", await cookieFor(devId, "password"))).status).toBe(200);
  });

  it("runs the page's loader inside the principal so the checkpoint sees the session's kind", async () => {
    constrainTo(["oidc"]);
    const request = new Request(`http://localhost/projects/${identifier}/cards`, { headers: { Cookie: await cookieFor(devId, "oidc") } });
    const response = await root.middleware[0]({ request, params: {}, context: {} } as never, async () => {
      // Inside the request: the loader's own checkpoint reads agree with the gate.
      expect(privilegeLevelFor(db, devId, projectId)).toBe(PrivilegeLevel.FULL_TEAM_MEMBER);
      const data = await cardsRoute.loader({ request, params: { identifier }, context: {} } as never);
      return new Response(JSON.stringify(data));
    });
    expect((response as Response).status).toBe(200);
  });
});

describe("API principals are judged by linked identities (Decision 5)", () => {
  it("refuses a bearer key whose owner holds no permitted identity, admits the same user after an SSO sign-in, and admits anyone when password is permitted", async () => {
    const key = mustOk(generateApiKey(db, sealer, { userId: devId, actorUserId: devId }), "key").key;
    const list = async () => {
      const request = new Request(`http://localhost/api/v1/projects/${identifier}/cards`, { headers: { Authorization: `Bearer ${key}` } });
      try {
        return (await apiCardsRoute.loader({ request, params: { identifier }, context: {} } as never)) as Response;
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      }
    };
    constrainTo(["oidc"]);
    const refused = await list();
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("single sign-on");
    expect(identitySatisfiesConstraint(db, devId, ["oidc"])).toBe(false);

    // The same user signs in through the provider once; the API now admits the key.
    mustOk(signInExternalUser(db, { claims: { kind: "oidc", subject: "dev-subject", login: "dev", name: "Dev", email: null }, autoEnroll: false }), "sso");
    expect(db.select().from(externalIdentities).where(and(eq(externalIdentities.userId, devId), eq(externalIdentities.kind, "oidc"))).all()).toHaveLength(1);
    expect(identitySatisfiesConstraint(db, devId, ["oidc"])).toBe(true);
    expect((await list()).status).toBe(200);

    constrainTo(["password"]);
    expect((await list()).status).toBe(200);
    constrainTo(["ldap"]);
    expect((await list()).status).toBe(403);
    constrainTo([]);
    expect((await list()).status).toBe(200);
  });
});

describe("the team list badges members the constraint refuses (Decision 6)", () => {
  it("reports a member without a permitted identity, never an admin, and nobody when unconstrained", async () => {
    const load = async () => {
      const request = new Request(`http://localhost/projects/${identifier}/team`, { headers: { Cookie: await cookieFor(adminId, "password") } });
      return (await teamRoute.loader({ request, params: { identifier }, context: {} } as never)) as {
        members: { userId: number; qualifies: boolean }[];
        constraint: string | null;
      };
    };
    mustOk(addTeamMember(db, { projectId, userId: adminId, role: "project_admin", actorUserId: adminId }), "admin membership");
    const open = await load();
    expect(open.constraint).toBeNull();
    expect(open.members.every((m) => m.qualifies)).toBe(true);

    constrainTo(["oidc"]);
    const gated = await load();
    expect(gated.constraint).toContain("single sign-on");
    expect(Object.fromEntries(gated.members.map((m) => [m.userId, m.qualifies]))).toEqual({ [adminId]: true, [devId]: false });
    // Still a member: the badge reports, the constraint never removed anyone.
    expect(membershipRows().map((m) => m.userId).sort()).toEqual([adminId, devId].sort());

    mustOk(signInExternalUser(db, { claims: { kind: "oidc", subject: "dev-subject", login: "dev", name: "Dev", email: null }, autoEnroll: false }), "sso");
    expect((await load()).members.find((m) => m.userId === devId)!.qualifies).toBe(true);
  });
});
