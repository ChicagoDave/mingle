/**
 * Browser session handling — signed cookie sessions.
 *
 * Purpose: tracks which user a browser is logged in as. This is
 * per-browser state (two browsers legitimately disagree), which is why
 * it lives here and not in the Identity domain module.
 *
 * Public interface: `createUserSession`, `getUserId`, `requireUserId`,
 * `destroySessionHeaders`.
 *
 * Owner context: infrastructure (HTTP session adapter) for Identity &
 * Access.
 *
 * Secret handling: SESSION_SECRET env wins; otherwise a secret is
 * generated once and persisted beside the database file, so a
 * self-hosted install keeps sessions across restarts with zero
 * configuration (ADR-0002's install story).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createCookieSessionStorage, redirect } from "react-router";

/**
 * Resolves the cookie-signing secret: env var, else a file persisted
 * next to the database (created on first boot, chmod 600).
 */
function resolveSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const databaseFile = resolve(process.env.DATABASE_FILE ?? "data/mingle.db");
  const secretFile = resolve(dirname(databaseFile), "session-secret");
  if (!existsSync(secretFile)) {
    mkdirSync(dirname(secretFile), { recursive: true });
    writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(secretFile, "utf8").trim();
}

const storage = createCookieSessionStorage({
  cookie: {
    name: "mingle_session",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secrets: [resolveSecret()],
    // Secure cookies require HTTPS; self-hosted installs often start on
    // plain HTTP behind a LAN, so this follows the env explicitly.
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "true",
  },
});

/**
 * Logs a browser in: stores the user id in a fresh session cookie and
 * redirects.
 */
export async function createUserSession(
  userId: number,
  redirectTo: string,
): Promise<Response> {
  const session = await storage.getSession();
  session.set("userId", userId);
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
