/**
 * /profile — profile settings (display name, email, password change,
 * API keys).
 *
 * Purpose: the Phase 2 profile route. Its forms post to one action,
 * discriminated by the `intent` field: "profile" runs UpdateUserProfile,
 * "password" runs ChangePassword, "generate-api-key" runs
 * GenerateApiKey (Phase 30 — the key is shown once), "revoke-api-key"
 * runs RevokeApiKey. Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/profile";
import { ActionBar, FormItem, ErrorLines, FlashBox } from "~/components/forms";
import "../styles/profile.css";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { users } from "~/db/schema/identity";
import {
  changePassword,
  updateUserProfile,
} from "~/domain/identity/commands.server";
import {
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  rotateSigningSecret,
} from "~/domain/identity/api-keys.server";
import { sealer } from "~/auth/sealer.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the logged-in user's editable profile fields. */
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Response("Not Found", { status: 404 });
  return {
    login: user.login,
    name: user.name,
    email: user.email,
    admin: user.admin,
    timeZone: user.timeZone,
    apiKeys: listApiKeys(db, userId).map((key) => ({
      id: key.id,
      keyPrefix: key.keyPrefix,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      previousSecretExpiresAt: key.previousSecretExpiresAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Dispatches the posted form by `intent` to UpdateUserProfile,
 * ChangePassword, GenerateApiKey, RotateSigningSecret, or RevokeApiKey;
 * returns field errors, or a saved flag (plus the one-time key or
 * secret when generated or rotated).
 */
export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "profile") {
    const result = updateUserProfile(db, {
      userId,
      name: String(form.get("name") ?? ""),
      email: form.get("email") ? String(form.get("email")) : null,
      timeZone: String(form.get("timeZone") ?? "UTC"),
    });
    return result.ok
      ? { saved: "profile" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "password") {
    const result = changePassword(db, {
      userId,
      currentPassword: String(form.get("currentPassword") ?? ""),
      newPassword: String(form.get("newPassword") ?? ""),
    });
    return result.ok
      ? { saved: "password" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "generate-api-key") {
    const result = generateApiKey(db, sealer, { userId, actorUserId: userId });
    return result.ok
      ? { saved: "api-key" as const, generatedKey: result.value.key, generatedSigningSecret: result.value.signingSecret }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "rotate-signing-secret") {
    const result = rotateSigningSecret(db, sealer, {
      apiKeyId: Number(form.get("apiKeyId") ?? 0),
      actorUserId: userId,
    });
    return result.ok
      ? {
          saved: "signing-secret-rotated" as const,
          rotatedKeyId: result.value.row.id,
          rotatedSigningSecret: result.value.signingSecret,
          previousSecretExpiresAt: result.value.previousSecretExpiresAt.toISOString(),
        }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "revoke-api-key") {
    const result = revokeApiKey(db, {
      apiKeyId: Number(form.get("apiKeyId") ?? 0),
      actorUserId: userId,
    });
    return result.ok
      ? { saved: "api-key-revoked" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Profile page — legacy users/show.rhtml (header, basic information, tabs) with users/_form.rhtml and _hmac_auth_key.rhtml. */
export default function Profile() {
  const user = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const generatedKey =
    actionData && "generatedKey" in actionData ? actionData.generatedKey : null;
  const generatedSigningSecret =
    actionData && "generatedSigningSecret" in actionData ? actionData.generatedSigningSecret : null;
  const rotated =
    actionData && "rotatedSigningSecret" in actionData
      ? { keyId: actionData.rotatedKeyId, secret: actionData.rotatedSigningSecret, until: actionData.previousSecretExpiresAt ?? "" }
      : null;
  const savedMessage =
    saved === "profile"
      ? "Profile was successfully updated."
      : saved === "password"
        ? "Password was successfully changed."
        : saved === "api-key"
          ? "A new API key was generated."
          : saved === "api-key-revoked"
            ? "The API key was revoked."
            : saved === "signing-secret-rotated"
              ? "The signing secret was rotated."
              : null;

  return (
    <div id="profile-page">
      <div>
        <h1>
          <span className="profile-title">{user.name}</span>
          <span className="profile-header-actions">
            <a href="#edit-profile" className="edit-user primary" id="edit-profile-link">
              Edit
            </a>
            <a href="#change-password" className="edit-password" id="change-password-link">
              Change password
            </a>
          </span>
        </h1>
      </div>
      {savedMessage ? <FlashBox kind="success">{savedMessage}</FlashBox> : null}
      <div className="basic-profile-information">
        {user.admin ? (
          <p>
            {user.name} is an <b>administrator</b>.{" "}
            <Link to="/admin/authentication">Authentication settings</Link> · <Link to="/admin/schedules">Schedules</Link>
          </p>
        ) : null}
        <p>
          <label>Sign-in name:</label>
          <span id="user_login">{user.login}</span>
        </p>
        <p>
          <label>Display name:</label>
          <span>{user.name}</span>
        </p>
        <p>
          <label>Email:</label>
          <span id="user_email">{user.email ? user.email : "Not set"}</span>
        </p>
        <p>
          <label>Time zone:</label>
          <span id="user_time_zone_value">{user.timeZone}</span>
        </p>
      </div>

      <div className="tabs_pane" id="profile-tabs">
        <h2 id="edit-profile">Edit profile</h2>
        <Form method="post" className="form_contents">
          <input type="hidden" name="intent" value="profile" />
          <FormItem
            label="Display name:"
            htmlFor="user_name"
            required
            notes="Used as display name in Mingle, i.e. this is the name other Mingle users see"
            field="name"
            errors={errors}
          >
            <input id="user_name" name="name" className="large" defaultValue={user.name} />
          </FormItem>
          <FormItem
            label="Email:"
            htmlFor="user_email_field"
            notes="Used for subscribing to alerts, etc. Should be of the form sam@email.com"
            field="email"
            errors={errors}
          >
            <input id="user_email_field" name="email" type="email" className="large" defaultValue={user.email ?? ""} />
          </FormItem>
          <FormItem
            label="Time zone:"
            htmlFor="user_time_zone"
            notes="IANA name, e.g. America/Chicago; timestamps are shown in this zone"
            field="timeZone"
            errors={errors}
          >
            <input id="user_time_zone" name="timeZone" className="large" defaultValue={user.timeZone} list="time-zones" />
            <datalist id="time-zones">
              {Intl.supportedValuesOf("timeZone").map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </FormItem>
          <ActionBar>
            <button type="submit" className="save">
              Save profile
            </button>
          </ActionBar>
        </Form>

        <h2 id="change-password">Change password</h2>
        <Form method="post" className="form_contents">
          <input type="hidden" name="intent" value="password" />
          <FormItem label="Current password:" htmlFor="current_password" required field="currentPassword" errors={errors}>
            <input id="current_password" name="currentPassword" type="password" className="large" />
          </FormItem>
          <FormItem label="New password:" htmlFor="new_password" required field="newPassword" errors={errors}>
            <input id="new_password" name="newPassword" type="password" className="large" />
          </FormItem>
          <ActionBar>
            <button type="submit" className="save">
              Change password
            </button>
          </ActionBar>
        </Form>

        <h2 id="hmac-auth-key">API keys</h2>
        <div className="content">
          <p className="notes">
            An API key authenticates requests to /api/v1 as you, sent as{" "}
            <code>Authorization: Bearer &lt;key&gt;</code>; its signing secret signs{" "}
            <code>Authorization: Mingle-HMAC-SHA256 {user.login}:&lt;signature&gt;</code> requests. Both are shown
            once, when generated.
          </p>
          {generatedKey ? (
            <FlashBox kind="info">
              Your new API key — copy it now, it will not be shown again:
              <br />
              <code data-testid="generated-api-key">{generatedKey}</code>
              <br />
              Its signing secret:
              <br />
              <code data-testid="generated-signing-secret">{generatedSigningSecret}</code>
            </FlashBox>
          ) : null}
          {rotated ? (
            <FlashBox kind="info">
              The new signing secret for key #{rotated.keyId} — copy it now, it will not be shown again:
              <br />
              <code data-testid="rotated-signing-secret">{rotated.secret}</code>
              <br />
              Requests signed with the previous secret are accepted until {rotated.until.slice(0, 16).replace("T", " ")} UTC.
            </FlashBox>
          ) : null}
          <ErrorLines field="apiKey" errors={errors} />
          <ErrorLines field="authorization" errors={errors} />
          <table id="api-keys" className="highlightable-table">
            <thead>
              <tr className="table-top">
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Signing secret</th>
                <th className="align-right last">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {user.apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={5} className="italic-light align-center last">
                    You have no API keys.
                  </td>
                </tr>
              ) : (
                user.apiKeys.map((key, index) => (
                  <tr key={key.id} className={index % 2 === 0 ? "odd" : "even"}>
                    <td>
                      <code>{key.keyPrefix}…</code>
                    </td>
                    <td>{key.createdAt.slice(0, 10)}</td>
                    <td>{key.lastUsedAt ? key.lastUsedAt.slice(0, 10) : "never"}</td>
                    <td className="inline-forms">
                      <Form method="post">
                        <input type="hidden" name="intent" value="rotate-signing-secret" />
                        <input type="hidden" name="apiKeyId" value={key.id} />
                        <button type="submit" className="inline">
                          Rotate
                        </button>
                      </Form>
                      {key.previousSecretExpiresAt ? (
                        <span className="notes"> previous secret valid until {key.previousSecretExpiresAt.slice(0, 16).replace("T", " ")} UTC</span>
                      ) : null}
                    </td>
                    <td className="align-right last inline-forms">
                      <Form method="post">
                        <input type="hidden" name="intent" value="revoke-api-key" />
                        <input type="hidden" name="apiKeyId" value={key.id} />
                        <button type="submit" className="inline delete">
                          Revoke
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div id="hmac-form">
            <Form method="post">
              <input type="hidden" name="intent" value="generate-api-key" />
              <button type="submit" id="generate-hmac" className="primary">
                Generate
              </button>
            </Form>
            <div id="hmac-key-warning" className="notes">
              Note: a key is shown once; keep it somewhere safe.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
