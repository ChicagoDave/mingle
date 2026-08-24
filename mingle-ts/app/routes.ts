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
] satisfies RouteConfig;
