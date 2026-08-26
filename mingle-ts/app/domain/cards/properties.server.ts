/**
 * Card Management command handlers — managed card properties (Phase 7)
 * and formula properties (Phase 8).
 *
 * Purpose: the only write path for property definitions, their
 * enumeration values, and card property values. Definitions carry a
 * `kind` discriminator (text | number | date | user | enumerated |
 * formula); values are validated per kind against the legacy rules
 * (property_definition.rb, property_type.rb, enumeration_value.rb,
 * user_property_definition.rb) and never silently coerced. Formula
 * definitions are compiled (parse + type-check) at definition time via
 * the formula engine; their values are materialized into
 * `card_property_values`, recomputed inside the same transaction as
 * any input change (so the version snapshot carries the fresh value,
 * matching legacy's same-save recomputation), and can never be set
 * directly. Every value mutation appends the card's next
 * `card_versions` row (Phase 5's versioning — INSERT only, never
 * update or delete a version) with the full property snapshot, and
 * emits a past-tense event — or rejects (rule 10).
 *
 * Commands → events:
 *   DefinePropertyDefinition   → PropertyDefinitionDefined
 *   SetCardPropertyValue       → CardPropertyValueSet (+ next card version)
 *   SetPropertyTransitionOnly  → PropertyDefinitionTransitionOnlySet
 *
 * Public interface: `definePropertyDefinition`, `setCardPropertyValue`,
 * `setPropertyTransitionOnly`,
 * `cardPropertySnapshot` (read helper reused by the card commands'
 * version inserts), and — for sibling Card Management commands that
 * set several properties in ONE card version (transitions.server.ts) —
 * `canonicalPropertyValue`, `samePropertyValue`, and
 * `appendPropertyValueChanges`. Those three keep this module the only
 * writer of `card_property_values`: callers validate through
 * `canonicalPropertyValue`, then hand the changes to
 * `appendPropertyValueChanges` inside their own transaction.
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
import { compileFormula } from "~/domain/cards/formula.server";
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

/**
 * Recomputes and re-materializes every formula property value for one
 * card, inside the caller's transaction. Called after any input value
 * changes (before the version snapshot, so the snapshot carries the
 * fresh values) and to backfill when a formula is defined.
 *
 * @param db - the transaction the surrounding command is using
 * @param projectId - the card's project
 * @param cardId - the card to recompute
 */
function recomputeCardFormulas(
  db: BetterSQLite3Database,
  projectId: number,
  cardId: number,
): void {
  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, projectId))
    .all();
  const formulas = definitions.filter((d) => d.kind === "formula");
  if (formulas.length === 0) return;
  const currentRows = db
    .select()
    .from(cardPropertyValues)
    .where(eq(cardPropertyValues.cardId, cardId))
    .all();
  const values = new Map(
    currentRows.map((row) => [row.propertyDefinitionId, row.value]),
  );
  for (const definition of formulas) {
    // Compile always succeeds here: the definition was validated at
    // definition time and inputs cannot be formulas themselves.
    const compiled = compileFormula(
      definition.formula ?? "",
      definitions,
      definition.nullIsZero,
    );
    if (!compiled.ok) continue;
    const next = compiled.formula.evaluate(values);
    const currentRow = currentRows.find(
      (row) => row.propertyDefinitionId === definition.id,
    );
    if (next === null) {
      if (currentRow)
        db.delete(cardPropertyValues)
          .where(eq(cardPropertyValues.id, currentRow.id))
          .run();
    } else if (currentRow) {
      if (currentRow.value !== next)
        db.update(cardPropertyValues)
          .set({ value: next, updatedAt: new Date() })
          .where(eq(cardPropertyValues.id, currentRow.id))
          .run();
    } else {
      db.insert(cardPropertyValues)
        .values({ cardId, propertyDefinitionId: definition.id, value: next })
        .run();
    }
  }
}

export interface DefinePropertyDefinitionInput {
  projectId: number;
  name: string;
  kind: string;
  /** Allowed values, in order — enumerated kind only. */
  values?: string[];
  /** The formula expression — formula kind only. */
  formula?: string | null;
  /** Evaluate unset numeric inputs as 0 — formula kind only. */
  nullIsZero?: boolean;
  /**
   * Restrict the property to transition execution (legacy
   * `transition_only`): a non-admin may not set it directly. Not
   * allowed on the formula kind, which is never set directly by anyone.
   */
  transitionOnly?: boolean;
  actorUserId: number;
}

/**
 * DefinePropertyDefinition — adds a managed or formula property to a
 * project.
 *
 * DOES: inserts a `property_definitions` row (position appended at the
 * end) plus, for the enumerated kind, one ordered `enumeration_values`
 * row per supplied value; for the formula kind, compiles the formula
 * (parse + type-check against the project's existing definitions) and
 * backfills the computed value into `card_property_values` for every
 * existing card in the project (no version rows appended — introducing
 * derived data is not a card edit); appends a PropertyDefinitionDefined
 * event, all in one transaction.
 * REJECTS: unknown project, actor below project administrator (legacy:
 * property management is PROJECT_ADMIN), invalid name (blank, over 40
 * chars, containing []"&=#; characters, '_', a reserved predefined
 * name, or taken case-insensitively in the project), unknown kind,
 * values supplied for a non-enumerated kind, an invalid enumeration
 * value (blank, over 255 chars, parenthesis-wrapped, or a
 * case-insensitive duplicate within the list), formula/nullIsZero
 * supplied for a non-formula kind, transitionOnly supplied for the
 * formula kind (a calculated property is never set directly, so
 * restricting it to transitions is meaningless), or — at definition
 * time, never at
 * evaluation time — a formula that is blank, malformed, references an
 * unknown/non-numeric/non-date property or another formula property,
 * or combines types illegally (date+date, number-date, date in * or /,
 * negated date).
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
  if (kind === "formula" && input.transitionOnly)
    return reject(
      "transitionOnly",
      "is not available for a formula property, which is never set directly",
    );
  if (kind !== "formula" && (input.formula?.trim() || input.nullIsZero))
    return reject("formula", "is only allowed for a formula property");
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

  const formulaText = input.formula?.trim() || null;
  if (kind === "formula") {
    const existing = db
      .select({
        id: propertyDefinitions.id,
        name: propertyDefinitions.name,
        kind: propertyDefinitions.kind,
      })
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.projectId, input.projectId))
      .all();
    const compiled = compileFormula(
      formulaText ?? "",
      existing,
      input.nullIsZero ?? false,
    );
    if (!compiled.ok) return { ok: false, errors: { formula: compiled.errors } };
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
        formula: kind === "formula" ? formulaText : null,
        nullIsZero: kind === "formula" ? (input.nullIsZero ?? false) : false,
        transitionOnly: kind === "formula" ? false : (input.transitionOnly ?? false),
      })
      .returning()
      .get();
    values.forEach((value, i) => {
      tx.insert(enumerationValues)
        .values({ propertyDefinitionId: row.id, value, position: i + 1 })
        .run();
    });
    if (kind === "formula") {
      // Backfill the computed value for every existing card so the new
      // property is immediately readable (legacy update_all_cards intent,
      // minus its version churn — see the header's rationale).
      const cardRows = tx
        .select({ id: cards.id })
        .from(cards)
        .where(eq(cards.projectId, input.projectId))
        .all();
      for (const card of cardRows)
        recomputeCardFormulas(tx, input.projectId, card.id);
    }
    emitEvent(tx, {
      type: "PropertyDefinitionDefined",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload:
        kind === "formula"
          ? { name: row.name, kind, formula: formulaText }
          : { name: row.name, kind, values },
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
/**
 * Validates a raw (non-blank, trimmed) value against a property
 * definition's kind and returns its canonical stored form — numbers as
 * the validated numeric string, dates as ISO yyyy-mm-dd, users as the
 * member's id, enumerated values in their defined casing. Never
 * coerces: an invalid value is a rejection keyed on "value" naming the
 * property.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project (user values must be team members)
 * @param definition - the property definition the value is for
 * @param raw - the trimmed, non-empty input value
 * @returns the canonical stored value, or field errors
 */
export function canonicalPropertyValue(
  db: BetterSQLite3Database,
  projectId: number,
  definition: PropertyDefinitionRow,
  raw: string,
): CommandResult<string> {
  switch (definition.kind as PropertyKind) {
    case "formula":
      // Callers reject formula kinds before validating a value; kept as
      // a guard so a formula can never be given a stored value.
      return reject(
        "property",
        `${definition.name} is a formula property and cannot be set directly`,
      );
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

/**
 * True when a new and a current stored value are the same property value
 * for the kind — numbers compare numerically ("5" and "5.0" are one
 * value, legacy NumericType ObjectComparator), everything else exactly;
 * null means unset.
 *
 * @param kind - the property's kind
 * @param next - the proposed canonical value, null to clear
 * @param current - the stored canonical value, null when unset
 */
export function samePropertyValue(
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
 * After the value change and before the snapshot, every formula
 * property of the project is recomputed for this card in the same
 * transaction, so the version records the derived values as they stood
 * after the change (legacy same-save recomputation).
 * REJECTS: unknown project, card, or property definition; a formula
 * property (calculated — never set directly); actor below full team
 * member; a value invalid for the definition's kind (non-numeric for
 * number, unparseable for date, over-long or parenthesis-wrapped text,
 * a non-member or unknown user, a value outside an enumerated
 * definition's list — never silently coerced); no actual change
 * (same value, or clearing an unset property); or a real change to a
 * transition-only property attempted by anyone below project
 * administrator ("<name>: is a transition only property." — such a
 * property changes only by executing a transition, Phase 15).
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
  if (samePropertyValue(definition.kind as PropertyKind, canonical, current))
    return reject("card", "has no changes to save");
  // Legacy transition_only_for_updating_card?: a transition-only
  // property refuses a direct change, but only for a non-admin and only
  // when the value would actually change (checked just above). The
  // transition path writes through appendPropertyValueChanges and never
  // reaches this guard.
  if (
    definition.transitionOnly &&
    authorizeProjectAction(
      db,
      input.actorUserId,
      input.projectId,
      PrivilegeLevel.PROJECT_ADMIN,
    ) !== null
  )
    return reject("property", `${definition.name}: is a transition only property.`);

  return db.transaction((tx) => {
    const row = appendPropertyValueChanges(
      tx,
      input.projectId,
      card,
      [{ definition, value: canonical }],
      input.actorUserId,
    );
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

export interface SetPropertyTransitionOnlyInput {
  projectId: number;
  propertyDefinitionId: number;
  transitionOnly: boolean;
  actorUserId: number;
}

/**
 * SetPropertyTransitionOnly — turns a property's transition-only
 * restriction on or off.
 *
 * DOES: updates the `property_definitions` row's `transition_only`
 * column and its modified stamp, and appends a
 * PropertyDefinitionTransitionOnlySet event. Existing card values are
 * untouched — the flag governs future writes, not the current state, so
 * no card version is appended.
 * WHEN: an existing project's admin flips the flag on one of its
 * non-formula properties to a value it does not already hold.
 * BECAUSE: a property becomes a workflow's state well after it was
 * created — usually at the moment its transitions are generated — so
 * the restriction has to be settable on a property that already exists
 * and already has values on cards.
 * REJECTS: unknown project or property; actor below project
 * administrator; a formula property (never set directly by anyone, so
 * the restriction would mean nothing); and a no-op change ("has no
 * changes to save").
 *
 * @param db - the Drizzle handle
 * @param input - the property, the new flag value, and the actor
 * @returns the updated definition row, or field errors
 */
export function setPropertyTransitionOnly(
  db: BetterSQLite3Database,
  input: SetPropertyTransitionOnlyInput,
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
  if (definition.kind === "formula")
    return reject(
      "property",
      `${definition.name} is a formula property and is never set directly`,
    );
  if (definition.transitionOnly === input.transitionOnly)
    return reject("property", "has no changes to save");

  return db.transaction((tx) => {
    const row = tx
      .update(propertyDefinitions)
      .set({ transitionOnly: input.transitionOnly, updatedAt: new Date() })
      .where(eq(propertyDefinitions.id, definition.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: "PropertyDefinitionTransitionOnlySet",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: {
        projectId: input.projectId,
        property: row.name,
        transitionOnly: row.transitionOnly,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<PropertyDefinitionRow>;
  });
}

/** One property value change to apply: the canonical value, or null to clear. */
export interface PropertyValueChange {
  definition: PropertyDefinitionRow;
  value: string | null;
}

/**
 * Applies a set of already-validated property value changes to a card as
 * ONE new card version, inside the caller's transaction: upserts (or
 * deletes, when clearing) each `card_property_values` row, recomputes
 * the project's formula properties for the card, bumps the `cards`
 * row's version and modified stamps, and inserts the next
 * `card_versions` row with the full property snapshot. Emits no event —
 * the calling command emits its own, so the trail names the command
 * that caused the version (CardPropertyValueSet, TransitionExecuted).
 *
 * Callers must have validated every value through
 * `canonicalPropertyValue` and dropped no-op changes with
 * `samePropertyValue`; this function trusts its input and always
 * appends a version.
 *
 * @param tx - the transaction the surrounding command is using
 * @param projectId - the card's project
 * @param card - the card row as loaded before the change
 * @param changes - the canonical changes, at most one per definition
 * @param actorUserId - the user recorded as the version's modifier
 * @returns the updated card row
 */
export function appendPropertyValueChanges(
  tx: BetterSQLite3Database,
  projectId: number,
  card: CardRow,
  changes: PropertyValueChange[],
  actorUserId: number,
): CardRow {
  const currentRows = tx
    .select()
    .from(cardPropertyValues)
    .where(eq(cardPropertyValues.cardId, card.id))
    .all();
  for (const { definition, value } of changes) {
    const currentRow = currentRows.find(
      (row) => row.propertyDefinitionId === definition.id,
    );
    if (value === null) {
      if (currentRow)
        tx.delete(cardPropertyValues)
          .where(eq(cardPropertyValues.id, currentRow.id))
          .run();
    } else if (currentRow) {
      tx.update(cardPropertyValues)
        .set({ value, updatedAt: new Date() })
        .where(eq(cardPropertyValues.id, currentRow.id))
        .run();
    } else {
      tx.insert(cardPropertyValues)
        .values({ cardId: card.id, propertyDefinitionId: definition.id, value })
        .run();
    }
  }
  recomputeCardFormulas(tx, projectId, card.id);
  const cardType = tx
    .select({ name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.id, card.cardTypeId))
    .get();
  const nextVersion = card.version + 1;
  const row = tx
    .update(cards)
    .set({
      version: nextVersion,
      modifiedByUserId: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(cards.id, card.id))
    .returning()
    .get();
  tx.insert(cardVersions)
    .values({
      cardId: card.id,
      projectId,
      number: card.number,
      version: nextVersion,
      name: card.name,
      description: card.description,
      cardTypeName: cardType?.name ?? "",
      propertyValues: JSON.stringify(cardPropertySnapshot(tx, card.id)),
      createdByUserId: card.createdByUserId,
      modifiedByUserId: actorUserId,
    })
    .run();
  return row;
}
