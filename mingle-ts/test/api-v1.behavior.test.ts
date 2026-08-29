/**
 * HTTP-path tests for the public API v1 route modules (Phase 30).
 *
 * Each test drives an actual /api/v1 route module — its exported
 * `loader` or `action` — with a `Request` carrying a real bearer key
 * (or none, or only a session cookie), then asserts on rows reloaded
 * from the database and on the JSON the route answers. The domain
 * commands behind the routes have their own suites; this one pins the
 * adapter: authentication, status codes, the error envelope, body
 * parsing, name→id resolution, and the all-or-nothing card writes.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Public API (HTTP adapter) verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiAvailableTransition,
  ApiCard,
  ApiCardType,
  ApiCardWrite,
  ApiErrorBody,
  ApiProject,
  ApiPropertyDefinition,
  ApiTransition,
  ApiTransitionExecution,
} from "../app/shared/wire-types";

const dir = mkdtempSync(join(tmpdir(), "mingle-api-v1-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "api-v1-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const { sealer } = await import("../app/auth/sealer.server");
const projectsRoute = await import("../app/routes/api.v1.projects");
const projectRoute = await import("../app/routes/api.v1.projects.project");
const cardTypesRoute = await import("../app/routes/api.v1.projects.card-types");
const definitionsRoute = await import("../app/routes/api.v1.projects.property-definitions");
const transitionsRoute = await import("../app/routes/api.v1.projects.transitions");
const cardsRoute = await import("../app/routes/api.v1.projects.cards");
const cardRoute = await import("../app/routes/api.v1.projects.cards.card");
const cardTransitionsRoute = await import("../app/routes/api.v1.projects.cards.card.transitions");

const { projects } = await import("../app/db/schema/projects");
const { apiKeys, users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardPropertyValues, enumerationValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { transitionActions, transitionPrerequisites, transitions } = await import("../app/db/schema/transitions");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { generateApiKey, revokeApiKey } = await import("../app/domain/identity/api-keys.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition, setCardPropertyValue } = await import("../app/domain/cards/properties.server");
const { defineTransition } = await import("../app/domain/cards/transitions.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ fixtures

let adminId: number; //    site admin, project creator
let devId: number; //      full_member
let viewerId: number; //   readonly_member
let adminKey: string;
let devKey: string;
let viewerKey: string;
let projectId: number;
const identifier = "apiproj";
let statusId: number;
let ownerId: number;
let estimateId: number;
let stageId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function register(login: string): number {
  return mustOk(registerUser(db, { login, name: login.toUpperCase(), password: "api-v1-1!" }), login).id;
}

function keyFor(userId: number): string {
  return mustOk(generateApiKey(db, sealer, { userId, actorUserId: userId }), `key ${userId}`).key;
}

beforeEach(() => {
  for (const table of [
    jobs, domainEvents, transitionActions, transitionPrerequisites, transitions, cardPropertyValues,
    enumerationValues, propertyDefinitions, cardVersions, cards, cardTypes, teamMemberships, projects, apiKeys, users,
  ]) db.delete(table).run();
  adminId = register("admin");
  devId = register("dev");
  viewerId = register("viewer");
  adminKey = keyFor(adminId);
  devKey = keyFor(devId);
  viewerKey = keyFor(viewerId);
  projectId = mustOk(createProject(db, { name: "API Project", identifier, actorUserId: adminId }), "project").id;
  mustOk(addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }), "dev membership");
  mustOk(addTeamMember(db, { projectId, userId: viewerId, role: "readonly_member", actorUserId: adminId }), "viewer membership");
  const define = (input: Parameters<typeof definePropertyDefinition>[1]) =>
    mustOk(definePropertyDefinition(db, input), input.name).id;
  statusId = define({ projectId, name: "Status", kind: "enumerated", values: ["New", "Open", "Closed"], actorUserId: adminId });
  ownerId = define({ projectId, name: "Owner", kind: "user", actorUserId: adminId });
  estimateId = define({ projectId, name: "Estimate", kind: "number", actorUserId: adminId });
  stageId = define({ projectId, name: "Stage", kind: "enumerated", values: ["Todo", "Doing"], transitionOnly: true, actorUserId: adminId });
  mustOk(defineTransition(db, {
    projectId, name: "Open it",
    prerequisites: [{ kind: "has_specific_value", propertyDefinitionId: statusId, value: "New" }],
    actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" }],
    actorUserId: adminId,
  }), "Open it");
  mustOk(defineTransition(db, {
    projectId, name: "Assign",
    prerequisites: [{ kind: "has_specific_value", propertyDefinitionId: statusId, value: "Open" }],
    actions: [{ propertyDefinitionId: ownerId, inputMode: "user_input_required" }],
    actorUserId: adminId,
  }), "Assign");
  mustOk(defineTransition(db, {
    projectId, name: "Start",
    prerequisites: [],
    actions: [{ propertyDefinitionId: stageId, inputMode: "fixed", value: "Doing" }],
    actorUserId: adminId,
  }), "Start");
  db.delete(domainEvents).run();
});

const cardTypeId = () => db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
const reloadCard = (number: number) => db.select().from(cards).where(and(eq(cards.projectId, projectId), eq(cards.number, number))).get();
const storedValue = (cardId: number, definitionId: number) =>
  db.select({ value: cardPropertyValues.value }).from(cardPropertyValues)
    .where(and(eq(cardPropertyValues.cardId, cardId), eq(cardPropertyValues.propertyDefinitionId, definitionId))).get()?.value ?? null;
const versionsOf = (cardId: number) => db.select().from(cardVersions).where(eq(cardVersions.cardId, cardId)).orderBy(asc(cardVersions.version)).all();
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

function seedCard(name: string, values: Record<number, string> = {}): number {
  const card = mustOk(createCard(db, { projectId, name, cardTypeId: cardTypeId(), actorUserId: devId }), name);
  for (const [definitionId, value] of Object.entries(values))
    mustOk(setCardPropertyValue(db, { projectId, cardNumber: card.number, propertyDefinitionId: Number(definitionId), value, actorUserId: devId }), `${name}.${definitionId}`);
  return card.number;
}

// ------------------------------------------------------------- harness

interface Outcome<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

interface Call {
  method?: string;
  path: string;
  params?: Record<string, string>;
  /** A bearer key; null sends no Authorization header. */
  key: string | null;
  /** Extra headers (e.g. a session cookie). */
  headers?: Record<string, string>;
  /** JSON body (object) or a raw string body. */
  body?: unknown;
}

/** Invokes a route loader/action the way the framework would, returning the JSON outcome. */
async function call<T = unknown>(fn: (args: never) => Promise<unknown>, spec: Call): Promise<Outcome<T>> {
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  if (spec.key !== null) headers.Authorization = `Bearer ${spec.key}`;
  let body: string | undefined;
  if (spec.body !== undefined) {
    body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    headers["Content-Type"] = "application/json";
  }
  const request = new Request(`http://localhost${spec.path}`, { method: spec.method ?? (body === undefined ? "GET" : "POST"), headers, body });
  let response: Response;
  try {
    response = (await fn({ request, params: spec.params ?? { identifier }, context: {} } as never)) as Response;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as T };
}

const base = `/api/v1/projects/${identifier}`;

// ------------------------------------------------------- authentication

describe("bearer-key authentication", () => {
  it("answers 401 with a WWW-Authenticate challenge when no key is sent", async () => {
    const outcome = await call<ApiErrorBody>(projectsRoute.loader, { path: "/api/v1/projects", key: null });
    expect(outcome.status).toBe(401);
    expect(outcome.headers.get("WWW-Authenticate")).toContain('Bearer realm="mingle-api"');
    expect(outcome.body.error).toContain("Authorization: Bearer");
  });

  it("never accepts the browser session cookie in place of a key", async () => {
    const cookie = (await createUserSession(adminId, "/")).headers.get("Set-Cookie")!;
    const outcome = await call<ApiErrorBody>(projectsRoute.action, {
      path: "/api/v1/projects", key: null, headers: { Cookie: cookie }, body: { name: "Via cookie" },
    });
    expect(outcome.status).toBe(401);
    expect(db.select().from(projects).where(eq(projects.name, "Via cookie")).get()).toBeUndefined();
  });

  it("rejects a malformed, unknown, or revoked key with 401", async () => {
    for (const key of ["nonsense", "mgl_unknown-key-value"]) {
      const outcome = await call<ApiErrorBody>(projectsRoute.loader, { path: "/api/v1/projects", key });
      expect(outcome.status).toBe(401);
      expect(outcome.body.error).toBe("Invalid or revoked API key");
    }
    const row = db.select().from(apiKeys).where(eq(apiKeys.userId, devId)).get()!;
    mustOk(revokeApiKey(db, { apiKeyId: row.id, actorUserId: devId }), "revoke");
    expect((await call(projectsRoute.loader, { path: "/api/v1/projects", key: devKey })).status).toBe(401);
  });

  it("stamps the key's last use on an authenticated request", async () => {
    await call(projectsRoute.loader, { path: "/api/v1/projects", key: viewerKey });
    expect(db.select().from(apiKeys).where(eq(apiKeys.userId, viewerId)).get()!.lastUsedAt).not.toBeNull();
  });
});

// ------------------------------------------------------------ projects

describe("/api/v1/projects", () => {
  it("GET lists every project for any authenticated user", async () => {
    mustOk(createProject(db, { name: "Another", identifier: "another", actorUserId: adminId }), "another");
    const outcome = await call<ApiProject[]>(projectsRoute.loader, { path: "/api/v1/projects", key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get("Content-Type")).toContain("application/json");
    expect(outcome.body.map((p) => p.identifier)).toEqual(["another", identifier]);
    expect(outcome.body[1]).toMatchObject({ name: "API Project", description: null });
  });

  it("POST creates a project through CreateProject for a site admin — 201, row and default card type persisted", async () => {
    const outcome = await call<ApiProject>(projectsRoute.action, {
      path: "/api/v1/projects", key: adminKey, body: { name: "Created via API", description: "  from curl " },
    });
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ identifier: "created_via_api", name: "Created via API", description: "from curl" });
    const row = db.select().from(projects).where(eq(projects.identifier, "created_via_api")).get()!;
    expect(row.createdByUserId).toBe(adminId);
    expect(db.select().from(cardTypes).where(eq(cardTypes.projectId, row.id)).all().map((t) => t.name)).toEqual(["Card"]);
    expect(events("ProjectCreated").map((e) => e.aggregateId)).toEqual([row.id]);
  });

  it("POST by a non-admin is 403 with the checkpoint's message and writes nothing", async () => {
    const outcome = await call<ApiErrorBody>(projectsRoute.action, { path: "/api/v1/projects", key: devKey, body: { name: "Nope" } });
    expect(outcome.status).toBe(403);
    expect(outcome.body.errors?.authorization).toEqual(["requires Mingle administrator access"]);
    expect(db.select().from(projects).all()).toHaveLength(1);
  });

  it("POST with an invalid field is 422 carrying the command's field errors", async () => {
    const outcome = await call<ApiErrorBody>(projectsRoute.action, {
      path: "/api/v1/projects", key: adminKey, body: { name: "   ", identifier: "1bad" },
    });
    expect(outcome.status).toBe(422);
    expect(outcome.body.error).toBe("Validation failed");
    expect(outcome.body.errors?.name).toBeDefined();
  });

  it("POST with a malformed body or a wrongly typed field is 400", async () => {
    const malformed = await call<ApiErrorBody>(projectsRoute.action, { path: "/api/v1/projects", key: adminKey, body: "{not json" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe("Request body must be valid JSON");
    const list = await call<ApiErrorBody>(projectsRoute.action, { path: "/api/v1/projects", key: adminKey, body: "[1]" });
    expect(list.status).toBe(400);
    const typed = await call<ApiErrorBody>(projectsRoute.action, { path: "/api/v1/projects", key: adminKey, body: { name: 42 } });
    expect(typed.status).toBe(400);
    expect(typed.body.error).toBe("'name' is required and must be a string");
    expect(db.select().from(projects).all()).toHaveLength(1);
  });

  it("an unsupported method is 405 naming the allowed ones", async () => {
    const outcome = await call<ApiErrorBody>(projectsRoute.action, { method: "PUT", path: "/api/v1/projects", key: adminKey, body: { name: "x" } });
    expect(outcome.status).toBe(405);
    expect(outcome.headers.get("Allow")).toBe("GET, POST");
  });

  it("GET /:identifier answers the project, or 404", async () => {
    const found = await call<ApiProject>(projectRoute.loader, { path: base, key: viewerKey });
    expect(found.status).toBe(200);
    expect(found.body.identifier).toBe(identifier);
    const missing = await call<ApiErrorBody>(projectRoute.loader, { path: "/api/v1/projects/nope", params: { identifier: "nope" }, key: viewerKey });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("No project with identifier 'nope'");
  });
});

// ------------------------------------------ card types, definitions, transitions

describe("project sub-resources", () => {
  it("GET card_types lists the project's types in order", async () => {
    const outcome = await call<ApiCardType[]>(cardTypesRoute.loader, { path: `${base}/card_types`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.map((t) => t.name)).toEqual(["Card"]);
  });

  it("GET property_definitions presents kinds, enumerated values in order, and the transition-only flag", async () => {
    const outcome = await call<ApiPropertyDefinition[]>(definitionsRoute.loader, { path: `${base}/property_definitions`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.map((d) => [d.name, d.kind, d.transitionOnly])).toEqual([
      ["Status", "enumerated", false], ["Owner", "user", false], ["Estimate", "number", false], ["Stage", "enumerated", true],
    ]);
    expect(outcome.body[0].values).toEqual(["New", "Open", "Closed"]);
    expect(outcome.body[1].values).toBeUndefined();
  });

  it("POST property_definitions defines one through DefinePropertyDefinition — 201 and persisted; 403 below project admin", async () => {
    const created = await call<ApiPropertyDefinition>(definitionsRoute.action, {
      path: `${base}/property_definitions`, key: adminKey,
      body: { name: "Priority", kind: "enumerated", values: ["Low", "High"] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Priority", kind: "enumerated", values: ["Low", "High"] });
    const row = db.select().from(propertyDefinitions).where(and(eq(propertyDefinitions.projectId, projectId), eq(propertyDefinitions.name, "Priority"))).get()!;
    expect(db.select().from(enumerationValues).where(eq(enumerationValues.propertyDefinitionId, row.id)).all().map((v) => v.value)).toEqual(["Low", "High"]);

    const refused = await call<ApiErrorBody>(definitionsRoute.action, {
      path: `${base}/property_definitions`, key: devKey, body: { name: "Nope", kind: "text" },
    });
    expect(refused.status).toBe(403);
    expect(db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, "Nope")).get()).toBeUndefined();

    const badType = await call<ApiErrorBody>(definitionsRoute.action, {
      path: `${base}/property_definitions`, key: adminKey, body: { name: "X", kind: "enumerated", values: "Low,High" },
    });
    expect(badType.status).toBe(400);
  });

  it("GET transitions lists definitions with legacy one-line descriptions", async () => {
    const outcome = await call<ApiTransition[]>(transitionsRoute.loader, { path: `${base}/transitions`, key: viewerKey });
    expect(outcome.status).toBe(200);
    const byName = Object.fromEntries(outcome.body.map((t) => [t.name, t]));
    expect(byName["Open it"]).toMatchObject({ cardType: null, prerequisites: ["Has value of New for Status"], actions: ["Sets Status to Open"] });
    expect(byName["Assign"].actions).toEqual(["Sets Owner to (user input - required)"]);
  });
});

// --------------------------------------------------------------- cards

describe("/api/v1/projects/:identifier/cards", () => {
  it("POST creates the card and sets its properties by name in one transaction — user values by login", async () => {
    const outcome = await call<ApiCardWrite>(cardsRoute.action, {
      path: `${base}/cards`, key: devKey,
      body: { name: "Login page", description: "As a user…", properties: { Status: "Open", Owner: "dev", Estimate: "3" } },
    });
    expect(outcome.status).toBe(201);
    expect(outcome.body.appliedTransitions).toEqual([]);
    expect(outcome.body.card).toMatchObject({
      number: 1, name: "Login page", type: "Card",
      properties: { Status: "Open", Owner: "dev", Estimate: "3", Stage: null },
    });
    const row = reloadCard(1)!;
    expect(row.createdByUserId).toBe(devId);
    expect(storedValue(row.id, statusId)).toBe("Open");
    expect(storedValue(row.id, ownerId)).toBe(String(devId));
    expect(storedValue(row.id, estimateId)).toBe("3");
    // One creation version plus one per property set, as the card page would produce.
    expect(versionsOf(row.id).map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(row.version).toBe(4);
    expect(outcome.body.card.version).toBe(4);
    expect(events("CardCreated")).toHaveLength(1);
    expect(events("CardPropertyValueSet")).toHaveLength(3);
  });

  it("POST resolves the type by name (case-insensitively) and rejects an unknown one", async () => {
    const ok = await call<ApiCardWrite>(cardsRoute.action, { path: `${base}/cards`, key: devKey, body: { name: "Typed", type: "card" } });
    expect(ok.status).toBe(201);
    const bad = await call<ApiErrorBody>(cardsRoute.action, { path: `${base}/cards`, key: devKey, body: { name: "Typed", type: "Bug" } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors?.type).toEqual(["'Bug' is not a card type of this project"]);
  });

  it("POST with an unknown property, an invalid value, or an unknown login creates nothing (rolled back)", async () => {
    const unknown = await call<ApiErrorBody>(cardsRoute.action, {
      path: `${base}/cards`, key: devKey, body: { name: "Half", properties: { Status: "Open", Bogus: "x" } },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors?.["properties.Bogus"]).toEqual(["is not a property of this project"]);

    const invalid = await call<ApiErrorBody>(cardsRoute.action, {
      path: `${base}/cards`, key: devKey, body: { name: "Half", properties: { Status: "Done" } },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors?.["properties.Status"]).toEqual(["Status is restricted to New, Open, Closed"]);

    const nobody = await call<ApiErrorBody>(cardsRoute.action, {
      path: `${base}/cards`, key: devKey, body: { name: "Half", properties: { Owner: "nobody" } },
    });
    expect(nobody.status).toBe(422);
    expect(nobody.body.errors?.["properties.Owner"]).toEqual(["Owner: 'nobody' is not a valid user"]);

    expect(db.select().from(cards).all()).toHaveLength(0);
    expect(db.select().from(cardVersions).all()).toHaveLength(0);
    expect(events("CardCreated")).toHaveLength(0);
  });

  it("POST by a readonly member is 403 and creates nothing", async () => {
    const outcome = await call<ApiErrorBody>(cardsRoute.action, { path: `${base}/cards`, key: viewerKey, body: { name: "Nope" } });
    expect(outcome.status).toBe(403);
    expect(outcome.body.errors?.authorization).toEqual(["requires Team member access to this project"]);
    expect(db.select().from(cards).all()).toHaveLength(0);
  });

  it("GET lists cards newest first with properties by name", async () => {
    seedCard("First", { [statusId]: "New" });
    seedCard("Second", { [ownerId]: String(viewerId) });
    const outcome = await call<ApiCard[]>(cardsRoute.loader, { path: `${base}/cards`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.map((c) => [c.number, c.name])).toEqual([[2, "Second"], [1, "First"]]);
    expect(outcome.body[0].properties).toEqual({ Status: null, Owner: "viewer", Estimate: null, Stage: null });
    expect(outcome.body[1].properties.Status).toBe("New");
  });
});

describe("/api/v1/projects/:identifier/cards/:number", () => {
  it("GET answers the card, or 404 for an unknown or non-numeric number", async () => {
    const number = seedCard("Shown", { [estimateId]: "5" });
    const found = await call<ApiCard>(cardRoute.loader, { path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: viewerKey });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ number, name: "Shown", properties: { Estimate: "5" } });
    for (const bad of ["99", "abc"]) {
      const missing = await call<ApiErrorBody>(cardRoute.loader, { path: `${base}/cards/${bad}`, params: { identifier, number: bad }, key: viewerKey });
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe(`No card #${bad} in this project`);
    }
  });

  it("PATCH changes name and description through UpdateCard — one new version, row persisted", async () => {
    const number = seedCard("Before");
    const outcome = await call<ApiCardWrite>(cardRoute.action, {
      method: "PATCH", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: devKey,
      body: { name: "After", description: "now described" },
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.card).toMatchObject({ name: "After", description: "now described", version: 2 });
    const row = reloadCard(number)!;
    expect(row.name).toBe("After");
    expect(row.description).toBe("now described");
    expect(row.modifiedByUserId).toBe(devId);
    expect(versionsOf(row.id)).toHaveLength(2);
    expect(events("CardUpdated")).toHaveLength(1);
  });

  it("PATCH with only unchanged fields or an already-held value writes no version", async () => {
    const number = seedCard("Same", { [estimateId]: "8" });
    const before = reloadCard(number)!.version;
    const outcome = await call<ApiCardWrite>(cardRoute.action, {
      method: "PATCH", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: devKey,
      body: { name: "Same", properties: { Estimate: "8.0" } },
    });
    expect(outcome.status).toBe(200);
    expect(reloadCard(number)!.version).toBe(before);
    expect(events("CardUpdated")).toHaveLength(0);
  });

  it("PATCH on a transition-only property executes the producing transition (ADR-0008) and reports it", async () => {
    const number = seedCard("Workflow");
    const outcome = await call<ApiCardWrite>(cardRoute.action, {
      method: "PATCH", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: devKey,
      body: { properties: { Stage: "Doing" } },
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.appliedTransitions).toEqual(["Start"]);
    expect(outcome.body.card.properties.Stage).toBe("Doing");
    const row = reloadCard(number)!;
    expect(storedValue(row.id, stageId)).toBe("Doing");
    expect(events("TransitionExecuted")).toHaveLength(1);
    expect(events("CardPropertyValueSet")).toHaveLength(0);
  });

  it("PATCH by a readonly member is 403; a bad property rolls the whole request back", async () => {
    const number = seedCard("Guarded", { [estimateId]: "1" });
    const refused = await call<ApiErrorBody>(cardRoute.action, {
      method: "PATCH", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: viewerKey,
      body: { name: "Changed" },
    });
    expect(refused.status).toBe(403);
    expect(reloadCard(number)!.name).toBe("Guarded");

    const partial = await call<ApiErrorBody>(cardRoute.action, {
      method: "PATCH", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: devKey,
      body: { name: "Renamed", properties: { Estimate: "2", Status: "Bogus" } },
    });
    expect(partial.status).toBe(422);
    expect(partial.body.errors?.["properties.Status"]).toBeDefined();
    const row = reloadCard(number)!;
    expect(row.name).toBe("Guarded");
    expect(storedValue(row.id, estimateId)).toBe("1");
    expect(versionsOf(row.id)).toHaveLength(2);
  });

  it("DELETE removes the card through DeleteCard for a project admin (204) and refuses a full member (403)", async () => {
    const number = seedCard("Doomed");
    const cardId = reloadCard(number)!.id;
    const refused = await call<ApiErrorBody>(cardRoute.action, {
      method: "DELETE", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: devKey,
    });
    expect(refused.status).toBe(403);
    expect(reloadCard(number)).toBeDefined();

    const done = await call<null>(cardRoute.action, {
      method: "DELETE", path: `${base}/cards/${number}`, params: { identifier, number: String(number) }, key: adminKey,
    });
    expect(done.status).toBe(204);
    expect(done.body).toBeNull();
    expect(reloadCard(number)).toBeUndefined();
    const trail = versionsOf(cardId);
    expect(trail.at(-1)?.isDeletion).toBe(true);
    expect(events("CardDeleted")).toHaveLength(1);
  });
});

// --------------------------------------------------- card transitions

describe("/api/v1/projects/:identifier/cards/:number/transitions", () => {
  const params = (number: number) => ({ identifier, number: String(number) });

  it("GET lists the transitions the caller may execute now, with their inputs", async () => {
    const number = seedCard("Fresh", { [statusId]: "New" });
    const outcome = await call<ApiAvailableTransition[]>(cardTransitionsRoute.loader, { path: `${base}/cards/${number}/transitions`, params: params(number), key: devKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.map((t) => t.name)).toEqual(["Open it", "Start"]);
    expect(outcome.body[0].inputs).toEqual([]);

    mustOk(setCardPropertyValue(db, { projectId, cardNumber: number, propertyDefinitionId: statusId, value: "Open", actorUserId: devId }), "open");
    const later = await call<ApiAvailableTransition[]>(cardTransitionsRoute.loader, { path: `${base}/cards/${number}/transitions`, params: params(number), key: devKey });
    expect(later.body.map((t) => t.name)).toEqual(["Assign", "Start"]);
    expect(later.body[0].inputs).toEqual([{ property: "Owner", kind: "user", required: true }]);
  });

  it("POST executes a transition named by name — Status persisted, one version, TransitionExecuted", async () => {
    const number = seedCard("Moving", { [statusId]: "New" });
    const outcome = await call<ApiTransitionExecution>(cardTransitionsRoute.action, {
      path: `${base}/cards/${number}/transitions`, params: params(number), key: devKey, body: { transition: "open IT" },
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ transition: "Open it", changedProperties: ["Status"] });
    expect(outcome.body.card.properties.Status).toBe("Open");
    const row = reloadCard(number)!;
    expect(storedValue(row.id, statusId)).toBe("Open");
    expect(row.version).toBe(3);
    expect(events("TransitionExecuted")).toHaveLength(1);
  });

  it("POST executes a transition by id with user input keyed by property name — a user value given as a login", async () => {
    const number = seedCard("Assigning", { [statusId]: "Open" });
    const assignId = db.select({ id: transitions.id }).from(transitions).where(and(eq(transitions.projectId, projectId), eq(transitions.name, "Assign"))).get()!.id;
    const outcome = await call<ApiTransitionExecution>(cardTransitionsRoute.action, {
      path: `${base}/cards/${number}/transitions`, params: params(number), key: devKey,
      body: { transition: assignId, userInput: { Owner: "viewer" } },
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.card.properties.Owner).toBe("viewer");
    expect(storedValue(reloadCard(number)!.id, ownerId)).toBe(String(viewerId));
  });

  it("POST rejects a missing required input, an unknown input name or login, an unknown transition, and an inapplicable one — nothing changes", async () => {
    const number = seedCard("Stuck", { [statusId]: "Open" });
    const path = `${base}/cards/${number}/transitions`;
    const before = reloadCard(number)!.version;

    const missing = await call<ApiErrorBody>(cardTransitionsRoute.action, { path, params: params(number), key: devKey, body: { transition: "Assign" } });
    expect(missing.status).toBe(422);
    expect(JSON.stringify(missing.body.errors)).toContain("must not be empty");

    const badName = await call<ApiErrorBody>(cardTransitionsRoute.action, { path, params: params(number), key: devKey, body: { transition: "Assign", userInput: { Nope: "x" } } });
    expect(badName.status).toBe(422);
    expect(badName.body.errors?.["userInput.Nope"]).toEqual(["is not a property of this project"]);

    const badLogin = await call<ApiErrorBody>(cardTransitionsRoute.action, { path, params: params(number), key: devKey, body: { transition: "Assign", userInput: { Owner: "ghost" } } });
    expect(badLogin.status).toBe(422);
    expect(badLogin.body.errors?.["userInput.Owner"]).toEqual(["Owner: 'ghost' is not a valid user"]);

    const unknown = await call<ApiErrorBody>(cardTransitionsRoute.action, { path, params: params(number), key: devKey, body: { transition: "Teleport" } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors?.transition).toEqual(["'Teleport' is not a transition of this project"]);

    const inapplicable = await call<ApiErrorBody>(cardTransitionsRoute.action, { path, params: params(number), key: devKey, body: { transition: "Open it" } });
    expect(inapplicable.status).toBe(422);
    expect(JSON.stringify(inapplicable.body.errors)).toContain("not applicable");

    const absent = await call<ApiErrorBody>(cardTransitionsRoute.action, { path, params: params(number), key: devKey, body: {} });
    expect(absent.status).toBe(400);

    expect(reloadCard(number)!.version).toBe(before);
    expect(events("TransitionExecuted")).toHaveLength(0);
  });

  it("POST by a readonly member is 403", async () => {
    const number = seedCard("Locked", { [statusId]: "New" });
    const outcome = await call<ApiErrorBody>(cardTransitionsRoute.action, {
      path: `${base}/cards/${number}/transitions`, params: params(number), key: viewerKey, body: { transition: "Open it" },
    });
    expect(outcome.status).toBe(403);
    expect(storedValue(reloadCard(number)!.id, statusId)).toBe("New");
  });
});
