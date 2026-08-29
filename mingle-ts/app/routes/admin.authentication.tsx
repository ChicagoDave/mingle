/**
 * /admin/authentication — site-wide sign-in sources (Phase 31).
 *
 * Purpose: the successor of editing legacy `auth_config.yml`: a site
 * admin enables and configures LDAP and OIDC here. Two forms post to
 * one action, discriminated by `intent` ("ldap" | "oidc"), each
 * running ConfigureAuthentication. Secrets are write-only: the page
 * says whether one is set, and a blank field keeps it.
 *
 * Public interface: `loader`, `action`, default component.
 * Owner context: Identity & Access (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/admin.authentication";
import type { AuthenticationView, FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { users } from "~/db/schema/identity";
import { sealer } from "~/auth/sealer.server";
import { requireUserId } from "~/auth/session.server";
import {
  authenticationView,
  configureAuthentication,
  type LdapSettings,
  type OidcSettings,
} from "~/domain/identity/auth-configuration.server";

/** Requires a logged-in site admin; 403 otherwise. */
async function requireSiteAdmin(request: Request): Promise<number> {
  const userId = await requireUserId(request);
  const user = db.select({ admin: users.admin }).from(users).where(eq(users.id, userId)).get();
  if (!user?.admin) throw new Response("Forbidden", { status: 403 });
  return userId;
}

/** Loads both sources' views (secrets as flags). */
export async function loader({ request }: Route.LoaderArgs) {
  await requireSiteAdmin(request);
  return authenticationView(db);
}

const text = (form: FormData, field: string) => String(form.get(field) ?? "");
const flag = (form: FormData, field: string) => form.get(field) === "on";

/** Dispatches by intent to ConfigureAuthentication for LDAP or OIDC. */
export async function action({ request }: Route.ActionArgs) {
  const actorUserId = await requireSiteAdmin(request);
  const form = await request.formData();
  const intent = text(form, "intent");
  if (intent === "ldap") {
    const settings: LdapSettings = {
      enabled: flag(form, "enabled"),
      url: text(form, "url"),
      bindDn: text(form, "bindDn"),
      bindPassword: text(form, "bindPassword"),
      baseDn: text(form, "baseDn"),
      loginAttribute: text(form, "loginAttribute"),
      objectClass: text(form, "objectClass"),
      nameAttribute: text(form, "nameAttribute"),
      mailAttribute: text(form, "mailAttribute"),
      groupDn: text(form, "groupDn"),
      groupObjectClass: text(form, "groupObjectClass"),
      groupAttribute: text(form, "groupAttribute"),
      autoEnroll: flag(form, "autoEnroll"),
    };
    const result = configureAuthentication(db, sealer, { kind: "ldap", settings, actorUserId });
    return result.ok ? { saved: "ldap" as const } : { intent, errors: result.errors satisfies FieldErrors };
  }
  if (intent === "oidc") {
    const settings: OidcSettings = {
      enabled: flag(form, "enabled"),
      displayName: text(form, "displayName"),
      issuer: text(form, "issuer"),
      clientId: text(form, "clientId"),
      clientSecret: text(form, "clientSecret"),
      scopes: text(form, "scopes"),
      autoEnroll: flag(form, "autoEnroll"),
    };
    const result = configureAuthentication(db, sealer, { kind: "oidc", settings, actorUserId });
    return result.ok ? { saved: "oidc" as const } : { intent, errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Authentication settings page. Styling is deliberately minimal until the UX-harvest phases. */
export default function AdminAuthentication() {
  const view = useLoaderData<typeof loader>() as AuthenticationView;
  const actionData = useActionData<typeof action>();
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const errorsFor = (intent: string): FieldErrors =>
    actionData && "errors" in actionData && actionData.intent === intent ? actionData.errors : {};
  const ldapErrors = errorsFor("ldap");
  const oidcErrors = errorsFor("oidc");

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Authentication</h1>
      <p>
        <Link to="/profile">Profile</Link> · <Link to="/projects">Projects</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved {saved === "ldap" ? "LDAP" : "single sign-on"} settings.</p> : null}

      <h2>LDAP</h2>
      <p>
        <small>
          Users sign in with their directory password. Site administrators can always sign in with their Mingle
          password as well, so a directory outage cannot lock the site.
        </small>
      </p>
      <Form method="post">
        <input type="hidden" name="intent" value="ldap" />
        <Field label="Enabled" errors={ldapErrors} field="enabled">
          <input type="checkbox" name="enabled" defaultChecked={view.ldap.enabled} />
        </Field>
        <Field label="Directory URL (ldap:// or ldaps://)" errors={ldapErrors} field="url">
          <input name="url" defaultValue={view.ldap.url} style={{ width: "100%" }} />
        </Field>
        <Field label="Bind DN (service account; blank for anonymous)" errors={ldapErrors} field="bindDn">
          <input name="bindDn" defaultValue={view.ldap.bindDn} style={{ width: "100%" }} />
        </Field>
        <Field label={`Bind password${view.ldap.bindPasswordSet ? " (set — leave blank to keep)" : ""}`} errors={ldapErrors} field="bindPassword">
          <input name="bindPassword" type="password" autoComplete="new-password" style={{ width: "100%" }} />
        </Field>
        <Field label="Base DN" errors={ldapErrors} field="baseDn">
          <input name="baseDn" defaultValue={view.ldap.baseDn} style={{ width: "100%" }} />
        </Field>
        <Field label="Login attribute (uid, sAMAccountName)" errors={ldapErrors} field="loginAttribute">
          <input name="loginAttribute" defaultValue={view.ldap.loginAttribute} />
        </Field>
        <Field label="User object class" errors={ldapErrors} field="objectClass">
          <input name="objectClass" defaultValue={view.ldap.objectClass} />
        </Field>
        <Field label="Name attribute" errors={ldapErrors} field="nameAttribute">
          <input name="nameAttribute" defaultValue={view.ldap.nameAttribute} />
        </Field>
        <Field label="Email attribute" errors={ldapErrors} field="mailAttribute">
          <input name="mailAttribute" defaultValue={view.ldap.mailAttribute} />
        </Field>
        <Field label="Required group DN (optional)" errors={ldapErrors} field="groupDn">
          <input name="groupDn" defaultValue={view.ldap.groupDn} style={{ width: "100%" }} />
        </Field>
        <Field label="Group object class" errors={ldapErrors} field="groupObjectClass">
          <input name="groupObjectClass" defaultValue={view.ldap.groupObjectClass} />
        </Field>
        <Field label="Group member attribute" errors={ldapErrors} field="groupAttribute">
          <input name="groupAttribute" defaultValue={view.ldap.groupAttribute} />
        </Field>
        <Field label="Create Mingle accounts on first sign-in" errors={ldapErrors} field="autoEnroll">
          <input type="checkbox" name="autoEnroll" defaultChecked={view.ldap.autoEnroll} />
        </Field>
        <ErrorLines field="authorization" errors={ldapErrors} />
        <button type="submit">Save LDAP settings</button>
      </Form>

      <h2>Single sign-on (OpenID Connect)</h2>
      <p>
        <small>
          Register this site with your provider using the callback URL <code>/auth/oidc/callback</code> on this
          site's address.
        </small>
      </p>
      <Form method="post">
        <input type="hidden" name="intent" value="oidc" />
        <Field label="Enabled" errors={oidcErrors} field="enabled">
          <input type="checkbox" name="enabled" defaultChecked={view.oidc.enabled} />
        </Field>
        <Field label="Button label" errors={oidcErrors} field="displayName">
          <input name="displayName" defaultValue={view.oidc.displayName} />
        </Field>
        <Field label="Issuer URL" errors={oidcErrors} field="issuer">
          <input name="issuer" defaultValue={view.oidc.issuer} style={{ width: "100%" }} />
        </Field>
        <Field label="Client ID" errors={oidcErrors} field="clientId">
          <input name="clientId" defaultValue={view.oidc.clientId} style={{ width: "100%" }} />
        </Field>
        <Field label={`Client secret${view.oidc.clientSecretSet ? " (set — leave blank to keep)" : ""}`} errors={oidcErrors} field="clientSecret">
          <input name="clientSecret" type="password" autoComplete="new-password" style={{ width: "100%" }} />
        </Field>
        <Field label="Scopes" errors={oidcErrors} field="scopes">
          <input name="scopes" defaultValue={view.oidc.scopes} style={{ width: "100%" }} />
        </Field>
        <Field label="Create Mingle accounts on first sign-in" errors={oidcErrors} field="autoEnroll">
          <input type="checkbox" name="autoEnroll" defaultChecked={view.oidc.autoEnroll} />
        </Field>
        <ErrorLines field="authorization" errors={oidcErrors} />
        <button type="submit">Save single sign-on settings</button>
      </Form>
    </main>
  );
}

/** A labelled field with its error lines. */
function Field({ label, field, errors, children }: { label: string; field: string; errors: FieldErrors; children: React.ReactNode }) {
  return (
    <p>
      <label>
        {label}
        <br />
        {children}
      </label>
      <ErrorLines field={field} errors={errors} />
    </p>
  );
}

/** Renders a field's error messages, if any. */
function ErrorLines({ field, errors }: { field: string; errors: FieldErrors }) {
  return (
    <>
      {errors[field]?.map((message) => (
        <span key={message} style={{ color: "crimson", display: "block" }}>
          {message}
        </span>
      ))}
    </>
  );
}
