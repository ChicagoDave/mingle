/**
 * Card Management schema — the `property_definitions`,
 * `enumeration_values`, and `card_property_values` tables.
 *
 * Purpose: persistence shape for managed card properties (Phase 7) —
 * PropertyDefinition with a `kind` discriminator (text | number | date
 * | user | enumerated), the ordered value list of an enumerated
 * definition, and one current-value row per card × definition. Values
 * are stored as text in their canonical stored form: numbers as the
 * validated numeric string, dates as ISO `yyyy-mm-dd`, users as the
 * user id, enumerated as the defined value's exact casing. History is
 * NOT kept here — every property mutation appends a `card_versions`
 * row whose `property_values` column snapshots all values (Phase 5's
 * versioning, not a parallel mechanism).
 *
 * Public interface: `propertyDefinitions`, `enumerationValues`,
 * `cardPropertyValues` (Drizzle tables). Enforcement of the write
 * rules lives in app/domain/cards — never write these tables from
 * route code directly.
 *
 * Owner context: Card Management.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const propertyDefinitions = sqliteTable(
  "property_definitions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** Display name; unique case-insensitively within the project. */
    name: text("name").notNull(),
    /** One of PROPERTY_KINDS (wire-types): text|number|date|user|enumerated. */
    kind: text("kind").notNull(),
    /** Ordering position within the project (appended at definition time). */
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy validates_uniqueness_of :name, scope project, case-insensitive.
    uniqueIndex("property_definitions_name_ci_unique").on(
      t.projectId,
      sql`lower(${t.name})`,
    ),
    index("property_definitions_project_idx").on(t.projectId),
  ],
);

export type PropertyDefinitionRow = typeof propertyDefinitions.$inferSelect;

export const enumerationValues = sqliteTable(
  "enumeration_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    propertyDefinitionId: integer("property_definition_id").notNull(),
    /** The allowed value, stored in its defined casing. */
    value: text("value").notNull(),
    /** 1-based ordering position within the definition (legacy acts_as_list). */
    position: integer("position").notNull(),
  },
  (t) => [
    // Legacy validates_uniqueness_of :value, scope definition, case-insensitive.
    uniqueIndex("enumeration_values_value_ci_unique").on(
      t.propertyDefinitionId,
      sql`lower(${t.value})`,
    ),
    index("enumeration_values_definition_idx").on(t.propertyDefinitionId),
  ],
);

export type EnumerationValueRow = typeof enumerationValues.$inferSelect;

export const cardPropertyValues = sqliteTable(
  "card_property_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cardId: integer("card_id").notNull(),
    propertyDefinitionId: integer("property_definition_id").notNull(),
    /** Canonical stored value (see header). A cleared property has NO row. */
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("card_property_values_unique").on(
      t.cardId,
      t.propertyDefinitionId,
    ),
    index("card_property_values_definition_idx").on(t.propertyDefinitionId),
  ],
);

export type CardPropertyValueRow = typeof cardPropertyValues.$inferSelect;
