/**
 * Card Trees schema — the `tree_configurations`, `tree_card_types` and
 * `tree_belongings` tables (Phase 23).
 *
 * Purpose: persistence shape for a card tree (legacy
 * `TreeConfiguration`): a named, ordered list of card types — Release
 * > Iteration > Story — where every type but the last owns a
 * relationship property (a `property_definitions` row of kind
 * `tree_relationship`, see app/db/schema/properties.ts) that a card
 * lower in the tree carries to name its ancestor of that type. A card
 * is IN a tree when it has a `tree_belongings` row, whatever its
 * relationship values say; a card at the root of the tree is in it
 * with every relationship unset.
 *
 * Legacy kept the type order on the relationship properties'
 * `position`; here it is a table of its own so the last type — which
 * has no relationship — is a row rather than an inference.
 *
 * Public interface: `treeConfigurations`, `treeCardTypes`,
 * `treeBelongings` (Drizzle tables) and their row types. Written only
 * through app/domain/trees — never from route code.
 *
 * Owner context: Card Trees.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const treeConfigurations = sqliteTable(
  "tree_configurations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** Display name; unique case-insensitively within the project (legacy uniq_tree_name_in_project). */
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("tree_configurations_name_ci_unique").on(t.projectId, sql`lower(${t.name})`),
    index("tree_configurations_project_idx").on(t.projectId),
  ],
);

export type TreeConfigurationRow = typeof treeConfigurations.$inferSelect;

export const treeCardTypes = sqliteTable(
  "tree_card_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    treeConfigurationId: integer("tree_configuration_id").notNull(),
    cardTypeId: integer("card_type_id").notNull(),
    /** 0 is the top of the tree; the highest position is the leaf type. */
    position: integer("position").notNull(),
  },
  (t) => [
    // A type appears once per tree, and each level holds one type.
    uniqueIndex("tree_card_types_type_unique").on(t.treeConfigurationId, t.cardTypeId),
    uniqueIndex("tree_card_types_position_unique").on(t.treeConfigurationId, t.position),
  ],
);

export type TreeCardTypeRow = typeof treeCardTypes.$inferSelect;

export const treeBelongings = sqliteTable(
  "tree_belongings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    treeConfigurationId: integer("tree_configuration_id").notNull(),
    cardId: integer("card_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy unique_card_in_tree.
    uniqueIndex("tree_belongings_unique").on(t.treeConfigurationId, t.cardId),
    index("tree_belongings_card_idx").on(t.cardId),
  ],
);

export type TreeBelongingRow = typeof treeBelongings.$inferSelect;
