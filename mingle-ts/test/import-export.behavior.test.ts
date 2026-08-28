/**
 * Behavioral tests for project export/import (Phase 28).
 *
 * Derived line-by-line from the rule 12 Behavior Statement for
 * `importProject` and the contract of `exportProject` / `parseBundle`:
 * the export is asserted against the source project's real rows, the
 * import against the rows it creates (card types, properties and their
 * values, trees and relationship properties, aggregates, transitions
 * with prerequisites and actions, variables, the events), and every
 * rejection proves the transaction rolled back — no project row
 * remains. Includes the phase's exit criterion: exporting a
 * fully-configured project and importing it into a fresh project
 * produces a structurally identical configuration, verified
 * field-by-field against the source project's rows.
 *
 * The route section drives the real export and import route modules
 * with a Request carrying a real session cookie, including a
 * multipart file upload.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Import/Export verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-import-export-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "import-export-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const exportRoute = await import("../app/routes/projects.export");
const importRoute = await import("../app/routes/projects.import");

const { cardTypes } = await import("../app/db/schema/cards");
const { projects, projectVariables } = await import("../app/db/schema/projects");
const { enumerationValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { transitions, transitionActions, transitionPrerequisites } = await import("../app/db/schema/transitions");
const { treeCardTypes, treeConfigurations } = await import("../app/db/schema/trees");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject, defineProjectVariable } = await import("../app/domain/projects/commands.server");
const { defineCardType } = await import("../app/domain/cards/commands.server");
const { defineAggregateProperty, definePropertyDefinition } = await import("../app/domain/cards/properties.server");
const { defineTransition } = await import("../app/domain/cards/transitions.server");
const { defineTree } = await import("../app/domain/trees/commands.server");
const { parseBundle, BUNDLE_FORMAT, BUNDLE_VERSION } = await import("../app/domain/import-export/bundle.server");
const { exportProject } = await import("../app/domain/import-export/export.server");
const { importProject } = await import("../app/domain/import-export/import.server");
type ProjectBundle = Awaited<ReturnType<typeof parseBundle>> extends infer R ? (R extends { ok: true; value: infer V } ? V : never) : never;

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
  return mustOk(
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "import-28!" }),
    login,
  ).id;
}

const adminId = register("admin"); // site admin
const memberId = register("member"); // full team member of the source project, not an admin

// ── The fully-configured source project ──
const source = mustOk(createProject(db, { name: "Source Project", identifier: "source", description: "the original", actorUserId: adminId }), "source");
mustOk(addTeamMember(db, { projectId: source.id, userId: memberId, actorUserId: adminId }), "member");
const a = { projectId: source.id, actorUserId: adminId };
const releaseType = mustOk(defineCardType(db, { ...a, name: "Release" }), "Release");
const storyType = mustOk(defineCardType(db, { ...a, name: "Story" }), "Story");
const status = mustOk(definePropertyDefinition(db, { ...a, name: "Status", kind: "enumerated", values: ["New", "In Progress", "Done"], transitionOnly: true }), "Status");
const estimate = mustOk(definePropertyDefinition(db, { ...a, name: "Estimate", kind: "number" }), "Estimate");
mustOk(definePropertyDefinition(db, { ...a, name: "Owner", kind: "user" }), "Owner");
mustOk(definePropertyDefinition(db, { ...a, name: "Due", kind: "date" }), "Due");
mustOk(definePropertyDefinition(db, { ...a, name: "Notes", kind: "text" }), "Notes");
mustOk(definePropertyDefinition(db, { ...a, name: "Double", kind: "formula", formula: "Estimate * 2", nullIsZero: true }), "Double");
const tree = mustOk(
  defineTree(db, { ...a, name: "Planning", description: "release > story", levels: [{ cardTypeId: releaseType.id, relationshipName: "Release" }, { cardTypeId: storyType.id }] }),
  "tree",
);
mustOk(
  defineAggregateProperty(db, { ...a, name: "Total Estimate", treeId: tree.id, aggregateCardTypeId: releaseType.id, aggregateType: "sum", targetPropertyDefinitionId: estimate.id, scopeCardTypeId: storyType.id, condition: "Status = Done" }),
  "aggregate",
);
mustOk(defineAggregateProperty(db, { ...a, name: "Story Count", treeId: tree.id, aggregateCardTypeId: releaseType.id, aggregateType: "count" }), "count");
mustOk(
  defineTransition(db, {
    ...a,
    name: "Start",
    cardTypeId: storyType.id,
    prerequisites: [
      { kind: "has_specific_value", propertyDefinitionId: status.id, value: "New" },
      { kind: "has_set_value", propertyDefinitionId: estimate.id },
      { kind: "is_user", userId: memberId },
    ],
    actions: [
      { propertyDefinitionId: status.id, inputMode: "fixed", value: "In Progress" },
      { propertyDefinitionId: estimate.id, inputMode: "user_input_optional" },
    ],
  }),
  "Start",
);
mustOk(defineTransition(db, { ...a, name: "Finish", prerequisites: [], actions: [{ propertyDefinitionId: status.id, inputMode: "fixed", value: "Done" }] }), "Finish");
mustOk(defineProjectVariable(db, { ...a, name: "Sprint Length", dataType: "NumericType", value: "14" }), "var");
mustOk(defineProjectVariable(db, { ...a, name: "Lead", dataType: "UserType", value: String(memberId) }), "user var");

/** A project's configuration as comparable rows: ids, project ids and timestamps stripped, cross-references resolved to names. */
function configurationOf(projectId: number) {
  const types = db.select().from(cardTypes).where(eq(cardTypes.projectId, projectId)).orderBy(asc(cardTypes.position)).all();
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const definitions = db.select().from(propertyDefinitions).where(eq(propertyDefinitions.projectId, projectId)).orderBy(asc(propertyDefinitions.position)).all();
  const definitionName = new Map(definitions.map((d) => [d.id, d.name]));
  const trees = db.select().from(treeConfigurations).where(eq(treeConfigurations.projectId, projectId)).orderBy(asc(treeConfigurations.name)).all();
  const treeName = new Map(trees.map((t) => [t.id, t.name]));
  const ids = definitions.map((d) => d.id);
  const values = ids.length ? db.select().from(enumerationValues).where(inArray(enumerationValues.propertyDefinitionId, ids)).orderBy(asc(enumerationValues.position)).all() : [];
  const transitionRows = db.select().from(transitions).where(eq(transitions.projectId, projectId)).orderBy(asc(transitions.name)).all();
  const transitionIds = transitionRows.map((t) => t.id);
  const prerequisites = transitionIds.length ? db.select().from(transitionPrerequisites).where(inArray(transitionPrerequisites.transitionId, transitionIds)).orderBy(asc(transitionPrerequisites.id)).all() : [];
  const actions = transitionIds.length ? db.select().from(transitionActions).where(inArray(transitionActions.transitionId, transitionIds)).orderBy(asc(transitionActions.id)).all() : [];
  const levels = trees.length ? db.select().from(treeCardTypes).where(inArray(treeCardTypes.treeConfigurationId, trees.map((t) => t.id))).orderBy(asc(treeCardTypes.position)).all() : [];
  return {
    cardTypes: types.map((t) => ({ name: t.name, position: t.position })),
    properties: definitions.map((d) => ({
      name: d.name,
      kind: d.kind,
      position: d.position,
      formula: d.formula,
      nullIsZero: d.nullIsZero,
      transitionOnly: d.transitionOnly,
      tree: d.treeConfigurationId === null ? null : treeName.get(d.treeConfigurationId),
      validCardType: d.validCardTypeId === null ? null : typeName.get(d.validCardTypeId),
      aggregateType: d.aggregateType,
      aggregateTarget: d.aggregateTargetId === null ? null : definitionName.get(d.aggregateTargetId),
      aggregateCardType: d.aggregateCardTypeId === null ? null : typeName.get(d.aggregateCardTypeId),
      aggregateScopeCardType: d.aggregateScopeCardTypeId === null ? null : typeName.get(d.aggregateScopeCardTypeId),
      aggregateCondition: d.aggregateCondition,
      values: values.filter((v) => v.propertyDefinitionId === d.id).map((v) => [v.value, v.position]),
    })),
    trees: trees.map((t) => ({
      name: t.name,
      description: t.description,
      levels: levels.filter((l) => l.treeConfigurationId === t.id).map((l) => [typeName.get(l.cardTypeId), l.position]),
    })),
    transitions: transitionRows.map((t) => ({
      name: t.name,
      cardType: t.cardTypeId === null ? null : typeName.get(t.cardTypeId),
      prerequisites: prerequisites
        .filter((p) => p.transitionId === t.id)
        .map((p) => ({ kind: p.kind, property: p.propertyDefinitionId === null ? null : definitionName.get(p.propertyDefinitionId), value: p.value, userId: p.userId, groupId: p.groupId })),
      actions: actions.filter((x) => x.transitionId === t.id).map((x) => ({ property: definitionName.get(x.propertyDefinitionId), inputMode: x.inputMode, value: x.value })),
    })),
    variables: db
      .select({ name: projectVariables.name, dataType: projectVariables.dataType, value: projectVariables.value })
      .from(projectVariables)
      .where(eq(projectVariables.projectId, projectId))
      .orderBy(asc(projectVariables.name))
      .all(),
  };
}

function treeIdsOf(projectId: number): number[] {
  return db.select({ id: treeConfigurations.id }).from(treeConfigurations).where(eq(treeConfigurations.projectId, projectId)).all().map((t) => t.id);
}

function projectByIdentifier(identifier: string) {
  return db.select().from(projects).where(eq(projects.identifier, identifier)).get();
}

function eventsFor(projectId: number): { type: string; payload: Record<string, unknown> }[] {
  return db
    .select({ type: domainEvents.type, payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.aggregateType, "Project"), eq(domainEvents.aggregateId, projectId)))
    .orderBy(asc(domainEvents.id))
    .all()
    .map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

function projectCount(): number {
  return db.select({ id: projects.id }).from(projects).all().length;
}

const NOW = new Date("2026-08-28T12:00:00Z");

describe("exportProject", () => {
  it("renders the source project's configuration by name, dropping what does not travel", () => {
    const bundle = mustOk(exportProject(db, { projectId: source.id, actorUserId: adminId, now: NOW }), "export");
    expect(bundle).toMatchObject({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: "2026-08-28T12:00:00.000Z" });
    expect(bundle.source).toEqual({ name: "Source Project", identifier: "source", description: "the original" });
    expect(bundle.cardTypes).toEqual(["Card", "Release", "Story"]);
    expect(bundle.properties).toEqual([
      { name: "Status", kind: "enumerated", values: ["New", "In Progress", "Done"], transitionOnly: true },
      { name: "Estimate", kind: "number", transitionOnly: false },
      { name: "Owner", kind: "user", transitionOnly: false },
      { name: "Due", kind: "date", transitionOnly: false },
      { name: "Notes", kind: "text", transitionOnly: false },
      { name: "Double", kind: "formula", formula: "Estimate * 2", nullIsZero: true, transitionOnly: false },
    ]);
    expect(bundle.trees).toEqual([
      { name: "Planning", description: "release > story", levels: [{ cardType: "Release", relationshipName: "Release" }, { cardType: "Story" }] },
    ]);
    expect(bundle.aggregates).toEqual([
      { name: "Total Estimate", tree: "Planning", holderCardType: "Release", aggregateType: "sum", targetProperty: "Estimate", scopeCardType: "Story", condition: "Status = Done" },
      { name: "Story Count", tree: "Planning", holderCardType: "Release", aggregateType: "count" },
    ]);
    expect(bundle.transitions).toEqual([
      { name: "Finish", prerequisites: [], actions: [{ property: "Status", inputMode: "fixed", value: "Done" }] },
      {
        name: "Start",
        cardType: "Story",
        prerequisites: [
          { kind: "has_specific_value", property: "Status", value: "New" },
          { kind: "has_set_value", property: "Estimate" },
        ], // the is_user prerequisite does not travel
        actions: [
          { property: "Status", inputMode: "fixed", value: "In Progress" },
          { property: "Estimate", inputMode: "user_input_optional", value: null },
        ],
      },
    ]);
    expect(bundle.variables).toEqual([
      { name: "Lead", dataType: "UserType", value: null },
      { name: "Sprint Length", dataType: "NumericType", value: "14" },
    ]);
    // The bundle round-trips through its own parser unchanged.
    expect(mustOk(parseBundle(JSON.stringify(bundle)), "parse")).toEqual(bundle);
  });

  it("rejects an unknown project and a non-admin team member", () => {
    expect(mustReject(exportProject(db, { projectId: 9999, actorUserId: adminId }), "unknown").project).toEqual(["does not exist"]);
    expect(mustReject(exportProject(db, { projectId: source.id, actorUserId: memberId }), "member").authorization).toEqual([
      expect.stringContaining("access to this project"),
    ]);
  });
});

describe("parseBundle", () => {
  it("rejects malformed documents naming the offending path", () => {
    expect(mustReject(parseBundle("{nope"), "json").bundle).toEqual(["is not valid JSON"]);
    expect(mustReject(parseBundle('{"format":"other"}'), "format").bundle).toEqual([`format must be "${BUNDLE_FORMAT}"`]);
    const good = mustOk(exportProject(db, { projectId: source.id, actorUserId: adminId, now: NOW }), "export");
    const broken = { ...good, properties: [{ ...good.properties[0], kind: "colour" }] };
    expect(mustReject(parseBundle(JSON.stringify(broken)), "kind").bundle).toEqual([
      expect.stringMatching(/^properties\[0\]\.kind must be one of/),
    ]);
    const missingLevels = { ...good, trees: [{ name: "T", description: null }] };
    expect(mustReject(parseBundle(JSON.stringify(missingLevels)), "levels").bundle).toEqual(["trees[0].levels must be a list"]);
  });
});

describe("importProject", () => {
  const bundle = mustOk(exportProject(db, { projectId: source.id, actorUserId: adminId, now: NOW }), "export");

  it("Phase 28 exit criterion: importing the export into a fresh project reproduces the configuration field by field", () => {
    const outcome = mustOk(importProject(db, { bundle, name: "Imported Project", identifier: "imported", actorUserId: adminId }), "import");
    expect(outcome).toEqual({
      projectId: expect.any(Number),
      identifier: "imported",
      counts: { cardTypes: 2, properties: 6, trees: 1, aggregates: 2, transitions: 2, variables: 2 },
    });
    const imported = projectByIdentifier("imported")!;
    expect(imported).toMatchObject({ name: "Imported Project", description: "the original", createdByUserId: adminId });

    const expected = configurationOf(source.id);
    // Identity does not travel: the source's is_user prerequisite and the UserType variable's value are absent after import.
    expected.transitions.find((t) => t.name === "Start")!.prerequisites = expected.transitions
      .find((t) => t.name === "Start")!
      .prerequisites.filter((p) => p.kind !== "is_user");
    expected.variables.find((v) => v.name === "Lead")!.value = null;
    expect(configurationOf(imported.id)).toEqual(expected);

    // Exporting the import yields the same bundle apart from its source block.
    const reexported = mustOk(exportProject(db, { projectId: imported.id, actorUserId: adminId, now: NOW }), "re-export");
    expect({ ...reexported, source: bundle.source }).toEqual(bundle);

    const events = eventsFor(imported.id).map((e) => e.type);
    expect(events[0]).toBe("ProjectCreated");
    expect(events).toContain("CardTypeDefined");
    expect(events).toContain("PropertyDefinitionDefined");
    expect(events.at(-1)).toBe("ProjectImported");
    const treeEvents = db
      .select({ type: domainEvents.type })
      .from(domainEvents)
      .where(and(eq(domainEvents.aggregateType, "TreeConfiguration"), inArray(domainEvents.aggregateId, configurationOf(imported.id).trees.length ? treeIdsOf(imported.id) : [-1])))
      .all()
      .map((e) => e.type);
    expect(treeEvents).toEqual(["TreeDefined"]);
    expect(eventsFor(imported.id).at(-1)!.payload).toEqual({
      identifier: "imported",
      source: "source",
      exportedAt: "2026-08-28T12:00:00.000Z",
      counts: outcome.counts,
    });
  });

  it("keeps the bundle's own name and identifier when no override is given, and treats a listed default type as already present", () => {
    const renamed: ProjectBundle = { ...bundle, source: { name: "Second Copy", identifier: "second_copy", description: null } };
    const outcome = mustOk(importProject(db, { bundle: renamed, name: "  ", identifier: "", actorUserId: adminId }), "import");
    expect(projectByIdentifier("second_copy")).toMatchObject({ name: "Second Copy", description: null });
    expect(outcome.counts.cardTypes).toBe(2); // "Card" came with CreateProject
    expect(configurationOf(outcome.projectId).cardTypes.map((t) => t.name)).toEqual(["Card", "Release", "Story"]);
  });

  it("rolls back entirely when an entry breaks a command's rule, keying the error by bundle path", () => {
    const before = projectCount();
    const badFormula: ProjectBundle = {
      ...bundle,
      source: { ...bundle.source, identifier: "bad_formula", name: "Bad Formula" },
      properties: bundle.properties.map((p) => (p.kind === "formula" ? { ...p, formula: "Estimate * Missing" } : p)),
    };
    const errors = mustReject(importProject(db, { bundle: badFormula, actorUserId: adminId }), "formula");
    expect(Object.keys(errors)).toEqual(["properties[5].formula"]);
    expect(projectByIdentifier("bad_formula")).toBeUndefined();
    expect(projectCount()).toBe(before);

    const danglingTree: ProjectBundle = {
      ...bundle,
      source: { ...bundle.source, identifier: "dangling", name: "Dangling" },
      trees: [{ ...bundle.trees[0], levels: [{ cardType: "Epic", relationshipName: "Epic" }, { cardType: "Story" }] }],
    };
    expect(mustReject(importProject(db, { bundle: danglingTree, actorUserId: adminId }), "tree")).toEqual({
      "trees[0].levels[0].cardType": ['refers to an unknown card type "Epic"'],
    });
    expect(projectByIdentifier("dangling")).toBeUndefined();

    const dangling = { ...bundle, source: { ...bundle.source, identifier: "dangling2", name: "Dangling 2" }, transitions: [{ ...bundle.transitions[0], actions: [{ property: "Ghost", inputMode: "fixed" as const, value: "x" }] }] };
    expect(Object.keys(mustReject(importProject(db, { bundle: dangling, actorUserId: adminId }), "action"))).toEqual(["transitions[0].actions[0].property"]);
    expect(projectCount()).toBe(before);
  });

  it("rejects a taken identifier and a non-admin actor without creating anything", () => {
    const before = projectCount();
    expect(mustReject(importProject(db, { bundle, actorUserId: adminId }), "taken")).toEqual({ "project.name": ["has already been taken"] });
    expect(mustReject(importProject(db, { bundle, name: "By Member", identifier: "by_member", actorUserId: memberId }), "member")).toEqual({
      "project.authorization": ["requires Mingle administrator access"],
    });
    expect(projectByIdentifier("by_member")).toBeUndefined();
    expect(projectCount()).toBe(before);
  });
});

describe("import/export routes (real route modules)", () => {
  async function cookieFor(userId: number): Promise<string> {
    return (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
  }

  async function call(
    fn: (args: never) => Promise<unknown>,
    userId: number | null,
    path: string,
    params: Record<string, string>,
    body?: FormData | URLSearchParams,
  ): Promise<{ status: number; location: string | null; response: Response | null; data: unknown }> {
    const headers: Record<string, string> = {};
    if (userId !== null) headers.Cookie = await cookieFor(userId);
    if (body instanceof URLSearchParams) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const request = new Request(`http://localhost${path}`, { method: body ? "POST" : "GET", headers, body });
    try {
      const result = (await fn({ request, params, context: {} } as never)) as { data?: unknown; init?: { status?: number } | null };
      if (result instanceof Response) return { status: result.status, location: null, response: result, data: null };
      return { status: result?.init?.status ?? 200, location: null, response: null, data: result?.init === undefined ? result : result.data };
    } catch (thrown) {
      if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location"), response: null, data: null };
      throw thrown;
    }
  }

  it("the export route downloads the bundle as an attachment for an admin, 403s a member, 404s an unknown project", async () => {
    const download = await call(exportRoute.loader, adminId, "/projects/source/export", { identifier: "source" });
    expect(download.status).toBe(200);
    expect(download.response!.headers.get("Content-Disposition")).toBe('attachment; filename="source-template.json"');
    const body = mustOk(parseBundle(await download.response!.text()), "download");
    expect(body.source.identifier).toBe("source");
    expect(body.cardTypes).toEqual(["Card", "Release", "Story"]);
    expect((await call(exportRoute.loader, memberId, "/projects/source/export", { identifier: "source" })).status).toBe(403);
    expect((await call(exportRoute.loader, adminId, "/projects/nope/export", { identifier: "nope" })).status).toBe(404);
    const anon = await call(exportRoute.loader, null, "/projects/source/export", { identifier: "source" });
    expect(anon.status).toBe(302);
    expect(anon.location).toMatch(/^\/login/);
  });

  it("the import route creates the project from an uploaded file, and from pasted text, and reports errors by path", async () => {
    const download = await call(exportRoute.loader, adminId, "/projects/source/export", { identifier: "source" });
    const text = await download.response!.text();

    const upload = new FormData();
    upload.set("bundle", new File([text], "source-template.json", { type: "application/json" }));
    upload.set("name", "Uploaded Copy");
    upload.set("identifier", "uploaded");
    const uploaded = await call(importRoute.action, adminId, "/projects/import", {}, upload);
    expect(uploaded).toMatchObject({ status: 302, location: "/projects/uploaded/settings" });
    expect(configurationOf(projectByIdentifier("uploaded")!.id).trees).toEqual(configurationOf(source.id).trees);

    const pasted = await call(importRoute.action, adminId, "/projects/import", {}, new URLSearchParams({ bundle_text: text, name: "Pasted Copy", identifier: "pasted" }));
    expect(pasted).toMatchObject({ status: 302, location: "/projects/pasted/settings" });
    expect(configurationOf(projectByIdentifier("pasted")!.id).transitions.map((t) => t.name)).toEqual(["Finish", "Start"]);

    const empty = await call(importRoute.action, adminId, "/projects/import", {}, new URLSearchParams({ bundle_text: "  " }));
    expect(empty.status).toBe(400);
    expect((empty.data as { errors: Record<string, string[]> }).errors.bundle).toEqual(["Export file must be uploaded"]);
    const garbage = await call(importRoute.action, adminId, "/projects/import", {}, new URLSearchParams({ bundle_text: "{" }));
    expect((garbage.data as { errors: Record<string, string[]> }).errors.bundle).toEqual(["is not valid JSON"]);
    const before = projectCount();
    const refused = await call(importRoute.action, memberId, "/projects/import", {}, new URLSearchParams({ bundle_text: text, identifier: "refused" }));
    expect(refused.status).toBe(400);
    expect(projectCount()).toBe(before);

    expect((await call(importRoute.loader, adminId, "/projects/import", {})).data).toEqual({ canImport: true });
    expect((await call(importRoute.loader, memberId, "/projects/import", {})).data).toEqual({ canImport: false });
  });
});
