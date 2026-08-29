/**
 * Real-path tests for OIDC single sign-on (Phase 31 exit criterion:
 * "a user authenticates via the configured SSO provider — a real OIDC
 * test provider in dev/test, not a stubbed identity assertion — and
 * is mapped to a real users row").
 *
 * The provider is `oidc-provider` (node-oidc-provider, a certified
 * OpenID Provider implementation) listening on a TCP port in this
 * process, with an interaction handler that signs a fixed account in
 * and consents — the part a person would do in a browser. The app's
 * side is untouched: real discovery over HTTP, a real authorization
 * redirect with state/nonce/PKCE, a real code exchange at the token
 * endpoint, and an ID token verified against the provider's JWKS.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Identity & Access verification.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Provider from "oidc-provider";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-oidc-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "oidc-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const startRoute = await import("../app/routes/auth.oidc");
const callbackRoute = await import("../app/routes/auth.oidc.callback");
const loginRoute = await import("../app/routes/login");
const { authConfigurations, externalIdentities, users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { configureAuthentication, DEFAULT_OIDC_SETTINGS } = await import("../app/domain/identity/auth-configuration.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

// ------------------------------------------------------- the provider

const APP_ORIGIN = "http://localhost";
const CALLBACK_URL = `${APP_ORIGIN}/auth/oidc/callback`;
const CLIENT_ID = "mingle";
const CLIENT_SECRET = "mingle-client-secret";
const ACCOUNT_ID = "acct-alice-42";
const ACCOUNT_CLAIMS = { sub: ACCOUNT_ID, name: "Alice Example", preferred_username: "alice", email: "alice@example.test" };

let issuer = "";
let httpServer: ReturnType<typeof createServer> | undefined;

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}`;
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [CALLBACK_URL],
        token_endpoint_auth_method: "client_secret_post",
      },
    ],
    cookies: { keys: ["oidc-test-cookie-key"] },
    claims: { openid: ["sub"], profile: ["name", "preferred_username"], email: ["email"] },
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    pkce: { required: () => true },
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ ...ACCOUNT_CLAIMS, sub: id }) }),
  });
  const handle = provider.callback();
  // The "person at the browser": signs the fixed account in and consents.
  const interaction = async (req: IncomingMessage, res: ServerResponse) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name === "login") {
      await provider.interactionFinished(req, res, { login: { accountId: ACCOUNT_ID } }, { mergeWithLastSubmission: false });
      return;
    }
    const grant = new provider.Grant({ accountId: ACCOUNT_ID, clientId: String(details.params.client_id) });
    grant.addOIDCScope(String(details.params.scope));
    const grantId = await grant.save();
    await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
  };
  httpServer = createServer((req, res) => {
    if (req.url?.startsWith("/interaction/")) {
      interaction(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
      return;
    }
    handle(req, res);
  });
  await new Promise<void>((resolve) => httpServer!.listen(port, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ fixtures

let adminId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  for (const table of [domainEvents, externalIdentities, authConfigurations, users]) db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "oidc-suite-1!" }), "admin").id;
  mustOk(
    configureAuthentication(db, sealer, {
      kind: "oidc",
      settings: { ...DEFAULT_OIDC_SETTINGS, enabled: true, displayName: "Corp SSO", issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      actorUserId: adminId,
    }),
    "configure",
  );
  db.delete(domainEvents).run();
});

const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

/** The cookie-bearing browser walk from the provider's authorize URL back to our callback URL. */
async function walkProvider(authorizeUrl: string): Promise<URL> {
  const jar = new Map<string, string>();
  let url = new URL(authorizeUrl);
  for (let hop = 0; hop < 10; hop += 1) {
    const res = await fetch(url, { redirect: "manual", headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...rest] = pair.split("=");
      jar.set(name.trim(), rest.join("="));
    }
    if (res.status < 300 || res.status >= 400) throw new Error(`provider answered ${res.status} at ${url}: ${await res.text()}`);
    const next = new URL(res.headers.get("Location")!, url);
    if (next.origin === APP_ORIGIN) return next;
    url = next;
  }
  throw new Error("too many provider redirects");
}

/** Starts the sign-in through our route: the provider URL and the pending cookie. */
async function start() {
  const response = (await startRoute.loader({ request: new Request(`${APP_ORIGIN}/auth/oidc`), params: {}, context: {} } as never)) as Response;
  expect(response.status).toBe(302);
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
  return { authorizeUrl: response.headers.get("Location")!, cookie };
}

async function finish(callbackUrl: URL, cookie: string | null) {
  const request = new Request(callbackUrl, { headers: cookie ? { Cookie: cookie } : {} });
  return (await callbackRoute.loader({ request, params: {}, context: {} } as never)) as Response;
}

// --------------------------------------------------------------- tests

describe("single sign-on through a real OpenID provider", () => {
  it("offers the button on /login only when enabled", async () => {
    const shown = (await loginRoute.loader({ request: new Request(`${APP_ORIGIN}/login`), params: {}, context: {} } as never)) as { sso: { displayName: string } | null };
    expect(shown.sso).toEqual({ displayName: "Corp SSO" });
    mustOk(configureAuthentication(db, sealer, { kind: "oidc", settings: { ...DEFAULT_OIDC_SETTINGS, enabled: false }, actorUserId: adminId }), "disable");
    const hidden = (await loginRoute.loader({ request: new Request(`${APP_ORIGIN}/login`), params: {}, context: {} } as never)) as { sso: unknown };
    expect(hidden.sso).toBeNull();
    await expect(startRoute.loader({ request: new Request(`${APP_ORIGIN}/auth/oidc`), params: {}, context: {} } as never)).rejects.toMatchObject({ status: 404 });
  });

  it("redirects to the provider with state, nonce, and a PKCE challenge, then maps the verified ID token to an enrolled user", async () => {
    const { authorizeUrl, cookie } = await start();
    const authorize = new URL(authorizeUrl);
    expect(authorize.origin).toBe(issuer);
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toContain("openid");
    expect(cookie.startsWith("mingle_oidc=")).toBe(true);

    const callbackUrl = await walkProvider(authorizeUrl);
    expect(callbackUrl.searchParams.get("code")).toBeTruthy();
    expect(callbackUrl.searchParams.get("state")).toBe(authorize.searchParams.get("state"));

    const done = await finish(callbackUrl, cookie);
    expect(done.status).toBe(302);
    expect(done.headers.get("Location")).toBe("/profile");
    const cookies = done.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("mingle_session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("mingle_oidc=") && /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);

    const alice = db.select().from(users).where(eq(users.login, "alice")).get()!;
    expect(alice).toMatchObject({ name: "Alice Example", email: "alice@example.test", admin: false });
    expect(alice.lastLoginAt).not.toBeNull();
    expect(db.select().from(externalIdentities).where(eq(externalIdentities.userId, alice.id)).get()).toMatchObject({ kind: "oidc", subject: ACCOUNT_ID });
    expect(events("UserEnrolled")).toHaveLength(1);
    expect(events("UserLoggedIn").map((e) => JSON.parse(e.payload))).toEqual([{ login: "alice", kind: "oidc" }]);

    // Signing in again resolves the same account by subject.
    const second = await start();
    const secondDone = await finish(await walkProvider(second.authorizeUrl), second.cookie);
    expect(secondDone.headers.get("Location")).toBe("/profile");
    expect(db.select().from(users).all()).toHaveLength(2);
    expect(events("UserLoggedIn")).toHaveLength(2);
  });

  it("refuses a callback whose state does not match, one without the pending cookie, and a reused code — no session, no user", async () => {
    const { authorizeUrl, cookie } = await start();
    const callbackUrl = await walkProvider(authorizeUrl);

    const forged = new URL(callbackUrl);
    forged.searchParams.set("state", "forged-state");
    const mismatch = await finish(forged, cookie);
    expect(mismatch.status).toBe(302);
    expect(mismatch.headers.get("Location")).toContain("/login?error=");
    expect(decodeURIComponent(mismatch.headers.get("Location")!)).toContain("did not match");

    const noCookie = await finish(callbackUrl, null);
    expect(noCookie.headers.get("Location")).toContain("/login?error=");

    expect(db.select().from(users).where(eq(users.login, "alice")).get()).toBeUndefined();

    // The genuine callback succeeds once; presenting the same code again is refused by the provider.
    const ok = await finish(callbackUrl, cookie);
    expect(ok.headers.get("Location")).toBe("/profile");
    const replay = await finish(callbackUrl, cookie);
    expect(decodeURIComponent(replay.headers.get("Location")!)).toContain("did not issue a token");
    expect(events("UserLoggedIn")).toHaveLength(1);
  });

  it("without auto-enrol, an unknown subject is refused and no account is created", async () => {
    mustOk(
      configureAuthentication(db, sealer, {
        kind: "oidc",
        settings: { ...DEFAULT_OIDC_SETTINGS, enabled: true, issuer, clientId: CLIENT_ID, clientSecret: "", autoEnroll: false },
        actorUserId: adminId,
      }),
      "no enrol",
    );
    const { authorizeUrl, cookie } = await start();
    const refused = await finish(await walkProvider(authorizeUrl), cookie);
    expect(decodeURIComponent(refused.headers.get("Location")!)).toContain("Invalid login or password");
    expect(db.select().from(users).all()).toHaveLength(1);
  });
});
