/**
 * Card Management command handlers — managed card properties (Phase 7).
 *
 * Purpose: the only write path for property definitions, their
 * enumeration values, and card property values. Definitions carry a
 * `kind` discriminator (text | number | date | user | enumerated);
 * values are validated per kind against the legacy rules
 * (property_definition.rb, property_type.rb, enumeration_value.rb,
 * user_property_definition.rb) and never silently coerced. Every value
 * mutation appends the card's next `card_versions` row (Phase 5's
 * versioning — INSERT only, never update or delete a version) with the
 * full property snapshot, and emits a past-tense event — or rejects
 * (rule 10).
 *
 * Commands → events:
 *   DefinePropertyDefinition → PropertyDefinitionDefined
 *   SetCardPropertyValue     → CardPropertyValueSet (+ next card version)
 *
 * Public interface: `definePropertyDefinition`, `setCardPropertyValue`,
 * `cardPropertySnapshot` (read helper reused by the card commands'
 * version inserts).
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  cards,
  cardTypes,
  cardVersions,
  type CardRow,
} from "~/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import { projects } from "~/db/schema/projects";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import { PROPERTY_KINDS, type PropertyKind } from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

// Legacy parity rules (mingle/app/models/property_definition.rb):
const NAME_MAX_LENGTH = 40; // COLUMN_NAME_MAX_LEN
const INVALID_NAME_CHARS = /[\[\]"&=#;]/; // INVALID_NAME_CHARS
const VALUE_MAX_LENGTH = 255;
const NUMERIC_FORMAT = /^[+-]?\d+(\.\d+)?$/;
const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Names reserved for the predefined card properties (legacy
 * PredefinedPropertyDefinitions::TYPES keys), compared after the same
 * normalization legacy applies: lowercase, non-word runs to "_".
 */
const RESERVED_PROPERTY_NAMES = new Set([
  "type",
  "number",
  "name",
  "project",
  "description",
  "project_card_rank",
  "modified_by",
  "created_by",
  "created_on",
  "modified_on",
]);

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

/**
 * The card's current property values keyed by property definition id
 * (stringified, JSON object keys being strings) — the shape snapshotted
 * into `card_versions.property_values`. Keyed by id, not name, so
 * snapshots stay immutable through property renames (ADR-0004); readers
 * join `property_definitions` for the current display name, mirroring
 * legacy's rewrite-history-to-the-current-name behavior.
 *
 * @param db - the Drizzle handle (or transaction) to read with
 * @param cardId - the card whose values to collect
 * @returns {propertyDefinitionId: canonicalStoredValue}, {} when none set
 */
export function cardPropertySnapshot(
  db: BetterSQLite3Database,
  cardId: number,
): Record<string, string> {
  const rows = db
    .select({
      propertyDefinitionId: cardPropertyValues.propertyDefinitionId,
      value: cardPropertyValues.value,
    })
    .from(cardPropertyValues)
    .where(eq(cardPropertyValues.cardId, cardId))
    .orderBy(asc(cardPropertyValues.propertyDefinitionId))
    .all();
  return Object.fromEntries(
    rows.map((row) => [String(row.propertyDefinitionId), row.value]),
  );
}

/**
 * Validates a new property definition's name against the legacy rules.
 * Uniqueness is checked separately.
 *
 * @returns an error message, or null when valid
 */
function propertyNameError(name: string): string | null {
  if (!name) return "can't be blank";
  if (name.length > NAME_MAX_LENGTH)
    return `is too long (maximum is ${NAME_MAX_LENGTH} characters)`;
  if (INVALID_NAME_CHARS.test(name))
    return "should not contain '&', '=', '#', '\"', ';', '[' and ']' characters";
  if (name === "_") return "cannot be '_'";
  if (RESERVED_PROPERTY_NAMES.has(name.toLowerCase().replace(/\W+/g, "_")))
    return "is a reserved property name";
  return null;
}

export interface DefinePropertyDefinitionInput {
  projectId: number;
  name: string;
  kind: string;
  /** Allowed values, in order — enumerated kind only. */
  values?: string[];
  actorUserId: number;
}

/**
 * DefinePropertyDefinition — adds a managed property to a project.
 *
 * DOES: inserts a `property_definitions` row (position appended at the
 * end) plus, for the enumerated kind, one ordered `enumeration_values`
 * row per supplied value, and appends a PropertyDefinitionDefined
 * event, all in one transaction.
 * REJECTS: unknown project, actor below project administrator (legacy:
 * property management is PROJECT_ADMIN), invalid name (blank, over 40
 * chars, containing []"&=#; characters, '_', a reserved predefined
 * name, or taken case-insensitively in the project), unknown kind,
 * values supplied for a non-enumerated kind, or an invalid enumeration
 * value (blank, over 255 chars, parenthesis-wrapped, or a
 * case-insensitive duplicate within the list).
 *
 * @returns the created definition row, or field errors
 */
export function definePropertyDefinition(
  db: BetterSQLite3Database,
  input: DefinePropertyDefinitionInput,
): CommandResult<PropertyDefinitionRow> {
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
  const nameError = propertyNameError(name);
  if (nameError) return reject("name", nameError);
  const taken = db
    .select({ id: propertyDefinitions.id })
    .from(propertyDefinitions)
    .where(
      and(
        eq(propertyDefinitions.projectId, input.projectId),
        sql`lower(${propertyDefinitions.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
  if (taken) return reject("name", "has already been taken");

  if (!(PROPERTY_KINDS as readonly string[]).includes(input.kind))
    return reject("kind", "must be selected");
  const kind = input.kind as PropertyKind;

  const values = (input.values ?? []).map((value) => value.trim());
  if (kind !== "enumerated" && values.length > 0)
    return reject("values", "are only allowed for a managed list property");
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) return reject("values", "can't include a blank value");
    if (value.length > VALUE_MAX_LENGTH)
      return reject(
        "values",
        `'${value}' is too long (maximum is ${VALUE_MAX_LENGTH} characters)`,
      );
    if (value.startsWith("(") && value.endsWith(")"))
      return reject("values", "cannot both start with '(' and end with ')'");
    if (seen.has(value.toLowerCase()))
      return reject("values", `'${value}' has already been taken`);
    seen.add(value.toLowerCase());
  }

  const last = db.get<{ highest: number }>(
    sql`SELECT COALESCE(MAX(position), 0) AS highest FROM ${propertyDefinitions} WHERE ${propertyDefinitions.projectId} = ${input.projectId}`,
  );
  return db.transaction((tx) => {
    const row = tx
      .insert(propertyDefinitions)
      .values({
        projectId: input.projectId,
        name,
        kind,
        position: (last?.highest ?? 0) + 1,
      })
      .returning()
      .get();
    values.forEach((value, i) => {
      tx.insert(enumerationValues)
        .values({ propertyDefinitionId: row.id, value, position: i + 1 })
        .run();
    });
    emitEvent(tx, {
      type: "PropertyDefinitionDefined",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { name: row.name, kind, values },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<PropertyDefinitionRow>;
  });
}

/**
 * Validates and canonicalizes a raw value for one property kind.
 * Mirrors the legacy per-type validate/find_object semantics: invalid
 * values are rejected with the property named, never silently coerced.
 *
 * @returns the canonical stored value, or a rejection
 */
function canonicalValue(
  db: BetterSQLite3Database,
  projectId: number,
  definition: PropertyDefinitionRow,
  raw: string,
): CommandResult<string> {
  switch (definition.kind as PropertyKind) {
    case "text": {
      if (raw.length > VALUE_MAX_LENGTH)
        return reject(
          "value",
          `${definition.name}: value is too long (maximum is ${VALUE_MAX_LENGTH} characters)`,
        );
      if (raw.startsWith("(") && raw.endsWith(")"))
        return reject(
          "value",
          `${definition.name}: value cannot both start with '(' and end with ')'`,
        );
      return { ok: true, value: raw };
    }
    case "number": {
      if (!NUMERIC_FORMAT.test(raw))
        return reject(
          "value",
          `${definition.name}: '${raw}' is an invalid numeric value`,
        );
      return { ok: true, value: raw };
    }
    case "date": {
      // ISO date only for now; legacy honored the project's date format,
      // which arrives with project date settings in a later phase.
      if (!ISO_DATE_FORMAT.test(raw) || Number.isNaN(Date.parse(raw)))
        return reject(
          "value",
          `${definition.name}: '${raw}' is an invalid date. Enter dates in yyyy-mm-dd format`,
        );
      return { ok: true, value: raw };
    }
    case "user": {
      const userId = Number(raw);
      const user = Number.isInteger(userId)
        ? db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(eq(users.id, userId))
            .get()
        : undefined;
      if (!user)
        return reject(
          "value",
          `${definition.name}: '${raw}' is not a valid user`,
        );
      const membership = db
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.projectId, projectId),
            eq(teamMemberships.userId, user.id),
          ),
        )
        .get();
      if (!membership)
        return reject(
          "value",
          `${definition.name}: ${user.name} is not a project member`,
        );
      return { ok: true, value: String(user.id) };
    }
    case "enumerated": {
      const allowed = db
        .select({ value: enumerationValues.value })
        .from(enumerationValues)
        .where(eq(enumerationValues.propertyDefinitionId, definition.id))
        .orderBy(asc(enumerationValues.position))
        .all();
      if (allowed.length === 0)
        return reject(
          "value",
          `${definition.name} does not have any defined values`,
        );
      const match = allowed.find(
        (candidate) => candidate.value.toLowerCase() === raw.toLowerCase(),
      );
      if (!match)
        return reject(
          "value",
          `${definition.name} is restricted to ${allowed
            .map((candidate) => candidate.value)
            .join(", ")}`,
        );
      return { ok: true, value: match.value };
    }
  }
}

/** True when new and current stored values are the same property value. */
function sameValue(
  kind: PropertyKind,
  next: string | null,
  current: string | null,
): boolean {
  if (next === null || current === null) return next === current;
  // Numbers compare numerically (legacy NumericType ObjectComparator):
  // "5" and "5.0" are the same value, not a new version.
  if (kind === "number") return Number(next) === Number(current);
  return next === current;
}

export interface SetCardPropertyValueInput {
  projectId: number;
  cardNumber: number;
  propertyDefinitionId: number;
  /** The raw value; null or blank clears the property (legacy nullable). */
  value?: string | null;
  actorUserId: number;
}

/**
 * SetCardPropertyValue — sets or clears one property value on a card.
 *
 * DOES: upserts (or deletes, when clearing) the `card_property_values`
 * row with the canonical value, bumps the `cards` row's version and
 * modified stamps, inserts the next `card_versions` row with the full
 * property snapshot (Phase 5's versioning — property history and card
 * history are one trail), and appends a CardPropertyValueSet event,
 * all in one transaction.
 * REJECTS: unknown project, card, or property definition; actor below
 * full team member; a value invalid for the definition's kind
 * (non-numeric for number, unparseable for date, over-long or
 * parenthesis-wrapped text, a non-member or unknown user, a value
 * outside an enumerated definition's list — never silently coerced);
 * or no actual change (same value, or clearing an unset property).
 *
 * @returns the updated card row, or field errors
 */
export function setCardPropertyValue(
  db: BetterSQLite3Database,
  input: SetCardPropertyValueInput,
): CommandResult<CardRow> {
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
  const definition = db
    .select()
    .from(propertyDefinitions)
    .where(
      and(
        eq(propertyDefinitions.projectId, input.projectId),
        eq(propertyDefinitions.id, input.propertyDefinitionId),
      ),
    )
    .get();
  if (!definition) return reject("property", "does not exist");

  const raw = input.value?.trim() || null;
  let canonical: string | null = null;
  if (raw !== null) {
    const result = canonicalValue(db, input.projectId, definition, raw);
    if (!result.ok) return result;
    canonical = result.value;
  }

  const currentRow = db
    .select()
    .from(cardPropertyValues)
    .where(
      and(
        eq(cardPropertyValues.cardId, card.id),
        eq(cardPropertyValues.propertyDefinitionId, definition.id),
      ),
    )
    .get();
  const current = currentRow?.value ?? null;
  if (sameValue(definition.kind as PropertyKind, canonical, current))
    return reject("card", "has no changes to save");

  const cardType = db
    .select({ name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.id, card.cardTypeId))
    .get();

  return db.transaction((tx) => {
    if (canonical === null) {
      tx.delete(cardPropertyValues)
        .where(eq(cardPropertyValues.id, currentRow!.id))
        .run();
    } else if (currentRow) {
      tx.update(cardPropertyValues)
        .set({ value: canonical, updatedAt: new Date() })
        .where(eq(cardPropertyValues.id, currentRow.id))
        .run();
    } else {
      tx.insert(cardPropertyValues)
        .values({
          cardId: card.id,
          propertyDefinitionId: definition.id,
          value: canonical,
        })
        .run();
    }
    const nextVersion = card.version + 1;
    const row = tx
      .update(cards)
      .set({
        version: nextVersion,
        modifiedByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(cards.id, card.id))
      .returning()
      .get();
    tx.insert(cardVersions)
      .values({
        cardId: card.id,
        projectId: input.projectId,
        number: card.number,
        version: nextVersion,
        name: card.name,
        description: card.description,
        cardTypeName: cardType?.name ?? "",
        propertyValues: JSON.stringify(cardPropertySnapshot(tx, card.id)),
        createdByUserId: card.createdByUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    emitEvent(tx, {
      type: "CardPropertyValueSet",
      aggregateType: "Card",
      aggregateId: card.id,
      payload: {
        projectId: input.projectId,
        number: card.number,
        property: definition.name,
        value: canonical,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<CardRow>;
  });
}
