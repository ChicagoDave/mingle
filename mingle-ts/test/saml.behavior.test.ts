/**
 * Real-path tests for SAML 2.0 single sign-on (P-9, Phase 9 exit
 * criterion: "verified against a real identity provider in test the
 * way OIDC was in Phase 31").
 *
 * The identity provider is `samlify`'s IdP running in this process
 * with an RSA key pair and self-signed certificate minted by openssl
 * for the suite: it parses the AuthnRequest this app redirects the
 * browser with, and issues a signed SAML Response for a fixed account
 * — the part a person and their IdP would do. The app's side is
 * untouched: a real AuthnRequest over the HTTP-Redirect binding, the
 * `mingle_saml` pending cookie, and a real Response over the HTTP-POST
 * binding validated by @node-saml/node-saml against the configured
 * certificate, audience, InResponseTo, and validity window, then
 * SignInExternalUser and a session recording strategy kind "saml".
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Identity & Access verification.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import * as samlify from "samlify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-saml-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "saml-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { getSessionPrincipal } = await import("../app/auth/session.server");
const startRoute = await import("../app/routes/auth.saml");
const callbackRoute = await import("../app/routes/auth.saml.callback");
const metadataRoute = await import("../app/routes/auth.saml.metadata");
const loginRoute = await import("../app/routes/login");
const { authConfigurations, externalIdentities, users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { configureAuthentication, DEFAULT_SAML_SETTINGS } = await import("../app/domain/identity/auth-configuration.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

// ------------------------------------------------------- the provider

const APP_ORIGIN = "http://localhost";
const CALLBACK_URL = `${APP_ORIGIN}/auth/saml/callback`;
const SP_ENTITY_ID = "http://localhost/mingle";
const IDP_ENTITY_ID = "urn:test:idp";
const IDP_SSO_URL = "http://idp.test/sso";
const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

let idpCert = "";
let idp: ReturnType<typeof samlify.IdentityProvider>;
let sp: ReturnType<typeof samlify.ServiceProvider>;

beforeAll(() => {
  // A real RSA key and self-signed certificate for the IdP, minted by openssl.
  const keyPath = join(dir, "idp-key.pem");
  const certPath = join(dir, "idp-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=test-idp"], { stdio: "ignore" });
  const privateKey = readFileSync(keyPath, "utf8");
  idpCert = readFileSync(certPath, "utf8");
  // XSD validation of the inbound AuthnRequest is the IdP's concern, not this app's; the test IdP skips it.
  samlify.setSchemaValidator({ validate: () => Promise.resolve("skipped") });
  idp = samlify.IdentityProvider({
    entityID: IDP_ENTITY_ID,
    privateKey,
    signingCert: idpCert,
    isAssertionEncrypted: false,
    wantAuthnRequestsSigned: false,
    nameIDFormat: ["urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"],
    singleSignOnService: [{ Binding: REDIRECT_BINDING, Location: IDP_SSO_URL }],
  });
  sp = samlify.ServiceProvider({
    entityID: SP_ENTITY_ID,
    authnRequestsSigned: false,
    wantAssertionsSigned: true,
    wantMessageSigned: false,
    assertionConsumerService: [{ Binding: POST_BINDING, Location: CALLBACK_URL }],
  });
});

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number;

beforeEach(() => {
  for (const table of [domainEvents, externalIdentities, authConfigurations, users]) db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "saml-suite-1!" }), "admin").id;
  mustOk(
    configureAuthentication(db, sealer, {
      kind: "saml",
      settings: { ...DEFAULT_SAML_SETTINGS, enabled: true, displayName: "Corp SSO", entryPoint: IDP_SSO_URL, idpIssuer: IDP_ENTITY_ID, idpCert, spEntityId: SP_ENTITY_ID, autoEnroll: true },
      actorUserId: adminId,
    }),
    "configure saml",
  );
  db.delete(domainEvents).run();
});

/** Runs a resource route, resolving to the Response whether returned or thrown. */
async function run(fn: (args: never) => Promise<unknown>, request: Request): Promise<Response> {
  try {
    return (await fn({ request, params: {}, context: {} } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** The IdP's half: parse the app's AuthnRequest and issue a signed Response for `account`. */
async function idpResponds(redirectTo: string, account: string, options: { tamper?: boolean } = {}): Promise<string> {
  const url = new URL(redirectTo);
  const query = Object.fromEntries(url.searchParams.entries());
  const requestInfo = (await idp.parseLoginRequest(sp, "redirect", { query })) as unknown as Parameters<typeof idp.createLoginResponse>[1];
  const response = await idp.createLoginResponse(sp, requestInfo, "post", { email: account }, { relayState: "" });
  if (!options.tamper) return response.context;
  // Flip a character inside the signed assertion so the signature no longer matches.
  const xml = Buffer.from(response.context, "base64").toString("utf8");
  return Buffer.from(xml.replace(account, account.toUpperCase()), "utf8").toString("base64");
}

/** Browser's half: follow /auth/saml out, hand the IdP's Response to the callback with the pending cookie. */
async function signIn(account: string, options: { tamper?: boolean; withoutCookie?: boolean } = {}): Promise<Response> {
  const start = await run(startRoute.loader, new Request(`${APP_ORIGIN}/auth/saml`));
  expect(start.status).toBe(302);
  const redirectTo = start.headers.get("Location")!;
  expect(redirectTo.startsWith(IDP_SSO_URL)).toBe(true);
  expect(new URL(redirectTo).searchParams.get("SAMLRequest")).toBeTruthy();
  const pendingCookie = start.headers.get("Set-Cookie")!.split(";")[0];
  const samlResponse = await idpResponds(redirectTo, account, options);
  const form = new URLSearchParams({ SAMLResponse: samlResponse, RelayState: "" });
  return run(
    callbackRoute.action,
    new Request(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(options.withoutCookie ? {} : { Cookie: pendingCookie }) },
      body: form,
    }),
  );
}

describe("SAML sign-in against the in-process identity provider", () => {
  it("offers the SAML source on the sign-in page and publishes SP metadata", async () => {
    const login = (await loginRoute.loader({ request: new Request(`${APP_ORIGIN}/login`), params: {}, context: {} } as never)) as {
      sso: { kind: string; displayName: string; href: string }[];
    };
    expect(login.sso).toEqual([{ kind: "saml", displayName: "Corp SSO", href: "/auth/saml" }]);
    const metadata = await run(metadataRoute.loader, new Request(`${APP_ORIGIN}/auth/saml/metadata`));
    expect(metadata.status).toBe(200);
    const xml = await metadata.text();
    expect(xml).toContain(`entityID="${SP_ENTITY_ID}"`);
    expect(xml).toContain(CALLBACK_URL);
  });

  it("enrols an unknown account from a signed Response and starts a session recorded as strategy kind saml", async () => {
    const response = await signIn("alice");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/profile");
    const user = db.select().from(users).where(eq(users.login, "alice")).get();
    expect(user).toBeDefined();
    expect(user!.admin).toBe(false);
    const identity = db.select().from(externalIdentities).where(and(eq(externalIdentities.kind, "saml"), eq(externalIdentities.subject, "alice"))).get();
    expect(identity?.userId).toBe(user!.id);
    expect(db.select().from(domainEvents).where(eq(domainEvents.type, "UserEnrolled")).all()).toHaveLength(1);
    expect(db.select().from(domainEvents).where(eq(domainEvents.type, "UserLoggedIn")).all()).toHaveLength(1);

    const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
    const sessionCookie = cookies.find((c) => c.startsWith("mingle_session="))!;
    expect(sessionCookie).toBeDefined();
    const principal = await getSessionPrincipal(new Request(`${APP_ORIGIN}/projects`, { headers: { Cookie: sessionCookie } }));
    expect(principal).toEqual({ via: "session", userId: user!.id, strategyKind: "saml" });
    // The pending cookie is cleared.
    expect(cookies.find((c) => c.startsWith("mingle_saml="))).toBe("mingle_saml=");
  });

  it("links a returning subject to its existing account and signs it in again without re-enrolling", async () => {
    const existing = mustOk(registerUser(db, { login: "bob", name: "Bob", password: "saml-suite-1!" }), "bob").id;
    const first = await signIn("bob");
    expect(first.headers.get("Location")).toBe("/profile");
    expect(db.select().from(externalIdentities).where(eq(externalIdentities.userId, existing)).all()).toHaveLength(1);
    expect(db.select().from(domainEvents).where(eq(domainEvents.type, "ExternalIdentityLinked")).all()).toHaveLength(1);
    const second = await signIn("bob");
    expect(second.headers.get("Location")).toBe("/profile");
    expect(db.select().from(users).all()).toHaveLength(2);
    expect(db.select().from(externalIdentities).all()).toHaveLength(1);
    expect(db.select().from(domainEvents).where(eq(domainEvents.type, "UserLoggedIn")).all()).toHaveLength(2);
  });

  it("refuses a tampered Response, a Response without the pending cookie, and a replayed Response — no account, no session", async () => {
    const tampered = await signIn("carol", { tamper: true });
    expect(tampered.status).toBe(302);
    expect(tampered.headers.get("Location")).toMatch(/^\/login\?error=/);
    expect(decodeURIComponent(tampered.headers.get("Location")!)).toContain("refused");
    expect(db.select().from(users).where(eq(users.login, "carol")).get()).toBeUndefined();
    expect(tampered.headers.getSetCookie().some((c) => c.startsWith("mingle_session="))).toBe(false);

    const noCookie = await signIn("dave", { withoutCookie: true });
    expect(decodeURIComponent(noCookie.headers.get("Location")!)).toContain("not started here");
    expect(db.select().from(users).where(eq(users.login, "dave")).get()).toBeUndefined();

    // Replay: the same Response a second time is refused (InResponseTo is spent).
    const start = await run(startRoute.loader, new Request(`${APP_ORIGIN}/auth/saml`));
    const pendingCookie = start.headers.get("Set-Cookie")!.split(";")[0];
    const samlResponse = await idpResponds(start.headers.get("Location")!, "erin");
    const post = () =>
      run(
        callbackRoute.action,
        new Request(CALLBACK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: pendingCookie },
          body: new URLSearchParams({ SAMLResponse: samlResponse }),
        }),
      );
    expect((await post()).headers.get("Location")).toBe("/profile");
    const replayed = await post();
    expect(replayed.headers.get("Location")).toMatch(/^\/login\?error=/);
    expect(db.select().from(domainEvents).where(eq(domainEvents.type, "UserLoggedIn")).all()).toHaveLength(1);
  });

  it("refuses a Response signed by a different certificate", async () => {
    // Reconfigure the app with another certificate: the IdP's real signature no longer matches.
    const otherCert = join(dir, "other-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "other-key.pem"), "-out", otherCert, "-days", "1", "-subj", "/CN=other-idp"], { stdio: "ignore" });
    mustOk(
      configureAuthentication(db, sealer, {
        kind: "saml",
        settings: { ...DEFAULT_SAML_SETTINGS, enabled: true, displayName: "Corp SSO", entryPoint: IDP_SSO_URL, idpIssuer: IDP_ENTITY_ID, idpCert: readFileSync(otherCert, "utf8"), spEntityId: SP_ENTITY_ID, autoEnroll: true },
        actorUserId: adminId,
      }),
      "reconfigure",
    );
    const refused = await signIn("frank");
    expect(refused.headers.get("Location")).toMatch(/^\/login\?error=/);
    expect(db.select().from(users).where(eq(users.login, "frank")).get()).toBeUndefined();
  });

  it("answers 404 on every SAML route while the source is disabled", async () => {
    mustOk(configureAuthentication(db, sealer, { kind: "saml", settings: { ...DEFAULT_SAML_SETTINGS, enabled: false }, actorUserId: adminId }), "disable");
    expect((await run(startRoute.loader, new Request(`${APP_ORIGIN}/auth/saml`))).status).toBe(404);
    expect((await run(metadataRoute.loader, new Request(`${APP_ORIGIN}/auth/saml/metadata`))).status).toBe(404);
    expect((await run(callbackRoute.action, new Request(CALLBACK_URL, { method: "POST", body: new URLSearchParams({ SAMLResponse: "x" }) }))).status).toBe(404);
  });
});
