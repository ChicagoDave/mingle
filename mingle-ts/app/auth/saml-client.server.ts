/**
 * SAML 2.0 service-provider client — SP-initiated sign-in over the
 * HTTP-Redirect (out) and HTTP-POST (back) bindings (P-9).
 *
 * Purpose: the one place the app speaks SAML. `beginSamlSignIn` builds
 * the AuthnRequest and the IdP redirect; `completeSamlSignIn`
 * validates the posted Response — signature against the configured IdP
 * certificate, audience, `InResponseTo` against the request this
 * process issued, and the assertion's validity window — and maps the
 * assertion to `ExternalIdentityClaims`, which `signInExternalUser`
 * turns into a session exactly as for OIDC. The SAML library
 * (@node-saml/node-saml) is confined to this module; a short-lived
 * signed cookie marks that a sign-in was started here, as the OIDC
 * client does. The InResponseTo cache is in-process, which ADR-0002's
 * single-node deployment allows.
 *
 * Public interface: `SamlSignInError`, `beginSamlSignIn`,
 * `completeSamlSignIn`, `serviceProviderMetadata`, `samlCallbackUrl`,
 * `pendingSamlHeaders`, `readPendingSaml`, `clearPendingSamlHeaders`.
 *
 * Owner context: Identity & Access (HTTP adapter for the SAML strategy).
 */
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import { createCookieSessionStorage } from "react-router";
import { appSecret } from "~/auth/secret.server";
import type { SamlSettings } from "~/domain/identity/auth-configuration.server";
import type { ExternalIdentityClaims } from "~/domain/identity/external-login.server";

export class SamlSignInError extends Error {}

/** What is remembered between the redirect out and the POST back. */
export interface PendingSaml {
  startedAt: number;
}

// ------------------------------------------------------- pending cookie

// The IdP POSTs the Response back cross-site, which a SameSite=Lax cookie
// would not accompany. SameSite=None is what that needs, and browsers
// accept it only with Secure — so an HTTPS install gets None; a plain-HTTP
// install falls back to Lax and relies on browsers' Lax-allowing-POST grace
// (and node-saml's InResponseTo check still binds the Response to a request
// this process issued).
const secureCookies = process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "true";
const pending = createCookieSessionStorage({
  cookie: {
    name: "mingle_saml",
    httpOnly: true,
    sameSite: secureCookies ? "none" : "lax",
    path: "/auth/saml",
    maxAge: 10 * 60,
    secrets: [appSecret()],
    secure: secureCookies,
  },
});

/** Headers that store the pending sign-in in its signed cookie. */
export async function pendingSamlHeaders(value: PendingSaml): Promise<HeadersInit> {
  const session = await pending.getSession();
  session.set("pending", value);
  return { "Set-Cookie": await pending.commitSession(session) };
}

/** The pending sign-in from the callback request's cookie, if any. */
export async function readPendingSaml(request: Request): Promise<PendingSaml | null> {
  const session = await pending.getSession(request.headers.get("Cookie"));
  const value = session.get("pending") as PendingSaml | undefined;
  return value && typeof value.startedAt === "number" ? value : null;
}

/** Headers that drop the pending cookie. */
export async function clearPendingSamlHeaders(request: Request): Promise<HeadersInit> {
  const session = await pending.getSession(request.headers.get("Cookie"));
  return { "Set-Cookie": await pending.destroySession(session) };
}

// ------------------------------------------------------------ the SP

/** The absolute assertion consumer URL for this deployment, derived from the request. */
export function samlCallbackUrl(request: Request): string {
  return new URL("/auth/saml/callback", request.url).toString();
}

/** This site's entity id: the configured one, else the site's origin. */
function entityId(settings: SamlSettings, callbackUrl: string): string {
  return settings.spEntityId || new URL(callbackUrl).origin;
}

/**
 * SP instances by their effective configuration. One instance per
 * configuration keeps node-saml's in-memory InResponseTo cache alive
 * between the redirect out and the POST back.
 */
const providers = new Map<string, SAML>();

function providerFor(settings: SamlSettings, callbackUrl: string): SAML {
  const key = JSON.stringify([settings.entryPoint, settings.idpIssuer, settings.idpCert, entityId(settings, callbackUrl), callbackUrl]);
  const cached = providers.get(key);
  if (cached) return cached;
  if (!settings.entryPoint || !settings.idpCert) throw new SamlSignInError("SAML sign-in is not fully configured");
  const provider = new SAML({
    callbackUrl,
    entryPoint: settings.entryPoint,
    issuer: entityId(settings, callbackUrl),
    idpCert: settings.idpCert,
    idpIssuer: settings.idpIssuer || undefined,
    audience: entityId(settings, callbackUrl),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    acceptedClockSkewMs: 5 * 60 * 1000,
    identifierFormat: null,
  });
  providers.set(key, provider);
  return provider;
}

// ---------------------------------------------------------------- flow

/**
 * Starts a sign-in: the IdP redirect carrying the AuthnRequest, and the
 * pending marker to keep for the callback.
 *
 * @param settings - the enabled SAML settings
 * @param callbackUrl - this app's absolute assertion consumer URL
 */
export async function beginSamlSignIn(
  settings: SamlSettings,
  callbackUrl: string,
): Promise<{ redirectTo: string; pending: PendingSaml }> {
  const provider = providerFor(settings, callbackUrl);
  try {
    const redirectTo = await provider.getAuthorizeUrlAsync("", undefined, {});
    return { redirectTo, pending: { startedAt: Date.now() } };
  } catch (error) {
    throw new SamlSignInError(`The SAML sign-in could not be started (${String(error)})`);
  }
}

/** The first value of a (possibly multi-valued) assertion attribute, or null. */
function attribute(profile: Profile, name: string): string | null {
  if (!name) return null;
  const value = (profile as unknown as Record<string, unknown>)[name];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

/**
 * Finishes a sign-in: validates the posted Response and maps it to
 * identity claims (kind "saml", subject = NameID).
 *
 * @param settings - the enabled SAML settings
 * @param callbackUrl - this app's absolute assertion consumer URL
 * @param form - the POSTed form (`SAMLResponse`, optional `RelayState`)
 * @throws SamlSignInError with a message fit for the sign-in page
 */
export async function completeSamlSignIn(
  settings: SamlSettings,
  callbackUrl: string,
  form: FormData,
): Promise<ExternalIdentityClaims> {
  const provider = providerFor(settings, callbackUrl);
  const samlResponse = form.get("SAMLResponse");
  if (typeof samlResponse !== "string" || samlResponse === "") throw new SamlSignInError("The identity provider sent no SAML response");
  let profile: Profile | null;
  try {
    ({ profile } = await provider.validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (error) {
    throw new SamlSignInError(`The SAML response was refused (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!profile || !profile.nameID) throw new SamlSignInError("The SAML response carried no subject");
  const login = attribute(profile, settings.loginAttribute) ?? profile.nameID;
  return {
    kind: "saml",
    subject: profile.nameID,
    login,
    name: attribute(profile, settings.nameAttribute) ?? login,
    email: attribute(profile, settings.emailAttribute) ?? profile.email ?? profile.mail ?? null,
  };
}

/**
 * The SP metadata document an IdP administrator registers.
 *
 * @param settings - the SAML settings (entity id)
 * @param callbackUrl - this app's absolute assertion consumer URL
 */
export function serviceProviderMetadata(settings: SamlSettings, callbackUrl: string): string {
  return providerFor(settings, callbackUrl).generateServiceProviderMetadata(null, null);
}
