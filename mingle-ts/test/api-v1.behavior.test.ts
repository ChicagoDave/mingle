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
import { existsSync, readdirSync, statSync } from "node:fs";
import type {
  ApiAttachment,
  ApiAvailableTransition,
  ApiCard,
  ApiCardType,
  ApiCardWrite,
  ApiErrorBody,
  ApiMurmur,
  ApiPage,
  ApiProject,
  ApiPropertyDefinition,
  ApiTransition,
  ApiTransitionExecution,
  ApiWikiPage,
} from "../app/shared/wire-types";

const dir = mkdtempSync(join(tmpdir(), "mingle-api-v1-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "api-v1-suite-secret";
process.env.ATTACHMENTS_DIR = join(dir, "attachments");

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
const cardTypeRoute = await import("../app/routes/api.v1.projects.card-types.card-type");
const transitionRoute = await import("../app/routes/api.v1.projects.transitions.transition");
const pagesRoute = await import("../app/routes/api.v1.projects.pages");
const pageRoute = await import("../app/routes/api.v1.projects.pages.page");
const murmursRoute = await import("../app/routes/api.v1.projects.murmurs");
const murmurRoute = await import("../app/routes/api.v1.projects.murmurs.murmur");
const attachmentsRoute = await import("../app/routes/api.v1.projects.cards.card.attachments");
const attachmentRoute = await import("../app/routes/api.v1.projects.cards.card.attachments.attachment");

const { projects } = await import("../app/db/schema/projects");
const { apiKeys, users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardPropertyValues, enumerationValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { transitionActions, transitionPrerequisites, transitions } = await import("../app/db/schema/transitions");
const { pages, pageVersions } = await import("../app/db/schema/pages");
const { cardMurmurLinks, murmurMentions, murmurs } = await import("../app/db/schema/murmurs");
const { attachments } = await import("../app/db/schema/card-content");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { generateApiKey, revokeApiKey } = await import("../app/domain/identity/api-keys.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition, setCardPropertyValue } = await import("../app/domain/cards/properties.server");
const { defineTransition } = await import("../app/domain/cards/transitions.server");
const { defineCardType } = await import("../app/domain/cards/commands.server");
const { createPage } = await import("../app/domain/pages/commands.server");
const { postMurmur } = await import("../app/domain/murmurs/commands.server");

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
    jobs, domainEvents, attachments, cardMurmurLinks, murmurMentions, murmurs, pageVersions, pages,
    transitionActions, transitionPrerequisites, transitions, cardPropertyValues,
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
    const outcome = await call<ApiPage<ApiProject>>(projectsRoute.loader, { path: "/api/v1/projects", key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get("Content-Type")).toContain("application/json");
    expect(outcome.body.items.map((p) => p.identifier)).toEqual(["another", identifier]);
    expect(outcome.body.items[1]).toMatchObject({ name: "API Project", description: null });
    expect(outcome.body.nextCursor).toBeNull();
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
    const outcome = await call<ApiPage<ApiCardType>>(cardTypesRoute.loader, { path: `${base}/card_types`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.items.map((t) => t.name)).toEqual(["Card"]);
  });

  it("GET property_definitions presents kinds, enumerated values in order, and the transition-only flag", async () => {
    const outcome = await call<ApiPage<ApiPropertyDefinition>>(definitionsRoute.loader, { path: `${base}/property_definitions`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.items.map((d) => [d.name, d.kind, d.transitionOnly])).toEqual([
      ["Status", "enumerated", false], ["Owner", "user", false], ["Estimate", "number", false], ["Stage", "enumerated", true],
    ]);
    expect(outcome.body.items[0].values).toEqual(["New", "Open", "Closed"]);
    expect(outcome.body.items[1].values).toBeUndefined();
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
    const outcome = await call<ApiPage<ApiTransition>>(transitionsRoute.loader, { path: `${base}/transitions`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.items.map((t) => t.name)).toEqual(["Assign", "Open it", "Start"]);
    const byName = Object.fromEntries(outcome.body.items.map((t) => [t.name, t]));
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
    const outcome = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: `${base}/cards`, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.items.map((c) => [c.number, c.name])).toEqual([[2, "Second"], [1, "First"]]);
    expect(outcome.body.items[0].properties).toEqual({ Status: null, Owner: "viewer", Estimate: null, Stage: null });
    expect(outcome.body.items[1].properties.Status).toBe("New");
    expect(outcome.body.nextCursor).toBeNull();
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
    const outcome = await call<ApiPage<ApiAvailableTransition>>(cardTransitionsRoute.loader, { path: `${base}/cards/${number}/transitions`, params: params(number), key: devKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.items.map((t) => t.name)).toEqual(["Open it", "Start"]);
    expect(outcome.body.items[0].inputs).toEqual([]);

    mustOk(setCardPropertyValue(db, { projectId, cardNumber: number, propertyDefinitionId: statusId, value: "Open", actorUserId: devId }), "open");
    const later = await call<ApiPage<ApiAvailableTransition>>(cardTransitionsRoute.loader, { path: `${base}/cards/${number}/transitions`, params: params(number), key: devKey });
    expect(later.body.items.map((t) => t.name)).toEqual(["Assign", "Start"]);
    expect(later.body.items[0].inputs).toEqual([{ property: "Owner", kind: "user", required: true }]);
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

// ------------------------------------------- pagination and filters (P-1)

describe("collection pagination and card filters", () => {
  const pagePath = (path: string, query: Record<string, string>) => `${path}?${new URLSearchParams(query).toString()}`;

  it("walks a multi-page card list end to end through the cursor, newest first, unshifted by an insert mid-walk", async () => {
    for (const name of ["One", "Two", "Three", "Four", "Five"]) seedCard(name);
    const first = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: pagePath(`${base}/cards`, { limit: "2" }), key: viewerKey });
    expect(first.status).toBe(200);
    expect(first.body.items.map((c) => c.number)).toEqual([5, 4]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    // A card created between two requests lands on no page already walked and shifts nothing.
    seedCard("Six");

    const second = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: pagePath(`${base}/cards`, { limit: "2", cursor: first.body.nextCursor! }), key: viewerKey });
    expect(second.body.items.map((c) => c.number)).toEqual([3, 2]);
    expect(second.body.nextCursor).toEqual(expect.any(String));
    const third = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: pagePath(`${base}/cards`, { limit: "2", cursor: second.body.nextCursor! }), key: viewerKey });
    expect(third.body.items.map((c) => c.number)).toEqual([1]);
    expect(third.body.nextCursor).toBeNull();
    // Every card was seen exactly once across the walk, except the one inserted after the walk began.
    const seen = [...first.body.items, ...second.body.items, ...third.body.items].map((c) => c.number);
    expect(seen).toEqual([5, 4, 3, 2, 1]);
    // A fresh walk sees the new card first.
    const fresh = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: pagePath(`${base}/cards`, { limit: "1" }), key: viewerKey });
    expect(fresh.body.items.map((c) => c.number)).toEqual([6]);
  });

  it("pages every collection by its own order: projects by name, definitions by position, transitions by name", async () => {
    mustOk(createProject(db, { name: "Zeta", identifier: "zeta", actorUserId: adminId }), "zeta");
    mustOk(createProject(db, { name: "alpha", identifier: "alpha", actorUserId: adminId }), "alpha");
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Outcome<ApiPage<ApiProject>> = await call<ApiPage<ApiProject>>(projectsRoute.loader, { path: pagePath("/api/v1/projects", { limit: "2", ...(cursor ? { cursor } : {}) }), key: viewerKey });
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      names.push(...page.body.items.map((p) => p.name));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(names).toEqual(["alpha", "API Project", "Zeta"]);

    const definitions = await call<ApiPage<ApiPropertyDefinition>>(definitionsRoute.loader, { path: pagePath(`${base}/property_definitions`, { limit: "3" }), key: viewerKey });
    expect(definitions.body.items.map((d) => d.name)).toEqual(["Status", "Owner", "Estimate"]);
    const rest = await call<ApiPage<ApiPropertyDefinition>>(definitionsRoute.loader, { path: pagePath(`${base}/property_definitions`, { limit: "3", cursor: definitions.body.nextCursor! }), key: viewerKey });
    expect(rest.body.items.map((d) => d.name)).toEqual(["Stage"]);
    expect(rest.body.nextCursor).toBeNull();

    const transitions = await call<ApiPage<ApiTransition>>(transitionsRoute.loader, { path: pagePath(`${base}/transitions`, { limit: "2" }), key: viewerKey });
    expect(transitions.body.items.map((t) => t.name)).toEqual(["Assign", "Open it"]);
    const lastTransitions = await call<ApiPage<ApiTransition>>(transitionsRoute.loader, { path: pagePath(`${base}/transitions`, { limit: "2", cursor: transitions.body.nextCursor! }), key: viewerKey });
    expect(lastTransitions.body.items.map((t) => t.name)).toEqual(["Start"]);

    const types = await call<ApiPage<ApiCardType>>(cardTypesRoute.loader, { path: pagePath(`${base}/card_types`, { limit: "1" }), key: viewerKey });
    expect(types.body.items.map((t) => t.name)).toEqual(["Card"]);
    expect(types.body.nextCursor).toBeNull();

    const number = seedCard("Paged", { [statusId]: "New" });
    const available = await call<ApiPage<ApiAvailableTransition>>(cardTransitionsRoute.loader, { path: pagePath(`${base}/cards/${number}/transitions`, { limit: "1" }), key: devKey, params: { identifier, number: String(number) } });
    expect(available.body.items.map((t) => t.name)).toEqual(["Open it"]);
    const availableRest = await call<ApiPage<ApiAvailableTransition>>(cardTransitionsRoute.loader, { path: pagePath(`${base}/cards/${number}/transitions`, { limit: "1", cursor: available.body.nextCursor! }), key: devKey, params: { identifier, number: String(number) } });
    expect(availableRest.body.items.map((t) => t.name)).toEqual(["Start"]);
    expect(availableRest.body.nextCursor).toBeNull();
  });

  it("rejects a non-positive or non-numeric limit and a foreign cursor with 400, and clamps a huge limit", async () => {
    for (const limit of ["0", "-1", "abc", "1.5"]) {
      const outcome = await call<ApiErrorBody>(cardsRoute.loader, { path: pagePath(`${base}/cards`, { limit }), key: viewerKey });
      expect(outcome.status, `limit=${limit}`).toBe(400);
      expect(outcome.body.error).toContain("'limit'");
    }
    for (const cursor of ["not-a-cursor", Buffer.from('{"offset":3}').toString("base64url"), Buffer.from("[null]").toString("base64url")]) {
      const outcome = await call<ApiErrorBody>(projectsRoute.loader, { path: pagePath("/api/v1/projects", { cursor }), key: viewerKey });
      expect(outcome.status, `cursor=${cursor}`).toBe(400);
      expect(outcome.body.error).toContain("'cursor'");
    }
    for (let index = 0; index < 3; index += 1) seedCard(`Bulk ${index}`);
    const clamped = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: pagePath(`${base}/cards`, { limit: "99999" }), key: viewerKey });
    expect(clamped.status).toBe(200);
    expect(clamped.body.items).toHaveLength(3);
    expect(clamped.body.nextCursor).toBeNull();
  });

  it("filters the card list with the list page's filters[] and filters[mql] wire shapes, and rejects an invalid filter with 400", async () => {
    const open = seedCard("Open one", { [statusId]: "Open", [estimateId]: "8" });
    seedCard("New one", { [statusId]: "New", [estimateId]: "3" });
    const unset = seedCard("Unset one");

    const simple = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: `${base}/cards?filters[]=${encodeURIComponent("[Status][is][Open]")}`, key: viewerKey });
    expect(simple.status).toBe(200);
    expect(simple.body.items.map((c) => c.number)).toEqual([open]);

    const notSet = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: `${base}/cards?filters[]=${encodeURIComponent("[Status][is][]")}`, key: viewerKey });
    expect(notSet.body.items.map((c) => c.number)).toEqual([unset]);

    const combined = await call<ApiPage<ApiCard>>(cardsRoute.loader, {
      path: `${base}/cards?filters[]=${encodeURIComponent("[Status][is not][]")}&filters[]=${encodeURIComponent("[Estimate][is greater than][5]")}`,
      key: viewerKey,
    });
    expect(combined.body.items.map((c) => c.number)).toEqual([open]);

    const mql = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: `${base}/cards?${new URLSearchParams({ "filters[mql]": "Status = Open OR Estimate < 5" })}`, key: viewerKey });
    expect(mql.body.items.map((c) => c.name)).toEqual(["New one", "Open one"]);

    const paged = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: `${base}/cards?${new URLSearchParams({ "filters[]": "[Status][is not][]", limit: "1" })}`, key: viewerKey });
    expect(paged.body.items.map((c) => c.name)).toEqual(["New one"]);
    const pagedRest = await call<ApiPage<ApiCard>>(cardsRoute.loader, { path: `${base}/cards?${new URLSearchParams({ "filters[]": "[Status][is not][]", limit: "1", cursor: paged.body.nextCursor! })}`, key: viewerKey });
    expect(pagedRest.body.items.map((c) => c.name)).toEqual(["Open one"]);
    expect(pagedRest.body.nextCursor).toBeNull();

    const invalid = await call<ApiErrorBody>(cardsRoute.loader, { path: `${base}/cards?filters[]=${encodeURIComponent("[Nope][is][x]")}`, key: viewerKey });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid filters");
    expect(invalid.body.errors?.filters?.join(" ")).toMatch(/Nope/);
    const badMql = await call<ApiErrorBody>(cardsRoute.loader, { path: `${base}/cards?${new URLSearchParams({ "filters[mql]": "SELECT name" })}`, key: viewerKey });
    expect(badMql.status).toBe(400);
  });
});

// ----------------------------------------- definitions over the API (P-2)

describe("/api/v1/projects/:identifier/card_types — define and delete", () => {
  const cardTypeRows = () => db.select().from(cardTypes).where(eq(cardTypes.projectId, projectId)).orderBy(asc(cardTypes.position)).all();

  it("POST defines a card type through DefineCardType for a project admin — 201, row and event persisted", async () => {
    const outcome = await call<ApiCardType>(cardTypesRoute.action, { path: `${base}/card_types`, key: adminKey, body: { name: "Bug" } });
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ name: "Bug", position: 2 });
    expect(cardTypeRows().map((t) => t.name)).toEqual(["Card", "Bug"]);
    expect(events("CardTypeDefined")).toHaveLength(1);
  });

  it("POST applies the settings page's validation: a taken name is 422, a full member is 403, a bad body is 400", async () => {
    const taken = await call<ApiErrorBody>(cardTypesRoute.action, { path: `${base}/card_types`, key: adminKey, body: { name: "card" } });
    expect(taken.status).toBe(422);
    expect(taken.body.errors).toEqual({ name: ["has already been taken"] });
    const forbidden = await call<ApiErrorBody>(cardTypesRoute.action, { path: `${base}/card_types`, key: devKey, body: { name: "Bug" } });
    expect(forbidden.status).toBe(403);
    const bad = await call<ApiErrorBody>(cardTypesRoute.action, { path: `${base}/card_types`, key: adminKey, body: { name: 7 } });
    expect(bad.status).toBe(400);
    expect(cardTypeRows().map((t) => t.name)).toEqual(["Card"]);
  });

  it("GET /card_types/:id answers the type, or 404", async () => {
    const id = cardTypeId();
    const outcome = await call<ApiCardType>(cardTypeRoute.loader, { path: `${base}/card_types/${id}`, params: { identifier, id: String(id) }, key: viewerKey });
    expect(outcome.status).toBe(200);
    expect(outcome.body.name).toBe("Card");
    const missing = await call<ApiErrorBody>(cardTypeRoute.loader, { path: `${base}/card_types/999`, params: { identifier, id: "999" }, key: viewerKey });
    expect(missing.status).toBe(404);
  });

  it("DELETE removes an unused type through DeleteCardType with the transitions restricted to it — 204, rows gone, CardTypeDeleted", async () => {
    const bug = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug");
    const restricted = mustOk(defineTransition(db, {
      projectId, name: "Triage", cardTypeId: bug.id, prerequisites: [], actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" }], actorUserId: adminId,
    }), "Triage");
    const outcome = await call(cardTypeRoute.action, { path: `${base}/card_types/${bug.id}`, params: { identifier, id: String(bug.id) }, method: "DELETE", key: adminKey });
    expect(outcome.status).toBe(204);
    expect(cardTypeRows().map((t) => t.name)).toEqual(["Card"]);
    expect(db.select().from(transitions).where(eq(transitions.id, restricted.id)).all()).toEqual([]);
    expect(db.select().from(transitionActions).where(eq(transitionActions.transitionId, restricted.id)).all()).toEqual([]);
    expect(events("CardTypeDeleted")).toHaveLength(1);
    // The project's other transitions are untouched.
    expect(db.select().from(transitions).where(eq(transitions.projectId, projectId)).all().map((t) => t.name).sort()).toEqual(["Assign", "Open it", "Start"]);
  });

  it("DELETE refuses the last type and a type in use with legacy's message, a full member with 403, and deletes nothing", async () => {
    const only = cardTypeId();
    const last = await call<ApiErrorBody>(cardTypeRoute.action, { path: `${base}/card_types/${only}`, params: { identifier, id: String(only) }, method: "DELETE", key: adminKey });
    expect(last.status).toBe(422);
    expect(last.body.errors).toEqual({ cardType: ["Card cannot be deleted because it is being used or is the last card type."] });

    const bug = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug");
    mustOk(createCard(db, { projectId, name: "A bug", cardTypeId: bug.id, actorUserId: devId }), "bug card");
    const used = await call<ApiErrorBody>(cardTypeRoute.action, { path: `${base}/card_types/${bug.id}`, params: { identifier, id: String(bug.id) }, method: "DELETE", key: adminKey });
    expect(used.status).toBe(422);
    expect(used.body.errors?.cardType?.[0]).toBe("Bug cannot be deleted because it is being used or is the last card type.");

    const forbidden = await call<ApiErrorBody>(cardTypeRoute.action, { path: `${base}/card_types/${only}`, params: { identifier, id: String(only) }, method: "DELETE", key: devKey });
    expect(forbidden.status).toBe(403);
    expect(cardTypeRows().map((t) => t.name)).toEqual(["Card", "Bug"]);
    expect(events("CardTypeDeleted")).toHaveLength(0);
  });
});

describe("/api/v1/projects/:identifier/transitions — define and delete", () => {
  const prerequisitesOf = (transitionId: number) =>
    db.select().from(transitionPrerequisites).where(eq(transitionPrerequisites.transitionId, transitionId)).all();
  const actionsOf = (transitionId: number) =>
    db.select().from(transitionActions).where(eq(transitionActions.transitionId, transitionId)).all();

  it("POST defines a transition by property, card type, user, and group names through DefineTransition — 201 and persisted", async () => {
    const outcome = await call<ApiTransition>(transitionsRoute.action, {
      path: `${base}/transitions`, key: adminKey,
      body: {
        name: "Close it", cardType: "card",
        prerequisites: [{ property: "Status", value: "Open" }, { property: "Estimate", set: true }],
        actions: [{ property: "Status", value: "Closed" }, { property: "Owner", input: "optional" }],
        usedBy: { users: ["dev"] },
      },
    });
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({
      name: "Close it", cardType: "Card",
      prerequisites: ["Has value of Open for Status", "Has value set for Estimate", "User is DEV"],
      actions: ["Sets Status to Closed", "Sets Owner to (user input - optional)"],
    });
    const stored = db.select().from(transitions).where(and(eq(transitions.projectId, projectId), eq(transitions.name, "Close it"))).get()!;
    expect(stored.cardTypeId).toBe(cardTypeId());
    expect(prerequisitesOf(stored.id).map((p) => [p.kind, p.propertyDefinitionId, p.value, p.userId])).toEqual([
      ["has_specific_value", statusId, "Open", null], ["has_set_value", estimateId, null, null], ["is_user", null, null, devId],
    ]);
    expect(actionsOf(stored.id).map((a) => [a.propertyDefinitionId, a.inputMode, a.value])).toEqual([
      [statusId, "fixed", "Closed"], [ownerId, "user_input_optional", null],
    ]);
    expect(events("TransitionDefined")).toHaveLength(1);
  });

  it("POST stores a null prerequisite value as the nil-valued HasSpecificValue — the property must be unset (ADR-0010)", async () => {
    const outcome = await call<ApiTransition>(transitionsRoute.action, {
      path: `${base}/transitions`, key: adminKey,
      body: { name: "Begin", prerequisites: [{ property: "Status", value: null }], actions: [{ property: "Status", value: "New" }] },
    });
    expect(outcome.status).toBe(201);
    const stored = db.select().from(transitions).where(and(eq(transitions.projectId, projectId), eq(transitions.name, "Begin"))).get()!;
    expect(prerequisitesOf(stored.id).map((p) => [p.kind, p.value])).toEqual([["has_specific_value", null]]);
    // Round trip: the definition reads back with the nil requirement described, and the transition applies only to an unset card.
    const listed = await call<ApiPage<ApiTransition>>(transitionsRoute.loader, { path: `${base}/transitions`, key: viewerKey });
    expect(listed.body.items.find((t) => t.name === "Begin")!.prerequisites).toEqual([expect.stringMatching(/not set/i)]);
    const unset = seedCard("Blank");
    const withStatus = seedCard("Started", { [statusId]: "Open" });
    const forUnset = await call<ApiPage<ApiAvailableTransition>>(cardTransitionsRoute.loader, { path: `${base}/cards/${unset}/transitions`, params: { identifier, number: String(unset) }, key: devKey });
    expect(forUnset.body.items.map((t) => t.name)).toContain("Begin");
    const forSet = await call<ApiPage<ApiAvailableTransition>>(cardTransitionsRoute.loader, { path: `${base}/cards/${withStatus}/transitions`, params: { identifier, number: String(withStatus) }, key: devKey });
    expect(forSet.body.items.map((t) => t.name)).not.toContain("Begin");
  });

  it("POST rejects an invalid definition — unknown names are 422 under their field, the command's rules are 422, a malformed body is 400, a full member is 403 — and stores nothing", async () => {
    const before = db.select().from(transitions).where(eq(transitions.projectId, projectId)).all().length;
    const unknownProperty = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", prerequisites: [{ property: "Nope", value: "1" }], actions: [{ property: "Status", value: "Open" }] } });
    expect(unknownProperty.status).toBe(422);
    expect(unknownProperty.body.errors).toEqual({ prerequisites: ["unknown property 'Nope'"] });
    const unknownUser = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", actions: [{ property: "Status", value: "Open" }], usedBy: { users: ["ghost"] } } });
    expect(unknownUser.status).toBe(422);
    expect(unknownUser.body.errors).toEqual({ usedBy: ["unknown user 'ghost'"] });
    const unknownType = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", cardType: "Epic", actions: [{ property: "Status", value: "Open" }] } });
    expect(unknownType.status).toBe(422);
    expect(unknownType.body.errors).toEqual({ cardType: ["unknown card type 'Epic'"] });
    const noActions = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", actions: [] } });
    expect(noActions.status).toBe(422);
    expect(noActions.body.errors?.actions).toEqual(["Transition must set at least one property."]);
    const badValue = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", actions: [{ property: "Status", value: "Nonsense" }] } });
    expect(badValue.status).toBe(422);
    const malformed = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", actions: "Status" } });
    expect(malformed.status).toBe(400);
    const badInput = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: adminKey, body: { name: "X", actions: [{ property: "Status", input: "maybe" }] } });
    expect(badInput.status).toBe(400);
    const forbidden = await call<ApiErrorBody>(transitionsRoute.action, { path: `${base}/transitions`, key: devKey, body: { name: "X", actions: [{ property: "Status", value: "Open" }] } });
    expect(forbidden.status).toBe(403);
    expect(db.select().from(transitions).where(eq(transitions.projectId, projectId)).all().length).toBe(before);
  });

  it("GET /transitions/:id answers the definition; DELETE removes it through DeleteTransition (204) and refuses a full member", async () => {
    const openIt = db.select().from(transitions).where(and(eq(transitions.projectId, projectId), eq(transitions.name, "Open it"))).get()!;
    const shown = await call<ApiTransition>(transitionRoute.loader, { path: `${base}/transitions/${openIt.id}`, params: { identifier, id: String(openIt.id) }, key: viewerKey });
    expect(shown.status).toBe(200);
    expect(shown.body.name).toBe("Open it");
    const forbidden = await call<ApiErrorBody>(transitionRoute.action, { path: `${base}/transitions/${openIt.id}`, params: { identifier, id: String(openIt.id) }, method: "DELETE", key: devKey });
    expect(forbidden.status).toBe(403);
    const deleted = await call(transitionRoute.action, { path: `${base}/transitions/${openIt.id}`, params: { identifier, id: String(openIt.id) }, method: "DELETE", key: adminKey });
    expect(deleted.status).toBe(204);
    expect(db.select().from(transitions).where(eq(transitions.id, openIt.id)).all()).toEqual([]);
    expect(prerequisitesOf(openIt.id)).toEqual([]);
    expect(events("TransitionDeleted")).toHaveLength(1);
    const gone = await call<ApiErrorBody>(transitionRoute.loader, { path: `${base}/transitions/${openIt.id}`, params: { identifier, id: String(openIt.id) }, key: viewerKey });
    expect(gone.status).toBe(404);
  });
});

// -------------------------------------------- content over the API (P-3)

describe("/api/v1/projects/:identifier/pages", () => {
  it("POST creates a page through CreatePage — sanitized on the way in (ADR-0011), version 1 persisted, readable by identifier", async () => {
    const outcome = await call<ApiWikiPage>(pagesRoute.action, { path: `${base}/pages`, key: devKey, body: { name: "Release Notes", content: "<p>Hello <b>there</b></p><script>alert(1)</script><p onclick=\"x()\">click</p>" } });
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ identifier: "Release_Notes", name: "Release Notes", version: 1, createdBy: "dev", modifiedBy: "dev" });
    expect(outcome.body.content).not.toContain("<script");
    expect(outcome.body.content).not.toContain("onclick");
    expect(outcome.body.content).toContain("<b>there</b>");
    const stored = db.select().from(pages).where(and(eq(pages.projectId, projectId), eq(pages.name, "Release Notes"))).get()!;
    expect(stored.content).toBe(outcome.body.content);
    expect(db.select().from(pageVersions).where(eq(pageVersions.pageId, stored.id)).all()).toHaveLength(1);
    expect(events("PageCreated")).toHaveLength(1);

    const shown = await call<ApiWikiPage>(pageRoute.loader, { path: `${base}/pages/release_notes`, params: { identifier, pagename: "release_notes" }, key: viewerKey });
    expect(shown.status).toBe(200);
    expect(shown.body.name).toBe("Release Notes");
    const missing = await call<ApiErrorBody>(pageRoute.loader, { path: `${base}/pages/Nope`, params: { identifier, pagename: "Nope" }, key: viewerKey });
    expect(missing.status).toBe(404);
  });

  it("GET lists pages by name in pages; POST refuses a taken or invalid name (422) and a readonly member (403)", async () => {
    for (const name of ["Zebra", "alpha", "Middle"]) mustOk(createPage(db, { projectId, name, content: "<p>x</p>", actorUserId: devId }), name);
    const first = await call<ApiPage<ApiWikiPage>>(pagesRoute.loader, { path: `${base}/pages?limit=2`, key: viewerKey });
    expect(first.body.items.map((p) => p.name)).toEqual(["alpha", "Middle"]);
    const rest = await call<ApiPage<ApiWikiPage>>(pagesRoute.loader, { path: `${base}/pages?limit=2&cursor=${first.body.nextCursor}`, key: viewerKey });
    expect(rest.body.items.map((p) => p.name)).toEqual(["Zebra"]);
    expect(rest.body.nextCursor).toBeNull();

    const taken = await call<ApiErrorBody>(pagesRoute.action, { path: `${base}/pages`, key: devKey, body: { name: "ALPHA" } });
    expect(taken.status).toBe(422);
    expect(taken.body.errors?.name).toBeDefined();
    const slash = await call<ApiErrorBody>(pagesRoute.action, { path: `${base}/pages`, key: devKey, body: { name: "a/b" } });
    expect(slash.status).toBe(422);
    const forbidden = await call<ApiErrorBody>(pagesRoute.action, { path: `${base}/pages`, key: viewerKey, body: { name: "Mine" } });
    expect(forbidden.status).toBe(403);
    expect(db.select().from(pages).where(eq(pages.projectId, projectId)).all()).toHaveLength(3);
  });
});

describe("/api/v1/projects/:identifier/murmurs", () => {
  it("POST posts through PostMurmur — mentions and card links resolved at post time (ADR-0017), persisted, and reported", async () => {
    const number = seedCard("Referenced");
    const outcome = await call<ApiMurmur>(murmursRoute.action, { path: `${base}/murmurs`, key: devKey, body: { body: `Look at #${number} and #999 @viewer @nobody` } });
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ body: `Look at #${number} and #999 @viewer @nobody`, author: "dev", authorName: "DEV", cardNumber: null, mentions: ["viewer"], cards: [number] });
    const stored = db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).all();
    expect(stored).toHaveLength(1);
    expect(db.select().from(murmurMentions).where(eq(murmurMentions.murmurId, stored[0].id)).all().map((m) => m.userId)).toEqual([viewerId]);
    expect(db.select().from(cardMurmurLinks).where(eq(cardMurmurLinks.murmurId, stored[0].id)).all()).toHaveLength(1);
    expect(events("MurmurPosted")).toHaveLength(1);

    const shown = await call<ApiMurmur>(murmurRoute.loader, { path: `${base}/murmurs/${stored[0].id}`, params: { identifier, id: String(stored[0].id) }, key: viewerKey });
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual(outcome.body);
    const missing = await call<ApiErrorBody>(murmurRoute.loader, { path: `${base}/murmurs/999`, params: { identifier, id: "999" }, key: viewerKey });
    expect(missing.status).toBe(404);
  });

  it("GET lists newest first in pages; POST refuses a blank body (422) and a readonly member (403)", async () => {
    for (const body of ["first", "second", "third"]) mustOk(postMurmur(db, { projectId, body, actorUserId: devId }), body);
    const first = await call<ApiPage<ApiMurmur>>(murmursRoute.loader, { path: `${base}/murmurs?limit=2`, key: viewerKey });
    expect(first.body.items.map((m) => m.body)).toEqual(["third", "second"]);
    const rest = await call<ApiPage<ApiMurmur>>(murmursRoute.loader, { path: `${base}/murmurs?limit=2&cursor=${first.body.nextCursor}`, key: viewerKey });
    expect(rest.body.items.map((m) => m.body)).toEqual(["first"]);
    expect(rest.body.nextCursor).toBeNull();

    const blank = await call<ApiErrorBody>(murmursRoute.action, { path: `${base}/murmurs`, key: devKey, body: { body: "   " } });
    expect(blank.status).toBe(422);
    expect(blank.body.errors).toEqual({ body: ["can't be blank"] });
    const forbidden = await call<ApiErrorBody>(murmursRoute.action, { path: `${base}/murmurs`, key: viewerKey, body: { body: "psst" } });
    expect(forbidden.status).toBe(403);
    expect(db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).all()).toHaveLength(3);
  });
});

describe("/api/v1/projects/:identifier/cards/:number/attachments", () => {
  const attachmentsDir = process.env.ATTACHMENTS_DIR!;
  const storedFiles = (): string[] => {
    if (!existsSync(attachmentsDir)) return [];
    const walk = (dirPath: string): string[] =>
      readdirSync(dirPath).flatMap((entry) => {
        const full = join(dirPath, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    return walk(attachmentsDir);
  };

  async function upload(number: number, key: string, fileName: string, content: string, type = "text/plain") {
    const form = new FormData();
    form.set("file", new File([content], fileName, { type }));
    const request = new Request(`http://localhost${base}/cards/${number}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    let response: Response;
    try {
      response = (await attachmentsRoute.action({ request, params: { identifier, number: String(number) }, context: {} } as never)) as Response;
    } catch (thrown) {
      if (!(thrown instanceof Response)) throw thrown;
      response = thrown;
    }
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as ApiAttachment & ApiErrorBody };
  }

  it("POST stores the bytes and records them through AddCardAttachment — 201, row persisted, file on disk, bytes served back by url", async () => {
    const number = seedCard("Attach me");
    const outcome = await upload(number, devKey, "notes.txt", "hello attachments");
    expect(outcome.status).toBe(201);
    expect(outcome.body).toMatchObject({ fileName: "notes.txt", contentType: "text/plain", size: 17, cardVersion: 1, uploadedBy: "dev" });
    expect(outcome.body.url).toBe(`${base}/cards/${number}/attachments/${outcome.body.id}`);
    const row = db.select().from(attachments).where(eq(attachments.id, outcome.body.id)).get()!;
    expect(row.cardId).toBe(reloadCard(number)!.id);
    expect(storedFiles().map((f) => f.endsWith("/notes.txt"))).toEqual([true]);
    expect(events("CardAttachmentAdded")).toHaveLength(1);

    // `call` parses JSON; drive the loader directly for the bytes.
    const raw = (await attachmentRoute.loader({ request: new Request(`http://localhost${outcome.body.url}`, { headers: { Authorization: `Bearer ${viewerKey}` } }), params: { identifier, number: String(number), attachmentId: String(outcome.body.id) }, context: {} } as never)) as Response;
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("text/plain");
    expect(raw.headers.get("Content-Disposition")).toBe('attachment; filename="notes.txt"');
    expect(await raw.text()).toBe("hello attachments");
    const meta = await call<ApiAttachment>(attachmentRoute.loader, { path: outcome.body.url, params: { identifier, number: String(number), attachmentId: String(outcome.body.id) }, key: viewerKey, headers: { Accept: "application/json" } });
    expect(meta.body).toEqual(outcome.body);

    const listed = await call<ApiPage<ApiAttachment>>(attachmentsRoute.loader, { path: `${base}/cards/${number}/attachments`, params: { identifier, number: String(number) }, key: viewerKey });
    expect(listed.body.items).toEqual([outcome.body]);
  });

  it("POST by a readonly member is 403 and leaves no bytes behind; a non-multipart body is 400; an unknown attachment is 404", async () => {
    const number = seedCard("Guarded");
    rmSync(attachmentsDir, { recursive: true, force: true });
    const forbidden = await upload(number, viewerKey, "secret.txt", "nope");
    expect(forbidden.status).toBe(403);
    expect(storedFiles()).toEqual([]);
    expect(db.select().from(attachments).where(eq(attachments.projectId, projectId)).all()).toEqual([]);
    const notMultipart = await call<ApiErrorBody>(attachmentsRoute.action, { path: `${base}/cards/${number}/attachments`, params: { identifier, number: String(number) }, key: devKey, body: { file: "x" } });
    expect(notMultipart.status).toBe(400);
    const missing = await call<ApiErrorBody>(attachmentRoute.loader, { path: `${base}/cards/${number}/attachments/42`, params: { identifier, number: String(number), attachmentId: "42" }, key: devKey });
    expect(missing.status).toBe(404);
  });
});
