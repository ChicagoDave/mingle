/**
 * Real-path test for the public API v1 (Phase 30 acceptance gate).
 *
 * Purpose: proves an external HTTP client — not the app's own UI, not
 * the route modules called in-process — can create a project, create a
 * card, set a property, and execute a transition purely through
 * /api/v1, with each step verified against the persisted rows. The
 * app is the production build served by `react-router-serve`, started
 * as a separate process on a temp database; the test talks to it with
 * `fetch` over TCP and reads the SQLite file through its own
 * connection (WAL — multi-process reads are the deployment shape).
 *
 * Seeding: a site admin and their API key are written before the
 * server starts (registration and key generation are profile-page
 * flows, not API resources); a transition is defined the same way
 * mid-walk (the API lists and executes transitions but does not
 * define them). Everything else goes over HTTP.
 *
 * Precondition: `npm run build` must succeed (it is run here, so the
 * suite takes tens of seconds). Run via `npm run test:realpath`.
 *
 * Owner context: Public API verification.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import { domainEvents } from "../app/db/schema/events";
import { projects } from "../app/db/schema/projects";
import { cardPropertyValues, propertyDefinitions } from "../app/db/schema/properties";
import { generateApiKey } from "../app/domain/identity/api-keys.server";
import { createSealer } from "../app/domain/identity/sealer.server";
import { signRequest } from "../app/domain/identity/api-signing.server";
import { registerUser } from "../app/domain/identity/commands.server";
import { defineTransition } from "../app/domain/cards/transitions.server";
import type {
  ApiCardWrite,
  ApiErrorBody,
  ApiProject,
  ApiPropertyDefinition,
  ApiTransitionExecution,
} from "../app/shared/wire-types";

const dir = mkdtempSync(join(tmpdir(), "mingle-api-real-"));
const databaseFile = join(dir, "real.db");
const sqlite = new Database(databaseFile);
sqlite.pragma("journal_mode = WAL");
const db: BetterSQLite3Database = drizzle(sqlite);

let server: ChildProcess | undefined;
let baseUrl = "";
let adminId = 0;
let apiKey = "";
let signingSecret = "";
/** Must match the SESSION_SECRET the server is started with, so the server can open the signing secret. */
const sealer = createSealer("api-real-path-secret");

/** A free TCP port, released for the server to take. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

/** Polls /healthz until the server answers (or the deadline passes). */
async function waitForServer(url: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up: ${String(lastError)}`);
}

beforeAll(async () => {
  migrate(db, { migrationsFolder: "drizzle" });
  const admin = registerUser(db, { login: "apiadmin", name: "API Admin", password: "real-path-1!" });
  if (!admin.ok) throw new Error(JSON.stringify(admin.errors));
  adminId = admin.value.id;
  const key = generateApiKey(db, sealer, { userId: adminId, actorUserId: adminId });
  if (!key.ok) throw new Error(JSON.stringify(key.errors));
  apiKey = key.value.key;
  signingSecret = key.value.signingSecret;

  execFileSync("npm", ["run", "build"], { cwd: resolve("."), stdio: "pipe" });

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [resolve("node_modules/@react-router/serve/dist/cli.js"), resolve("build/server/index.js")],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOST: "127.0.0.1",
        DATABASE_FILE: databaseFile,
        SESSION_SECRET: "api-real-path-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  server.stdout?.on("data", (chunk) => (output += String(chunk)));
  server.stderr?.on("data", (chunk) => (output += String(chunk)));
  try {
    await waitForServer(baseUrl, 30_000);
  } catch (error) {
    throw new Error(`${String(error)}\n--- server output ---\n${output}`);
  }
}, 240_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => server!.once("exit", r));
  }
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One API call from the outside: bearer key, JSON in, JSON out. */
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

describe("an external HTTP client driving the built server through /api/v1", () => {
  it("is refused without a key, then creates a project, a card, sets a property, and executes a transition — each persisted", async () => {
    // Unauthenticated: the challenge, and nothing else.
    const anonymous = await fetch(`${baseUrl}/api/v1/projects`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("WWW-Authenticate")).toContain('Bearer realm="mingle-api"');

    // 1. Create a project.
    const project = await api<ApiProject>("POST", "/api/v1/projects", { name: "Real Path", identifier: "realpath" });
    expect(project.status).toBe(201);
    expect(project.body.identifier).toBe("realpath");
    const projectRow = db.select().from(projects).where(eq(projects.identifier, "realpath")).get()!;
    expect(projectRow).toBeDefined();
    expect(projectRow.createdByUserId).toBe(adminId);
    expect(db.select().from(cardTypes).where(eq(cardTypes.projectId, projectRow.id)).all().map((t) => t.name)).toEqual(["Card"]);

    // 2. Define a property, then create a card carrying a value for it.
    const status = await api<ApiPropertyDefinition>("POST", "/api/v1/projects/realpath/property_definitions", {
      name: "Status", kind: "enumerated", values: ["New", "Open"],
    });
    expect(status.status).toBe(201);
    const statusRow = db.select().from(propertyDefinitions)
      .where(and(eq(propertyDefinitions.projectId, projectRow.id), eq(propertyDefinitions.name, "Status"))).get()!;
    expect(statusRow.id).toBe(status.body.id);

    const created = await api<ApiCardWrite>("POST", "/api/v1/projects/realpath/cards", {
      name: "First card over HTTP", properties: { Status: "New" },
    });
    expect(created.status).toBe(201);
    expect(created.body.card.number).toBe(1);
    const cardRow = db.select().from(cards).where(and(eq(cards.projectId, projectRow.id), eq(cards.number, 1))).get()!;
    expect(cardRow.name).toBe("First card over HTTP");
    const valueOf = () =>
      db.select({ value: cardPropertyValues.value }).from(cardPropertyValues)
        .where(and(eq(cardPropertyValues.cardId, cardRow.id), eq(cardPropertyValues.propertyDefinitionId, statusRow.id))).get()?.value;
    expect(valueOf()).toBe("New");

    // 3. Set a property on the existing card.
    const estimate = await api<ApiPropertyDefinition>("POST", "/api/v1/projects/realpath/property_definitions", { name: "Estimate", kind: "number" });
    expect(estimate.status).toBe(201);
    const patched = await api<ApiCardWrite>("PATCH", "/api/v1/projects/realpath/cards/1", { properties: { Estimate: "13" } });
    expect(patched.status).toBe(200);
    expect(patched.body.card.properties).toMatchObject({ Status: "New", Estimate: "13" });
    const estimateValue = db.select({ value: cardPropertyValues.value }).from(cardPropertyValues)
      .where(and(eq(cardPropertyValues.cardId, cardRow.id), eq(cardPropertyValues.propertyDefinitionId, estimate.body.id))).get()?.value;
    expect(estimateValue).toBe("13");

    // 4. Execute a transition (defined through the domain, as the UI would; executed over HTTP).
    const defined = defineTransition(db, {
      projectId: projectRow.id, name: "Open it",
      prerequisites: [{ kind: "has_specific_value", propertyDefinitionId: statusRow.id, value: "New" }],
      actions: [{ propertyDefinitionId: statusRow.id, inputMode: "fixed", value: "Open" }],
      actorUserId: adminId,
    });
    if (!defined.ok) throw new Error(JSON.stringify(defined.errors));
    const executed = await api<ApiTransitionExecution>("POST", "/api/v1/projects/realpath/cards/1/transitions", { transition: "Open it" });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ transition: "Open it", changedProperties: ["Status"] });
    expect(valueOf()).toBe("Open");
    const versions = db.select().from(cardVersions).where(eq(cardVersions.cardId, cardRow.id)).all();
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    const executions = db.select().from(domainEvents).where(eq(domainEvents.type, "TransitionExecuted")).all();
    expect(executions).toHaveLength(1);
    expect(executions[0].actorUserId).toBe(adminId);

    // A second execution is refused by the same rule the UI applies, and changes nothing.
    const again = await api<ApiErrorBody>("POST", "/api/v1/projects/realpath/cards/1/transitions", { transition: "Open it" });
    expect(again.status).toBe(422);
    expect(valueOf()).toBe("Open");

    // 5. Phase 31: an HMAC-signed request is accepted; an incorrectly signed one is rejected.
    const signedPath = "/api/v1/projects/realpath/cards/1";
    const good = await fetch(`${baseUrl}${signedPath}`, { headers: signRequest({ login: "apiadmin", secret: signingSecret, method: "GET", url: signedPath }) });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { name: string }).name).toBe("First card over HTTP");
    const bad = await fetch(`${baseUrl}${signedPath}`, { headers: signRequest({ login: "apiadmin", secret: "not-the-secret", method: "GET", url: signedPath }) });
    expect(bad.status).toBe(401);
    const signedBody = JSON.stringify({ name: "Renamed by signature" });
    const patched2 = await fetch(`${baseUrl}${signedPath}`, {
      method: "PATCH",
      headers: { ...signRequest({ login: "apiadmin", secret: signingSecret, method: "PATCH", url: signedPath, body: signedBody }), "Content-Type": "application/json" },
      body: signedBody,
    });
    expect(patched2.status).toBe(200);
    expect(db.select().from(cards).where(eq(cards.id, cardRow.id)).get()!.name).toBe("Renamed by signature");
  }, 60_000);
});
