/**
 * Site context — the read model behind the application shell (P-16).
 *
 * Purpose: computes, for one request, everything the legacy
 * layouts/application.rhtml needed from its controller: the signed-in
 * user (shared/_profile_utilities.rhtml), the selected project
 * (`project_selected?` — derived here from the `/projects/:identifier`
 * URL prefix the way the legacy router set `@project`), the project's
 * display tabs (models/display_tabs.rb: Overview, the team favorites
 * promoted to tabs, Dependencies, All, History — Source is not carried,
 * the port has no repository integration), which tab is current, and
 * whether the sign-in page is rendering (`rendering_login?`, which
 * suppresses the header). Purely a read: no state changes, no events.
 *
 * Public interface: `loadSiteContext` (its result type `SiteContext`
 * lives in app/shared/wire-types.ts so the shell component can import
 * it without touching a server module).
 *
 * Owner context: application shell (HTTP adapter read model).
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import { projects } from "~/db/schema/projects";
import { listFavorites, favoriteHref } from "~/domain/cards/favorites.server";
import { getUserId } from "~/auth/session.server";
import type { SiteContext, SiteTab } from "~/shared/wire-types";

/** Route segments under /projects/ that are not project identifiers. */
const NON_PROJECT_SEGMENTS = new Set(["new", "import"]);

/**
 * Legacy `html_id`: the tab name lowercased with runs of whitespace
 * collapsed to underscores, prefixed `tab_`.
 */
function tabHtmlId(name: string): string {
  return `tab_${name.toLowerCase().replace(/\s+/g, "_")}`;
}

/**
 * Builds the project's display tabs in legacy order and marks the one
 * the request is on.
 */
function projectTabs(
  db: BetterSQLite3Database,
  project: { id: number; identifier: string },
  url: URL,
  viewerUserId: number | null,
): SiteTab[] {
  const base = `/projects/${project.identifier}`;
  const rest = url.pathname.slice(base.length);
  const favoriteId = url.searchParams.get("favorite_id");
  const onCards = rest === "/cards" || rest.startsWith("/cards/");

  const saved = listFavorites(db, project.id, viewerUserId ?? -1).tabs.map(
    (favorite): SiteTab => ({
      htmlId: tabHtmlId(favorite.name),
      name: favorite.name,
      href: favoriteHref(project.identifier, favorite),
      kind: favorite.style === "grid" ? "grid" : "list",
      current: onCards && favoriteId === String(favorite.id),
    }),
  );

  return [
    {
      htmlId: "tab_overview",
      name: "Overview",
      // Legacy Project::OVERVIEW_PAGE_IDENTIFIER — the page named "Overview Page".
      href: `${base}/wiki/Overview_Page`,
      kind: "overview",
      current: rest === "/wiki/Overview_Page",
    },
    ...saved,
    {
      htmlId: "tab_dependencies",
      name: "Dependencies",
      href: `${base}/dependencies`,
      kind: "dependencies",
      current: rest === "/dependencies" || rest.startsWith("/dependencies/"),
    },
    {
      htmlId: "tab_all",
      name: "All",
      href: `${base}/cards`,
      kind: "all",
      current: onCards && favoriteId === null,
    },
    {
      htmlId: "tab_history",
      name: "History",
      href: `${base}/history`,
      kind: "history",
      current: rest === "/history",
    },
  ];
}

/**
 * Computes the shell's context for a request.
 *
 * @param db - Drizzle handle
 * @param request - the incoming request (cookie and URL are read)
 * @returns the signed-in user, selected project, tabs, and login flag;
 *   an unknown project identifier yields `project: null` and no tabs
 *   (the page route owns the 404)
 */
export async function loadSiteContext(
  db: BetterSQLite3Database,
  request: Request,
): Promise<SiteContext> {
  const url = new URL(request.url);
  const userId = await getUserId(request);

  const user =
    userId === null
      ? null
      : (db
          .select({ id: users.id, name: users.name, login: users.login, admin: users.admin })
          .from(users)
          .where(eq(users.id, userId))
          .get() ?? null);

  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(url.pathname);
  const identifier =
    match && !NON_PROJECT_SEGMENTS.has(match[1]) ? decodeURIComponent(match[1]) : null;
  const project =
    identifier === null
      ? null
      : (db
          .select({ id: projects.id, name: projects.name, identifier: projects.identifier })
          .from(projects)
          .where(eq(projects.identifier, identifier))
          .get() ?? null);

  return {
    user,
    project: project ? { name: project.name, identifier: project.identifier } : null,
    tabs: project ? projectTabs(db, project, url, userId) : [],
    renderingLogin: url.pathname === "/login",
  };
}
