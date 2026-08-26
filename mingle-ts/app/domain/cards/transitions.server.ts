/**
 * Card Management command handlers and read models — transitions
 * (Phase 14).
 *
 * Purpose: the only write path for transitions and the only place a
 * transition is executed against a card. A Transition (transition.rb)
 * is a named workflow step, optionally restricted to one card type, made
 * of prerequisites — property requirements that AND together, plus
 * user/group requirements that OR together and then AND with the rest
 * (legacy prerequisites_collection) — and actions that each set one
 * property to a fixed value, clear it, or take the value from the
 * executing user. Executing a transition applies every action as ONE
 * card version (legacy: one `card.save`), through the property
 * module's shared write path, and emits a past-tense event — or rejects
 * with the specific unmet requirement named (rule 10).
 *
 * Commands → events:
 *   DefineTransition  → TransitionDefined
 *   DeleteTransition  → TransitionDeleted
 *   ExecuteTransition → TransitionExecuted (+ next card version when any
 *                       property actually changed)
 *
 * Public interface: `defineTransition`, `deleteTransition`,
 * `executeTransition` (commands); `loadTransitions`,
 * `availableTransitions`, `describePrerequisite`, `describeAction`
 * (read models for the admin page and the card page).
 *
 * Owner context: Card Management (workflow). Handlers take the Drizzle
 * handle as a parameter — no module-level infrastructure imports;
 * tests supply their own real database.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardTypes, type CardRow } from "~/db/schema/cards";
import {
  cardPropertyValues,
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import { projects } from "~/db/schema/projects";
import { users } from "~/db/schema/identity";
import {
  groupMemberships,
  groups,
  teamMemberships,
} from "~/db/schema/membership";
import {
  transitionActions,
  transitionPrerequisites,
  transitions,
  type TransitionActionRow,
  type TransitionPrerequisiteRow,
  type TransitionRow,
} from "~/db/schema/transitions";
import type {
  FieldErrors,
  PropertyKind,
  TransitionActionInputMode,
  TransitionPrerequisiteKind,
} from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  appendPropertyValueChanges,
  canonicalPropertyValue,
  samePropertyValue,
  type PropertyValueChange,
} from "~/domain/cards/properties.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

const NAME_MAX_LENGTH = 255;

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** A prerequisite as posted to DefineTransition. */
export type TransitionPrerequisiteInput =
  | {
      kind: "has_specific_value";
      propertyDefinitionId: number;
      /**
       * Raw value, validated per the property's kind; null requires the
       * property to be UNSET (legacy's nil-valued HasSpecificValue, the
       * form's "(not set)"). A blank string is a rejection, not a null.
       */
      value: string | null;
    }
  | { kind: "has_set_value"; propertyDefinitionId: number }
  | { kind: "is_user"; userId: number }
  | { kind: "in_group"; groupId: number };

/** An action as posted to DefineTransition. */
export interface TransitionActionInput {
  propertyDefinitionId: number;
  inputMode: TransitionActionInputMode;
  /** fixed mode: raw value to set, or null to clear ("(not set)"). */
  value?: string | null;
}

export interface DefineTransitionInput {
  projectId: number;
  name: string;
  /** Restrict to one card type; null/undefined = any type. */
  cardTypeId?: number | null;
  prerequisites: TransitionPrerequisiteInput[];
  actions: TransitionActionInput[];
  actorUserId: number;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** True when the project id names an existing project. */
function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get(),
  );
}

/** Looks a card up by its per-project number. */
function findCard(
  db: BetterSQLite3Database,
  projectId: number,
  number: number,
): CardRow | undefined {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .get();
}

/** All property definitions of a project, keyed by id. */
function definitionsById(
  db: BetterSQLite3Database,
  projectId: number,
): Map<number, PropertyDefinitionRow> {
  return new Map(
    db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.projectId, projectId))
      .all()
      .map((row) => [row.id, row]),
  );
}

/** A transition with its prerequisite and action rows. */
export interface TransitionDetail {
  transition: TransitionRow;
  prerequisites: TransitionPrerequisiteRow[];
  actions: TransitionActionRow[];
}

/**
 * Loads every transition of a project with its prerequisites and
 * actions, ordered by name (legacy order_by_name: lower(name)).
 *
 * @param db - the Drizzle handle
 * @param projectId - the project
 */
export function loadTransitions(
  db: BetterSQLite3Database,
  projectId: number,
): TransitionDetail[] {
  const rows = db
    .select()
    .from(transitions)
    .where(eq(transitions.projectId, projectId))
    .orderBy(sql`lower(${transitions.name})`)
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const prerequisites = db
    .select()
    .from(transitionPrerequisites)
    .where(inArray(transitionPrerequisites.transitionId, ids))
    .orderBy(asc(transitionPrerequisites.id))
    .all();
  const actions = db
    .select()
    .from(transitionActions)
    .where(inArray(transitionActions.transitionId, ids))
    .orderBy(asc(transitionActions.id))
    .all();
  return rows.map((transition) => ({
    transition,
    prerequisites: prerequisites.filter((p) => p.transitionId === transition.id),
    actions: actions.filter((a) => a.transitionId === transition.id),
  }));
}

/** Loads one transition of a project with its rows, or undefined. */
function loadTransition(
  db: BetterSQLite3Database,
  projectId: number,
  transitionId: number,
): TransitionDetail | undefined {
  const transition = db
    .select()
    .from(transitions)
    .where(
      and(eq(transitions.projectId, projectId), eq(transitions.id, transitionId)),
    )
    .get();
  if (!transition) return undefined;
  return {
    transition,
    prerequisites: db
      .select()
      .from(transitionPrerequisites)
      .where(eq(transitionPrerequisites.transitionId, transition.id))
      .orderBy(asc(transitionPrerequisites.id))
      .all(),
    actions: db
      .select()
      .from(transitionActions)
      .where(eq(transitionActions.transitionId, transition.id))
      .orderBy(asc(transitionActions.id))
      .all(),
  };
}

// ---------------------------------------------------------------------------
// Display helpers (legacy to_s wording, shared by the admin and card pages)
// ---------------------------------------------------------------------------

/** Names for the ids a prerequisite/action may reference. */
export interface TransitionNames {
  properties: Map<number, { name: string; kind: string }>;
  users: Map<number, string>;
  groups: Map<number, string>;
}

/**
 * Collects the display names every transition of a project references.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project
 */
export function loadTransitionNames(
  db: BetterSQLite3Database,
  projectId: number,
): TransitionNames {
  return {
    properties: new Map(
      db
        .select({
          id: propertyDefinitions.id,
          name: propertyDefinitions.name,
          kind: propertyDefinitions.kind,
        })
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.projectId, projectId))
        .all()
        .map((row) => [row.id, { name: row.name, kind: row.kind }]),
    ),
    users: new Map(
      db
        .select({ id: users.id, name: users.name })
        .from(users)
        .all()
        .map((row) => [row.id, row.name]),
    ),
    groups: new Map(
      db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(eq(groups.projectId, projectId))
        .all()
        .map((row) => [row.id, row.name]),
    ),
  };
}

/** A stored value as the legacy UI shows it (user ids become names). */
function displayValue(
  value: string | null,
  kind: string | undefined,
  names: TransitionNames,
): string {
  if (value === null) return "(not set)";
  if (kind === "user") return names.users.get(Number(value)) ?? value;
  return value;
}

/**
 * The legacy one-line description of a prerequisite
 * (TransitionPrerequisite#to_s: "Has value of X for P", "Has value set
 * for P", "User is N", "In group G").
 */
export function describePrerequisite(
  prerequisite: TransitionPrerequisiteRow,
  names: TransitionNames,
): string {
  const property = prerequisite.propertyDefinitionId
    ? names.properties.get(prerequisite.propertyDefinitionId)
    : undefined;
  switch (prerequisite.kind as TransitionPrerequisiteKind) {
    case "has_specific_value":
      return `Has value of ${displayValue(prerequisite.value, property?.kind, names)} for ${property?.name ?? "?"}`;
    case "has_set_value":
      return `Has value set for ${property?.name ?? "?"}`;
    case "is_user":
      return `User is ${names.users.get(prerequisite.userId ?? 0) ?? "?"}`;
    case "in_group":
      return `In group ${names.groups.get(prerequisite.groupId ?? 0) ?? "?"}`;
  }
}

/**
 * The legacy one-line description of an action
 * (PropertyDefinitionTransitionAction#to_s: "Sets P to V", with the
 * user-input special values shown verbatim).
 */
export function describeAction(
  action: TransitionActionRow,
  names: TransitionNames,
): string {
  const property = names.properties.get(action.propertyDefinitionId);
  const target =
    action.inputMode === "user_input_required"
      ? "(user input - required)"
      : action.inputMode === "user_input_optional"
        ? "(user input - optional)"
        : displayValue(action.value, property?.kind, names);
  return `Sets ${property?.name ?? "?"} to ${target}`;
}

// ---------------------------------------------------------------------------
// DefineTransition
// ---------------------------------------------------------------------------

/**
 * DefineTransition — adds a transition with its prerequisites and
 * actions to a project.
 *
 * DOES: inserts one `transitions` row plus its `transition_prerequisites`
 * and `transition_actions` rows (fixed values stored canonically), and
 * appends a TransitionDefined event, all in one transaction.
 * REJECTS: unknown project; actor below project administrator (legacy
 * TransitionsController privileges); blank, over-long, or duplicate
 * (case-insensitive) name; a card type not in the project; no actions
 * ("Transition must set at least one property."); an action or
 * property prerequisite naming a property outside the project or a
 * formula property; the same property in two actions or two property
 * prerequisites; a fixed action value or specific-value requirement
 * invalid for the property's kind (never coerced); an is_user
 * prerequisite naming a non-member; an in_group prerequisite naming a
 * group outside the project; both is_user and in_group prerequisites
 * ("Transition can't have both is user and in group prerequisites").
 *
 * @returns the created transition row, or field errors
 */
export function defineTransition(
  db: BetterSQLite3Database,
  input: DefineTransitionInput,
): CommandResult<TransitionRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const name = input.name.trim();
  if (!name) return reject("name", "can't be blank");
  if (name.length > NAME_MAX_LENGTH)
    return reject(
      "name",
      `is too long (maximum is ${NAME_MAX_LENGTH} characters)`,
    );
  const duplicate = db
    .select({ id: transitions.id })
    .from(transitions)
    .where(
      and(
        eq(transitions.projectId, input.projectId),
        sql`lower(${transitions.name}) = lower(${name})`,
      ),
    )
    .get();
  if (duplicate) return reject("name", "has already been taken");

  const cardTypeId = input.cardTypeId ?? null;
  if (cardTypeId !== null) {
    const cardType = db
      .select({ id: cardTypes.id })
      .from(cardTypes)
      .where(
        and(eq(cardTypes.projectId, input.projectId), eq(cardTypes.id, cardTypeId)),
      )
      .get();
    if (!cardType) return reject("cardType", "does not exist");
  }

  if (input.actions.length === 0)
    return reject("actions", "Transition must set at least one property.");

  const definitions = definitionsById(db, input.projectId);

  // Actions: one per property, fixed values canonical.
  const actionRows: {
    propertyDefinitionId: number;
    inputMode: TransitionActionInputMode;
    value: string | null;
  }[] = [];
  const actionProperties = new Set<number>();
  for (const action of input.actions) {
    const definition = definitions.get(action.propertyDefinitionId);
    if (!definition) return reject("actions", "property does not exist");
    if (definition.kind === "formula")
      return reject(
        "actions",
        `${definition.name} is a formula property and cannot be set by a transition`,
      );
    if (actionProperties.has(definition.id))
      return reject(
        "actions",
        `${definition.name} is set more than once by this transition`,
      );
    actionProperties.add(definition.id);
    let value: string | null = null;
    if (action.inputMode === "fixed") {
      const raw = action.value?.trim() || null;
      if (raw !== null) {
        const canonical = canonicalPropertyValue(
          db,
          input.projectId,
          definition,
          raw,
        );
        if (!canonical.ok) return canonical;
        value = canonical.value;
      }
    }
    actionRows.push({
      propertyDefinitionId: definition.id,
      inputMode: action.inputMode,
      value,
    });
  }

  // Prerequisites.
  const prerequisiteRows: {
    kind: TransitionPrerequisiteKind;
    propertyDefinitionId: number | null;
    value: string | null;
    userId: number | null;
    groupId: number | null;
  }[] = [];
  const requiredProperties = new Set<number>();
  let hasUser = false;
  let hasGroup = false;
  for (const prerequisite of input.prerequisites) {
    switch (prerequisite.kind) {
      case "has_specific_value":
      case "has_set_value": {
        const definition = definitions.get(prerequisite.propertyDefinitionId);
        if (!definition)
          return reject("prerequisites", "property does not exist");
        if (definition.kind === "formula")
          return reject(
            "prerequisites",
            `${definition.name} is a formula property and cannot be required by a transition`,
          );
        if (requiredProperties.has(definition.id))
          return reject(
            "prerequisites",
            `${definition.name} is required more than once by this transition`,
          );
        requiredProperties.add(definition.id);
        let value: string | null = null;
        // A null value is the deliberate "(not set)" requirement; a
        // blank string is a form that posted nothing and is rejected.
        if (
          prerequisite.kind === "has_specific_value" &&
          prerequisite.value !== null
        ) {
          const raw = prerequisite.value.trim();
          if (!raw)
            return reject(
              "prerequisites",
              `${definition.name}: required value can't be blank`,
            );
          const canonical = canonicalPropertyValue(
            db,
            input.projectId,
            definition,
            raw,
          );
          if (!canonical.ok) return canonical;
          value = canonical.value;
        }
        prerequisiteRows.push({
          kind: prerequisite.kind,
          propertyDefinitionId: definition.id,
          value,
          userId: null,
          groupId: null,
        });
        break;
      }
      case "is_user": {
        const membership = db
          .select({ id: teamMemberships.id })
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.projectId, input.projectId),
              eq(teamMemberships.userId, prerequisite.userId),
            ),
          )
          .get();
        if (!membership)
          return reject("prerequisites", "user is not a project member");
        hasUser = true;
        prerequisiteRows.push({
          kind: "is_user",
          propertyDefinitionId: null,
          value: null,
          userId: prerequisite.userId,
          groupId: null,
        });
        break;
      }
      case "in_group": {
        const group = db
          .select({ id: groups.id })
          .from(groups)
          .where(
            and(eq(groups.projectId, input.projectId), eq(groups.id, prerequisite.groupId)),
          )
          .get();
        if (!group) return reject("prerequisites", "group does not exist");
        hasGroup = true;
        prerequisiteRows.push({
          kind: "in_group",
          propertyDefinitionId: null,
          value: null,
          userId: null,
          groupId: prerequisite.groupId,
        });
        break;
      }
    }
  }
  if (hasUser && hasGroup)
    return reject(
      "prerequisites",
      "Transition can't have both is user and in group prerequisites",
    );

  return db.transaction((tx) => {
    const row = tx
      .insert(transitions)
      .values({ projectId: input.projectId, name, cardTypeId })
      .returning()
      .get();
    if (prerequisiteRows.length > 0)
      tx.insert(transitionPrerequisites)
        .values(prerequisiteRows.map((p) => ({ ...p, transitionId: row.id })))
        .run();
    tx.insert(transitionActions)
      .values(actionRows.map((a) => ({ ...a, transitionId: row.id })))
      .run();
    emitEvent(tx, {
      type: "TransitionDefined",
      aggregateType: "Transition",
      aggregateId: row.id,
      payload: {
        projectId: input.projectId,
        name,
        cardTypeId,
        prerequisites: prerequisiteRows.length,
        actions: actionRows.length,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<TransitionRow>;
  });
}

// ---------------------------------------------------------------------------
// DeleteTransition
// ---------------------------------------------------------------------------

export interface DeleteTransitionInput {
  projectId: number;
  transitionId: number;
  actorUserId: number;
}

/**
 * DeleteTransition — removes a transition and its rows.
 *
 * DOES: deletes the `transitions` row and its `transition_prerequisites`
 * and `transition_actions` rows, and appends a TransitionDeleted event,
 * all in one transaction. Card history produced by past executions is
 * untouched.
 * REJECTS: unknown project or transition; actor below project
 * administrator.
 *
 * @returns the deleted transition row, or field errors
 */
export function deleteTransition(
  db: BetterSQLite3Database,
  input: DeleteTransitionInput,
): CommandResult<TransitionRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;
  const detail = loadTransition(db, input.projectId, input.transitionId);
  if (!detail) return reject("transition", "does not exist");
  return db.transaction((tx) => {
    tx.delete(transitionActions)
      .where(eq(transitionActions.transitionId, detail.transition.id))
      .run();
    tx.delete(transitionPrerequisites)
      .where(eq(transitionPrerequisites.transitionId, detail.transition.id))
      .run();
    tx.delete(transitions).where(eq(transitions.id, detail.transition.id)).run();
    emitEvent(tx, {
      type: "TransitionDeleted",
      aggregateType: "Transition",
      aggregateId: detail.transition.id,
      payload: { projectId: input.projectId, name: detail.transition.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: detail.transition } as CommandResult<TransitionRow>;
  });
}

// ---------------------------------------------------------------------------
// Availability (legacy Transition#available_to?)
// ---------------------------------------------------------------------------

/** The facts about a card that prerequisites are evaluated against. */
interface CardFacts {
  cardTypeId: number;
  /** Current canonical values keyed by property definition id. */
  values: Map<number, string>;
}

/** Loads a card's current property values keyed by definition id. */
function cardValues(db: BetterSQLite3Database, cardId: number): Map<number, string> {
  return new Map(
    db
      .select({
        propertyDefinitionId: cardPropertyValues.propertyDefinitionId,
        value: cardPropertyValues.value,
      })
      .from(cardPropertyValues)
      .where(eq(cardPropertyValues.cardId, cardId))
      .all()
      .map((row) => [row.propertyDefinitionId, row.value]),
  );
}

/**
 * Evaluates a transition's prerequisites against a card for a user and
 * returns the unmet ones as legacy-worded requirement descriptions —
 * empty when the transition is available. Property prerequisites AND;
 * user/group prerequisites OR together into one requirement
 * (legacy prerequisites_collection).
 */
function unmetRequirements(
  db: BetterSQLite3Database,
  detail: TransitionDetail,
  card: CardFacts,
  userId: number,
  names: TransitionNames,
): string[] {
  const unmet: string[] = [];
  const { transition, prerequisites } = detail;
  if (transition.cardTypeId !== null && transition.cardTypeId !== card.cardTypeId) {
    const typeName = db
      .select({ name: cardTypes.name })
      .from(cardTypes)
      .where(eq(cardTypes.id, transition.cardTypeId))
      .get()?.name;
    unmet.push(`applies only to cards of type ${typeName ?? "?"}`);
  }
  const userBased: TransitionPrerequisiteRow[] = [];
  for (const prerequisite of prerequisites) {
    const property = prerequisite.propertyDefinitionId
      ? names.properties.get(prerequisite.propertyDefinitionId)
      : undefined;
    const current = prerequisite.propertyDefinitionId
      ? (card.values.get(prerequisite.propertyDefinitionId) ?? null)
      : null;
    switch (prerequisite.kind as TransitionPrerequisiteKind) {
      case "has_specific_value":
        if (
          !samePropertyValue(
            (property?.kind ?? "text") as PropertyKind,
            prerequisite.value,
            current,
          )
        )
          unmet.push(
            `requires ${property?.name ?? "?"} to be ${displayValue(prerequisite.value, property?.kind, names)}`,
          );
        break;
      case "has_set_value":
        if (current === null)
          unmet.push(`requires ${property?.name ?? "?"} to be set`);
        break;
      case "is_user":
      case "in_group":
        userBased.push(prerequisite);
        break;
    }
  }
  if (userBased.length > 0) {
    const allowed = userBased.some((prerequisite) =>
      prerequisite.kind === "is_user"
        ? prerequisite.userId === userId
        : Boolean(
            db
              .select({ id: groupMemberships.id })
              .from(groupMemberships)
              .where(
                and(
                  eq(groupMemberships.groupId, prerequisite.groupId ?? 0),
                  eq(groupMemberships.userId, userId),
                ),
              )
              .get(),
          ),
    );
    if (!allowed) {
      const who = userBased
        .map((prerequisite) =>
          prerequisite.kind === "is_user"
            ? (names.users.get(prerequisite.userId ?? 0) ?? "?")
            : `members of ${names.groups.get(prerequisite.groupId ?? 0) ?? "?"}`,
        )
        .join(", ");
      unmet.push(`may only be used by ${who}`);
    }
  }
  return unmet;
}

/** A transition the card page can offer, with the inputs it needs. */
export interface AvailableTransition {
  id: number;
  name: string;
  /** Actions whose value the user supplies, in definition order. */
  inputs: {
    propertyDefinitionId: number;
    propertyName: string;
    kind: string;
    required: boolean;
  }[];
}

/**
 * The transitions a user may execute on a card right now (legacy
 * Card#transitions): those whose card type matches and whose
 * prerequisites all hold for this card and user.
 *
 * @param db - the Drizzle handle
 * @param projectId - the card's project
 * @param cardNumber - the card
 * @param userId - the user who would execute
 * @returns available transitions ordered by name; [] for an unknown card
 */
export function availableTransitions(
  db: BetterSQLite3Database,
  projectId: number,
  cardNumber: number,
  userId: number,
): AvailableTransition[] {
  const names = loadTransitionNames(db, projectId);
  return availableTransitionDetails(db, projectId, cardNumber, userId).map(
    (detail) => ({
      id: detail.transition.id,
      name: detail.transition.name,
      inputs: detail.actions
        .filter((action) => action.inputMode !== "fixed")
        .map((action) => ({
          propertyDefinitionId: action.propertyDefinitionId,
          propertyName: names.properties.get(action.propertyDefinitionId)?.name ?? "?",
          kind: names.properties.get(action.propertyDefinitionId)?.kind ?? "text",
          required: action.inputMode === "user_input_required",
        })),
    }),
  );
}

/**
 * The same selection as `availableTransitions`, but with each
 * transition's prerequisite and action rows — for callers that must
 * inspect what a transition would do, not merely offer it by name
 * (Phase 15 auto-transition matching). Keeping the availability rule
 * in one place is why `unmetRequirements` stays private.
 *
 * @param db - the Drizzle handle
 * @param projectId - the card's project
 * @param cardNumber - the card
 * @param userId - the user who would execute
 * @returns available transitions with their rows, ordered by name; []
 *   for an unknown card
 */
export function availableTransitionDetails(
  db: BetterSQLite3Database,
  projectId: number,
  cardNumber: number,
  userId: number,
): TransitionDetail[] {
  const card = findCard(db, projectId, cardNumber);
  if (!card) return [];
  const facts: CardFacts = {
    cardTypeId: card.cardTypeId,
    values: cardValues(db, card.id),
  };
  const names = loadTransitionNames(db, projectId);
  return loadTransitions(db, projectId).filter(
    (detail) => unmetRequirements(db, detail, facts, userId, names).length === 0,
  );
}

// ---------------------------------------------------------------------------
// ExecuteTransition
// ---------------------------------------------------------------------------

export interface ExecuteTransitionInput {
  projectId: number;
  cardNumber: number;
  transitionId: number;
  /**
   * Values for the transition's user-input actions, keyed by property
   * definition id. A required input must be present and non-blank; an
   * optional input that is absent or blank leaves the property unchanged.
   */
  userInput?: Record<string, string | null | undefined>;
  actorUserId: number;
}

/** What ExecuteTransition reports back. */
export interface TransitionExecution {
  card: CardRow;
  transitionName: string;
  /** Names of the properties whose values actually changed. */
  changedProperties: string[];
}

/**
 * ExecuteTransition — applies a transition to one card.
 *
 * DOES: when every prerequisite holds for the card and actor, writes the
 * value of each action (fixed, cleared, or user-entered) into
 * `card_property_values`, recomputes formulas, bumps the card's version
 * and inserts exactly ONE `card_versions` row snapshotting all of them
 * (legacy: one card.save per transition) — skipped entirely when no
 * action changes a value (legacy `card.save if card.altered?`) — and
 * appends a TransitionExecuted event naming the changed properties,
 * all in one transaction.
 * REJECTS: unknown project or card; actor below full team member;
 * unknown transition ("Couldn't find transition with id N."); a
 * transition not applicable to the card — with each unmet requirement
 * named ("<name> is not applicable to Card #n: requires Status to be
 * Open; may only be used by …") and no state changed; a missing or
 * blank value for a required user input ("Value of <property> property
 * for this transition must not be empty."); a user-entered value
 * invalid for its property's kind (never coerced).
 *
 * @returns the execution facts, or field errors
 */
export function executeTransition(
  db: BetterSQLite3Database,
  input: ExecuteTransitionInput,
): CommandResult<TransitionExecution> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;
  const card = findCard(db, input.projectId, input.cardNumber);
  if (!card) return reject("card", "does not exist");
  const detail = loadTransition(db, input.projectId, input.transitionId);
  if (!detail)
    return reject(
      "transition",
      `Couldn't find transition with id ${input.transitionId}.`,
    );
  const names = loadTransitionNames(db, input.projectId);
  const values = cardValues(db, card.id);
  const unmet = unmetRequirements(
    db,
    detail,
    { cardTypeId: card.cardTypeId, values },
    input.actorUserId,
    names,
  );
  if (unmet.length > 0)
    return reject(
      "transition",
      `${detail.transition.name} is not applicable to Card #${card.number}: ${unmet.join("; ")}`,
    );

  const definitions = definitionsById(db, input.projectId);
  const userInput = input.userInput ?? {};
  const changes: PropertyValueChange[] = [];
  for (const action of detail.actions) {
    const definition = definitions.get(action.propertyDefinitionId);
    if (!definition) continue; // definition deleted since; nothing to set
    let canonical: string | null;
    if (action.inputMode === "fixed") {
      canonical = action.value;
    } else {
      const raw = userInput[String(definition.id)]?.trim() || null;
      if (raw === null) {
        if (action.inputMode === "user_input_required")
          return reject(
            "transition",
            `Value of ${definition.name} property for this transition must not be empty.`,
          );
        continue; // optional and not supplied: leave unchanged
      }
      const result = canonicalPropertyValue(db, input.projectId, definition, raw);
      if (!result.ok) return result;
      canonical = result.value;
    }
    const current = values.get(definition.id) ?? null;
    if (samePropertyValue(definition.kind as PropertyKind, canonical, current))
      continue;
    changes.push({ definition, value: canonical });
  }

  return db.transaction((tx) => {
    const row =
      changes.length > 0
        ? appendPropertyValueChanges(
            tx,
            input.projectId,
            card,
            changes,
            input.actorUserId,
          )
        : card;
    const changedProperties = changes.map((change) => change.definition.name);
    emitEvent(tx, {
      type: "TransitionExecuted",
      aggregateType: "Card",
      aggregateId: card.id,
      payload: {
        projectId: input.projectId,
        number: card.number,
        transitionId: detail.transition.id,
        transition: detail.transition.name,
        changedProperties,
        version: row.version,
      },
      actorUserId: input.actorUserId,
    });
    return {
      ok: true,
      value: { card: row, transitionName: detail.transition.name, changedProperties },
    } as CommandResult<TransitionExecution>;
  });
}

// ---------------------------------------------------------------------------
// Bulk execution (legacy CardsController#bulk_transition)
// ---------------------------------------------------------------------------

/**
 * The transitions every card in a selection can execute right now —
 * the intersection of each card's `availableTransitions` (legacy
 * bulk_transitions.js `Array.findIntersection` over the per-card
 * lists). Only these may be offered for a bulk apply, because bulk
 * execution is all-or-none: offering a transition that is unavailable
 * on one selected card guarantees the whole apply is cancelled.
 *
 * @param db - the Drizzle handle
 * @param projectId - the cards' project
 * @param cardNumbers - the selected card numbers
 * @param userId - the user who would execute
 * @returns transitions available on every selected card, ordered by
 *   name; [] for an empty selection or when any selected card is
 *   unknown (an unknown card has no available transitions, so the
 *   intersection is empty)
 */
export function commonTransitions(
  db: BetterSQLite3Database,
  projectId: number,
  cardNumbers: number[],
  userId: number,
): AvailableTransition[] {
  const numbers = [...new Set(cardNumbers)];
  if (numbers.length === 0) return [];
  const [first, ...rest] = numbers.map((number) =>
    availableTransitions(db, projectId, number, userId),
  );
  return first.filter((transition) =>
    rest.every((list) => list.some((other) => other.id === transition.id)),
  );
}

export interface ExecuteBulkTransitionInput {
  projectId: number;
  /** The selected card numbers; duplicates are collapsed. */
  cardNumbers: number[];
  transitionId: number;
  /** User-input action values, applied identically to every card. */
  userInput?: Record<string, string | null | undefined>;
  actorUserId: number;
}

/** What ExecuteBulkTransition reports back. */
export interface BulkTransitionExecution {
  transitionName: string;
  /** The cards the transition was applied to, in selection order. */
  cardNumbers: number[];
  /** The subset whose property values actually changed (a version each). */
  changedCardNumbers: number[];
}

/** Thrown to unwind the bulk transaction when one card rejects. */
class BulkTransitionAbort extends Error {
  constructor(readonly errors: FieldErrors) {
    super("bulk transition aborted");
    this.name = "BulkTransitionAbort";
  }
}

/**
 * Appends legacy's cancellation sentence to every message of a
 * per-card rejection, so the caller reports both which card refused
 * and that nothing was written.
 */
function withCancellation(errors: FieldErrors): FieldErrors {
  const cancelled: FieldErrors = {};
  for (const [field, messages] of Object.entries(errors))
    cancelled[field] = messages.map(
      (message) =>
        `${message.endsWith(".") ? message : `${message}.`} All work was cancelled.`,
    );
  return cancelled;
}

/**
 * ExecuteBulkTransition — applies one transition to a selection of cards.
 *
 * DOES: executes the transition against each selected card in one
 * transaction, so each card that changes gets exactly ONE new
 * `card_versions` row and its updated `card_property_values` (via
 * `executeTransition`, which is the only execution path — ADR-0007
 * Decision 4), emits the per-card TransitionExecuted events that
 * execution already emits, and appends one BulkTransitionExecuted
 * event naming the transition and every card applied.
 * WHEN: the actor is a full team member of an existing project, the
 * transition exists in it, every selected card exists, and the
 * transition is applicable to every one of them for this actor.
 * BECAUSE: legacy bulk_transition is all-or-none — a selection is a
 * single user gesture, so a transition that is not applicable to one
 * card must leave the other cards untouched rather than half-applying
 * the gesture ("All work was cancelled.").
 * REJECTS: unknown project; actor below full team member; an empty
 * selection ("Please select at least one card."); an unknown
 * transition; a selected card that does not exist; and any per-card
 * rejection `executeTransition` would give (not applicable, with the
 * card number and unmet requirements named; a missing required user
 * input; an invalid user-entered value) — with the whole transaction
 * rolled back and " All work was cancelled." appended, so NO card is
 * left changed.
 *
 * @param db - the Drizzle handle
 * @param input - the selection, transition, user input, and actor
 * @returns the applied card numbers, or field errors
 */
export function executeBulkTransition(
  db: BetterSQLite3Database,
  input: ExecuteBulkTransitionInput,
): CommandResult<BulkTransitionExecution> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;
  const numbers = [...new Set(input.cardNumbers)];
  if (numbers.length === 0)
    return reject("cards", "Please select at least one card.");
  const detail = loadTransition(db, input.projectId, input.transitionId);
  if (!detail)
    return reject(
      "transition",
      `Couldn't find transition with id ${input.transitionId}.`,
    );
  for (const number of numbers)
    if (!findCard(db, input.projectId, number))
      return reject("cards", `Couldn't find card with number ${number}.`);

  try {
    return db.transaction((tx) => {
      const changed: number[] = [];
      for (const number of numbers) {
        const result = executeTransition(tx, {
          projectId: input.projectId,
          cardNumber: number,
          transitionId: input.transitionId,
          userInput: input.userInput,
          actorUserId: input.actorUserId,
        });
        // Unwinds the whole selection: legacy raises
        // TransitionNotAvailableException out of the same loop.
        if (!result.ok) throw new BulkTransitionAbort(result.errors);
        if (result.value.changedProperties.length > 0) changed.push(number);
      }
      emitEvent(tx, {
        type: "BulkTransitionExecuted",
        aggregateType: "Project",
        aggregateId: input.projectId,
        payload: {
          projectId: input.projectId,
          transitionId: detail.transition.id,
          transition: detail.transition.name,
          cardNumbers: numbers,
          changedCardNumbers: changed,
        },
        actorUserId: input.actorUserId,
      });
      return {
        ok: true,
        value: {
          transitionName: detail.transition.name,
          cardNumbers: numbers,
          changedCardNumbers: changed,
        },
      } as CommandResult<BulkTransitionExecution>;
    });
  } catch (error) {
    if (error instanceof BulkTransitionAbort)
      return { ok: false, errors: withCancellation(error.errors) };
    throw error;
  }
}
