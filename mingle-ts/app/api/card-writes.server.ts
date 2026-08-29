/**
 * API card writes — the API's create/update card requests composed
 * from the domain commands, all-or-nothing.
 *
 * Purpose: an API client sends a card and its property values in one
 * request, where the card page posts them one form at a time. This
 * module runs the same commands the card page runs — `createCard` /
 * `updateCard` for the card fields and `applyCardPropertyValue`
 * (ADR-0008: the entry point that routes a transition-only property
 * through its transition) for each property — on one transaction, so
 * a request with any invalid part writes nothing. It writes no rows
 * itself and holds no business rules: names are resolved to ids,
 * logins to user ids, and rejections re-keyed to the request's field.
 *
 * Public interface: `createCardViaApi`, `updateCardViaApi`,
 * `CardWriteOutcome`.
 *
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, type CardRow } from "~/db/schema/cards";
import type { PropertyDefinitionRow } from "~/db/schema/properties";
import { createCard, updateCard } from "~/domain/cards/commands.server";
import { applyCardPropertyValue } from "~/domain/cards/transition-workflows.server";
import type { CommandResult } from "~/domain/command.server";
import type { FieldErrors } from "~/shared/wire-types";
import {
  findCardTypeByName,
  findPropertyDefinitionByName,
  listCardTypes,
  listPropertyDefinitions,
  resolvePropertyInput,
} from "~/api/resources.server";

/** Carries a rejection out of the transaction so it rolls back. */
class CardWriteRejected extends Error {
  constructor(readonly errors: FieldErrors) {
    super("card write rejected");
  }
}

/** Unwraps a command result, re-keying non-authorization errors under `field` when given. */
function must<T>(result: CommandResult<T>, field?: string): T {
  if (result.ok) return result.value;
  if (!field) throw new CardWriteRejected(result.errors);
  const errors: FieldErrors = {};
  for (const [key, messages] of Object.entries(result.errors))
    errors[key === "authorization" ? key : field] = [...(errors[key === "authorization" ? key : field] ?? []), ...messages];
  throw new CardWriteRejected(errors);
}

/** What a card write reports. */
export interface CardWriteOutcome {
  card: CardRow;
  /** Names of transitions executed because a property change required one. */
  appliedTransitions: string[];
}

interface Scope {
  projectId: number;
  actorUserId: number;
}

/**
 * Applies `properties` (name → value) to a card through
 * `applyCardPropertyValue`, one at a time on the given transaction.
 * A user-kind value is a login and is resolved to the user's id first.
 * Outcomes that write nothing but need the caller's decision (user
 * input required, several transitions match, none match) are
 * rejections here: an API request cannot pick interactively.
 */
function applyProperties(
  tx: BetterSQLite3Database,
  scope: Scope,
  cardNumber: number,
  properties: Record<string, string | null>,
  definitions: PropertyDefinitionRow[],
): string[] {
  const applied: string[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const field = `properties.${name}`;
    const definition = findPropertyDefinitionByName(definitions, name);
    if (!definition) throw new CardWriteRejected({ [field]: ["is not a property of this project"] });
    const resolved = resolvePropertyInput(tx, definition, raw);
    if (!resolved.ok) throw new CardWriteRejected({ [field]: [resolved.message] });
    const outcome = must(
      applyCardPropertyValue(tx, { ...scope, cardNumber, propertyDefinitionId: definition.id, value: resolved.value }),
      field,
    );
    switch (outcome.kind) {
      case "unchanged":
      case "value_set":
        break;
      case "transition_applied":
        applied.push(outcome.transition.name);
        break;
      case "require_user_input":
        throw new CardWriteRejected({
          [field]: [
            `${outcome.transition.name} sets that value but needs user input; execute it through the card's transitions resource`,
          ],
        });
      case "multi_transitions_matched":
        throw new CardWriteRejected({
          [field]: [
            `More than one transition sets that value (${outcome.transitions.map((t) => t.name).join(", ")}); execute one through the card's transitions resource`,
          ],
        });
      case "no_transition_matched":
        throw new CardWriteRejected({
          [field]: ["That value can only be reached by a transition, and none is available for this card right now"],
        });
    }
  }
  return applied;
}

/** The card as it stands after the writes. */
function reloadCard(tx: BetterSQLite3Database, projectId: number, number: number): CardRow {
  const row = tx.select().from(cards).where(and(eq(cards.projectId, projectId), eq(cards.number, number))).get();
  if (!row) throw new CardWriteRejected({ card: ["does not exist"] });
  return row;
}

/** Runs `body` on one transaction, turning a carried rejection into a result. */
function transactional<T>(db: BetterSQLite3Database, body: (tx: BetterSQLite3Database) => T): CommandResult<T> {
  try {
    return { ok: true, value: db.transaction((tx) => body(tx)) };
  } catch (error) {
    if (error instanceof CardWriteRejected) return { ok: false, errors: error.errors };
    throw error;
  }
}

export interface CreateCardViaApiInput extends Scope {
  name: string;
  description?: string | null;
  /** Card type by name; the project's first type when absent. */
  typeName?: string | null;
  properties?: Record<string, string | null>;
}

/**
 * Creates a card and sets its properties on one transaction.
 *
 * DOES: runs `createCard` (type resolved by name, or the project's
 * first type), then `applyCardPropertyValue` per property; commits
 * only when every step succeeds, so no card exists after a rejected
 * request.
 * REJECTS: an unknown type name (`type`), an unknown property name or
 * unresolvable login (`properties.<name>`), any rejection the commands
 * themselves make (re-keyed to the request field, `authorization`
 * kept), or a property change that would need interactive choice.
 *
 * @returns the created card and any applied transitions, or field errors
 */
export function createCardViaApi(db: BetterSQLite3Database, input: CreateCardViaApiInput): CommandResult<CardWriteOutcome> {
  const scope: Scope = { projectId: input.projectId, actorUserId: input.actorUserId };
  return transactional(db, (tx) => {
    const type = input.typeName?.trim()
      ? findCardTypeByName(tx, input.projectId, input.typeName)
      : listCardTypes(tx, input.projectId)[0];
    if (!type) throw new CardWriteRejected({ type: [`'${input.typeName ?? ""}' is not a card type of this project`] });
    const created = must(
      createCard(tx, { ...scope, name: input.name, description: input.description, cardTypeId: type.id }),
    );
    const definitions = listPropertyDefinitions(tx, input.projectId);
    const appliedTransitions = input.properties
      ? applyProperties(tx, scope, created.number, input.properties, definitions)
      : [];
    return { card: reloadCard(tx, input.projectId, created.number), appliedTransitions };
  });
}

export interface UpdateCardViaApiInput extends Scope {
  cardNumber: number;
  name?: string;
  description?: string | null;
  typeName?: string | null;
  properties?: Record<string, string | null>;
}

/**
 * Updates a card's fields and/or properties on one transaction.
 *
 * DOES: runs `updateCard` when a supplied name, description, or type
 * differs from the card's current value (a version records a change,
 * so an unchanged field alone is not sent to the command), then
 * `applyCardPropertyValue` per property; commits only when every step
 * succeeds.
 * REJECTS: unknown card (`card`), an unknown type name (`type`), and
 * everything `createCardViaApi` rejects for properties and commands.
 *
 * @returns the card as it stands and any applied transitions, or field errors
 */
export function updateCardViaApi(db: BetterSQLite3Database, input: UpdateCardViaApiInput): CommandResult<CardWriteOutcome> {
  const scope: Scope = { projectId: input.projectId, actorUserId: input.actorUserId };
  return transactional(db, (tx) => {
    const current = reloadCard(tx, input.projectId, input.cardNumber);
    let cardTypeId = current.cardTypeId;
    if (input.typeName !== undefined && input.typeName !== null) {
      const type = findCardTypeByName(tx, input.projectId, input.typeName);
      if (!type) throw new CardWriteRejected({ type: [`'${input.typeName}' is not a card type of this project`] });
      cardTypeId = type.id;
    }
    const name = input.name === undefined ? current.name : input.name;
    const description = input.description === undefined ? current.description : input.description;
    const fieldsChanged =
      name.trim() !== current.name ||
      (description?.trim() || null) !== current.description ||
      cardTypeId !== current.cardTypeId;
    if (fieldsChanged)
      must(updateCard(tx, { ...scope, cardNumber: input.cardNumber, name, description, cardTypeId }));
    const definitions = listPropertyDefinitions(tx, input.projectId);
    const appliedTransitions = input.properties
      ? applyProperties(tx, scope, input.cardNumber, input.properties, definitions)
      : [];
    return { card: reloadCard(tx, input.projectId, input.cardNumber), appliedTransitions };
  });
}
