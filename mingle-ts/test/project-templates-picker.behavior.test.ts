/**
 * Behavioral tests for the New Project template picker (P-5, project
 * templates Phase 5).
 *
 * Derived from the rule 12 Behavior Statement for the `/projects/new`
 * action: a template creates the project through ImportProject with
 * the entered name and identifier, Blank through CreateProject, both
 * under CreateProject's site-administrator checkpoint; the loader lists
 * the shipped templates from the templates directory. Assertions
 * re-read `projects`, `favorites`, `cards` and `pages`, drive the real
 * root loader for the tab bar and the real wiki route for the overview.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Projects verification.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-picker-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "picker-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const root = await import("../app/root");
const newRoute = await import("../app/routes/projects.new");
const wikiRoute = await import("../app/routes/projects.wiki.page");
const { cards } = await import("../app/db/schema/cards");
const { favorites } = await import("../app/db/schema/favorites");
const { pages } = await import("../app/db/schema/pages");
const { projects } = await import("../app/db/schema/projects");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { listTemplates, loadTemplate } = await import("../app/files/templates.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };
type SiteContext = { tabs: { name: string }[] };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.TEMPLATES_DIR;
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

const adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "picker-5!" }), "admin").id;
const memberId = mustOk(registerUser(db, { login: "member", name: "Member", password: "picker-5!" }), "member").id;

const cookieFor = async (userId: number) => (await createUserSession(userId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];

/** Posts the New Project form as `userId`; a thrown redirect comes back as its Response. */
async function post(userId: number, fields: Record<string, string>): Promise<Response | { errors: Record<string, string[]> }> {
  const request = new Request("http://localhost/projects/new", {
    method: "POST",
    headers: { Cookie: await cookieFor(userId), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  try {
    return (await newRoute.action({ request, params: {}, context: {} } as never)) as { errors: Record<string, string[]> };
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

const projectRows = () => db.select({ identifier: projects.identifier, name: projects.name, description: projects.description }).from(projects).orderBy(projects.id).all();

describe("the shipped template listing", () => {
  it("lists the templates directory's bundles and skips a file that is not a bundle", () => {
    expect(listTemplates()).toEqual([
      { identifier: "kanban", name: "Kanban", description: expect.stringContaining("Kanban board") },
    ]);
    expect(loadTemplate("kanban")?.source.identifier).toBe("kanban");
    expect(loadTemplate("../kanban")).toBeNull();
    expect(loadTemplate("nope")).toBeNull();

    const custom = mkdtempSync(join(dir, "templates-"));
    writeFileSync(join(custom, "broken.json"), "{not json");
    writeFileSync(join(custom, "zeta.json"), JSON.stringify({ ...loadTemplate("kanban"), source: { name: "Zeta", identifier: "zeta", description: null } }));
    writeFileSync(join(custom, "scrum.json"), JSON.stringify({ ...loadTemplate("kanban"), source: { name: "Scrum", identifier: "scrum", description: null } }));
    process.env.TEMPLATES_DIR = custom;
    // Legacy order (scrum before kanban) first, then alphabetical; the broken file is skipped.
    expect(listTemplates().map((t) => t.identifier)).toEqual(["scrum", "zeta"]);
    process.env.TEMPLATES_DIR = join(dir, "missing");
    expect(listTemplates()).toEqual([]);
  });
});

describe("/projects/new", () => {
  it("the loader offers the shipped templates to a signed-in user", async () => {
    const loaded = (await newRoute.loader({ request: new Request("http://localhost/projects/new", { headers: { Cookie: await cookieFor(memberId) } }), params: {}, context: {} } as never)) as {
      templates: { identifier: string }[];
    };
    expect(loaded.templates.map((t) => t.identifier)).toEqual(["kanban"]);
  });

  it("creates a project from the Kanban template with the entered name and identifier, whose first tab is the board and whose overview renders", async () => {
    const response = await post(adminId, { template: "kanban", name: "Team Board", identifier: "board", description: "Our flow" });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe("/projects/board/wiki/Overview_Page");
    expect(projectRows()).toEqual([{ identifier: "board", name: "Team Board", description: "Our flow" }]);
    const project = db.select().from(projects).where(eq(projects.identifier, "board")).get()!;
    expect(db.select({ name: favorites.name, tabView: favorites.tabView, wipLimits: favorites.wipLimits }).from(favorites).where(eq(favorites.projectId, project.id)).all()).toEqual([
      { name: "Kanban Board", tabView: true, wipLimits: '{"In Progress":2,"In Test":2}' },
    ]);
    expect(db.select({ name: cards.name }).from(cards).where(eq(cards.projectId, project.id)).all().map((c) => c.name)).toEqual(["Work 1", "Work 2", "Work 3", "Work 4"]);
    expect(db.select({ name: pages.name }).from(pages).where(eq(pages.projectId, project.id)).all().map((p) => p.name)).toEqual(["Overview Page"]);

    // The tab bar: Overview, then the template's tab.
    const context = (await root.loader({ request: new Request("http://localhost/projects/board/cards", { headers: { Cookie: await cookieFor(adminId) } }), params: {}, context: {} } as never)) as SiteContext;
    expect(context.tabs.slice(0, 2).map((tab) => tab.name)).toEqual(["Overview", "Kanban Board"]);

    // The overview renders through the real wiki route with the chart in it.
    const overview = await wikiRoute.loader({
      request: new Request("http://localhost/projects/board/wiki/Overview_Page", { headers: { Cookie: await cookieFor(adminId) } }),
      params: { identifier: "board", pagename: "Overview_Page" },
      context: {},
    } as never);
    const rendered = JSON.stringify(overview);
    expect(rendered).toContain("daily-history-chart");
    expect(rendered).toContain("<svg");
    expect(rendered).not.toContain("{{template:");
  });

  it("creates a blank project through CreateProject alone and redirects to its settings", async () => {
    const response = await post(adminId, { template: "blank", name: "Plain", identifier: "plain" });
    expect((response as Response).headers.get("Location")).toBe("/projects/plain/settings");
    const project = db.select().from(projects).where(eq(projects.identifier, "plain")).get()!;
    expect(db.select().from(favorites).where(eq(favorites.projectId, project.id)).all()).toEqual([]);
    expect(db.select().from(cards).where(eq(cards.projectId, project.id)).all()).toEqual([]);
    // An absent template field means Blank too (the form's default).
    const bare = await post(adminId, { name: "Bare" });
    expect((bare as Response).headers.get("Location")).toBe("/projects/bare/settings");
  });

  it("rejects an unknown template, a non-administrator on either path, and a taken identifier — creating nothing", async () => {
    const before = projectRows();
    expect(await post(adminId, { template: "nope", name: "X" })).toEqual({ errors: { template: ["is not one of the available templates"] } });
    const deniedTemplate = (await post(memberId, { template: "kanban", name: "Sneaky", identifier: "sneaky" })) as { errors: Record<string, string[]> };
    expect(Object.keys(deniedTemplate.errors)).toEqual(["project.authorization"]);
    const deniedBlank = (await post(memberId, { template: "blank", name: "Sneaky", identifier: "sneaky" })) as { errors: Record<string, string[]> };
    expect(Object.keys(deniedBlank.errors)).toEqual(["authorization"]);
    const taken = (await post(adminId, { template: "kanban", name: "Again", identifier: "board" })) as { errors: Record<string, string[]> };
    expect(taken.errors["project.identifier"]?.[0]).toMatch(/taken/);
    expect(projectRows()).toEqual(before);
  });
});
