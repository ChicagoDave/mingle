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
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/admin.authentication";
import { ActionBar, FormItem, ErrorLines, FlashBox } from "~/components/forms";
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
  type SamlSettings,
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

/** Dispatches by intent to ConfigureAuthentication for LDAP, OIDC, or SAML. */
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
      startTls: flag(form, "startTls"),
      tlsCaCert: text(form, "tlsCaCert"),
      groupMappings: text(form, "groupMappings"),
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
  if (intent === "saml") {
    const settings: SamlSettings = {
      enabled: flag(form, "enabled"),
      displayName: text(form, "displayName"),
      entryPoint: text(form, "entryPoint"),
      idpIssuer: text(form, "idpIssuer"),
      idpCert: text(form, "idpCert"),
      spEntityId: text(form, "spEntityId"),
      loginAttribute: text(form, "loginAttribute"),
      nameAttribute: text(form, "nameAttribute"),
      emailAttribute: text(form, "emailAttribute"),
      autoEnroll: flag(form, "autoEnroll"),
    };
    const result = configureAuthentication(db, sealer, { kind: "saml", settings, actorUserId });
    return result.ok ? { saved: "saml" as const } : { intent, errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Authentication settings — no legacy counterpart (Phase 31); reuses the legacy settings-page structure (form sections, form items, action bars). */
export default function AdminAuthentication() {
  const view = useLoaderData<typeof loader>() as AuthenticationView;
  const actionData = useActionData<typeof action>();
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const errorsFor = (intent: string): FieldErrors =>
    actionData && "errors" in actionData && actionData.intent === intent ? actionData.errors : {};
  const ldapErrors = errorsFor("ldap");
  const oidcErrors = errorsFor("oidc");
  const samlErrors = errorsFor("saml");

  return (
    <div id="admin-authentication">
      <h1>Authentication</h1>
      {saved ? (
        <FlashBox kind="success">
          {saved === "ldap" ? "LDAP" : saved === "saml" ? "SAML" : "Single sign-on"} settings were successfully saved.
        </FlashBox>
      ) : null}

      <h2 id="ldap">LDAP</h2>
      <p className="notes">
        Users sign in with their directory password. Site administrators can always sign in with their Mingle password
        as well, so a directory outage cannot lock the site.
      </p>
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="ldap" />
        <div className="form_section">
          <div className="checkbox_row">
            <input type="checkbox" id="ldap_enabled" name="enabled" defaultChecked={view.ldap.enabled} />{" "}
            <label htmlFor="ldap_enabled" className="inline">
              Enabled
            </label>
            <ErrorLines field="enabled" errors={ldapErrors} />
          </div>
          <FormItem label="Directory URL:" htmlFor="ldap_url" required notes="ldap:// or ldaps://" field="url" errors={ldapErrors}>
            <input id="ldap_url" name="url" className="width-full" defaultValue={view.ldap.url} />
          </FormItem>
          <FormItem label="Bind DN:" htmlFor="ldap_bind_dn" notes="service account; blank for anonymous" field="bindDn" errors={ldapErrors}>
            <input id="ldap_bind_dn" name="bindDn" className="width-full" defaultValue={view.ldap.bindDn} />
          </FormItem>
          <FormItem
            label="Bind password:"
            htmlFor="ldap_bind_password"
            notes={view.ldap.bindPasswordSet ? "set — leave blank to keep" : undefined}
            field="bindPassword"
            errors={ldapErrors}
          >
            <input id="ldap_bind_password" name="bindPassword" type="password" autoComplete="new-password" className="width-full" />
          </FormItem>
          <FormItem label="Base DN:" htmlFor="ldap_base_dn" required field="baseDn" errors={ldapErrors}>
            <input id="ldap_base_dn" name="baseDn" className="width-full" defaultValue={view.ldap.baseDn} />
          </FormItem>
          <div className="checkbox_row">
            <input type="checkbox" id="ldap_start_tls" name="startTls" defaultChecked={view.ldap.startTls} />{" "}
            <label htmlFor="ldap_start_tls" className="inline">
              Upgrade the connection with StartTLS before binding (ldap:// URLs)
            </label>
            <ErrorLines field="startTls" errors={ldapErrors} />
          </div>
          <FormItem label="TLS CA certificate:" htmlFor="ldap_tls_ca_cert" notes="PEM; blank trusts the system store — for ldaps:// and StartTLS" field="tlsCaCert" errors={ldapErrors}>
            <textarea id="ldap_tls_ca_cert" name="tlsCaCert" rows={4} defaultValue={view.ldap.tlsCaCert} />
          </FormItem>
        </div>
        <div className="form_section">
          <h4>User lookup</h4>
          <FormItem label="Login attribute:" htmlFor="ldap_login_attribute" notes="uid, sAMAccountName" field="loginAttribute" errors={ldapErrors}>
            <input id="ldap_login_attribute" name="loginAttribute" defaultValue={view.ldap.loginAttribute} />
          </FormItem>
          <FormItem label="User object class:" htmlFor="ldap_object_class" field="objectClass" errors={ldapErrors}>
            <input id="ldap_object_class" name="objectClass" defaultValue={view.ldap.objectClass} />
          </FormItem>
          <FormItem label="Name attribute:" htmlFor="ldap_name_attribute" field="nameAttribute" errors={ldapErrors}>
            <input id="ldap_name_attribute" name="nameAttribute" defaultValue={view.ldap.nameAttribute} />
          </FormItem>
          <FormItem label="Email attribute:" htmlFor="ldap_mail_attribute" field="mailAttribute" errors={ldapErrors}>
            <input id="ldap_mail_attribute" name="mailAttribute" defaultValue={view.ldap.mailAttribute} />
          </FormItem>
        </div>
        <div className="form_section last">
          <h4>Group restriction</h4>
          <FormItem label="Required group DN:" htmlFor="ldap_group_dn" notes="optional" field="groupDn" errors={ldapErrors}>
            <input id="ldap_group_dn" name="groupDn" className="width-full" defaultValue={view.ldap.groupDn} />
          </FormItem>
          <FormItem label="Group object class:" htmlFor="ldap_group_object_class" field="groupObjectClass" errors={ldapErrors}>
            <input id="ldap_group_object_class" name="groupObjectClass" defaultValue={view.ldap.groupObjectClass} />
          </FormItem>
          <FormItem label="Group member attribute:" htmlFor="ldap_group_attribute" field="groupAttribute" errors={ldapErrors}>
            <input id="ldap_group_attribute" name="groupAttribute" defaultValue={view.ldap.groupAttribute} />
          </FormItem>
          <FormItem
            label="Group mappings:"
            htmlFor="ldap_group_mappings"
            notes="one per line: <group DN> => <project identifier>/<Mingle group name>; reconciled on every LDAP sign-in — a mapped LDAP group adds the user to the project team and the Mingle group, leaving it removes them from the Mingle group only"
            field="groupMappings"
            errors={ldapErrors}
          >
            <textarea id="ldap_group_mappings" name="groupMappings" rows={4} defaultValue={view.ldap.groupMappings} />
          </FormItem>
          <div className="checkbox_row">
            <input type="checkbox" id="ldap_auto_enroll" name="autoEnroll" defaultChecked={view.ldap.autoEnroll} />{" "}
            <label htmlFor="ldap_auto_enroll" className="inline">
              Create Mingle accounts on first sign-in
            </label>
            <ErrorLines field="autoEnroll" errors={ldapErrors} />
          </div>
          <ErrorLines field="authorization" errors={ldapErrors} />
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Save LDAP settings
          </button>
        </ActionBar>
      </Form>

      <h2 id="sso">Single sign-on (OpenID Connect)</h2>
      <p className="notes">
        Register this site with your provider using the callback URL <code>/auth/oidc/callback</code> on this site's
        address.
      </p>
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="oidc" />
        <div className="form_section last">
          <div className="checkbox_row">
            <input type="checkbox" id="oidc_enabled" name="enabled" defaultChecked={view.oidc.enabled} />{" "}
            <label htmlFor="oidc_enabled" className="inline">
              Enabled
            </label>
            <ErrorLines field="enabled" errors={oidcErrors} />
          </div>
          <FormItem label="Button label:" htmlFor="oidc_display_name" field="displayName" errors={oidcErrors}>
            <input id="oidc_display_name" name="displayName" className="width-large" defaultValue={view.oidc.displayName} />
          </FormItem>
          <FormItem label="Issuer URL:" htmlFor="oidc_issuer" required field="issuer" errors={oidcErrors}>
            <input id="oidc_issuer" name="issuer" className="width-full" defaultValue={view.oidc.issuer} />
          </FormItem>
          <FormItem label="Client ID:" htmlFor="oidc_client_id" required field="clientId" errors={oidcErrors}>
            <input id="oidc_client_id" name="clientId" className="width-full" defaultValue={view.oidc.clientId} />
          </FormItem>
          <FormItem
            label="Client secret:"
            htmlFor="oidc_client_secret"
            notes={view.oidc.clientSecretSet ? "set — leave blank to keep" : undefined}
            field="clientSecret"
            errors={oidcErrors}
          >
            <input id="oidc_client_secret" name="clientSecret" type="password" autoComplete="new-password" className="width-full" />
          </FormItem>
          <FormItem label="Scopes:" htmlFor="oidc_scopes" field="scopes" errors={oidcErrors}>
            <input id="oidc_scopes" name="scopes" className="width-full" defaultValue={view.oidc.scopes} />
          </FormItem>
          <div className="checkbox_row">
            <input type="checkbox" id="oidc_auto_enroll" name="autoEnroll" defaultChecked={view.oidc.autoEnroll} />{" "}
            <label htmlFor="oidc_auto_enroll" className="inline">
              Create Mingle accounts on first sign-in
            </label>
            <ErrorLines field="autoEnroll" errors={oidcErrors} />
          </div>
          <ErrorLines field="authorization" errors={oidcErrors} />
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Save single sign-on settings
          </button>
        </ActionBar>
      </Form>

      <h2 id="saml">SAML 2.0</h2>
      <p className="notes">
        SP-initiated sign-in over the HTTP-POST binding. Register this site with the identity provider using the
        metadata at <code>/auth/saml/metadata</code> (assertion consumer URL <code>/auth/saml/callback</code>); paste the
        provider's signing certificate below. Signed-in users are matched to Mingle accounts by the NameID (or the login
        attribute), as OIDC users are.
      </p>
      <Form method="post" className="form_contents">
        <input type="hidden" name="intent" value="saml" />
        <div className="form_section">
          <div className="checkbox_row">
            <input type="checkbox" id="saml_enabled" name="enabled" defaultChecked={view.saml.enabled} />{" "}
            <label htmlFor="saml_enabled" className="inline">
              Enabled
            </label>
            <ErrorLines field="enabled" errors={samlErrors} />
          </div>
          <FormItem label="Button label:" htmlFor="saml_display_name" required field="displayName" errors={samlErrors}>
            <input id="saml_display_name" name="displayName" className="width-large" defaultValue={view.saml.displayName} />
          </FormItem>
          <FormItem label="IdP single sign-on URL:" htmlFor="saml_entry_point" required notes="HTTP-Redirect binding" field="entryPoint" errors={samlErrors}>
            <input id="saml_entry_point" name="entryPoint" className="width-full" defaultValue={view.saml.entryPoint} />
          </FormItem>
          <FormItem label="IdP entity id:" htmlFor="saml_idp_issuer" notes="optional; responses from any other issuer are refused" field="idpIssuer" errors={samlErrors}>
            <input id="saml_idp_issuer" name="idpIssuer" className="width-full" defaultValue={view.saml.idpIssuer} />
          </FormItem>
          <FormItem label="IdP signing certificate:" htmlFor="saml_idp_cert" required notes="PEM, or the bare base64 body" field="idpCert" errors={samlErrors}>
            <textarea id="saml_idp_cert" name="idpCert" rows={6} defaultValue={view.saml.idpCert} />
          </FormItem>
          <FormItem label="This site's entity id:" htmlFor="saml_sp_entity_id" notes="the Audience the IdP must name; blank uses the site's address" field="spEntityId" errors={samlErrors}>
            <input id="saml_sp_entity_id" name="spEntityId" className="width-full" defaultValue={view.saml.spEntityId} />
          </FormItem>
        </div>
        <div className="form_section last">
          <h4>Attribute mapping</h4>
          <FormItem label="Login attribute:" htmlFor="saml_login_attribute" notes="blank uses the NameID" field="loginAttribute" errors={samlErrors}>
            <input id="saml_login_attribute" name="loginAttribute" defaultValue={view.saml.loginAttribute} />
          </FormItem>
          <FormItem label="Name attribute:" htmlFor="saml_name_attribute" notes="blank uses the login" field="nameAttribute" errors={samlErrors}>
            <input id="saml_name_attribute" name="nameAttribute" defaultValue={view.saml.nameAttribute} />
          </FormItem>
          <FormItem label="Email attribute:" htmlFor="saml_email_attribute" field="emailAttribute" errors={samlErrors}>
            <input id="saml_email_attribute" name="emailAttribute" defaultValue={view.saml.emailAttribute} />
          </FormItem>
          <div className="checkbox_row">
            <input type="checkbox" id="saml_auto_enroll" name="autoEnroll" defaultChecked={view.saml.autoEnroll} />{" "}
            <label htmlFor="saml_auto_enroll" className="inline">
              Create Mingle accounts on first sign-in
            </label>
            <ErrorLines field="autoEnroll" errors={samlErrors} />
          </div>
          <ErrorLines field="authorization" errors={samlErrors} />
        </div>
        <ActionBar>
          <button type="submit" className="save">
            Save SAML settings
          </button>
        </ActionBar>
      </Form>
    </div>
  );
}
