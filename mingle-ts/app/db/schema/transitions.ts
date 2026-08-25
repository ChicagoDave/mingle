/**
 * Card Management schema — the `transitions`, `transition_prerequisites`,
 * and `transition_actions` tables (Phase 14).
 *
 * Purpose: persistence shape for a Transition — a named, project-scoped
 * workflow step that, when its prerequisites hold for a card, sets a
 * fixed group of property values on it in one card version. Modeled on
 * the legacy tables of the same names with two deliberate
 * modernizations: legacy's STI `type` column on prerequisites
 * (HasSpecificValue | HasSetValue | IsUser | InGroup) becomes a `kind`
 * discriminator with the same four meanings, and legacy's polymorphic
 * `executor_id/executor_type` on actions (transitions and, later,
 * transition workflows both own actions) becomes a plain
 * `transition_id` — Phase 15's workflows generate transitions rather
 * than owning actions of their own. Actions carry an `input_mode`
 * instead of legacy's UserInputRequired/UserInputOptional subclasses.
 *
 * Not carried in this phase (nullable ALTERs when their phases land):
 * `require_comment` (comments arrive with Phase 20), project-variable
 * bindings on prerequisites/actions (`project_variable_id`,
 * `variable_binding_id`), and tree-belonging actions (Phase 23).
 *
 * Public interface: `transitions`, `transitionPrerequisites`,
 * `transitionActions` (Drizzle tables). Enforcement of the write rules
 * lives in app/domain/cards/transitions.server.ts — never write these
 * tables from route code directly.
 *
 * Owner context: Card Management (workflow).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const transitions = sqliteTable(
  "transitions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** Display name; non-blank, unique case-insensitively within the project. */
    name: text("name").notNull(),
    /**
     * Restricts the transition to cards of this type; null means it
     * applies to cards of any type (legacy `card_type_id` nullable).
     */
    cardTypeId: integer("card_type_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Legacy validates_uniqueness_of :name, scope project, case-insensitive.
    uniqueIndex("transitions_name_ci_unique").on(
      t.projectId,
      sql`lower(${t.name})`,
    ),
    index("transitions_project_idx").on(t.projectId),
  ],
);

export type TransitionRow = typeof transitions.$inferSelect;

export const transitionPrerequisites = sqliteTable(
  "transition_prerequisites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transitionId: integer("transition_id").notNull(),
    /**
     * One of TRANSITION_PREREQUISITE_KINDS (wire-types):
     * has_specific_value | has_set_value | is_user | in_group.
     * Property kinds AND together; user/group kinds OR together and
     * then AND with the property kinds (legacy prerequisites_collection).
     */
    kind: text("kind").notNull(),
    /** has_specific_value / has_set_value: the property inspected. */
    propertyDefinitionId: integer("property_definition_id"),
    /** has_specific_value: the required canonical stored value. */
    value: text("value"),
    /** is_user: the team member who may execute the transition. */
    userId: integer("user_id"),
    /** in_group: the group whose members may execute the transition. */
    groupId: integer("group_id"),
  },
  (t) => [
    index("transition_prerequisites_transition_idx").on(t.transitionId),
    index("transition_prerequisites_definition_idx").on(
      t.propertyDefinitionId,
    ),
  ],
);

export type TransitionPrerequisiteRow =
  typeof transitionPrerequisites.$inferSelect;

export const transitionActions = sqliteTable(
  "transition_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transitionId: integer("transition_id").notNull(),
    /** The property this action sets; one action per property per transition. */
    propertyDefinitionId: integer("property_definition_id").notNull(),
    /**
     * One of TRANSITION_ACTION_INPUT_MODES (wire-types): fixed sets
     * `value`; user_input_required / user_input_optional take the value
     * from the executing user (legacy "(user input - required)" and
     * "(user input - optional)" special values).
     */
    inputMode: text("input_mode").notNull().default("fixed"),
    /** fixed mode: the canonical stored value to set; null clears the property. */
    value: text("value"),
  },
  (t) => [
    uniqueIndex("transition_actions_property_unique").on(
      t.transitionId,
      t.propertyDefinitionId,
    ),
    index("transition_actions_definition_idx").on(t.propertyDefinitionId),
  ],
);

export type TransitionActionRow = typeof transitionActions.$inferSelect;
