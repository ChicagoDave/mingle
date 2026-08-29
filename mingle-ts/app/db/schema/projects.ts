/**
 * Card Management schema — the `projects` and `project_variables` tables.
 *
 * Purpose: persistence shape for the Project aggregate and its
 * ProjectVariable value objects (Phase 3). Mirrors the legacy rules:
 * project name is unique case-insensitively, the identifier is a
 * lowercase `[0-9a-z_]` slug unique across the install, and a project
 * variable's name is unique case-insensitively within its project.
 *
 * Public interface: `projects`, `projectVariables` (Drizzle tables).
 * Enforcement of the write rules lives in app/domain/projects — never
 * insert into these tables from route code directly.
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

export const projects = sqliteTable(
  "projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Display name; unique case-insensitively (legacy parity). */
    name: text("name").notNull(),
    /**
     * URL slug: lowercase letters, digits, underscore; max 30 chars;
     * may not start with a digit. Format enforced in the domain layer.
     */
    identifier: text("identifier").notNull().unique(),
    description: text("description"),
    /**
     * JSON array of the strategy kinds this project admits (ADR-0021);
     * "[]" = no constraint. Validity enforced in the domain layer.
     */
    permittedStrategyKinds: text("permitted_strategy_kinds").notNull().default("[]"),
    /** User who created the project (plain id; enforced in the domain layer). */
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Case-insensitive name uniqueness, matching the legacy
    // validates_uniqueness_of :name, :case_sensitive => false.
    uniqueIndex("projects_name_ci_unique").on(sql`lower(${t.name})`),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;

export const projectVariables = sqliteTable(
  "project_variables",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** Display name; unique case-insensitively within the project. */
    name: text("name").notNull(),
    /**
     * Discriminator, one of the legacy ProjectVariable::DATA_TYPES:
     * StringType | NumericType | UserType | DateType | CardType
     * (shared with the client as ProjectVariableDataType in wire-types).
     */
    dataType: text("data_type").notNull(),
    /** The variable's value, stored as text regardless of data type. */
    value: text("value"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Per-project case-insensitive name uniqueness, matching the legacy
    // validates_uniqueness_of :name, :case_sensitive => false, :scope => :project_id.
    uniqueIndex("project_variables_name_ci_unique").on(
      t.projectId,
      sql`lower(${t.name})`,
    ),
    index("project_variables_project_idx").on(t.projectId),
  ],
);

export type ProjectVariableRow = typeof projectVariables.$inferSelect;
