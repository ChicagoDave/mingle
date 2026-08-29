/**
 * /logout — ends the browser session.
 *
 * Accepts both GET and POST: legacy's "Sign out" was a plain link to
 * `profile#logout` (ADR-0001 fidelity), and the profile page's form
 * posts here. Either way the session cookie is destroyed and the
 * visitor lands on /login.
 *
 * Public interface: `loader` (GET) and `action` (POST), both sign out.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { destroySessionHeaders } from "~/auth/session.server";

/**
 * Destroys the session cookie and redirects to /login.
 *
 * @param request - the incoming request carrying the session cookie
 * @returns a 302 to /login with the cookie-clearing headers
 */
async function signOut(request: Request) {
  return redirect("/login", {
    headers: await destroySessionHeaders(request),
  });
}

/** GET /logout — signs out (legacy "Sign out" link parity). */
export async function loader({ request }: Route.LoaderArgs) {
  return signOut(request);
}

/** POST /logout — signs out (the profile page's form). */
export async function action({ request }: Route.ActionArgs) {
  return signOut(request);
}
