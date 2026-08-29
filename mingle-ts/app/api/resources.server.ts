/**
 * API resource presenters and lookups — rows in, `/api/v1` shapes out.
 *
 * Purpose: the read side of the public API. Resolves URL segments to
 * rows (404 when absent), and presents projects, card types, property
 * definitions, cards, and transitions in the wire shapes declared in
 * `~/shared/wire-types`. Presentation rules that differ from storage
 * live here in one place: card property values are keyed by name
 * (storage keys by id, ADR-0004), user properties carry the login
 * (storage holds the id), and dates are ISO strings.
 *
 * Public interface: `requireProject`, `requireCard`, `projectResource`,
 * `listCardTypes`, `cardTypeResource`, `findCardTypeByName`,
 * `listPropertyDefinitions`, `propertyDefinitionResources`,
 * `findPropertyDefinitionByName`, `cardPresenter`, `userIdForLogin`,
 * `transitionResources`, `availableTransitionResources`.
 *
 * Owner context: Public API (HTTP adapter). Reads only; every write
 * goes through the domain commands.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardTypes, cards, type CardRow, type CardTypeRow } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import { projects, type ProjectRow } from "~/db/schema/projects";
import { enumerationValues, propertyDefinitions, type PropertyDefinitionRow } from "~/db/schema/properties";
import { cardPropertySnapshot } from "~/domain/cards/properties.server";
import {
  availableTransitions,
  describeAction,
  describePrerequisite,
  loadTransitionNames,
  loadTransitions,
} from "~/domain/cards/transitions.server";
import type {
  ApiAvailableTransition,
  ApiCard,
  ApiCardType,
  ApiProject,
  ApiPropertyDefinition,
  ApiTransition,
  PropertyKind,
} from "~/shared/wire-types";
import { apiError } from "~/api/http.server";

// ---------------------------------------------------------------- lookups

/**
 * Resolves the `:identifier` URL segment to a project.
 *
 * @throws a 404 Response when no project has that identifier
 */
export function requireProject(db: BetterSQLite3Database, identifier: string | undefined): ProjectRow {
  const row = identifier
    ? db.select().from(projects).where(eq(projects.identifier, identifier)).get()
    : undefined;
  if (!row) throw apiError(404, `No project with identifier '${identifier ?? ""}'`);
  return row;
}

/**
 * Resolves the `:number` URL segment to a card of the project.
 *
 * @throws a 404 Response when the segment is not a number or names no live card
 */
export function requireCard(db: BetterSQLite3Database, projectId: number, numberParam: string | undefined): CardRow {
  const number = Number(numberParam);
  const row = Number.isInteger(number)
    ? db.select().from(cards).where(and(eq(cards.projectId, projectId), eq(cards.number, number))).get()
    : undefined;
  if (!row) throw apiError(404, `No card #${numberParam ?? ""} in this project`);
  return row;
}

/** The project's card types in display order. */
export function listCardTypes(db: BetterSQLite3Database, projectId: number): CardTypeRow[] {
  return db.select().from(cardTypes).where(eq(cardTypes.projectId, projectId)).orderBy(asc(cardTypes.position), asc(cardTypes.id)).all();
}

/** A card type looked up by name, case-insensitively (legacy names are CI-unique). */
export function findCardTypeByName(db: BetterSQLite3Database, projectId: number, name: string): CardTypeRow | undefined {
  return db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, projectId), sql`lower(${cardTypes.name}) = ${name.trim().toLowerCase()}`))
    .get();
}

/** The project's property definitions in display order. */
export function listPropertyDefinitions(db: BetterSQLite3Database, projectId: number): PropertyDefinitionRow[] {
  return db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, projectId))
    .orderBy(asc(propertyDefinitions.position), asc(propertyDefinitions.id))
    .all();
}

/** A definition found by name, case-insensitively (legacy names are CI-unique). */
export function findPropertyDefinitionByName(
  definitions: PropertyDefinitionRow[],
  name: string,
): PropertyDefinitionRow | undefined {
  const wanted = name.trim().toLowerCase();
  return definitions.find((definition) => definition.name.toLowerCase() === wanted);
}

/** A user's id by login (case-insensitive), for user-kind property input. */
export function userIdForLogin(db: BetterSQLite3Database, login: string): number | undefined {
  return db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.login}) = ${login.trim().toLowerCase()}`)
    .get()?.id;
}

/**
 * Translates an API-supplied property value to what the commands
 * expect: a user-kind value arrives as a login and the value rule
 * wants the user's id (the Phase 29 card-import convention); every
 * other kind passes through untouched for the command to validate.
 *
 * @returns the value to hand the command, or the rejection message
 *   (in the command's own wording) when the login names no user
 */
export function resolvePropertyInput(
  db: BetterSQLite3Database,
  definition: PropertyDefinitionRow,
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (definition.kind !== "user" || raw === null || raw === undefined || raw.trim() === "")
    return { ok: true, value: raw ?? null };
  const userId = userIdForLogin(db, raw);
  if (userId === undefined) return { ok: false, message: `${definition.name}: '${raw}' is not a valid user` };
  return { ok: true, value: String(userId) };
}

// ------------------------------------------------------------- presenters

/** Presents a project row. */
export function projectResource(row: ProjectRow): ApiProject {
  return {
    identifier: row.identifier,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Presents a card type row. */
export function cardTypeResource(row: CardTypeRow): ApiCardType {
  return { id: row.id, name: row.name, position: row.position };
}

/** Presents every property definition of a project, with enumerated values in order. */
export function propertyDefinitionResources(db: BetterSQLite3Database, projectId: number): ApiPropertyDefinition[] {
  const definitions = listPropertyDefinitions(db, projectId);
  const enumeratedIds = definitions.filter((d) => d.kind === "enumerated").map((d) => d.id);
  const valuesByDefinition = new Map<number, string[]>();
  if (enumeratedIds.length > 0) {
    for (const row of db
      .select({ propertyDefinitionId: enumerationValues.propertyDefinitionId, value: enumerationValues.value })
      .from(enumerationValues)
      .where(inArray(enumerationValues.propertyDefinitionId, enumeratedIds))
      .orderBy(asc(enumerationValues.position), asc(enumerationValues.id))
      .all()) {
      const list = valuesByDefinition.get(row.propertyDefinitionId) ?? [];
      list.push(row.value);
      valuesByDefinition.set(row.propertyDefinitionId, list);
    }
  }
  return definitions.map((definition) => {
    const resource: ApiPropertyDefinition = {
      id: definition.id,
      name: definition.name,
      kind: definition.kind as PropertyKind,
      transitionOnly: definition.transitionOnly,
      position: definition.position,
    };
    if (definition.kind === "enumerated") resource.values = valuesByDefinition.get(definition.id) ?? [];
    if (definition.kind === "formula") resource.formula = definition.formula;
    return resource;
  });
}

/**
 * Builds a presenter for the cards of one project. Loads the project's
 * definitions and card type names once; user logins are resolved as
 * cards reference them, so presenting a list costs one values query
 * per card plus one login query per distinct user.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project the cards belong to
 * @returns a function presenting a card row as `ApiCard`
 */
export function cardPresenter(db: BetterSQLite3Database, projectId: number): (card: CardRow) => ApiCard {
  const definitions = listPropertyDefinitions(db, projectId);
  const typeNames = new Map(listCardTypes(db, projectId).map((type) => [type.id, type.name]));
  const logins = new Map<number, string>();
  const loginFor = (id: number): string => {
    const known = logins.get(id);
    if (known !== undefined) return known;
    const login = db.select({ login: users.login }).from(users).where(eq(users.id, id)).get()?.login ?? String(id);
    logins.set(id, login);
    return login;
  };
  return (card) => {
    const snapshot = cardPropertySnapshot(db, card.id);
    const properties: Record<string, string | null> = {};
    for (const definition of definitions) {
      const stored = snapshot[String(definition.id)] ?? null;
      properties[definition.name] =
        stored !== null && definition.kind === "user" ? loginFor(Number(stored)) : stored;
    }
    return {
      number: card.number,
      name: card.name,
      description: card.description,
      type: typeNames.get(card.cardTypeId) ?? "?",
      version: card.version,
      properties,
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString(),
    };
  };
}

/** Presents every transition of a project with legacy one-line descriptions. */
export function transitionResources(db: BetterSQLite3Database, projectId: number): ApiTransition[] {
  const names = loadTransitionNames(db, projectId);
  const typeNames = new Map(listCardTypes(db, projectId).map((type) => [type.id, type.name]));
  return loadTransitions(db, projectId).map((detail) => ({
    id: detail.transition.id,
    name: detail.transition.name,
    cardType: detail.transition.cardTypeId ? (typeNames.get(detail.transition.cardTypeId) ?? null) : null,
    prerequisites: detail.prerequisites.map((prerequisite) => describePrerequisite(prerequisite, names)),
    actions: detail.actions.map((action) => describeAction(action, names)),
  }));
}

/** Presents the transitions a user may execute on a card right now. */
export function availableTransitionResources(
  db: BetterSQLite3Database,
  projectId: number,
  cardNumber: number,
  userId: number,
): ApiAvailableTransition[] {
  return availableTransitions(db, projectId, cardNumber, userId).map((transition) => ({
    id: transition.id,
    name: transition.name,
    inputs: transition.inputs.map((input) => ({
      property: input.propertyName,
      kind: input.kind as PropertyKind,
      required: input.required,
    })),
  }));
}
