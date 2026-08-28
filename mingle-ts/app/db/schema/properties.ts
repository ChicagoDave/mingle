/**
 * Card Management schema — the `property_definitions`,
 * `enumeration_values`, and `card_property_values` tables.
 *
 * Purpose: persistence shape for managed card properties (Phase 7),
 * formula properties (Phase 8), tree relationships (Phase 23) and
 * aggregate properties (Phase 24) — PropertyDefinition with a `kind`
 * discriminator (text | number | date | user | enumerated | formula |
 * tree_relationship | aggregate), the ordered value list of an
 * enumerated definition, and one current-value row per card ×
 * definition. Values are stored as text in their canonical stored
 * form: numbers as the validated numeric string, dates as ISO
 * `yyyy-mm-dd`, users as the user id, enumerated as the defined
 * value's exact casing. Formula and aggregate values are materialized
 * here too (recomputed by the domain layer whenever an input changes —
 * never written directly); an aggregate's refresh on its holder card
 * appends NO card version (legacy `bypass_versioning`) — the version
 * trail records user edits, and a descendant's edit is not an edit of
 * its ancestor. A definition may be marked
 * `transition_only` (Phase 15), which moves its only write path from
 * `setCardPropertyValue` to a transition execution. History is
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
    /**
     * One of PROPERTY_KINDS (wire-types): text|number|date|user|
     * enumerated|formula|tree_relationship|aggregate. tree_relationship
     * is created only by configuring a card tree (Phase 23): its value
     * is the NUMBER of the ancestor card of `valid_card_type_id` this
     * card sits under. aggregate (Phase 24) is defined on a tree for one
     * of its non-leaf card types: its value on a card of that type is
     * SUM/AVG/MIN/MAX of a numeric target property, or COUNT, over the
     * card's member descendants in the tree (legacy
     * AggregatePropertyDefinition).
     */
    kind: text("kind").notNull(),
    /** tree_relationship and aggregate kinds: the tree this definition belongs to. */
    treeConfigurationId: integer("tree_configuration_id"),
    /**
     * tree_relationship kind only: the card type a value must be — the
     * property "Release" on a Story holds a Release card's number.
     */
    validCardTypeId: integer("valid_card_type_id"),
    /** aggregate kind only: one of AGGREGATE_TYPES (wire-types) — sum|avg|min|max|count. */
    aggregateType: text("aggregate_type"),
    /**
     * aggregate kind only: the numeric property summed/averaged/etc.
     * over the descendants; null for count (legacy aggregate_target_id).
     */
    aggregateTargetId: integer("aggregate_target_id"),
    /**
     * aggregate kind only: the card type whose cards CARRY the value —
     * a non-leaf level of the tree (legacy aggregate_card_type_id).
     */
    aggregateCardTypeId: integer("aggregate_card_type_id"),
    /**
     * aggregate kind only: restrict the aggregated descendants to one
     * card type below the holder's level; null means all descendants
     * (legacy aggregate_scope_card_type_id / AggregateScope).
     */
    aggregateScopeCardTypeId: integer("aggregate_scope_card_type_id"),
    /**
     * aggregate kind only: an optional MQL condition (conditions only,
     * no TODAY / CURRENT USER / THIS CARD) a descendant must satisfy to
     * be aggregated; re-parsed at computation time, so a definition
     * that no longer parses evaluates as unset rather than failing the
     * edit that triggered it (legacy aggregate_condition).
     */
    aggregateCondition: text("aggregate_condition"),
    /**
     * The formula expression text — formula kind only, null otherwise.
     * Validated (parse + type-check) at definition time; references
     * other properties by NAME (legacy parity — a future property
     * rename command must rewrite these texts, mirroring
     * formula_property_definition.rb#rename_property).
     */
    formula: text("formula"),
    /**
     * Formula kind only: when true, an unset numeric input evaluates
     * as 0 instead of making the result unset (legacy null_is_zero).
     */
    nullIsZero: integer("null_is_zero", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * When true the property may only be changed by executing a
     * transition, never by setting it directly (legacy
     * `transition_only`, migration 059). A project admin bypasses the
     * restriction; everyone else's attempt to set it is routed to the
     * matching transition instead (Phase 15 auto-transitions).
     */
    transitionOnly: integer("transition_only", { mode: "boolean" })
      .notNull()
      .default(false),
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
