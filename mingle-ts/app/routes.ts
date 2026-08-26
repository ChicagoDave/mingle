/**
 * Route manifest — the single registry of every route in the app.
 *
 * Purpose: maps URL space to route modules (React Router framework mode).
 * Public interface: the default RouteConfig export consumed by the build.
 * Owner context: application shell.
 */
import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("register", "routes/register.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("profile", "routes/profile.tsx"),
  route("projects", "routes/projects.tsx"),
  route("projects/new", "routes/projects.new.tsx"),
  route("projects/:identifier/settings", "routes/projects.settings.tsx"),
  route("projects/:identifier/team", "routes/projects.team.tsx"),
  route("projects/:identifier/groups", "routes/projects.groups.tsx"),
  route("projects/:identifier/transitions", "routes/projects.transitions.tsx"),
  route("projects/:identifier/favorites", "routes/projects.favorites.tsx"),
  route(
    "projects/:identifier/favorites/:favoriteId",
    "routes/projects.favorites.show.ts",
  ),
  route("projects/:identifier/wiki", "routes/projects.wiki.tsx"),
  route("projects/:identifier/wiki/new", "routes/projects.wiki.new.tsx"),
  route("projects/:identifier/wiki/:pagename", "routes/projects.wiki.page.tsx"),
  route(
    "projects/:identifier/wiki/:pagename/edit",
    "routes/projects.wiki.page.edit.tsx",
  ),
  route("projects/:identifier/cards", "routes/projects.cards.tsx"),
  route("projects/:identifier/cards/grid", "routes/projects.cards.grid.tsx"),
  route("projects/:identifier/cards/new", "routes/projects.cards.new.tsx"),
  route("projects/:identifier/cards/:number", "routes/projects.cards.card.tsx"),
  route(
    "projects/:identifier/cards/:number/attachments/:attachmentId",
    "routes/projects.cards.attachment.ts",
  ),
] satisfies RouteConfig;
