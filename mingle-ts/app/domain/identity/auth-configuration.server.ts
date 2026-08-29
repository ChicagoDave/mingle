/**
 * Authentication configuration — which external sign-in sources the
 * site enables, and their settings (Phase 31).
 *
 * Purpose: the successor of legacy `auth_config.yml` (`authentication:
 * ldap`, `ldap_settings`, and the SaaS SSO config). Site-wide, as
 * legacy's was; edited by site admins. Secret settings — the LDAP bind
 * password, the OIDC client secret — are stored sealed and are
 * write-only from the admin page: a blank posted secret keeps the one
 * on file.
 *
 * Commands → events:
 *   ConfigureAuthentication → AuthenticationConfigured
 *
 * Public interface: `LdapSettings`, `OidcSettings`, `SamlSettings`,
 * `AuthenticationConfiguration`, `configureAuthentication`,
 * `loadAuthenticationConfiguration`, `authenticationView`,
 * `DEFAULT_LDAP_SETTINGS`, `DEFAULT_OIDC_SETTINGS`,
 * `DEFAULT_SAML_SETTINGS`.
 *
 * Owner context: Identity & Access. Handlers take the Drizzle handle
 * and the sealer as parameters.
 *
 * INVARIANT — a secret is never in an event payload, a view, or a
 * rejection message, and never in `auth_configurations.settings`
 * unsealed.
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { authConfigurations } from "~/db/schema/identity";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import { SEALED_PREFIX, type Sealer } from "~/domain/identity/sealer.server";
import { parseLdapGroupMappings } from "~/domain/identity/ldap-group-sync.server";
import type {
  AuthSourceKind,
  AuthenticationView,
  FieldErrors,
  LdapSettingsView,
  OidcSettingsView,
  SamlSettingsView,
} from "~/shared/wire-types";

/** LDAP settings with the bind password in the clear (in memory only). */
export interface LdapSettings extends Omit<LdapSettingsView, "bindPasswordSet"> {
  bindPassword: string;
}

/** OIDC settings with the client secret in the clear (in memory only). */
export interface OidcSettings extends Omit<OidcSettingsView, "clientSecretSet"> {
  clientSecret: string;
}

/** SAML settings carry no secret (P-9): the view is the settings. */
export type SamlSettings = SamlSettingsView;
/** Everything the sign-in adapters need, decrypted. */
export interface AuthenticationConfiguration {
  ldap: LdapSettings;
  oidc: OidcSettings;
  saml: SamlSettings;
}

export const DEFAULT_LDAP_SETTINGS: LdapSettings = {
  enabled: false,
  url: "",
  bindDn: "",
  bindPassword: "",
  baseDn: "",
  loginAttribute: "uid",
  objectClass: "person",
  nameAttribute: "cn",
  mailAttribute: "mail",
  groupDn: "",
  groupObjectClass: "",
  groupAttribute: "",
  autoEnroll: true,  startTls: false,
  tlsCaCert: "",
  groupMappings: "",
};

export const DEFAULT_OIDC_SETTINGS: OidcSettings = {
  enabled: false,
  displayName: "Single sign-on",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
  autoEnroll: true,
};

export const DEFAULT_SAML_SETTINGS: SamlSettings = {
  enabled: false,
  displayName: "Corporate sign-in (SAML)",
  entryPoint: "",
  idpIssuer: "",
  idpCert: "",
  spEntityId: "",
  loginAttribute: "",
  nameAttribute: "",
  emailAttribute: "",
  autoEnroll: true,
};

/** The one secret field of each kind, sealed at rest (SAML has none). */
const SECRET_FIELD: Partial<Record<AuthSourceKind, "bindPassword" | "clientSecret">> = {
  ldap: "bindPassword",
  oidc: "clientSecret",
};

type Settings = LdapSettings | OidcSettings | SamlSettings;

const DEFAULTS: Record<AuthSourceKind, Settings> = {
  ldap: DEFAULT_LDAP_SETTINGS,
  oidc: DEFAULT_OIDC_SETTINGS,
  saml: DEFAULT_SAML_SETTINGS,
};

/** Reads a kind's stored settings (secret still sealed), defaults applied. */
function storedSettings(db: BetterSQLite3Database, kind: AuthSourceKind): Settings {
  const row = db.select().from(authConfigurations).where(eq(authConfigurations.kind, kind)).get();
  const defaults = DEFAULTS[kind];
  const parsed = row ? (JSON.parse(row.settings) as Partial<Settings>) : {};
  return { ...defaults, ...parsed, enabled: row?.enabled ?? false } as Settings;
}

/** Trims every string field of a settings object. */
function trimmed<T extends object>(settings: T): T {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]),
  ) as T;
}

/** Legacy-style presence checks for the fields a kind cannot work without. */
function settingsErrors(kind: AuthSourceKind, settings: Settings): FieldErrors {
  const errors: FieldErrors = {};
  const required = (field: keyof LdapSettings | keyof OidcSettings | keyof SamlSettings) => {
    if (!(settings as unknown as Record<string, unknown>)[field]) errors[field] = ["can't be blank"];
  };
  if (kind === "saml") {
    const saml = settings as unknown as SamlSettings;
    required("entryPoint");
    if (saml.entryPoint && !/^https?:\/\/\S+$/i.test(saml.entryPoint)) errors.entryPoint = ["must be an http(s) URL"];
    required("idpCert");
    required("displayName");
    return errors;
  }
  if (kind === "ldap") {
    const ldap = settings as LdapSettings;
    required("url");
    if (ldap.url && !/^ldaps?:\/\/\S+$/i.test(ldap.url)) errors.url = ["must be an ldap:// or ldaps:// URL"];
    required("baseDn");
    required("loginAttribute");
    required("objectClass");
    const groupFields = [ldap.groupDn, ldap.groupObjectClass, ldap.groupAttribute].filter(Boolean).length;
    if (groupFields !== 0 && groupFields !== 3)
      errors.groupDn = ["group DN, object class, and member attribute must be given together"];
    if (ldap.startTls && /^ldaps:/i.test(ldap.url)) errors.startTls = ["applies to ldap:// URLs; an ldaps:// URL is already TLS"];
    const mappingErrors = parseLdapGroupMappings(ldap.groupMappings).errors;
    if (mappingErrors.length > 0) errors.groupMappings = mappingErrors;
  } else {
    const oidc = settings as OidcSettings;
    required("issuer");
    if (oidc.issuer && !/^https?:\/\/\S+$/i.test(oidc.issuer)) errors.issuer = ["must be an http(s) URL"];
    required("clientId");
    required("clientSecret");
    required("displayName");
    if (!oidc.scopes.split(/\s+/).includes("openid")) errors.scopes = ["must include openid"];
  }
  return errors;
}

export interface ConfigureAuthenticationInput {
  kind: AuthSourceKind;
  /** The full settings for the kind; a blank secret keeps the stored one. */
  settings: LdapSettings | OidcSettings | SamlSettings;
  actorUserId: number;
}

/**
 * ConfigureAuthentication — replaces a source's settings.
 *
 * DOES: upserts the `auth_configurations` row for the kind with the
 * trimmed settings (the secret sealed; a blank posted secret keeps the
 * stored one) and the enabled flag, and appends an
 * AuthenticationConfigured event naming the kind and whether it is
 * enabled — never the settings — in one transaction.
 * REJECTS: actor not a site admin; a required field blank (`url`,
 * `baseDn`, `loginAttribute`, `objectClass` for LDAP; `issuer`,
 * `clientId`, `clientSecret` on first save, `displayName` for OIDC;
 * `entryPoint`, `idpCert`, `displayName` for SAML);
 * a malformed URL; group fields given partially; OIDC scopes without
 * `openid`. Validation applies only when the source is enabled —
 * a disabled source may be saved half-filled.
 *
 * @returns the stored view of the kind, or field errors
 */
export function configureAuthentication(
  db: BetterSQLite3Database,
  sealer: Sealer,
  input: ConfigureAuthenticationInput,
): CommandResult<LdapSettingsView | OidcSettingsView | SamlSettingsView> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;

  const secretField = SECRET_FIELD[input.kind];
  const current = storedSettings(db, input.kind) as unknown as Record<string, unknown>;
  const posted = trimmed(input.settings) as unknown as Record<string, unknown>;
  const postedSecret = secretField ? String(posted[secretField] ?? "") : "";
  const sealedSecret = secretField ? (postedSecret ? sealer.seal(postedSecret) : String(current[secretField] ?? "")) : "";
  const effective = (secretField ? { ...posted, [secretField]: sealedSecret ? "set" : "" } : posted) as unknown as Settings;
  if (effective.enabled) {
    const errors = settingsErrors(input.kind, effective);
    if (Object.keys(errors).length > 0) return { ok: false, errors };
  }
  const toStore = secretField ? { ...posted, [secretField]: sealedSecret } : { ...posted };
  delete (toStore as Record<string, unknown>).enabled;

  return db.transaction((tx) => {
    const existing = tx.select({ id: authConfigurations.id }).from(authConfigurations).where(eq(authConfigurations.kind, input.kind)).get();
    const values = {
      enabled: Boolean(posted.enabled),
      settings: JSON.stringify(toStore),
      updatedByUserId: input.actorUserId,
      updatedAt: new Date(),
    };
    if (existing) tx.update(authConfigurations).set(values).where(eq(authConfigurations.id, existing.id)).run();
    else tx.insert(authConfigurations).values({ kind: input.kind, ...values }).run();
    emitEvent(tx, {
      type: "AuthenticationConfigured",
      aggregateType: "AuthConfiguration",
      aggregateId: existing?.id ?? tx.select({ id: authConfigurations.id }).from(authConfigurations).where(eq(authConfigurations.kind, input.kind)).get()!.id,
      payload: { kind: input.kind, enabled: values.enabled },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: viewOf(input.kind, tx) } as CommandResult<LdapSettingsView | OidcSettingsView | SamlSettingsView>;
  });
}

/** The admin-page view of one kind: secret replaced by a presence flag. */
function viewOf(kind: AuthSourceKind, db: BetterSQLite3Database): LdapSettingsView | OidcSettingsView | SamlSettingsView {
  const settings = storedSettings(db, kind) as unknown as Record<string, unknown>;
  const secretField = SECRET_FIELD[kind];
  if (!secretField) return settings as unknown as SamlSettingsView;
  const { [secretField]: sealed, ...rest } = settings;
  const flag = kind === "ldap" ? "bindPasswordSet" : "clientSecretSet";
  return { ...rest, [flag]: typeof sealed === "string" && sealed.startsWith(SEALED_PREFIX) } as unknown as
    | LdapSettingsView
    | OidcSettingsView;
}

/**
 * The authentication page's data — every kind, secrets as flags.
 *
 * @param db - the Drizzle handle
 */
export function authenticationView(db: BetterSQLite3Database): AuthenticationView {
  return {
    ldap: viewOf("ldap", db) as LdapSettingsView,
    oidc: viewOf("oidc", db) as OidcSettingsView,
    saml: viewOf("saml", db) as SamlSettingsView,
  };
}

/**
 * The decrypted configuration for the sign-in adapters.
 *
 * @param db - the Drizzle handle
 * @param sealer - opens the stored secrets
 * @returns settings for both kinds; a secret that cannot be opened
 *   (sealed under another install secret) reads as blank
 */
export function loadAuthenticationConfiguration(db: BetterSQLite3Database, sealer: Sealer): AuthenticationConfiguration {
  const open = (sealed: unknown): string => {
    if (typeof sealed !== "string" || !sealed.startsWith(SEALED_PREFIX)) return "";
    try {
      return sealer.open(sealed);
    } catch {
      return "";
    }
  };
  const ldap = storedSettings(db, "ldap") as LdapSettings;
  const oidc = storedSettings(db, "oidc") as OidcSettings;
  const saml = storedSettings(db, "saml") as unknown as SamlSettings;
  return {
    ldap: { ...ldap, bindPassword: open(ldap.bindPassword) },
    oidc: { ...oidc, clientSecret: open(oidc.clientSecret) },
    saml,
  };
}
