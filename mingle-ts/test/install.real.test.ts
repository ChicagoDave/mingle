/**
 * Real-path test for the one-command install (Phase 33 acceptance gate,
 * rule 13a — this phase is docker/deploy-shaped, so nothing is stubbed).
 *
 * Purpose: proves that `docker compose up` from this checkout builds
 * the production image, boots it healthy on its SQLite volume with the
 * migrations applied, and that a person (or script) at the other end
 * of plain HTTP can register, create a project, define a property and
 * a transition, create and edit a card, execute the transition, and
 * write a wiki page — then that every one of those is in the database
 * INSIDE the container, and still there after the stack is stopped and
 * started again without the volume being touched.
 *
 * Isolation: a random compose project name and host port, so a
 * developer's own `docker compose up` stack is left alone; the stack
 * and its volume are removed at the end.
 *
 * Precondition: a Docker daemon. Run via `npm run test:install` (also
 * part of `npm run test:realpath`). The first build compiles
 * better-sqlite3 inside the image and takes minutes.
 *
 * Owner context: infrastructure verification (packaging).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiCard, ApiCardWrite, ApiProject, ApiPropertyDefinition, ApiTransition, ApiTransitionExecution } from "../app/shared/wire-types";

const projectName = `mingle-install-${randomBytes(3).toString("hex")}`;
let port = 0;
let baseUrl = "";
let output = "";

/** Runs docker compose for this test's isolated project. */
function compose(args: string[], options: { timeoutMs?: number; env?: Record<string, string> } = {}): string {
  const result = execFileSync("docker", ["compose", "-p", projectName, "-f", "compose.yaml", ...args], {
    cwd: resolve("."),
    env: { ...process.env, MINGLE_PORT: String(port), SITE_URL: baseUrl, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 120_000,
    encoding: "utf8",
  });
  output += result;
  return result;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(found)));
    });
  });
}

beforeAll(async () => {
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  try {
    compose(["up", "-d", "--build", "--wait", "--wait-timeout", "300"], { timeoutMs: 15 * 60 * 1000 });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`docker compose up failed: ${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}, 16 * 60 * 1000);

afterAll(() => {
  try {
    compose(["down", "-v", "--remove-orphans"], { timeoutMs: 120_000 });
  } catch {
    // best effort: the volume is named after the random project, so a leak is visible in `docker volume ls`
  }
}, 180_000);

// ------------------------------------------------------------- http helpers

let cookie = "";
let apiKey = "";

/** A plain form POST as a browser would send it, with the session cookie. */
async function postForm(path: string, fields: Record<string, string>, redirect: "manual" | "follow" = "manual") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect,
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields),
  });
}

/**
 * `fetch` that survives a container restart: the keep-alive socket the
 * client pooled to the old container answers "other side closed" once,
 * and a fresh connection is only made on the next attempt.
 */
async function fetchRetrying(url: string, init?: RequestInit, attempts = 8): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

/** One API call with the bearer key. */
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetchRetrying(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Reads rows from the database file inside the running container — the volume, not a copy. */
function queryInsideContainer<T>(sql: string): T {
  const script = [
    "const Database = require('better-sqlite3');",
    "const db = new Database(process.env.DATABASE_FILE, { readonly: true });",
    `process.stdout.write(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));`,
  ].join(" ");
  const out = compose(["exec", "-T", "app", "node", "-e", script]);
  return JSON.parse(out.trim()) as T;
}

// -------------------------------------------------------------------- tests

describe("docker compose up from this checkout", () => {
  it("boots one healthy, unprivileged container whose /healthz round-trips the database on the volume", async () => {
    const containerId = compose(["ps", "-q", "app"]).trim();
    expect(containerId).not.toBe("");
    const health = execFileSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", containerId], { encoding: "utf8" }).trim();
    expect(health).toBe("healthy");
    expect(compose(["exec", "-T", "app", "id", "-un"]).trim()).toBe("mingle");
    expect(compose(["exec", "-T", "app", "sh", "-c", "ls /data"]).trim()).toContain("mingle.db");

    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { db: string }).db).toBe("connected");
    // Migrations were applied at boot — the newest tables exist.
    const tables = queryInsideContainer<{ name: string }[]>("select name from sqlite_master where type='table' order by name").map((t) => t.name);
    for (const table of ["users", "projects", "cards", "api_keys", "auth_configurations", "commit_links"]) expect(tables).toContain(table);
  }, 60_000);

  it("lets a person register, then create a project, a property, a transition, a card (created, edited, transitioned), and a wiki page — each persisted inside the container", async () => {
    // 1. Register the first user (the site admin) through the real form.
    const registered = await postForm("/register", { login: "installer", name: "Install Smoke", email: "installer@example.test", password: "install-1!" });
    expect(registered.status).toBe(302);
    const setCookie = registered.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("mingle_session=");
    cookie = setCookie.split(";")[0];

    // 2. Mint an API key from the profile page and read it off the page, as a person would.
    const profile = await postForm("/profile", { intent: "generate-api-key" }, "follow");
    expect(profile.status).toBe(200);
    const html = await profile.text();
    const match = /data-testid="generated-api-key">(mgl_[^<]+)</.exec(html);
    expect(match).not.toBeNull();
    apiKey = match![1];

    // 3. Project.
    const project = await api<ApiProject>("POST", "/api/v1/projects", { name: "Smoke", identifier: "smoke" });
    expect(project.status).toBe(201);

    // 4. Property, then a transition defined through the real transitions form.
    const status = await api<ApiPropertyDefinition>("POST", "/api/v1/projects/smoke/property_definitions", { name: "Status", kind: "enumerated", values: ["New", "Open"] });
    expect(status.status).toBe(201);
    const defined = await postForm("/projects/smoke/transitions", { intent: "create", name: "Open it", usedBy: "all", [`requires[${status.body.id}]`]: "New", [`sets[${status.body.id}]`]: "Open" }, "follow");
    expect(defined.status).toBe(200);
    const transitions = await api<ApiTransition[]>("GET", "/api/v1/projects/smoke/transitions");
    expect(transitions.body.map((t) => t.name)).toEqual(["Open it"]);

    // 5. Card: created, edited, transitioned.
    const created = await api<ApiCardWrite>("POST", "/api/v1/projects/smoke/cards", { name: "Smoke card", properties: { Status: "New" } });
    expect(created.status).toBe(201);
    expect(created.body.card.number).toBe(1);
    const edited = await api<ApiCardWrite>("PATCH", "/api/v1/projects/smoke/cards/1", { description: "edited over HTTP" });
    expect(edited.status).toBe(200);
    const executed = await api<ApiTransitionExecution>("POST", "/api/v1/projects/smoke/cards/1/transitions", { transition: "Open it" });
    expect(executed.status).toBe(200);
    expect(executed.body.card.properties.Status).toBe("Open");

    // 6. Wiki page through the real form, then read back through the real page.
    const page = await postForm("/projects/smoke/wiki/new", { name: "Runbook", content: "<p>Restart the app with docker compose</p>" });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("/projects/smoke/wiki/Runbook");
    const shown = await fetch(`${baseUrl}/projects/smoke/wiki/Runbook`, { headers: { Cookie: cookie } });
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("Restart the app with docker compose");

    // 7. Every step, read from the database file inside the container.
    const [user] = queryInsideContainer<{ login: string; admin: number }[]>("select login, admin from users where login='installer'");
    expect(user).toEqual({ login: "installer", admin: 1 });
    const [card] = queryInsideContainer<{ name: string; description: string; version: number }[]>(
      "select c.name, c.description, c.version from cards c join projects p on p.id=c.project_id where p.identifier='smoke' and c.number=1",
    );
    expect(card).toEqual({ name: "Smoke card", description: "edited over HTTP", version: 4 });
    const [value] = queryInsideContainer<{ value: string }[]>(
      "select v.value from card_property_values v join property_definitions d on d.id=v.property_definition_id join cards c on c.id=v.card_id where c.number=1 and d.name='Status'",
    );
    expect(value).toEqual({ value: "Open" });
    expect(queryInsideContainer<{ n: number }[]>("select count(*) as n from transitions where name='Open it'")[0].n).toBe(1);
    expect(queryInsideContainer<{ name: string }[]>("select name from pages where name='Runbook'")).toEqual([{ name: "Runbook" }]);
    expect(queryInsideContainer<{ n: number }[]>("select count(*) as n from domain_events where type='TransitionExecuted'")[0].n).toBe(1);
  }, 120_000);

  it("keeps everything across a stop and start — the volume is the install's state", async () => {
    compose(["down"], { timeoutMs: 120_000 }); // no -v: the volume stays
    compose(["up", "-d", "--wait", "--wait-timeout", "120"], { timeoutMs: 180_000 });
    const card = await api<ApiCard>("GET", "/api/v1/projects/smoke/cards/1");
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ name: "Smoke card", description: "edited over HTTP", properties: { Status: "Open" } });
    const page = await fetchRetrying(`${baseUrl}/projects/smoke/wiki/Runbook`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200); // the session secret persisted on the volume too — the old cookie still works
  }, 300_000);
});
