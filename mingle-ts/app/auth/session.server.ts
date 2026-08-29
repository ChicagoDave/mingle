/**
 * Browser session handling — signed cookie sessions.
 *
 * Purpose: tracks which user a browser is logged in as. This is
 * per-browser state (two browsers legitimately disagree), which is why
 * it lives here and not in the Identity domain module.
 *
 * Public interface: `createUserSession`, `getUserId`, `requireUserId`,
 * `getSessionPrincipal`, `destroySessionHeaders`.
 *
 * Owner context: infrastructure (HTTP session adapter) for Identity &
 * Access.
 *
 * Secret handling: the cookie is signed with the install's secret from
 * app/auth/secret.server.ts (SESSION_SECRET env, else a file persisted
 * beside the database — ADR-0002's zero-configuration install story).
 */
import { createCookieSessionStorage, redirect } from "react-router";
import { appSecret } from "~/auth/secret.server";
import type { RequestPrincipal } from "~/domain/identity/principal.server";
import { STRATEGY_KINDS, type StrategyKind } from "~/shared/wire-types";

const storage = createCookieSessionStorage({
  cookie: {
    name: "mingle_session",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secrets: [appSecret()],
    // Secure cookies require HTTPS; self-hosted installs often start on
    // plain HTTP behind a LAN, so this follows the env explicitly.
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "true",
  },
});

/**
 * Logs a browser in: stores the user id and the strategy kind that
 * authenticated them (ADR-0021 Decision 4) in a fresh session cookie
 * and redirects. A session created without a kind satisfies no
 * project constraint.
 */
export async function createUserSession(
  userId: number,
  redirectTo: string,
  strategyKind: StrategyKind | null = null,
): Promise<Response> {
  const session = await storage.getSession();
  session.set("userId", userId);
  if (strategyKind) session.set("strategyKind", strategyKind);
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await storage.commitSession(session) },
  });
}

/** Reads the logged-in user id from the request cookie, if any. */
export async function getUserId(request: Request): Promise<number | null> {
  const session = await storage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");
  return typeof userId === "number" ? userId : null;
}

/**
 * The request principal a session cookie carries: the user and the
 * strategy kind that opened the session (null for a cookie issued
 * before kinds were recorded), or anonymous.
 */
export async function getSessionPrincipal(request: Request): Promise<RequestPrincipal> {
  const session = await storage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");
  if (typeof userId !== "number") return { via: "anonymous" };
  const kind = session.get("strategyKind");
  const strategyKind = (STRATEGY_KINDS as readonly string[]).includes(String(kind)) ? (kind as StrategyKind) : null;
  return { via: "session", userId, strategyKind };
}

/**
 * Like getUserId, but redirects to /login when the browser is not
 * logged in. Use in loaders/actions of protected routes.
 */
export async function requireUserId(request: Request): Promise<number> {
  const userId = await getUserId(request);
  if (userId === null) throw redirect("/login");
  return userId;
}

/** Returns headers that destroy the browser's session cookie. */
export async function destroySessionHeaders(
  request: Request,
): Promise<HeadersInit> {
  const session = await storage.getSession(request.headers.get("Cookie"));
  return { "Set-Cookie": await storage.destroySession(session) };
}
