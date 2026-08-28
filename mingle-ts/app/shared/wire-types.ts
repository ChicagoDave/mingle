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
 * One piece of a murmur body prepared for display (Phase 20).
 *
 * A murmur is stored as plain text; the server splits it into these
 * segments — resolving which `@` tokens actually named a team member
 * and which `#123` references name a real card — and the browser
 * renders each segment, escaping the text ones. The shape crosses the
 * wire in every murmur loader payload, so both sides import it here
 * rather than the Collaboration read model, which is `.server`-only
 * (rule 8b).
 */
export type MurmurSegment =
  | { kind: "text"; text: string }
  | { kind: "card"; number: number }
  | { kind: "mention"; token: string };

/**
 * Field-keyed validation errors returned by form actions (register,
 * login, profile, password change). Keys are input field names; values
 * are human-readable messages in legacy Mingle's phrasing.
 */
export type FieldErrors = Record<string, string[]>;

/**
 * The card type pseudo-property's display name (legacy
 * CardTypeDefinition#name). Filterable and selectable as a column like
 * a real property, but backed by `cards.card_type_id`.
 *
 * Lives here rather than in the list-view module because it crosses the
 * wire in `filters[]` and `columns` params and is rendered by the card
 * list's own selectors — both sides must agree on the exact string, and
 * a `.server` module cannot be imported by the browser (rule 8b).
 */
export const CARD_TYPE_COLUMN_NAME = "Type";

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
  "tree_relationship",
] as const;

/**
 * The kinds a project admin can define directly on the properties
 * page. `tree_relationship` (Phase 23) is created by configuring a
 * card tree, never from the define-property form.
 */
export const DEFINABLE_PROPERTY_KINDS = PROPERTY_KINDS.filter(
  (kind) => kind !== "tree_relationship",
);

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
  tree_relationship: "Any card used in tree",
};

/**
 * Transition prerequisite kinds (Phase 14) — legacy TransitionPrerequisite
 * STI classes HasSpecificValue | HasSetValue | IsUser | InGroup as a
 * discriminator. Crosses the wire in the define-transition form's
 * "requires" selectors and the stored `transition_prerequisites.kind`.
 */
export const TRANSITION_PREREQUISITE_KINDS = [
  "has_specific_value",
  "has_set_value",
  "is_user",
  "in_group",
] as const;

/** One of TRANSITION_PREREQUISITE_KINDS. */
export type TransitionPrerequisiteKind =
  (typeof TRANSITION_PREREQUISITE_KINDS)[number];

/**
 * Transition action input modes (Phase 14) — whether an action sets a
 * fixed value or takes it from the executing user (legacy special
 * values "(user input - required)" / "(user input - optional)").
 * Crosses the wire in the define-transition form's "sets" selectors,
 * the stored `transition_actions.input_mode`, and the card page's
 * transition forms (which render an input per user-input action).
 */
export const TRANSITION_ACTION_INPUT_MODES = [
  "fixed",
  "user_input_required",
  "user_input_optional",
] as const;

/** One of TRANSITION_ACTION_INPUT_MODES. */
export type TransitionActionInputMode =
  (typeof TRANSITION_ACTION_INPUT_MODES)[number];

/**
 * The legacy special values the define-transition form posts in a
 * property's "requires"/"sets" field in place of a real value
 * (transition.rb USER_INPUT_* constants and PropertyValue's SET /
 * NOT_SET display values). Anything else posted is a literal value; an
 * empty string means "no requirement" / "no action" for that property.
 */
export const TRANSITION_SPECIAL_VALUES = {
  SET: "(set)",
  NOT_SET: "(not set)",
  USER_INPUT_REQUIRED: "(user input - required)",
  USER_INPUT_OPTIONAL: "(user input - optional)",
} as const;

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

/**
 * History subscription kinds (Phase 22) — what a subscription watches.
 * Posted by the subscribe forms and stored in `history_subscriptions.kind`.
 * `project` is everything in the project (legacy's global subscription),
 * `card` one card, `page` one wiki page, and `mql` the cards an MQL
 * condition selects.
 */
export const SUBSCRIPTION_KINDS = ["project", "card", "page", "mql"] as const;

/** One of SUBSCRIPTION_KINDS. */
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

/** A subscription as the subscriptions page receives it from its loader. */
export interface SubscriptionSummary {
  id: number;
  kind: SubscriptionKind;
  /** Human wording of what is watched, e.g. "Card #12 Fix login". */
  description: string;
  /** Why delivery last failed for this subscription, when it did. */
  lastError: string | null;
}
