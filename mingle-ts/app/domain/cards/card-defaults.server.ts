/**
 * Card Management command handlers — card defaults (P-2, project
 * templates Phase 1; legacy card_defaults.rb).
 *
 * Purpose: the only write path for `card_defaults` — the property
 * values a new card of a card type starts with — and the read helpers
 * the settings page and CreateCard use. A default is validated the way
 * a card value is (`canonicalPropertyValue`: an enumerated default must
 * be one of the property's values, a user default a team member) with
 * one addition: a user-kind default may hold the marker
 * `(current user)`, stored literally and resolved to the creating actor
 * when a card is created. Only directly settable kinds
 * (`DEFAULTABLE_PROPERTY_KINDS`) may carry a default — formula, tree
 * relationship and aggregate values are derived or structural.
 *
 * Commands → events:
 *   SetCardDefaults → CardDefaultsSet
 *
 * Public interface: `setCardDefaults`, `cardDefaultsFor`,
 * `listCardDefaults`, `defaultPropertyChanges` (for CreateCard: the
 * validated, marker-resolved changes to write into version 1).
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports.
 */
import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardDefaults, type CardDefaultRow } from "~/db/schema/card-defaults";
import { cardTypes, type CardTypeRow } from "~/db/schema/cards";
import { propertyDefinitions, type PropertyDefinitionRow } from "~/db/schema/properties";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { canonicalPropertyValue, type PropertyValueChange } from "~/domain/cards/properties.server";
import {
  CURRENT_USER_MARKER,
  DEFAULTABLE_PROPERTY_KINDS,
  type CardDefaultsView,
  type FieldErrors,
  type PropertyKind,
} from "~/shared/wire-types";

export interface SetCardDefaultsInput {
  projectId: number;
  cardTypeId: number;
  /**
   * Property name → default value. Null or blank clears that
   * property's default; a property not named here keeps no default —
   * the call replaces the card type's whole default set.
   */
  defaults: Record<string, string | null>;
  actorUserId: number;
}

/** True when a raw value is the current-user marker (case-insensitive, legacy also accepted the bare alias). */
export function isCurrentUserMarker(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === CURRENT_USER_MARKER || value === "current user";
}

function defaultable(kind: string): boolean {
  return (DEFAULTABLE_PROPERTY_KINDS as readonly string[]).includes(kind);
}

function kindLabel(kind: PropertyKind): string {
  return kind === "tree_relationship" ? "tree relationship" : kind;
}

/** Re-keys a value rejection under the default's own field. */
function rekey(errors: FieldErrors, field: string): CommandResult<never> {
  const messages = Object.entries(errors).flatMap(([key, list]) => (key === "authorization" ? [] : list));
  return { ok: false, errors: { [field]: messages } };
}

/**
 * SetCardDefaults — replaces a card type's default property values.
 *
 * DOES: deletes the card type's `card_defaults` rows and inserts one
 * row per named, non-blank default with the canonical value (or the
 * `(current user)` marker for a user property), in one transaction,
 * and emits CardDefaultsSet naming the card type and the defaults by
 * property name.
 * REJECTS: unknown project or card type; actor below project
 * administrator; a name that is not a property of the project; a
 * property of formula, tree-relationship or aggregate kind; a value
 * invalid for the property (an enumerated value the property does not
 * manage, a user who is not a team member, a bad number or date) —
 * each keyed `defaults.<property name>`.
 *
 * @returns the stored default rows, or field errors
 */
export function setCardDefaults(
  db: BetterSQLite3Database,
  input: SetCardDefaultsInput,
): CommandResult<CardDefaultRow[]> {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get();
  if (!project) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const cardType = db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, input.projectId), eq(cardTypes.id, input.cardTypeId)))
    .get();
  if (!cardType) return reject("cardType", "does not exist");

  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, input.projectId))
    .all();
  const resolved: { definition: PropertyDefinitionRow; value: string }[] = [];
  for (const [name, raw] of Object.entries(input.defaults)) {
    const definition = definitions.find((row) => row.name.toLowerCase() === name.trim().toLowerCase());
    if (!definition) return reject(`defaults.${name}`, "is not a property of this project");
    const value = raw?.trim() ?? "";
    if (!value) continue;
    const field = `defaults.${definition.name}`;
    if (!defaultable(definition.kind))
      return reject(field, `${definition.name} is a ${kindLabel(definition.kind as PropertyKind)} property and cannot have a default`);
    if (resolved.some((entry) => entry.definition.id === definition.id))
      return reject(field, "is named more than once");
    if (definition.kind === "user" && isCurrentUserMarker(value)) {
      resolved.push({ definition, value: CURRENT_USER_MARKER });
      continue;
    }
    const canonical = canonicalPropertyValue(db, input.projectId, definition, value);
    if (!canonical.ok) return rekey(canonical.errors, field);
    resolved.push({ definition, value: canonical.value });
  }

  return db.transaction((tx) => {
    tx.delete(cardDefaults).where(eq(cardDefaults.cardTypeId, cardType.id)).run();
    const rows: CardDefaultRow[] = [];
    for (const { definition, value } of resolved) {
      rows.push(
        tx
          .insert(cardDefaults)
          .values({ projectId: input.projectId, cardTypeId: cardType.id, propertyDefinitionId: definition.id, value })
          .returning()
          .get(),
      );
    }
    emitEvent(tx, {
      type: "CardDefaultsSet",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: {
        cardTypeName: cardType.name,
        defaults: Object.fromEntries(resolved.map(({ definition, value }) => [definition.name, value])),
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: rows } as CommandResult<CardDefaultRow[]>;
  });
}

/** The stored defaults of one card type, with their definitions, in property order. */
export function cardDefaultsFor(
  db: BetterSQLite3Database,
  cardTypeId: number,
): { definition: PropertyDefinitionRow; value: string }[] {
  return db
    .select({ definition: propertyDefinitions, value: cardDefaults.value })
    .from(cardDefaults)
    .innerJoin(propertyDefinitions, eq(propertyDefinitions.id, cardDefaults.propertyDefinitionId))
    .where(eq(cardDefaults.cardTypeId, cardTypeId))
    .orderBy(asc(propertyDefinitions.position))
    .all();
}

/** Every card type's defaults in a project, for the settings page. */
export function listCardDefaults(db: BetterSQLite3Database, projectId: number): CardDefaultsView[] {
  const rows = db
    .select({ cardTypeId: cardDefaults.cardTypeId, propertyDefinitionId: cardDefaults.propertyDefinitionId, value: cardDefaults.value })
    .from(cardDefaults)
    .where(eq(cardDefaults.projectId, projectId))
    .all();
  const byType = new Map<number, Record<string, string>>();
  for (const row of rows) {
    const values = byType.get(row.cardTypeId) ?? {};
    values[String(row.propertyDefinitionId)] = row.value;
    byType.set(row.cardTypeId, values);
  }
  return [...byType.entries()].map(([cardTypeId, values]) => ({ cardTypeId, values }));
}

/**
 * The property changes a new card of `cardType` starts with: each
 * stored default re-validated against the property as it stands now
 * (a value removed from an enumerated property since the default was
 * set is refused, as legacy's "Unable to set default" was), with the
 * `(current user)` marker resolved to `actorUserId` — stored as the
 * actor's id whether or not the actor is a team member, as legacy did.
 *
 * @returns the canonical changes for `insertInitialPropertyValues`, or a rejection keyed "property"
 */
export function defaultPropertyChanges(
  db: BetterSQLite3Database,
  projectId: number,
  cardType: CardTypeRow,
  actorUserId: number,
): CommandResult<PropertyValueChange[]> {
  const changes: PropertyValueChange[] = [];
  for (const { definition, value } of cardDefaultsFor(db, cardType.id)) {
    if (!defaultable(definition.kind)) continue;
    if (definition.kind === "user" && value === CURRENT_USER_MARKER) {
      changes.push({ definition, value: String(actorUserId) });
      continue;
    }
    const canonical = canonicalPropertyValue(db, projectId, definition, value);
    if (!canonical.ok) {
      const why = Object.values(canonical.errors).flat().join("; ");
      return reject("property", `Unable to set default for ${definition.name} to ${value} because ${why}`);
    }
    changes.push({ definition, value: canonical.value });
  }
  return { ok: true, value: changes };
}
