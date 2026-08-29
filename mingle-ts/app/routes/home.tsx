/**
 * Root route — sends `/` to the projects list.
 *
 * Purpose: legacy Mingle's root (`map.root` → `projects#index`) was the
 * projects list, which bounces anonymous visitors to sign-in; this route
 * reproduces that by redirecting to `/projects`, whose loader enforces
 * the login. Nothing renders here.
 * Public interface: the `loader` (always redirects).
 * Owner context: application shell.
 */
import { redirect } from "react-router";

/**
 * Redirects every request for `/` to `/projects`.
 *
 * @returns never — always throws a 302 redirect to `/projects`
 */
export function loader() {
  throw redirect("/projects");
}
