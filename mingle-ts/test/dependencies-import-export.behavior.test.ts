/**
 * Behavioral tests for dependencies export/import (Phase 29).
 *
 * Derived line-by-line from the rule 12 Behavior Statement for
 * `importDependencies` and the contracts of `exportDependencies`,
 * `previewDependencyImport` and `parseDependenciesBundle`: the export
 * is asserted against real dependency rows, the import against the
 * rows, links, version trails and events it creates, and every
 * rejection proves nothing was written.
 *
 * The route section drives the real route module with a Request
 * carrying a real session cookie, including a multipart file upload.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Import/Export verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-deps-import-export-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "deps-import-export-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const route = await import("../app/routes/dependencies.import-export");

const { cardTypes } = await import("../app/db/schema/cards");
const { dependencies, dependencyResolvingCards, dependencyVersions } = await import("../app/db/schema/dependencies");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { linkResolvingCards, raiseDependency, toggleDependencyResolved } = await import("../app/domain/dependencies/commands.server");
const { DEPENDENCIES_FORMAT, parseDependenciesBundle } = await import("../app/domain/import-export/dependencies-bundle.server");
const { exportDependencies, projectsForDependencyExport } = await import("../app/domain/import-export/dependency-export.server");
const { importDependencies, previewDependencyImport } = await import("../app/domain/import-export/dependency-import.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}
function mustReject<T>(result: CommandResult<T>, what: string): Record<string, string[]> {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return result.errors;
}
function register(login: string): number {
  return mustOk(registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "deps-29!" }), login).id;
}

const adminId = register("admin");
const devAId = register("deva");
const devBId = register("devb");

function project(name: string, identifier: string) {
  const row = mustOk(createProject(db, { name, identifier, actorUserId: adminId }), name);
  return { id: row.id, identifier: row.identifier, name: row.name };
}
function card(projectId: number, name: string): number {
  const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
  return mustOk(createCard(db, { projectId, name, cardTypeId: typeId, actorUserId: adminId }), name).number;
}

const alpha = project("Alpha", "alpha");
const beta = project("Beta", "beta");
const gamma = project("Gamma", "gamma");
mustOk(addTeamMember(db, { projectId: alpha.id, userId: devAId, actorUserId: adminId }), "devA");
mustOk(addTeamMember(db, { projectId: beta.id, userId: devBId, actorUserId: adminId }), "devB");
const aLogin = card(alpha.id, "Login");
const aSignup = card(alpha.id, "Signup");
const bApi = card(beta.id, "API");
const bSchema = card(beta.id, "Schema");

// D1: alpha#1 → beta, accepted with two resolving cards. D2: beta#2 → alpha, resolved. D3: alpha#2 → alpha, new.
const d1 = mustOk(raiseDependency(db, { raisingProjectId: alpha.id, raisingCardNumber: aLogin, name: "Need the API", description: "auth endpoint", desiredEndDate: "2026-09-30", resolvingProjectId: beta.id, actorUserId: devAId }), "D1");
mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: d1.number, cardNumbers: [bApi, bSchema], actorUserId: devBId }), "link D1");
const d2 = mustOk(raiseDependency(db, { raisingProjectId: beta.id, raisingCardNumber: bSchema, name: "Need signup flow", description: null, desiredEndDate: "2026-10-15", resolvingProjectId: alpha.id, actorUserId: devBId }), "D2");
mustOk(linkResolvingCards(db, { projectId: alpha.id, dependencyNumber: d2.number, cardNumbers: [aSignup], actorUserId: devAId }), "link D2");
mustOk(toggleDependencyResolved(db, { projectId: alpha.id, dependencyNumber: d2.number, actorUserId: devAId }), "resolve D2");
const d3 = mustOk(raiseDependency(db, { raisingProjectId: alpha.id, raisingCardNumber: aSignup, name: "Internal", description: null, desiredEndDate: "2026-11-01", resolvingProjectId: alpha.id, actorUserId: devAId }), "D3");

const NOW = new Date("2026-08-28T12:00:00Z");

function reload(number: number) {
  return db.select().from(dependencies).where(eq(dependencies.number, number)).get();
}
function linksOf(dependencyId: number): number[] {
  return db.select({ n: dependencyResolvingCards.cardNumber }).from(dependencyResolvingCards).where(eq(dependencyResolvingCards.dependencyId, dependencyId)).orderBy(asc(dependencyResolvingCards.cardNumber)).all().map((r) => r.n);
}
function trail(dependencyId: number) {
  return db.select({ version: dependencyVersions.version, status: dependencyVersions.status }).from(dependencyVersions).where(eq(dependencyVersions.dependencyId, dependencyId)).orderBy(asc(dependencyVersions.version)).all();
}
function dependencyCount(): number {
  return db.select({ id: dependencies.id }).from(dependencies).all().length;
}
function eventsOfType(type: string) {
  return db.select({ payload: domainEvents.payload }).from(domainEvents).where(eq(domainEvents.type, type)).orderBy(asc(domainEvents.id)).all().map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

describe("exportDependencies", () => {
  it("bundles every dependency raised by or asked of the chosen projects, once each, by name", () => {
    const bundle = mustOk(exportDependencies(db, { projectIds: [alpha.id], actorUserId: adminId, now: NOW }), "export");
    expect(bundle).toMatchObject({ format: DEPENDENCIES_FORMAT, version: 1, exportedAt: "2026-08-28T12:00:00.000Z" });
    expect(bundle.dependencies).toEqual([
      { number: d1.number, name: "Need the API", description: "auth endpoint", desiredEndDate: "2026-09-30", status: "ACCEPTED", raisingProject: "alpha", raisingCard: { number: aLogin, name: "Login" }, raisingUser: "deva", resolvingProject: "beta", resolvingCards: [{ number: bApi, name: "API" }, { number: bSchema, name: "Schema" }] },
      { number: d2.number, name: "Need signup flow", description: null, desiredEndDate: "2026-10-15", status: "RESOLVED", raisingProject: "beta", raisingCard: { number: bSchema, name: "Schema" }, raisingUser: "devb", resolvingProject: "alpha", resolvingCards: [{ number: aSignup, name: "Signup" }] },
      { number: d3.number, name: "Internal", description: null, desiredEndDate: "2026-11-01", status: "NEW", raisingProject: "alpha", raisingCard: { number: aSignup, name: "Signup" }, raisingUser: "deva", resolvingProject: "alpha", resolvingCards: [] },
    ]);
    expect(mustOk(exportDependencies(db, { projectIds: [beta.id], actorUserId: adminId }), "beta").dependencies.map((d) => d.number)).toEqual([d1.number, d2.number]);
    expect(mustOk(exportDependencies(db, { projectIds: [gamma.id], actorUserId: adminId }), "gamma").dependencies).toEqual([]);
    expect(mustOk(parseDependenciesBundle(JSON.stringify(bundle)), "parse")).toEqual(bundle);
    expect(projectsForDependencyExport(db).map((p) => [p.identifier, p.dependencyCount])).toEqual([["alpha", 3], ["beta", 2], ["gamma", 0]]);
  });

  it("rejects a non-admin, an empty selection, and an unknown project", () => {
    expect(mustReject(exportDependencies(db, { projectIds: [alpha.id], actorUserId: devAId }), "dev").authorization).toEqual(["requires Mingle administrator access"]);
    expect(mustReject(exportDependencies(db, { projectIds: [], actorUserId: adminId }), "none").projects).toEqual(["must be selected"]);
    expect(mustReject(exportDependencies(db, { projectIds: [alpha.id, 999], actorUserId: adminId }), "unknown").projects).toEqual(["unknown project id 999"]);
  });
});

describe("parseDependenciesBundle", () => {
  it("names the offending path", () => {
    expect(mustReject(parseDependenciesBundle("nope"), "json").bundle).toEqual(["is not valid JSON"]);
    expect(mustReject(parseDependenciesBundle('{"format":"x"}'), "format").bundle).toEqual([`format must be "${DEPENDENCIES_FORMAT}"`]);
    const good = mustOk(exportDependencies(db, { projectIds: [alpha.id], actorUserId: adminId, now: NOW }), "export");
    const bad = { ...good, dependencies: [{ ...good.dependencies[0], status: "MAYBE" }] };
    expect(mustReject(parseDependenciesBundle(JSON.stringify(bad)), "status").bundle).toEqual([expect.stringMatching(/^dependencies\[0\]\.status must be one of/)]);
    const noCard = { ...good, dependencies: [{ ...good.dependencies[0], raisingCard: { name: "x" } }] };
    expect(mustReject(parseDependenciesBundle(JSON.stringify(noCard)), "card").bundle).toEqual(["dependencies[0].raisingCard.number must be a positive whole number"]);
  });
});

describe("previewDependencyImport / importDependencies", () => {
  const bundle = mustOk(exportDependencies(db, { projectIds: [alpha.id], actorUserId: adminId, now: NOW }), "export");

  it("previews what each dependency attaches to, honoring raising-card overrides, and reports errors and warnings", () => {
    const altered = {
      ...bundle,
      dependencies: [
        { ...bundle.dependencies[0], raisingCard: { number: 99, name: "Gone" } },
        { ...bundle.dependencies[1], resolvingCards: [{ number: 77, name: "Gone too" }] },
        { ...bundle.dependencies[2], resolvingProject: "delta" },
      ],
    };
    const preview = mustOk(previewDependencyImport(db, { bundle: altered, actorUserId: adminId }), "preview");
    expect({ importable: preview.importable, errorCount: preview.errorCount }).toEqual({ importable: 1, errorCount: 2 });
    expect(preview.entries[0]).toMatchObject({ raisingCard: { number: 99, found: false }, errors: ['raising card #99 does not exist in "alpha"'] });
    expect(preview.entries[1]).toMatchObject({ errors: [], warnings: ['resolving card #77 does not exist in "alpha" and will be dropped', "no resolving card survives, so the dependency imports as NEW"] });
    expect(preview.entries[2]).toMatchObject({ resolvingProject: { identifier: "delta", found: false }, errors: ['resolving project "delta" does not exist'] });

    const remapped = mustOk(previewDependencyImport(db, { bundle: altered, raisingCardOverrides: { [d1.number]: aLogin }, actorUserId: adminId }), "override");
    expect(remapped.entries[0]).toMatchObject({ raisingCard: { number: aLogin, found: true }, errors: [] });
    expect(mustReject(previewDependencyImport(db, { bundle, actorUserId: devAId }), "dev").authorization).toBeDefined();
  });

  it("recreates the bundle's dependencies with fresh numbers, links, and status, on one transaction, and records the mapping", () => {
    const before = dependencyCount();
    const outcome = mustOk(importDependencies(db, { bundle, actorUserId: adminId }), "import");
    expect(outcome.imported).toEqual([
      { source: d1.number, number: d3.number + 1 },
      { source: d2.number, number: d3.number + 2 },
      { source: d3.number, number: d3.number + 3 },
    ]);
    expect(dependencyCount()).toBe(before + 3);
    const one = reload(d3.number + 1)!;
    expect(one).toMatchObject({ name: "Need the API", description: "auth endpoint", desiredEndDate: "2026-09-30", raisingProjectId: alpha.id, raisingCardNumber: aLogin, resolvingProjectId: beta.id, status: "ACCEPTED", raisingUserId: adminId, version: 2 });
    expect(linksOf(one.id)).toEqual([bApi, bSchema]);
    const two = reload(d3.number + 2)!;
    expect(two).toMatchObject({ raisingProjectId: beta.id, raisingCardNumber: bSchema, resolvingProjectId: alpha.id, status: "RESOLVED", version: 3 });
    expect(linksOf(two.id)).toEqual([aSignup]);
    expect(trail(two.id).map((v) => [v.version, v.status])).toEqual([[1, "NEW"], [2, "ACCEPTED"], [3, "RESOLVED"]]);
    const three = reload(d3.number + 3)!;
    expect(three).toMatchObject({ status: "NEW", version: 1, resolvingProjectId: alpha.id });
    expect(linksOf(three.id)).toEqual([]);
    expect(eventsOfType("DependenciesImported").at(-1)).toEqual({ exportedAt: "2026-08-28T12:00:00.000Z", imported: outcome.imported });
    // The originals are untouched.
    expect(reload(d1.number)).toMatchObject({ version: 2, status: "ACCEPTED" });
  });

  it("writes nothing when any dependency cannot attach, keying the error by index; rejects an empty bundle and a non-admin", () => {
    const before = dependencyCount();
    const broken = { ...bundle, dependencies: [bundle.dependencies[0], { ...bundle.dependencies[1], raisingProject: "nowhere" }] };
    expect(mustReject(importDependencies(db, { bundle: broken, actorUserId: adminId }), "broken")).toEqual({ "dependencies[1]": ['raising project "nowhere" does not exist'] });
    expect(dependencyCount()).toBe(before);
    // A rejection the preview cannot see (the command's own date rule) surfaces mid-batch: the first
    // dependency was already raised inside the transaction and must be rolled back with it.
    const midBatch = { ...bundle, dependencies: [bundle.dependencies[0], { ...bundle.dependencies[1], desiredEndDate: "not-a-date" }] };
    expect(mustReject(importDependencies(db, { bundle: midBatch, actorUserId: adminId }), "mid-batch")).toEqual({ "dependencies[1].desired_end_date": ["is not a valid date"] });
    expect(dependencyCount()).toBe(before);
    expect(reload(d3.number + 4)).toBeUndefined();
    expect(mustReject(importDependencies(db, { bundle: { ...bundle, dependencies: [] }, actorUserId: adminId }), "empty").bundle).toEqual(["has no dependencies"]);
    expect(mustReject(importDependencies(db, { bundle, actorUserId: devAId }), "dev").authorization).toBeDefined();
    expect(dependencyCount()).toBe(before);
  });
});

describe("dependencies import/export route (real route module)", () => {
  async function cookieFor(userId: number): Promise<string> {
    return (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
  }
  async function call(fn: (args: never) => Promise<unknown>, userId: number, body?: FormData | URLSearchParams, query = "") {
    const headers: Record<string, string> = { Cookie: await cookieFor(userId) };
    if (body instanceof URLSearchParams) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const request = new Request(`http://localhost/dependencies/import-export${query}`, { method: body ? "POST" : "GET", headers, body });
    try {
      const result = (await fn({ request, params: {}, context: {} } as never)) as { data?: unknown; init?: { status?: number } | null };
      if (result instanceof Response) return { status: result.status, location: null as string | null, response: result as Response | null, data: null as unknown };
      return { status: result?.init?.status ?? 200, location: null as string | null, response: null as Response | null, data: result?.init === undefined ? result : result.data };
    } catch (thrown) {
      if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location"), response: null, data: null };
      throw thrown;
    }
  }

  it("exports as an attachment, previews pasted text, imports an uploaded file, and gates everything on site admin", async () => {
    expect((await call(route.loader, adminId, undefined, "?imported=2")).data).toMatchObject({ canManage: true, imported: 2, projects: [{ identifier: "alpha" }, { identifier: "beta" }, { identifier: "gamma" }] });
    expect((await call(route.loader, devAId)).data).toMatchObject({ canManage: false, imported: null });

    const exported = await call(route.action, adminId, new URLSearchParams([["intent", "export"], ["project_id", String(beta.id)]]));
    expect(exported.status).toBe(200);
    expect(exported.response!.headers.get("Content-Disposition")).toBe('attachment; filename="dependencies.json"');
    const text = await exported.response!.text();
    // The copies imported above touch beta too, so beta's export now carries four.
    expect(mustOk(parseDependenciesBundle(text), "download").dependencies.map((d) => d.number)).toEqual([d1.number, d2.number, d3.number + 1, d3.number + 2]);
    expect((await call(route.action, devAId, new URLSearchParams([["intent", "export"], ["project_id", String(beta.id)]]))).status).toBe(400);

    const previewed = await call(route.action, adminId, new URLSearchParams({ intent: "preview", text }));
    expect(previewed.status).toBe(200);
    expect((previewed.data as { preview: { importable: number } }).preview.importable).toBe(4);

    const before = dependencyCount();
    const upload = new FormData();
    upload.set("intent", "import");
    upload.set("file", new File([text], "dependencies.json", { type: "application/json" }));
    const imported = await call(route.action, adminId, upload);
    expect(imported).toMatchObject({ status: 302, location: "/dependencies/import-export?imported=4" });
    expect(dependencyCount()).toBe(before + 4);

    expect((await call(route.action, adminId, new URLSearchParams({ intent: "import", text: "" }))).status).toBe(400);
    expect((await call(route.action, adminId, new URLSearchParams({ intent: "import", text: "{" }))).status).toBe(400);
  });
});
