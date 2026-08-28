/**
 * Program Management schema — the `programs`, `plans`,
 * `program_projects`, `objectives` and `objective_versions` tables
 * (Phase 26).
 *
 * Purpose: persistence shape for the Program aggregate (legacy
 * `Program`, a `Deliverable` like a project) and what hangs off it: its
 * one `Plan` (the timeline window, created with the program), the
 * projects that belong to it (legacy `program_projects`), and its
 * objectives (legacy `Objective`) with the scheduling fields the plan
 * timeline places them by. Objectives carry a version trail appended on
 * every change exactly as cards, pages and dependencies do (ADR-0004),
 * with a final deletion version so a deleted objective stays on record
 * and its number is never reused (legacy `acts_as_versioned_ext
 * :keep_versions_on_destroy => true`).
 *
 * Mirrors the legacy rules: program name unique case-insensitively
 * among programs, identifier a lowercase `[0-9a-z_]` slug unique among
 * programs; one plan per program; a project belongs to a program at
 * most once; objective name unique case-insensitively within its
 * program (max 80), objective number per program and never reused
 * (legacy `program_N_objective_numbers` sequence), identifier
 * generated from the name and unique within the program.
 *
 * Program USER membership is not here — it is Identity & Access
 * (`program_memberships` in membership.ts), so the authorization
 * checkpoint never imports this context.
 *
 * Public interface: `programs`, `plans`, `programProjects`,
 * `objectives`, `objectiveVersions` (Drizzle tables) and their row
 * types. Written only through app/domain/programs — never from route
 * code.
 *
 * Owner context: Program Management.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const programs = sqliteTable(
  "programs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Display name; unique case-insensitively among programs (legacy parity). */
    name: text("name").notNull(),
    /** URL slug: lowercase letters, digits, underscore; max 30; no leading digit. Enforced in the domain layer. */
    identifier: text("identifier").notNull().unique(),
    description: text("description"),
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("programs_name_ci_unique").on(sql`lower(${t.name})`)],
);

export type ProgramRow = typeof programs.$inferSelect;

export const plans = sqliteTable(
  "plans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Exactly one plan per program, created with it (legacy `initialize_plan!`). */
    programId: integer("program_id").notNull(),
    /** ISO `YYYY-MM-DD`; the timeline window start. */
    startAt: text("start_at").notNull(),
    /** ISO `YYYY-MM-DD`; the timeline window end, never before `startAt`. */
    endAt: text("end_at").notNull(),
    /** Decimal places for the plan's numbers (legacy default 2). */
    precision: integer("precision").notNull().default(2),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("plans_program_unique").on(t.programId)],
);

export type PlanRow = typeof plans.$inferSelect;

export const programProjects = sqliteTable(
  "program_projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    programId: integer("program_id").notNull(),
    projectId: integer("project_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // A project belongs to a given program at most once.
    uniqueIndex("program_projects_unique").on(t.programId, t.projectId),
    index("program_projects_project_idx").on(t.projectId),
  ],
);

export type ProgramProjectRow = typeof programProjects.$inferSelect;

export const objectives = sqliteTable(
  "objectives",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    programId: integer("program_id").notNull(),
    /** Per-program, never reused; the next is one past the highest ever used in the program. */
    number: integer("number").notNull(),
    /** Non-blank, max 80, unique case-insensitively within the program. */
    name: text("name").notNull(),
    /** Generated from the name (legacy `generate_identifier`); unique within the program. */
    identifier: text("identifier").notNull(),
    /** Free text describing the objective's value. Stored and rendered as plain text in this phase. */
    valueStatement: text("value_statement"),
    /** ISO `YYYY-MM-DD`; required while PLANNED. */
    startAt: text("start_at"),
    /** ISO `YYYY-MM-DD`; required while PLANNED, never before `startAt`. */
    endAt: text("end_at"),
    /** Row on the plan timeline (legacy 1..TIMELINE_ROWS, middle = 6). */
    verticalPosition: integer("vertical_position").notNull().default(6),
    size: integer("size").notNull().default(0),
    value: integer("value").notNull().default(0),
    /** See OBJECTIVE_STATUSES in app/shared/wire-types.ts. */
    status: text("status").notNull().default("PLANNED"),
    /** 1-based, dense within the program's objectives of the same status; a new objective takes 1. */
    position: integer("position").notNull(),
    /** Current version number; the matching objective_versions row is the latest. */
    version: integer("version").notNull(),
    modifiedByUserId: integer("modified_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("objectives_number_unique").on(t.programId, t.number),
    uniqueIndex("objectives_name_ci_unique").on(t.programId, sql`lower(${t.name})`),
    uniqueIndex("objectives_identifier_unique").on(t.programId, t.identifier),
    index("objectives_program_status_idx").on(t.programId, t.status, t.position),
  ],
);

export type ObjectiveRow = typeof objectives.$inferSelect;

export const objectiveVersions = sqliteTable(
  "objective_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The objective this version belongs to; the row may no longer exist. */
    objectiveId: integer("objective_id").notNull(),
    programId: integer("program_id").notNull(),
    /** The objective's number, retained so deleted numbers stay reserved. */
    number: integer("number").notNull(),
    /** 1-based, dense per objective; the deletion version is the last. */
    version: integer("version").notNull(),
    name: text("name").notNull(),
    identifier: text("identifier").notNull(),
    valueStatement: text("value_statement"),
    startAt: text("start_at"),
    endAt: text("end_at"),
    verticalPosition: integer("vertical_position").notNull(),
    size: integer("size").notNull(),
    value: integer("value").notNull(),
    status: text("status").notNull(),
    position: integer("position").notNull(),
    /** True only on the final version appended when the objective is deleted. */
    isDeletion: integer("is_deletion", { mode: "boolean" }).notNull().default(false),
    modifiedByUserId: integer("modified_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("objective_versions_version_unique").on(t.objectiveId, t.version),
    index("objective_versions_objective_idx").on(t.objectiveId),
    index("objective_versions_program_idx").on(t.programId),
  ],
);

export type ObjectiveVersionRow = typeof objectiveVersions.$inferSelect;
