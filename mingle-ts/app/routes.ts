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
] satisfies RouteConfig;
