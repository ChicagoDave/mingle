/**
 * Behavioral tests for the site chrome (P-16, Phase 1).
 *
 * Derived from app/shell/site-context.server.ts (what the shell knows
 * about a request: the signed-in user, the project the URL is inside,
 * the legacy display-tab set and which tab is current, and the
 * sign-in page's header-less rendering) and app/components/
 * site-chrome.tsx (the legacy application.rhtml structure: #header
 * with logo, project name, user menu and #hd-nav tab bar; #bd > #main
 * > .main_inner > #flash ahead of the page; the #ft footbar). This is
 * the phase exit criterion: a signed-in project page's HTML carries
 * the header, the tab bar, and the footer.
 *
 * Each test drives the real root route's `loader` with a `Request`
 * carrying a real signed session cookie, then renders `SiteChrome`
 * with that loader payload to static HTML — the same markup the
 * server sends — and asserts on the ids, classes, links, and text the
 * legacy layout carries. Runs against a real, file-backed SQLite
 * database opened through the app's own client module with the real
 * migrations; favorites and tabs are seeded through the real commands.
 *
 * Owner context: application shell verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SiteContext } from "../app/shared/wire-types";

const dir = mkdtempSync(join(tmpdir(), "mingle-site-chrome-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "site-chrome-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const root = await import("../app/root");
const { SiteChrome } = await import("../app/components/site-chrome");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { makeFavoriteTab, saveFavorite } = await import("../app/domain/cards/favorites.server");

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
let projectId: number;
let tabFavoriteId: number;
let plainFavoriteId: number;
const identifier = "chrome";

beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "ada", name: "Ada Lovelace", email: "ada@example.test", password: "site-chrome-1!" }),
    "admin",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "Chrome Project", identifier, actorUserId: adminId }),
    "project",
  ).id;
  const view = { projectId, filters: [], columns: [], groupBy: "", personal: false, actorUserId: adminId };
  tabFavoriteId = mustOk(saveFavorite(db, { ...view, name: "Open work", style: "grid" }), "tab favorite").id;
  mustOk(makeFavoriteTab(db, { projectId, favoriteId: tabFavoriteId, actorUserId: adminId }), "make tab");
  plainFavoriteId = mustOk(saveFavorite(db, { ...view, name: "Plain", style: "list" }), "plain favorite").id;
  mustOk(saveFavorite(db, { ...view, name: "Mine", style: "list", personal: true }), "personal favorite");
});

async function cookieFor(userId: number): Promise<string> {
  return (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
}

/** Drives the real root loader for a path, signed in as `userId` when given. */
async function contextFor(path: string, userId: number | null = adminId): Promise<SiteContext> {
  const headers: Record<string, string> = {};
  if (userId !== null) headers.Cookie = await cookieFor(userId);
  const request = new Request(`http://localhost${path}`, { headers });
  return (await root.loader({ request, params: {}, context: {} } as never)) as SiteContext;
}

/** Renders the shell around a marker page to the HTML the server would send. */
function html(context: SiteContext, path: string): string {
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <SiteChrome context={context}>
        <main id="the-page">page body</main>
      </SiteChrome>
    </StaticRouter>,
  );
}

describe("site chrome on a signed-in project page", () => {
  it("renders the header, the project tab bar, the page, and the footer", async () => {
    const path = `/projects/${identifier}/cards`;
    const context = await contextFor(path);
    const markup = html(context, path);

    // Header (_application_hd.rhtml): logo home link, project name, user menu.
    expect(markup).toContain('id="header"');
    expect(markup).toContain('<div id="project-list"><a class="logo" href="/projects"');
    expect(markup).toContain('<img src="/images/logo.png" alt="Mingle"/>');
    expect(markup).toContain(`<span class="header-name"><a href="/projects/${identifier}/cards"`);
    expect(markup).toContain(">Chrome Project</a></span>");
    expect(markup).toContain('id="current-user"');
    expect(markup).toContain("<span>Ada Lovelace</span>");
    expect(markup).toContain('<li class="logout"><a href="/logout" id="logout"');
    expect(markup).toContain(">Sign out</a>");
    expect(markup).not.toContain('id="nav-login"');
    // Project header actions (_header_actions.rhtml).
    expect(markup).toMatch(new RegExp(`<a href="/projects/${identifier}/murmurs"[^>]*>Murmurs</a>`));
    expect(markup).toMatch(new RegExp(`<a href="/projects/${identifier}/settings"[^>]*>Project admin</a>`));
    // Tab bar (_tabs.rhtml) inside the header wrapper.
    expect(markup.indexOf('id="hd-nav"')).toBeGreaterThan(markup.indexOf('id="header_wrapper"'));
    expect(markup).toContain('<ul class="sortable-tabs">');
    // Body: #bd > #main.page-content > .main_inner > #flash then the page.
    expect(markup).toContain('<div id="bd"><div class="page-content" id="main"><div class="main_inner"><div id="flash"></div><main id="the-page">page body</main>');
    // Footbar (_footbar.rhtml) after the body.
    expect(markup.indexOf('id="ft"')).toBeGreaterThan(markup.indexOf('id="the-page"'));
    expect(markup).toContain('<ul id="support" class="clearfix">');
    expect(markup).toContain(`Copyright 2007-${new Date().getFullYear()} ThoughtWorks, Inc.`);
  });

  it("lists the legacy display tabs in order: Overview, tab favorites, Dependencies, All, History", async () => {
    const context = await contextFor(`/projects/${identifier}/cards`);
    expect(context.project).toEqual({ name: "Chrome Project", identifier });
    expect(context.tabs.map((t) => [t.htmlId, t.name, t.kind, t.href])).toEqual([
      ["tab_overview", "Overview", "overview", `/projects/${identifier}/wiki/Overview_Page`],
      ["tab_open_work", "Open work", "grid", `/projects/${identifier}/cards/grid?favorite_id=${tabFavoriteId}`],
      ["tab_dependencies", "Dependencies", "dependencies", `/projects/${identifier}/dependencies`],
      ["tab_all", "All", "all", `/projects/${identifier}/cards`],
      ["tab_history", "History", "history", `/projects/${identifier}/history`],
    ]);
    // A team favorite that is not a tab, and a personal favorite, never become tabs.
    expect(context.tabs.some((t) => t.href.includes(`favorite_id=${plainFavoriteId}`))).toBe(false);
    expect(context.tabs.some((t) => t.name === "Mine")).toBe(false);
  });

  it("marks the All tab current on the card list and renders it with the legacy classes", async () => {
    const path = `/projects/${identifier}/cards`;
    const context = await contextFor(path);
    expect(context.tabs.filter((t) => t.current).map((t) => t.name)).toEqual(["All"]);
    const markup = html(context, path);
    expect(markup).toContain('<li id="tab_all" class="current-menu-item all-tab" data-tab-name="All">');
    expect(markup).toMatch(new RegExp(`<a id="tab_all_link" title="All" role="tab-name" href="/projects/${identifier}/cards"[^>]*>All</a>`));
    expect(markup).toContain('<li id="tab_open_work" class="menu-item grid-tab" data-tab-name="Open work">');
  });

  it("marks the favorite's tab current when the view carries its favorite_id", async () => {
    const path = `/projects/${identifier}/cards/grid?favorite_id=${tabFavoriteId}`;
    const context = await contextFor(path);
    expect(context.tabs.filter((t) => t.current).map((t) => t.name)).toEqual(["Open work"]);
    expect(html(context, path)).toContain('<li id="tab_open_work" class="current-menu-item grid-tab"');
  });

  it("marks History, Dependencies, and Overview current on their own pages", async () => {
    const current = async (rest: string) =>
      (await contextFor(`/projects/${identifier}${rest}`)).tabs.filter((t) => t.current).map((t) => t.name);
    expect(await current("/history")).toEqual(["History"]);
    expect(await current("/dependencies")).toEqual(["Dependencies"]);
    expect(await current("/dependencies/3")).toEqual(["Dependencies"]);
    expect(await current("/wiki/Overview_Page")).toEqual(["Overview"]);
    expect(await current("/settings")).toEqual([]);
  });
});

describe("site chrome outside a project", () => {
  it("renders the plain logo header without a tab bar on the project list", async () => {
    const context = await contextFor("/projects");
    expect(context.project).toBeNull();
    expect(context.tabs).toEqual([]);
    const markup = html(context, "/projects");
    expect(markup).toContain('<a id="logo_link" class="logo" href="/projects"');
    expect(markup).not.toContain('id="project-list"');
    expect(markup).not.toContain('id="hd-nav"');
    expect(markup).not.toContain("Project admin");
    expect(markup).toContain('id="ft"');
  });

  it("treats /projects/new and an unknown identifier as no project", async () => {
    expect((await contextFor("/projects/new")).project).toBeNull();
    const unknown = await contextFor("/projects/nope/cards");
    expect(unknown.project).toBeNull();
    expect(unknown.tabs).toEqual([]);
  });

  it("offers Sign in instead of the user menu to an anonymous visitor", async () => {
    const context = await contextFor("/projects", null);
    expect(context.user).toBeNull();
    const markup = html(context, "/projects");
    expect(markup).toMatch(/<ul class="login-panel"><li id="login"><a id="nav-login" [^>]*href="\/login"[^>]*>Sign in<\/a><\/li><\/ul>/);
    expect(markup).not.toContain('id="logout"');
  });

  it("renders the sign-in page without the header but with the footbar (legacy rendering_login?)", async () => {
    const context = await contextFor("/login", null);
    expect(context.renderingLogin).toBe(true);
    const markup = html(context, "/login");
    expect(markup).not.toContain('id="header"');
    expect(markup).toContain('id="the-page"');
    expect(markup).toContain('id="ft"');
  });
});
