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
  "aggregate",
] as const;

/**
 * The kinds a project admin can define directly on the properties
 * page. `tree_relationship` (Phase 23) is created by configuring a
 * card tree and `aggregate` (Phase 24) is defined on a tree's page for
 * one of its card types — neither comes from the define-property form.
 */
export const DEFINABLE_PROPERTY_KINDS = PROPERTY_KINDS.filter(
  (kind) => kind !== "tree_relationship" && kind !== "aggregate",
);

/**
 * The kinds a card type may carry a default value for (P-2): the
 * directly settable ones. Formula, tree relationship and aggregate
 * values are derived or structural and never defaulted.
 */
export const DEFAULTABLE_PROPERTY_KINDS = PROPERTY_KINDS.filter(
  (kind) => kind !== "formula" && kind !== "tree_relationship" && kind !== "aggregate",
);

/**
 * The marker a user-kind card default may hold in place of a user id
 * (legacy PropertyType::UserType::CURRENT_USER): resolved to the actor
 * creating the card.
 */
export const CURRENT_USER_MARKER = "(current user)";

/** One card type's defaults as the settings page shows them. */
export interface CardDefaultsView {
  cardTypeId: number;
  /** propertyDefinitionId → stored value (canonical, or the current-user marker). */
  values: Record<string, string>;
}

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
  aggregate: "Aggregate",
};

/**
 * Aggregate functions an aggregate property can apply over a holder
 * card's descendants (Phase 24; legacy AggregateType identifiers,
 * lower-cased). `count` needs no target property; the others take a
 * numeric one. Crosses the wire in the tree page's define-aggregate
 * form and is stored in `property_definitions.aggregate_type`.
 */
export const AGGREGATE_TYPES = ["sum", "avg", "min", "max", "count"] as const;

/** One of AGGREGATE_TYPES. */
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

/** Human labels for the aggregate function selector (legacy display names). */
export const AGGREGATE_TYPE_LABELS: Record<AggregateType, string> = {
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  count: "Count",
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

// ------------------------------------------------ dependencies (Phase 25)

/**
 * A dependency's lifecycle (legacy Dependency::NEW/ACCEPTED/RESOLVED).
 * NEW: raised, no resolving card yet. ACCEPTED: the resolving project
 * linked at least one card. RESOLVED: marked done. Stored in
 * `dependencies.status`; validity enforced in the domain layer.
 */
export const DEPENDENCY_STATUSES = ["NEW", "ACCEPTED", "RESOLVED"] as const;

/** One of DEPENDENCY_STATUSES. */
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];

/**
 * Which side of a dependency a project list shows (legacy
 * DependencyView `filter`): the ones this project raised, or the ones
 * it is asked to resolve.
 */
export const DEPENDENCY_LIST_FILTERS = ["raising", "resolving"] as const;

/** One of DEPENDENCY_LIST_FILTERS. */
export type DependencyListFilter = (typeof DEPENDENCY_LIST_FILTERS)[number];

/**
 * Program team roles (legacy MembershipRole::PROGRAM_ROLES ids, stored
 * in `program_memberships.role`; Phase 26). A program administrator
 * ranks with a project administrator and a program member with a full
 * team member on the one privilege ladder — legacy gave the two role
 * sets the same PrivilegeLevel values.
 */
export const PROGRAM_ROLES = ["program_admin", "program_member"] as const;

/** One of PROGRAM_ROLES. */
export type ProgramRole = (typeof PROGRAM_ROLES)[number];

/** Human labels for the program role selector (legacy MembershipRole names). */
export const PROGRAM_ROLE_LABELS: Record<ProgramRole, string> = {
  program_admin: "Program administrator",
  program_member: "Program member",
};

/** The role a new program member gets when none is chosen. */
export const DEFAULT_PROGRAM_ROLE: ProgramRole = "program_member";

/**
 * Objective statuses (legacy Objective::Status; Phases 26–27). PLANNED:
 * on the plan timeline with a date range. BACKLOG: proposed, awaiting
 * planning, with no dates and an explicit backlog position. Stored in
 * `objectives.status`; validity enforced in the domain layer.
 */
export const OBJECTIVE_STATUSES = ["PLANNED", "BACKLOG"] as const;

/** One of OBJECTIVE_STATUSES. */
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Public API v1 (Phase 30) — the JSON resources and request bodies served
// under /api/v1. External clients consume these shapes; the route modules
// and the api adapter (app/api/*) produce them. Dates are ISO-8601 strings.
// ---------------------------------------------------------------------------

/**
 * The ways a session can be opened (ADR-0021). Site-wide configuration
 * decides which are enabled; a project may constrain access to a
 * subset of them (`projects.permitted_strategy_kinds`, empty = none).
 */
export const STRATEGY_KINDS = ["password", "ldap", "oidc", "saml"] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];
export const STRATEGY_KIND_LABELS: Record<StrategyKind, string> = {
  password: "Mingle password",
  ldap: "LDAP",
  oidc: "single sign-on (OpenID Connect)",
  saml: "SAML",
};

/**
 * Every collection response (P-1). `items` is one page in the
 * collection's order; `nextCursor` is the opaque token to send back as
 * `?cursor=` for the next page, or null on the last page. Pages are
 * keyset-cursor based — an insert between two requests neither shifts
 * nor repeats items. `?limit=` bounds the page (default 50, max 200).
 */
export interface ApiPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every non-2xx API response body. `errors` carries command rejections. */
export interface ApiErrorBody {
  error: string;
  errors?: FieldErrors;
}

/** A project as the API presents it (`/api/v1/projects/:identifier`). */
export interface ApiProject {
  identifier: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/v1/projects. */
export interface ApiCreateProjectBody {
  name: string;
  /** Generated from the name when omitted. */
  identifier?: string | null;
  description?: string | null;
}

/** A card type as the API presents it. */
export interface ApiCardType {
  id: number;
  name: string;
  position: number;
}

/** A property definition as the API presents it. */
export interface ApiPropertyDefinition {
  id: number;
  name: string;
  kind: PropertyKind;
  /** The allowed values in order — enumerated kind only. */
  values?: string[];
  /** The expression — formula kind only. */
  formula?: string | null;
  transitionOnly: boolean;
  position: number;
}

/** POST /api/v1/projects/:identifier/property_definitions. */
export interface ApiDefinePropertyDefinitionBody {
  name: string;
  kind: string;
  values?: string[];
  formula?: string | null;
  nullIsZero?: boolean;
  transitionOnly?: boolean;
}

/**
 * A card as the API presents it. `properties` is keyed by property
 * name and lists every definition of the project — null when unset.
 * User properties carry the user's login, not the internal id.
 */
export interface ApiCard {
  number: number;
  name: string;
  description: string | null;
  type: string;
  version: number;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /api/v1/projects/:identifier/cards. `type` defaults to the
 * project's first card type; `properties` are set by name in the same
 * transaction — any invalid one and no card is created.
 */
export interface ApiCreateCardBody {
  name: string;
  description?: string | null;
  type?: string | null;
  properties?: Record<string, string | null>;
}

/**
 * PATCH /api/v1/projects/:identifier/cards/:number. Only the fields
 * present change. A transition-only property changes by executing the
 * transition that produces the value (ADR-0008), exactly as the card
 * page does; the transitions applied that way are reported back.
 */
export interface ApiUpdateCardBody {
  name?: string;
  description?: string | null;
  type?: string | null;
  properties?: Record<string, string | null>;
}

/** What a card write reports: the card, plus any transitions applied by property changes. */
export interface ApiCardWrite {
  card: ApiCard;
  appliedTransitions: string[];
}

/** A transition definition as the API presents it. */
export interface ApiTransition {
  id: number;
  name: string;
  /** The card type it is restricted to; null for any. */
  cardType: string | null;
  /** Legacy one-line descriptions ("Has value of Open for Status"). */
  prerequisites: string[];
  /** Legacy one-line descriptions ("Sets Status to Closed"). */
  actions: string[];
}

/** A transition the caller may execute on a card right now, with the inputs it needs. */
export interface ApiAvailableTransition {
  id: number;
  name: string;
  inputs: { property: string; kind: PropertyKind; required: boolean }[];
}

/**
 * POST /api/v1/projects/:identifier/cards/:number/transitions.
 * `transition` names a transition by id or (case-insensitively) by name;
 * `userInput` supplies user-entered action values keyed by property name.
 */
export interface ApiExecuteTransitionBody {
  transition: number | string;
  userInput?: Record<string, string | null>;
}

/** What executing a transition reports. */
export interface ApiTransitionExecution {
  card: ApiCard;
  transition: string;
  changedProperties: string[];
}

/** POST /api/v1/projects/:identifier/card_types. */
export interface ApiDefineCardTypeBody {
  name: string;
}

/**
 * One prerequisite of a transition being defined. `value: null` is
 * the nil-valued HasSpecificValue — the card must have the property
 * UNSET (ADR-0010: null crosses the wire as JSON null, never ""). `set:
 * true` requires any value (HasSetValue).
 */
export type ApiTransitionPrerequisiteBody =
  | { property: string; value: string | null }
  | { property: string; set: true };

/**
 * One action of a transition being defined: `value` sets the property
 * (null clears it); `input` asks the executing user for it instead.
 */
export interface ApiTransitionActionBody {
  property: string;
  value?: string | null;
  input?: "required" | "optional";
}

/**
 * POST /api/v1/projects/:identifier/transitions — the same definition
 * the transitions page posts (DefineTransition). Editing is
 * delete-and-recreate (ADR-0007). `usedBy` restricts who may execute
 * it: logins and/or group names; absent means every team member.
 */
export interface ApiDefineTransitionBody {
  name: string;
  cardType?: string | null;
  prerequisites?: ApiTransitionPrerequisiteBody[];
  actions: ApiTransitionActionBody[];
  usedBy?: { users?: string[]; groups?: string[] };
}

/** A wiki page as the API presents it. `content` is the stored, sanitized HTML (ADR-0011). */
export interface ApiWikiPage {
  identifier: string;
  name: string;
  content: string | null;
  version: number;
  createdBy: string;
  modifiedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/v1/projects/:identifier/pages. */
export interface ApiCreateWikiPageBody {
  name: string;
  content?: string | null;
}

/**
 * A murmur as the API presents it: the body as typed (plain text),
 * the author's login, and the facts resolved when it was posted
 * (ADR-0017) — the logins it mentioned and the cards it referenced.
 */
export interface ApiMurmur {
  id: number;
  body: string;
  author: string;
  authorName: string;
  /** The card this murmur comments on, when it is a card comment. */
  cardNumber: number | null;
  mentions: string[];
  cards: number[];
  createdAt: string;
}

/** POST /api/v1/projects/:identifier/murmurs. */
export interface ApiPostMurmurBody {
  body: string;
}

/** A card attachment as the API presents it; `url` serves the bytes. */
export interface ApiAttachment {
  id: number;
  fileName: string;
  contentType: string;
  size: number;
  cardVersion: number;
  uploadedBy: string;
  createdAt: string;
  url: string;
}

/** A schedule as /admin/schedules shows it (ADR-0023); instants are ISO UTC, formatted in the viewer's zone by the page. */
export interface ScheduleView {
  id: number;
  key: string;
  name: string;
  jobType: string;
  cron: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  lastFinishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Program timeline (Phase 26) — legacy Plan::Constants. Crosses the wire
// in the objective forms' row selectors, so both sides import it here.
// ---------------------------------------------------------------------------

/** Rows on the plan timeline. */
export const TIMELINE_ROWS = 14;
/** The row a new objective lands on. */
export const VERTICALLY_MIDDLE_OF_TIMELINE = 6;

// ---------------------------------------------------------------------------
// Card import column mapping (Phase 29) — the form encoding the mapping
// preview posts back. Pure string parsing; both sides import it here.
// ---------------------------------------------------------------------------

/** What an imported column maps to. */
export type ColumnTarget =
  | { kind: "number" | "name" | "description" | "type" | "ignore" }
  | { kind: "property"; propertyDefinitionId: number };

/** Parses the form encoding of a target: `number|name|description|type|ignore|property:<id>`. */
export function parseColumnTarget(text: string): ColumnTarget | null {
  const value = text.trim();
  if (value === "number" || value === "name" || value === "description" || value === "type" || value === "ignore")
    return { kind: value };
  const match = /^property:(\d+)$/.exec(value);
  return match ? { kind: "property", propertyDefinitionId: Number(match[1]) } : null;
}

/** The form encoding of a target (inverse of `parseColumnTarget`). */
export function formatColumnTarget(target: ColumnTarget): string {
  return target.kind === "property" ? `property:${target.propertyDefinitionId}` : target.kind;
}

// ---------------------------------------------------------------------------
// Authentication configuration (Phase 31) — what the site admin's
// authentication page shows and posts. Secrets never cross the wire
// outbound: the views only say whether one is set.
// ---------------------------------------------------------------------------

/** External authentication sources a site can enable. */
export const AUTH_SOURCE_KINDS = ["ldap", "oidc", "saml"] as const;

/** One of `AUTH_SOURCE_KINDS`. */
export type AuthSourceKind = (typeof AUTH_SOURCE_KINDS)[number];

/** LDAP settings as the admin page shows them (legacy ldap_settings, renamed). */
export interface LdapSettingsView {
  enabled: boolean;
  /** ldap:// or ldaps:// URL of the directory. */
  url: string;
  /** Service account for the user search; blank for anonymous search. */
  bindDn: string;
  bindPasswordSet: boolean;
  baseDn: string;
  /** Attribute holding the Mingle login (legacy ldapfilter: uid, sAMAccountName). */
  loginAttribute: string;
  /** Object class of user entries (legacy ldapobjectclass). */
  objectClass: string;
  /** Attribute mapped to the display name (legacy ldap_map_fullname). */
  nameAttribute: string;
  /** Attribute mapped to the email (legacy ldap_map_mail). */
  mailAttribute: string;
  /** Optional group the user must belong to (legacy ldapgroupdn / objectclass / attribute). */
  groupDn: string;
  groupObjectClass: string;
  groupAttribute: string;
  /** Create Mingle accounts on first successful sign-in (legacy auto_enroll). */
  autoEnroll: boolean;
  /** Upgrade an ldap:// connection with StartTLS before binding (legacy ldapusetls; P-7). */
  startTls: boolean;
  /** PEM CA certificate(s) the directory's TLS certificate must chain to; blank uses the system store. */
  tlsCaCert: string;
  /**
   * LDAP group → Mingle group mappings (P-6), one per line:
   * `<group DN> => <project identifier>/<group name>`. Reconciled on
   * every LDAP sign-in.
   */
  groupMappings: string;
}

/** OIDC settings as the admin page shows them. */
export interface OidcSettingsView {
  enabled: boolean;
  /** Button label on the sign-in page. */
  displayName: string;
  /** Issuer URL; discovery is fetched from `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  /** Space-separated scopes; must include openid. */
  scopes: string;
  autoEnroll: boolean;
}

/**
 * SAML 2.0 settings as the authentication page shows them (P-9). The
 * service provider is this site (SP-initiated, HTTP-POST binding);
 * nothing here is secret — the IdP's signing certificate is public.
 */
export interface SamlSettingsView {
  enabled: boolean;
  /** Button label on the sign-in page. */
  displayName: string;
  /** The IdP's single sign-on URL (HTTP-Redirect binding). */
  entryPoint: string;
  /** The IdP's entity id; when set, a response from another issuer is refused. */
  idpIssuer: string;
  /** The IdP's X.509 signing certificate, PEM or bare base64. */
  idpCert: string;
  /** This site's entity id (the Audience the IdP must name); defaults to the site URL. */
  spEntityId: string;
  /** Assertion attribute holding the Mingle login; blank uses the NameID. */
  loginAttribute: string;
  /** Assertion attribute holding the display name; blank uses the login. */
  nameAttribute: string;
  /** Assertion attribute holding the email; blank leaves it unset. */
  emailAttribute: string;
  autoEnroll: boolean;
}

/** The whole authentication page. */
export interface AuthenticationView {
  ldap: LdapSettingsView;
  oidc: OidcSettingsView;
  saml: SamlSettingsView;
}

// ---------------------------------------------------------------------------
// External Integrations (Phase 32) — what the project integrations page
// and the card page show. Secrets (webhook URL, GitHub secret) never
// cross the wire outbound.
// ---------------------------------------------------------------------------

/**
 * The history event types a Slack route can name (P-10): the feed's
 * kind and action, joined by a dot. Only combinations the history
 * projection produces are listed.
 */
export const SLACK_EVENT_TYPES = [
  "card.created",
  "card.changed",
  "card.commented",
  "card.deleted",
  "page.created",
  "page.changed",
  "page.deleted",
  "murmur.murmured",
  "dependency.created",
  "dependency.changed",
  "dependency.deleted",
] as const;
export type SlackEventType = (typeof SLACK_EVENT_TYPES)[number];
export const SLACK_EVENT_TYPE_LABELS: Record<SlackEventType, string> = {
  "card.created": "Card created",
  "card.changed": "Card changed",
  "card.commented": "Card commented on",
  "card.deleted": "Card deleted",
  "page.created": "Page created",
  "page.changed": "Page changed",
  "page.deleted": "Page deleted",
  "murmur.murmured": "Murmur posted",
  "dependency.created": "Dependency raised",
  "dependency.changed": "Dependency changed",
  "dependency.deleted": "Dependency deleted",
};

/** Where an event type goes: a webhook id, the project's default webhook, or nowhere. */
export type SlackRouteTarget = number | "default" | "suppressed";

/** One incoming webhook of a project as the integrations page shows it (the URL never crosses the wire). */
export interface SlackWebhookView {
  id: number;
  channelLabel: string;
  enabled: boolean;
  isDefault: boolean;
  lastDeliveredAt: string | null;
  lastError: string | null;
}

/** The project's Slack notifier as the integrations page shows it: its webhooks and its event routing. */
export interface SlackIntegrationView {
  configured: boolean;
  webhooks: SlackWebhookView[];
  routes: Record<SlackEventType, SlackRouteTarget>;
}

/** The SCM hosts whose webhooks a project can receive (P-12). */
export const SCM_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;
export type ScmProvider = (typeof SCM_PROVIDERS)[number];
export const SCM_PROVIDER_LABELS: Record<ScmProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

/** One repository registered to push to the project, on one SCM host. */
export interface GithubIntegrationView {
  id: number;
  provider: ScmProvider;
  repository: string;
  enabled: boolean;
  lastReceivedAt: string | null;
}

/** The latest commit status GitHub reported for a linked commit (P-11). */
export interface CommitStatusView {
  /** "success", "failure", "error", or "pending". */
  state: string;
  context: string;
  description: string;
  url: string | null;
  reportedAt: string;
}

/** A commit linked to a card by a `#123` reference in its message. */
export interface CommitLinkView {
  sha: string;
  shortSha: string;
  url: string;
  repository: string;
  authorName: string;
  message: string;
  committedAt: string;
  /** The card the link is on — for the project-wide recent list. */
  cardNumber: number;
  status: CommitStatusView | null;
}

/** A pull request linked to a card by a `#123` reference (P-11). */
export interface PullRequestLinkView {
  number: number;
  title: string;
  url: string;
  repository: string;
  state: string;
  authorLogin: string | null;
  updatedAt: string;
  cardNumber: number;
}

/**
 * Site chrome (P-16) — what the root loader hands the application
 * shell: the signed-in user, the selected project, its display tabs,
 * and whether the sign-in page is rendering.
 */

/** The signed-in user as the header shows them. */
export interface SiteUser {
  id: number;
  name: string;
  login: string;
  admin: boolean;
}

/** The project the current URL is inside, if any. */
export interface SiteProject {
  name: string;
  identifier: string;
}

/**
 * One project tab. `kind` reproduces the legacy tab's `image_name`
 * (the class that picks its icon) and `htmlId` its `html_id`.
 */
export interface SiteTab {
  htmlId: string;
  name: string;
  href: string;
  kind: "overview" | "list" | "grid" | "dependencies" | "all" | "history";
  current: boolean;
}

/** Everything the shell renders from. */
export interface SiteContext {
  user: SiteUser | null;
  project: SiteProject | null;
  tabs: SiteTab[];
  /** Legacy `rendering_login?` — the sign-in page has no header. */
  renderingLogin: boolean;
}
