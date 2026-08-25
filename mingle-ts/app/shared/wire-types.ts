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

/**
 * Property definition kinds (Phases 7–8), the `kind` discriminator on
 * `property_definitions`. Maps to the legacy STI classes:
 * text/number → TextPropertyDefinition (is_numeric toggles),
 * date → DatePropertyDefinition, user → UserPropertyDefinition,
 * enumerated → EnumeratedPropertyDefinition,
 * formula → FormulaPropertyDefinition (calculated — never set
 * directly). Crosses the wire in the define-property form's kind
 * selector.
 */
export const PROPERTY_KINDS = [
  "text",
  "number",
  "date",
  "user",
  "enumerated",
  "formula",
] as const;

/** One of PROPERTY_KINDS. */
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/** Human labels for the kind selector (legacy describe_type strings). */
export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
  text: "Any text",
  number: "Any number",
  date: "Date",
  user: "Automatically generated from the team list",
  enumerated: "Managed text list",
  formula: "Formula",
};

/**
 * Saved card view styles (Phase 11) — which view a favorite reopens
 * into. Crosses the wire in the save-favorite form's hidden `style`
 * field and the favorite's stored `style` column (legacy
 * CardView::Style names "list" and "grid").
 */
export const CARD_VIEW_STYLES = ["list", "grid"] as const;

/** One of CARD_VIEW_STYLES. */
export type CardViewStyle = (typeof CARD_VIEW_STYLES)[number];

/**
 * A favorite as the card views receive it from their loaders (Phase 11):
 * identity, display facts, and the canonical URL it reopens into.
 */
export interface FavoriteSummary {
  id: number;
  name: string;
  style: CardViewStyle;
  /** True when this team favorite is shown as a project tab. */
  tabView: boolean;
  /** True when owned by the viewing user rather than the team. */
  personal: boolean;
  href: string;
}

/**
 * Card list filter operators (Phase 9) — the operator vocabulary of the
 * legacy interactive filters (operator.rb names as serialized by
 * filters.rb's encoded form). These are the values that cross the wire
 * in the `filters[]` query parameter and the filter form's operator
 * selector. Date properties *display* "is less than" as "is before"
 * and "is greater than" as "is after" (legacy Operator date_name), but
 * the encoded parameter always carries the canonical name below.
 */
export const FILTER_OPERATORS = [
  "is",
  "is not",
  "is less than",
  "is greater than",
] as const;

/** One of FILTER_OPERATORS. */
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * The operators a filter on the given column offers (legacy
 * available_operators): equality only for text and user properties and
 * the card type pseudo-property; equality plus ordinals for number,
 * date, enumerated (ordered by defined position), and formula.
 *
 * @param kind - a PropertyKind, or "type" for the card type column
 * @returns the offered operators, in legacy menu order
 */
export function filterOperatorsFor(
  kind: PropertyKind | "type",
): readonly FilterOperator[] {
  if (kind === "type" || kind === "text" || kind === "user") {
    return ["is", "is not"];
  }
  return FILTER_OPERATORS;
}

/**
 * Display name for an operator on a given column (legacy
 * Operator.date_name): date properties read "is before"/"is after".
 *
 * @param operator - the canonical operator
 * @param isDate - whether the filtered property is date-valued
 * @returns the label to show in the operator selector
 */
export function filterOperatorLabel(
  operator: FilterOperator,
  isDate: boolean,
): string {
  if (!isDate) return operator;
  if (operator === "is less than") return "is before";
  if (operator === "is greater than") return "is after";
  return operator;
}

/** Health probe response returned by GET /healthz. */
export interface HealthzResponse {
  /** Overall service status: "ok" only when the database round-trip succeeded. */
  status: "ok" | "degraded";
  /** Database connectivity: result of a real SELECT round-trip, never assumed. */
  db: "connected" | "unreachable";
  /** ISO-8601 timestamp the probe was answered at (server clock). */
  checkedAt: string;
}
