/**
 * /logout — ends the browser session (resource route, POST only).
 *
 * Public interface: `action`.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { destroySessionHeaders } from "~/auth/session.server";

/** Destroys the session cookie and returns to /login. */
export async function action({ request }: Route.ActionArgs) {
  return redirect("/login", {
    headers: await destroySessionHeaders(request),
  });
}
