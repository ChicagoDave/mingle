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
  route("auth/oidc", "routes/auth.oidc.ts"),
  route("auth/oidc/callback", "routes/auth.oidc.callback.ts"),
  route("admin/authentication", "routes/admin.authentication.tsx"),
  route("projects", "routes/projects.tsx"),
  route("projects/new", "routes/projects.new.tsx"),
  route("projects/import", "routes/projects.import.tsx"),
  route("dependencies/import-export", "routes/dependencies.import-export.tsx"),
  route("programs", "routes/programs.tsx"),
  route("programs/:identifier", "routes/programs.program.tsx"),
  route("programs/:identifier/settings", "routes/programs.settings.tsx"),
  route("programs/:identifier/team", "routes/programs.team.tsx"),
  route("programs/:identifier/backlog", "routes/programs.backlog.tsx"),
  route(
    "programs/:identifier/objectives/:number",
    "routes/programs.objectives.show.tsx",
  ),
  route("projects/:identifier/settings", "routes/projects.settings.tsx"),
  route("projects/:identifier/export", "routes/projects.export.ts"),
  route("projects/:identifier/team", "routes/projects.team.tsx"),
  route("projects/:identifier/groups", "routes/projects.groups.tsx"),
  route("projects/:identifier/transitions", "routes/projects.transitions.tsx"),
  route("projects/:identifier/favorites", "routes/projects.favorites.tsx"),
  route("projects/:identifier/trees", "routes/projects.trees.tsx"),
  route("projects/:identifier/integrations", "routes/projects.integrations.tsx"),
  route("projects/:identifier/github/webhook", "routes/projects.github.webhook.ts"),
  route("projects/:identifier/trees/:treeId", "routes/projects.trees.tree.tsx"),
  route(
    "projects/:identifier/favorites/:favoriteId",
    "routes/projects.favorites.show.ts",
  ),
  route("projects/:identifier/murmurs", "routes/projects.murmurs.tsx"),
  route("projects/:identifier/dependencies", "routes/projects.dependencies.tsx"),
  route(
    "projects/:identifier/dependencies/:number",
    "routes/projects.dependencies.show.tsx",
  ),
  route("projects/:identifier/history", "routes/projects.history.tsx"),
  route("projects/:identifier/feed.atom", "routes/projects.feed.atom.ts"),
  route(
    "projects/:identifier/subscriptions",
    "routes/projects.subscriptions.tsx",
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
  route("projects/:identifier/cards/import", "routes/projects.cards.import.tsx"),
  route("projects/:identifier/cards/:number", "routes/projects.cards.card.tsx"),
  route(
    "projects/:identifier/cards/:number/attachments/:attachmentId",
    "routes/projects.cards.attachment.ts",
  ),
  // Public API v1 (Phase 30) — JSON resource routes, bearer-key
  // authenticated, reusing the UI's command handlers.
  route("api/v1/projects", "routes/api.v1.projects.ts"),
  route("api/v1/projects/:identifier", "routes/api.v1.projects.project.ts"),
  route("api/v1/projects/:identifier/card_types", "routes/api.v1.projects.card-types.ts"),
  route(
    "api/v1/projects/:identifier/property_definitions",
    "routes/api.v1.projects.property-definitions.ts",
  ),
  route("api/v1/projects/:identifier/transitions", "routes/api.v1.projects.transitions.ts"),
  route("api/v1/projects/:identifier/cards", "routes/api.v1.projects.cards.ts"),
  route("api/v1/projects/:identifier/cards/:number", "routes/api.v1.projects.cards.card.ts"),
  route(
    "api/v1/projects/:identifier/cards/:number/transitions",
    "routes/api.v1.projects.cards.card.transitions.ts",
  ),
] satisfies RouteConfig;
