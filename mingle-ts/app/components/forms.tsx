/**
 * Form-page primitives (P-17) — the legacy building blocks every admin
 * and form page is assembled from.
 *
 * Purpose: the markup of `action_bar` / `styled_box` (application_helper),
 * `form_item` + `error_message_on` (the `.form_item` / `.field_error` /
 * `.notes` / `.required` idiom of users/_form.rhtml and projects/_form.rhtml),
 * the flash boxes of layouts/_flash.rhtml, and the project-admin sidebar
 * of shared/_admin_actions.rhtml (`ul#admin-nav`, grouped per
 * project_admin_actions_helper.rb — Project / Cards / Integrations /
 * Views & content / Users, with the current page marked
 * `current-selection`). Purely presentational.
 *
 * Public interface: `ActionBar`, `FormItem`, `ErrorLines`, `FlashBox`,
 * `AdminPage`, `AdminSection`.
 *
 * Owner context: Frontend UI (presentation).
 */
import { Link } from "react-router";
import type { FieldErrors } from "~/shared/wire-types";
import "../styles/forms.css";

/** Legacy `action_bar`: the strip of page actions above/below a form. */
export function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className="action-bar">{children}</div>;
}

/**
 * A field's error messages (legacy `error_message_on`), rendered
 * above the input. `prefix` reproduces legacy's `:prepend_text`
 * ("Sign-in name " + "can't be blank").
 */
export function ErrorLines({
  field,
  errors,
  prefix,
}: {
  field: string;
  errors: FieldErrors;
  prefix?: string;
}) {
  const messages = errors[field];
  if (!messages?.length) return null;
  return (
    <>
      {messages.map((message) => (
        <div key={message} className="field_error">
          {prefix ? `${prefix} ${message}` : message}
        </div>
      ))}
    </>
  );
}

/**
 * Legacy `.form_item`: a label (with optional required star and
 * italic note), the field's errors, then the control.
 */
export function FormItem({
  label,
  htmlFor,
  required = false,
  notes,
  field,
  errors = {},
  errorPrefix,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  notes?: React.ReactNode;
  field?: string;
  errors?: FieldErrors;
  errorPrefix?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form_item">
      <label htmlFor={htmlFor}>
        {label}
        {required ? <span className="required">*</span> : null}
        {notes ? <> <span className="notes">({notes})</span></> : null}
      </label>
      {field ? <ErrorLines field={field} errors={errors} prefix={errorPrefix} /> : null}
      {children}
    </div>
  );
}

/** Legacy flash message boxes (`render_flash_messages`). */
export function FlashBox({
  kind,
  children,
}: {
  kind: "success" | "error" | "info" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div className={`${kind}-box`}>
      <div className="flash-content">{children}</div>
    </div>
  );
}

/** Keys of the project-admin pages, for marking the current nav entry. */
export type AdminSection =
  | "settings"
  | "variables"
  | "card-types"
  | "properties"
  | "transitions"
  | "trees"
  | "integrations"
  | "favorites"
  | "pages"
  | "team"
  | "groups";

/** The admin-nav groups (project_admin_actions_helper.rb), with the port's routes. */
function adminGroups(base: string): { heading: string; links: { key: AdminSection; title: string; href: string }[] }[] {
  return [
    {
      heading: "Project",
      links: [
        { key: "settings", title: "Project settings", href: `${base}/settings` },
        { key: "variables", title: "Project variables", href: `${base}/settings#project-variables` },
      ],
    },
    {
      heading: "Cards",
      links: [
        { key: "card-types", title: "Card types", href: `${base}/settings#card-types` },
        { key: "properties", title: "Card properties", href: `${base}/settings#card-properties` },
        { key: "transitions", title: "Card transitions", href: `${base}/transitions` },
        { key: "trees", title: "Card trees", href: `${base}/trees` },
      ],
    },
    {
      heading: "Integrations",
      links: [{ key: "integrations", title: "Slack & GitHub", href: `${base}/integrations` }],
    },
    {
      heading: "Views / content",
      links: [
        { key: "favorites", title: "Team favorites & tabs", href: `${base}/favorites` },
        { key: "pages", title: "Pages", href: `${base}/wiki` },
      ],
    },
    {
      heading: "Users",
      links: [
        { key: "team", title: "Team members", href: `${base}/team` },
        { key: "groups", title: "Groups", href: `${base}/groups` },
      ],
    },
  ];
}

/**
 * A project-admin page: the content beside the legacy admin sidebar
 * (`#sidebar` > `.sidebar-panel` > `ul#admin-nav`).
 */
export function AdminPage({
  identifier,
  current,
  children,
}: {
  identifier: string;
  current: AdminSection;
  children: React.ReactNode;
}) {
  return (
    <div id="admin-page" className="with-sidebar">
      <div className="admin-content">{children}</div>
      <div className="sidebar expanded" id="sidebar">
        <div className="sidebar-panel">
          <ul id="admin-nav">
            {adminGroups(`/projects/${identifier}`).map((group) => (
              <li key={group.heading} className="heading-group">
                <ul>
                  <li className="heading">{group.heading}</li>
                  {group.links.map((link) => (
                    <li key={link.key} className={link.key === current ? "current-selection" : undefined}>
                      <Link to={link.href}>{link.title}</Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
