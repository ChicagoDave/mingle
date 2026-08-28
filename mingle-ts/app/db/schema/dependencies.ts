/**
 * Cross-Project Dependencies schema — the `dependencies`,
 * `dependency_resolving_cards` and `dependency_versions` tables
 * (Phase 25).
 *
 * Purpose: persistence shape for a dependency (legacy `Dependency`): a
 * card in one project (the RAISING card) needs something from another
 * project (the RESOLVING project), which answers by linking one or
 * more of its own cards as the resolving cards. The dependency carries
 * its own status lifecycle — NEW until a resolving card is linked,
 * ACCEPTED while cards are linked, RESOLVED once marked done — and its
 * own version trail, appended on every change exactly as
 * `card_versions` is for cards (ADR-0004), with the resolving card
 * numbers snapshotted per version so a version reads the same whether
 * or not the cards still exist.
 *
 * Dependency numbers are GLOBAL, not per project (legacy
 * `dependency_numbers` sequence, shown as `D12`): a dependency lives
 * in two projects at once, so a per-project number would give it two
 * names. Numbers are never reused; the version trail of a deleted
 * dependency keeps its number reserved.
 *
 * Public interface: `dependencies`, `dependencyResolvingCards`,
 * `dependencyVersions` (Drizzle tables) and their row types. Written
 * only through app/domain/dependencies — never from route code.
 *
 * Owner context: Cross-Project Dependencies.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const dependencies = sqliteTable(
  "dependencies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Global, never reused; presented as `D<number>`. */
    number: integer("number").notNull(),
    /** Non-blank (legacy validates_presence_of :name). */
    name: text("name").notNull(),
    description: text("description"),
    /** ISO `YYYY-MM-DD`; required (legacy validates_presence_of :desired_end_date). */
    desiredEndDate: text("desired_end_date").notNull(),
    raisingProjectId: integer("raising_project_id").notNull(),
    /** The raising card's NUMBER in the raising project (legacy stored the number, not the id). */
    raisingCardNumber: integer("raising_card_number").notNull(),
    raisingUserId: integer("raising_user_id").notNull(),
    resolvingProjectId: integer("resolving_project_id").notNull(),
    /** See DEPENDENCY_STATUSES in app/shared/wire-types.ts. Validity enforced in the domain layer. */
    status: text("status").notNull().default("NEW"),
    /** Current version number; the matching dependency_versions row is the latest. */
    version: integer("version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("dependencies_number_unique").on(t.number),
    index("dependencies_raising_idx").on(t.raisingProjectId, t.raisingCardNumber),
    index("dependencies_resolving_idx").on(t.resolvingProjectId),
  ],
);

export type DependencyRow = typeof dependencies.$inferSelect;

export const dependencyResolvingCards = sqliteTable(
  "dependency_resolving_cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    dependencyId: integer("dependency_id").notNull(),
    /** The resolving project at link time (denormalized for the card's own dependency lookups). */
    projectId: integer("project_id").notNull(),
    /** The resolving card's NUMBER in `projectId`. */
    cardNumber: integer("card_number").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // A card resolves a dependency once (legacy link_resolving_cards skipped duplicates).
    uniqueIndex("dependency_resolving_cards_unique").on(t.dependencyId, t.cardNumber),
    index("dependency_resolving_cards_card_idx").on(t.projectId, t.cardNumber),
  ],
);

export type DependencyResolvingCardRow = typeof dependencyResolvingCards.$inferSelect;

export const dependencyVersions = sqliteTable(
  "dependency_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The dependency this version belongs to; the row may no longer exist. */
    dependencyId: integer("dependency_id").notNull(),
    /** The dependency's number, retained so deleted numbers stay reserved. */
    number: integer("number").notNull(),
    /** 1-based, dense per dependency; the deletion version is the last. */
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    desiredEndDate: text("desired_end_date").notNull(),
    raisingProjectId: integer("raising_project_id").notNull(),
    raisingCardNumber: integer("raising_card_number").notNull(),
    raisingUserId: integer("raising_user_id").notNull(),
    resolvingProjectId: integer("resolving_project_id").notNull(),
    status: text("status").notNull(),
    /** JSON array of the resolving card numbers at version time (legacy cloned the resolving cards per version). */
    resolvingCardNumbers: text("resolving_card_numbers").notNull().default("[]"),
    /** True only on the final version appended when the dependency is deleted. */
    isDeletion: integer("is_deletion", { mode: "boolean" }).notNull().default(false),
    modifiedByUserId: integer("modified_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("dependency_versions_version_unique").on(t.dependencyId, t.version),
    index("dependency_versions_dependency_idx").on(t.dependencyId),
    // The history feed reads a project's versions from either side.
    index("dependency_versions_raising_idx").on(t.raisingProjectId),
    index("dependency_versions_resolving_idx").on(t.resolvingProjectId),
  ],
);

export type DependencyVersionRow = typeof dependencyVersions.$inferSelect;
