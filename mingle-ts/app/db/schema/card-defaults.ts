/**
 * Card Management schema — the `card_defaults` table (P-2, project
 * templates Phase 1).
 *
 * Purpose: persistence shape for a card type's default property
 * values — legacy `card_defaults` + its `PropertyDefinitionTransitionAction`
 * rows, flattened: one row per card type × property definition holding
 * the value a new card of that type starts with. The value is the
 * property's canonical stored form (see app/db/schema/properties.ts),
 * except that a user-kind default may hold the literal marker
 * `(current user)` (wire-types `CURRENT_USER_MARKER`), resolved to the
 * creating actor when a card is created. Legacy's default description
 * and checklist items are not carried.
 *
 * Public interface: `cardDefaults` (Drizzle table), `CardDefaultRow`.
 * Enforcement of the write rules lives in
 * app/domain/cards/card-defaults.server — never write this table from
 * route code directly.
 *
 * Owner context: Card Management.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const cardDefaults = sqliteTable(
  "card_defaults",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    cardTypeId: integer("card_type_id").notNull(),
    propertyDefinitionId: integer("property_definition_id").notNull(),
    /** Canonical stored value, or the `(current user)` marker for a user property. */
    value: text("value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("card_defaults_unique").on(t.cardTypeId, t.propertyDefinitionId),
    index("card_defaults_project_idx").on(t.projectId),
  ],
);

export type CardDefaultRow = typeof cardDefaults.$inferSelect;
