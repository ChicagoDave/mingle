/**
 * Identity & Access schema — the `team_memberships`, `groups`,
 * `group_memberships` and `program_memberships` tables.
 *
 * Purpose: persistence shape for project team membership and roles
 * (Phase 4) and program membership and roles (Phase 26). Mirrors the
 * legacy rules: one role per user per project or program (legacy
 * `member_roles.permission`, which served both deliverable types),
 * group names unique case-insensitively within a project, non-blank,
 * and comma-free, and one membership row per user per group. Deviation from legacy noted:
 * the original modeled the team itself as an internal `Group`
 * (`groups.internal = true`); here team membership is its own table per
 * the plan, so `groups` holds user-defined groups only and needs no
 * `internal` flag.
 *
 * Public interface: `teamMemberships`, `groups`, `groupMemberships`,
 * `programMemberships` (Drizzle tables). Enforcement of the write rules
 * lives in app/domain/identity — never insert into these tables from
 * route code directly.
 *
 * Owner context: Identity & Access.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const teamMemberships = sqliteTable(
  "team_memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    userId: integer("user_id").notNull(),
    /**
     * The member's role: one of PROJECT_ROLES in wire-types
     * (project_admin | full_member | readonly_member), stored as the
     * legacy `member_roles.permission` string. Validity enforced in the
     * domain layer.
     */
    role: text("role").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // One role per user per project (legacy validates_uniqueness_of
    // :user_id scoped to the deliverable).
    uniqueIndex("team_memberships_user_unique").on(t.projectId, t.userId),
    index("team_memberships_project_idx").on(t.projectId),
    index("team_memberships_user_idx").on(t.userId),
  ],
);

export type TeamMembershipRow = typeof teamMemberships.$inferSelect;

export const groups = sqliteTable(
  "groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /**
     * Display name; unique case-insensitively within the project,
     * non-blank, and may not contain a comma (legacy group.rb rules,
     * enforced in the domain layer).
     */
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Per-project case-insensitive name uniqueness, matching the legacy
    // validates_uniqueness_of :name, :scope => :deliverable_id, :case_sensitive => false.
    uniqueIndex("groups_name_ci_unique").on(t.projectId, sql`lower(${t.name})`),
    index("groups_project_idx").on(t.projectId),
  ],
);

export type GroupRow = typeof groups.$inferSelect;

export const groupMemberships = sqliteTable(
  "group_memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    groupId: integer("group_id").notNull(),
    userId: integer("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // One membership row per user per group (legacy
    // validates_uniqueness_of :user_id, :scope => [:group_id]).
    uniqueIndex("group_memberships_user_unique").on(t.groupId, t.userId),
    index("group_memberships_group_idx").on(t.groupId),
    index("group_memberships_user_idx").on(t.userId),
  ],
);

export type GroupMembershipRow = typeof groupMemberships.$inferSelect;

export const programMemberships = sqliteTable(
  "program_memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    programId: integer("program_id").notNull(),
    userId: integer("user_id").notNull(),
    /**
     * The member's role: one of PROGRAM_ROLES in wire-types
     * (program_admin | program_member), stored as the legacy
     * `member_roles.permission` string. Validity enforced in the
     * domain layer.
     */
    role: text("role").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // One role per user per program (legacy idx_unique_member_roles).
    uniqueIndex("program_memberships_user_unique").on(t.programId, t.userId),
    index("program_memberships_program_idx").on(t.programId),
    index("program_memberships_user_idx").on(t.userId),
  ],
);

export type ProgramMembershipRow = typeof programMemberships.$inferSelect;
