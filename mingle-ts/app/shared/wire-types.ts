/**
 * Wire types shared between client and server (ADR-0001, rule 8b).
 *
 * Purpose: the single import point for every type that crosses the
 * HTTP boundary — response payloads, request bodies, discriminators,
 * and enums. Client and server both import from this file directly;
 * no re-declaration, no re-export chains.
 *
 * Public interface: the exported types below. Add new wire types here
 * as routes gain them; never define a wire shape inline in a route.
 *
 * Owner context: cross-cutting protocol layer (no bounded context).
 *
 * INVARIANT — no runtime-specific types. Nothing in this file may
 * reference Node types (Buffer, fs.*), DOM types (DOMException,
 * HTMLElement), or any import that drags in a runtime one side lacks.
 * Plain data shapes only.
 */

/**
 * Field-keyed validation errors returned by form actions (register,
 * login, profile, password change). Keys are input field names; values
 * are human-readable messages in legacy Mingle's phrasing.
 */
export type FieldErrors = Record<string, string[]>;

/**
 * Project variable data types (legacy ProjectVariable::DATA_TYPES).
 * Crosses the wire in the define-variable form's type selector.
 */
export const PROJECT_VARIABLE_DATA_TYPES = [
  "StringType",
  "NumericType",
  "UserType",
  "DateType",
  "CardType",
] as const;

/** One of PROJECT_VARIABLE_DATA_TYPES. */
export type ProjectVariableDataType =
  (typeof PROJECT_VARIABLE_DATA_TYPES)[number];

/**
 * Human labels for the data type selector (legacy
 * ProjectVariable::DATA_TYPE_DESCRIPTIONS).
 */
export const PROJECT_VARIABLE_DATA_TYPE_LABELS: Record<
  ProjectVariableDataType,
  string
> = {
  StringType: "Text",
  NumericType: "Numeric",
  UserType: "Selected from team list",
  DateType: "Date",
  CardType: "Card",
};

/**
 * Project team roles (legacy MembershipRole::PROJECT_ROLES ids, stored
 * in `team_memberships.role`). Crosses the wire in the team page's role
 * selector. The site-wide admin flag (`users.admin`) is not a project
 * role — it outranks all of these (legacy PrivilegeLevel::MINGLE_ADMIN).
 */
export const PROJECT_ROLES = [
  "project_admin",
  "full_member",
  "readonly_member",
] as const;

/** One of PROJECT_ROLES. */
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Human labels for the role selector (legacy MembershipRole names). */
export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  project_admin: "Project administrator",
  full_member: "Team member",
  readonly_member: "Read only team member",
};

/** The role a new team member gets when none is chosen (legacy MembershipRole.default). */
export const DEFAULT_PROJECT_ROLE: ProjectRole = "full_member";

/** Health probe response returned by GET /healthz. */
export interface HealthzResponse {
  /** Overall service status: "ok" only when the database round-trip succeeded. */
  status: "ok" | "degraded";
  /** Database connectivity: result of a real SELECT round-trip, never assumed. */
  db: "connected" | "unreachable";
  /** ISO-8601 timestamp the probe was answered at (server clock). */
  checkedAt: string;
}
