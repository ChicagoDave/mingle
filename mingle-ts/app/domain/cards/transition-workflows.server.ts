/**
 * Card Management command handlers and read models — transition
 * workflows and auto-transitions (Phase 15).
 *
 * Purpose: the two things legacy Mingle builds *on top of* a plain
 * transition. A **workflow** (transition_workflow.rb) generates a whole
 * chain of transitions in one gesture: given a card type and a managed
 * list property, it creates one "Move <Type> to <Value>" transition per
 * step of that property's value list, each requiring the previous value
 * (the first requires the property to be unset) and setting the next.
 * An **auto-transition** (app/controllers/auto_transition) is what
 * happens when someone tries to change a property that is marked
 * transition-only: instead of writing the value, Mingle looks for the
 * transition that would produce it and fires that transition — so the
 * value change happens through the workflow, with its prerequisites
 * enforced, without the user picking a transition by name.
 *
 * Commands → events:
 *   GenerateTransitionWorkflow → TransitionWorkflowGenerated (+ one
 *                                TransitionDefined per generated step)
 *   ApplyCardPropertyValue     → whatever the branch it takes emits:
 *                                CardPropertyValueSet for an ordinary
 *                                property, TransitionExecuted for a
 *                                transition-only one, and nothing at all
 *                                when it reports back that the caller
 *                                must choose or supply more (rule 10:
 *                                those outcomes change no state).
 *
 * Public interface: `previewTransitionWorkflow` (read model),
 * `generateTransitionWorkflow`, `applyCardPropertyValue` (commands).
 *
 * Owner context: Card Management (workflow). This module composes its
 * two siblings — it generates transitions through `defineTransition`
 * and fires them through `executeTransition`, and writes property
 * values only through `setCardPropertyValue`. It owns no tables of its
 * own and never writes `card_property_values` or `card_versions`
 * directly (ADR-0007 Decision 4). Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardTypes, type CardRow } from "~/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import { projects } from "~/db/schema/projects";
import { transitions } from "~/db/schema/transitions";
import type { PropertyKind } from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  canonicalPropertyValue,
  samePropertyValue,
  setCardPropertyValue,
} from "~/domain/cards/properties.server";
import {
  availableTransitionDetails,
  defineTransition,
  executeTransition,
} from "~/domain/cards/transitions.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

/** Legacy Transition name column limit, mirrored by transitions.server.ts. */
const TRANSITION_NAME_MAX_LENGTH = 255;

// ---------------------------------------------------------------------------
// Shared lookups
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

/** Looks a project's property definition up by id. */
function findDefinition(
  db: BetterSQLite3Database,
  projectId: number,
  definitionId: number,
): PropertyDefinitionRow | undefined {
  return db
    .select()
    .from(propertyDefinitions)
    .where(
      and(
        eq(propertyDefinitions.projectId, projectId),
        eq(propertyDefinitions.id, definitionId),
      ),
    )
    .get();
}

/** The ordered value list of an enumerated definition. */
function definitionValues(
  db: BetterSQLite3Database,
  definitionId: number,
): string[] {
  return db
    .select({ value: enumerationValues.value })
    .from(enumerationValues)
    .where(eq(enumerationValues.propertyDefinitionId, definitionId))
    .orderBy(asc(enumerationValues.position))
    .all()
    .map((row) => row.value);
}

// ---------------------------------------------------------------------------
// Workflow generation (legacy TransitionWorkflow)
// ---------------------------------------------------------------------------

/** One step of a workflow: the value moved from, and the value moved to. */
export interface WorkflowStep {
  /** The value the card must currently hold; null means "not set". */
  from: string | null;
  to: string;
  /** The transition name this step will be (or was) given. */
  name: string;
}

/** What a workflow would generate, before anything is written. */
export interface TransitionWorkflowPreview {
  cardTypeName: string;
  propertyName: string;
  steps: WorkflowStep[];
  /**
   * How many transitions already exist for this card type that touch
   * this property (legacy `existing_transitions_count`) — the admin
   * page warns with it, because generating adds to them rather than
   * replacing them.
   */
  existingTransitionsCount: number;
}

/**
 * Builds the workflow step names, made unique the way legacy's
 * `TransitionWorkflow::Names` does: "Move <Type> to <Value>", with the
 * value truncated to fit the 255-char name column, and " 1", " 2", …
 * appended until the name collides with neither an existing transition
 * nor an earlier name in this same batch.
 */
function buildSteps(
  db: BetterSQLite3Database,
  projectId: number,
  cardTypeName: string,
  values: string[],
): WorkflowStep[] {
  const taken = new Set(
    db
      .select({ name: transitions.name })
      .from(transitions)
      .where(eq(transitions.projectId, projectId))
      .all()
      .map((row) => row.name.toLowerCase()),
  );
  const compose = (to: string, appendage: string): string => {
    const room =
      TRANSITION_NAME_MAX_LENGTH - `Move ${cardTypeName} to ${appendage}`.length;
    const fitted =
      to.length > room ? `${to.slice(0, Math.max(0, room - 3))}...` : to;
    return `Move ${cardTypeName} to ${fitted}${appendage}`;
  };
  return values.map((to, index) => {
    let suffix = 0;
    let name = compose(to, "");
    while (taken.has(name.toLowerCase())) {
      suffix += 1;
      name = compose(to, ` ${suffix}`);
    }
    taken.add(name.toLowerCase());
    return { from: index === 0 ? null : values[index - 1], to, name };
  });
}

/**
 * The transitions a workflow would generate for a card type and a
 * managed list property, without writing anything — the admin page's
 * preview (legacy TransitionWorkflow#build).
 *
 * @param db - the Drizzle handle
 * @param projectId - the project
 * @param cardTypeId - the card type the generated transitions restrict to
 * @param propertyDefinitionId - the enumerated property driving the chain
 * @returns the preview, or field errors for an input that cannot generate
 */
export function previewTransitionWorkflow(
  db: BetterSQLite3Database,
  projectId: number,
  cardTypeId: number,
  propertyDefinitionId: number,
): CommandResult<TransitionWorkflowPreview> {
  const cardType = db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.id, cardTypeId)))
    .get();
  if (!cardType) return reject("cardType", "does not exist");
  const definition = findDefinition(db, projectId, propertyDefinitionId);
  if (!definition) return reject("property", "does not exist");
  if (definition.kind !== "enumerated")
    return reject(
      "property",
      `${definition.name} is not a managed list property, so it has no value order to generate a workflow from`,
    );
  const values = definitionValues(db, definition.id);
  if (values.length === 0)
    return reject(
      "property",
      `${definition.name} has no values, so there is nothing to generate`,
    );
  const existing = db.get<{ total: number }>(
    sql`SELECT COUNT(DISTINCT t.id) AS total
        FROM ${transitions} t
        WHERE t.project_id = ${projectId}
          AND t.card_type_id = ${cardTypeId}
          AND (
            EXISTS (SELECT 1 FROM transition_actions a
                     WHERE a.transition_id = t.id
                       AND a.property_definition_id = ${definition.id})
            OR EXISTS (SELECT 1 FROM transition_prerequisites p
                        WHERE p.transition_id = t.id
                          AND p.property_definition_id = ${definition.id})
          )`,
  );
  return {
    ok: true,
    value: {
      cardTypeName: cardType.name,
      propertyName: definition.name,
      steps: buildSteps(db, projectId, cardType.name, values),
      existingTransitionsCount: existing?.total ?? 0,
    },
  };
}

export interface GenerateTransitionWorkflowInput {
  projectId: number;
  cardTypeId: number;
  propertyDefinitionId: number;
  actorUserId: number;
}

/** What GenerateTransitionWorkflow reports back. */
export interface TransitionWorkflowGeneration {
  cardTypeName: string;
  propertyName: string;
  /** The generated transitions, in value order. */
  transitions: { id: number; name: string; from: string | null; to: string }[];
}

/**
 * GenerateTransitionWorkflow — creates a card type's whole transition
 * chain for one managed list property in a single gesture.
 *
 * DOES: inserts one `transitions` row per value of the property (named
 * "Move <Type> to <Value>", restricted to the card type), each with one
 * `transition_prerequisites` row requiring the property to hold the
 * PREVIOUS value — or to be unset, for the first value — and one
 * `transition_actions` row setting it to that value, by calling
 * `defineTransition` per step so every generated transition passes the
 * same validation a hand-written one does; appends the
 * TransitionDefined event each of those emits plus one
 * TransitionWorkflowGenerated event naming the whole chain — all in one
 * transaction, so a chain is never half-created.
 * WHEN: an existing project's admin names one of its card types and one
 * of its managed list properties that has at least one value.
 * BECAUSE: a status property's transitions are the same shape every
 * time — from each value to the next — and hand-creating N of them is
 * where legacy users made mistakes that silently broke a workflow.
 * REJECTS: unknown project; actor below project administrator; unknown
 * card type; unknown property; a property that is not a managed list
 * (nothing defines the value order); a managed list with no values; and
 * any rejection `defineTransition` gives for a generated step — which
 * rolls the whole chain back.
 *
 * @param db - the Drizzle handle
 * @param input - the card type, property, and actor
 * @returns the generated transitions, or field errors
 */
export function generateTransitionWorkflow(
  db: BetterSQLite3Database,
  input: GenerateTransitionWorkflowInput,
): CommandResult<TransitionWorkflowGeneration> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;
  const preview = previewTransitionWorkflow(
    db,
    input.projectId,
    input.cardTypeId,
    input.propertyDefinitionId,
  );
  if (!preview.ok) return preview;
  const { cardTypeName, propertyName, steps } = preview.value;

  try {
    return db.transaction((tx) => {
      const generated: TransitionWorkflowGeneration["transitions"] = [];
      for (const step of steps) {
        const result = defineTransition(tx, {
          projectId: input.projectId,
          name: step.name,
          cardTypeId: input.cardTypeId,
          prerequisites: [
            {
              kind: "has_specific_value",
              propertyDefinitionId: input.propertyDefinitionId,
              value: step.from,
            },
          ],
          actions: [
            {
              propertyDefinitionId: input.propertyDefinitionId,
              inputMode: "fixed",
              value: step.to,
            },
          ],
          actorUserId: input.actorUserId,
        });
        if (!result.ok) throw new WorkflowAbort(result.errors);
        generated.push({
          id: result.value.id,
          name: result.value.name,
          from: step.from,
          to: step.to,
        });
      }
      emitEvent(tx, {
        type: "TransitionWorkflowGenerated",
        aggregateType: "Project",
        aggregateId: input.projectId,
        payload: {
          projectId: input.projectId,
          cardTypeId: input.cardTypeId,
          cardType: cardTypeName,
          propertyDefinitionId: input.propertyDefinitionId,
          property: propertyName,
          transitions: generated.map((entry) => entry.name),
        },
        actorUserId: input.actorUserId,
      });
      return {
        ok: true,
        value: { cardTypeName, propertyName, transitions: generated },
      } as CommandResult<TransitionWorkflowGeneration>;
    });
  } catch (error) {
    if (error instanceof WorkflowAbort)
      return { ok: false, errors: error.errors };
    throw error;
  }
}

/** Thrown to unwind generation when one step fails to define. */
class WorkflowAbort extends Error {
  constructor(readonly errors: Record<string, string[]>) {
    super("transition workflow generation aborted");
    this.name = "WorkflowAbort";
  }
}

// ---------------------------------------------------------------------------
// Auto-transitions (legacy AutoTransition::Model / ::Transitions)
// ---------------------------------------------------------------------------

/** A transition the dispatcher matched, as the caller needs to name it. */
export interface MatchedTransition {
  id: number;
  name: string;
}

/**
 * What happened when a property change was applied. The last three are
 * questions back to the caller, not failures: nothing was written and
 * the UI decides what to show (legacy's :require_user_input,
 * :multi_transitions_matched, :no_transition_matched).
 */
export type AutoTransitionOutcome =
  /** The card already held that value; nothing to do. */
  | { kind: "unchanged" }
  /** An ordinary property: the value was written directly. */
  | { kind: "value_set"; card: CardRow }
  /** A transition-only property: the matching transition was executed. */
  | { kind: "transition_applied"; card: CardRow; transition: MatchedTransition }
  /** Exactly one transition matched, but it needs values from the user. */
  | { kind: "require_user_input"; transition: MatchedTransition }
  /** Several transitions produce that value; the user must pick one. */
  | { kind: "multi_transitions_matched"; transitions: MatchedTransition[] }
  /** No available transition produces that value for this card and user. */
  | { kind: "no_transition_matched" };

export interface ApplyCardPropertyValueInput {
  projectId: number;
  cardNumber: number;
  propertyDefinitionId: number;
  /** The requested raw value; null or blank clears the property. */
  value?: string | null;
  actorUserId: number;
}

/**
 * ApplyCardPropertyValue — the property-change entry point for the card
 * page and the card wall, which routes a transition-only property's
 * change through the transition that produces it.
 *
 * DOES: for an ordinary property, writes the value exactly as
 * `setCardPropertyValue` does (one `card_property_values` row, one new
 * `card_versions` row, a CardPropertyValueSet event). For a
 * transition-only property, writes nothing itself: it finds the
 * transitions available to this user on this card whose fixed action
 * sets that property to that value, and when exactly one matches and
 * needs no further input, executes it — so the card gains the value AND
 * every other action of that transition in one card version, with the
 * transition's prerequisites enforced and a TransitionExecuted event.
 * WHEN: the actor is a full team member of the project, the card and
 * property exist, and the requested value differs from the card's
 * current one.
 * BECAUSE: a transition-only property is the workflow's state, and
 * legacy's rule is that it moves only along the workflow — so dragging
 * a card to a new column must run the workflow step, not overwrite the
 * state and skip the step's other effects.
 * REJECTS: unknown project, card, or property; actor below full team
 * member; a formula property (calculated, never set); a value invalid
 * for the property's kind. Reports (without writing) `unchanged` when
 * the card already holds the value, and — for a transition-only
 * property — `require_user_input`, `multi_transitions_matched`, or
 * `no_transition_matched` when it cannot pick a single transition to
 * run unattended.
 *
 * @param db - the Drizzle handle
 * @param input - the card, property, requested value, and actor
 * @returns the outcome, or field errors
 */
export function applyCardPropertyValue(
  db: BetterSQLite3Database,
  input: ApplyCardPropertyValueInput,
): CommandResult<AutoTransitionOutcome> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;
  const card = db
    .select()
    .from(cards)
    .where(
      and(
        eq(cards.projectId, input.projectId),
        eq(cards.number, input.cardNumber),
      ),
    )
    .get();
  if (!card) return reject("card", "does not exist");
  const definition = findDefinition(db, input.projectId, input.propertyDefinitionId);
  if (!definition) return reject("property", "does not exist");
  if (definition.kind === "formula")
    return reject(
      "property",
      `${definition.name} is a formula property and cannot be set directly`,
    );

  const raw = input.value?.trim() || null;
  let canonical: string | null = null;
  if (raw !== null) {
    const result = canonicalPropertyValue(db, input.projectId, definition, raw);
    if (!result.ok) return result;
    canonical = result.value;
  }
  const current =
    db
      .select({ value: cardPropertyValues.value })
      .from(cardPropertyValues)
      .where(
        and(
          eq(cardPropertyValues.cardId, card.id),
          eq(cardPropertyValues.propertyDefinitionId, definition.id),
        ),
      )
      .get()?.value ?? null;
  // Legacy no_property_value_changed?: a drag that lands where the card
  // already is must not fire a transition, or report an error.
  if (samePropertyValue(definition.kind as PropertyKind, canonical, current))
    return { ok: true, value: { kind: "unchanged" } };

  if (!definition.transitionOnly) {
    const result = setCardPropertyValue(db, {
      projectId: input.projectId,
      cardNumber: input.cardNumber,
      propertyDefinitionId: definition.id,
      value: input.value,
      actorUserId: input.actorUserId,
    });
    if (!result.ok) return result;
    return { ok: true, value: { kind: "value_set", card: result.value } };
  }

  // Transition-only: the value may only arrive by executing a
  // transition that sets it. Legacy selects from the card's AVAILABLE
  // transitions, so a transition whose prerequisites do not hold is not
  // a match — it is simply not there to fire.
  const matches = availableTransitionDetails(
    db,
    input.projectId,
    input.cardNumber,
    input.actorUserId,
  ).filter((detail) =>
    detail.actions.some(
      (action) =>
        action.propertyDefinitionId === definition.id &&
        action.inputMode === "fixed" &&
        samePropertyValue(
          definition.kind as PropertyKind,
          action.value,
          canonical,
        ),
    ),
  );
  const named = matches.map((detail) => ({
    id: detail.transition.id,
    name: detail.transition.name,
  }));
  if (named.length === 0) return { ok: true, value: { kind: "no_transition_matched" } };
  if (named.length > 1)
    return { ok: true, value: { kind: "multi_transitions_matched", transitions: named } };

  const [only] = matches;
  if (only.actions.some((action) => action.inputMode !== "fixed"))
    return { ok: true, value: { kind: "require_user_input", transition: named[0] } };

  const executed = executeTransition(db, {
    projectId: input.projectId,
    cardNumber: input.cardNumber,
    transitionId: only.transition.id,
    actorUserId: input.actorUserId,
  });
  if (!executed.ok) return executed;
  return {
    ok: true,
    value: {
      kind: "transition_applied",
      card: executed.value.card,
      transition: named[0],
    },
  };
}
