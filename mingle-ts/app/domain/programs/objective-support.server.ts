/**
 * Program Management — persistence primitives shared by the objective
 * commands (Phase 27; extracted from Phase 26's objectives module).
 *
 * Purpose: the rules every objective command upholds regardless of
 * status — the per-program never-reused number sequence, the
 * name-derived identifier, name and estimate validation, the version
 * trail append, and dense positioning within a status group (legacy
 * `default_to_top_position` / `update_positions`). PLANNED commands
 * (objectives.server.ts) and BACKLOG commands (backlog.server.ts) both
 * compose these; neither imports the other.
 *
 * Public interface: `NAME_MAX_LENGTH`, `programExists`,
 * `findObjective`, `nextObjectiveNumber`, `objectiveIdentifier`,
 * `squish`, `nameError`, `estimateError`, `appendVersion`,
 * `shiftGroupDown`, `compactGroupAfter`. Every function takes the
 * Drizzle handle (or the caller's transaction) as a parameter.
 *
 * Owner context: Program Management.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { objectives, objectiveVersions, programs, type ObjectiveRow } from "~/db/schema/programs";
import { generateIdentifier } from "~/domain/identifiable.server";
import type { ObjectiveStatus } from "~/shared/wire-types";

/** Legacy validates_length_of :name, :maximum => 80. */
export const NAME_MAX_LENGTH = 80;

/** Whether a program row with this id exists. */
export function programExists(db: BetterSQLite3Database, programId: number): boolean {
  return Boolean(db.select({ id: programs.id }).from(programs).where(eq(programs.id, programId)).get());
}

/** The objective with this number in the program, if it still exists. */
export function findObjective(db: BetterSQLite3Database, programId: number, number: number): ObjectiveRow | undefined {
  return db
    .select()
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.number, number)))
    .get();
}

/**
 * The next objective number in a program: one past the highest ever
 * used across live objectives and the trails of deleted ones — never
 * reused (legacy `program_N_objective_numbers` table sequence).
 */
export function nextObjectiveNumber(db: BetterSQLite3Database, programId: number): number {
  const row = db.get<{ highest: number }>(sql`
    SELECT COALESCE(MAX(number), 0) AS highest FROM (
      SELECT number FROM ${objectives} WHERE program_id = ${programId}
      UNION ALL
      SELECT number FROM ${objectiveVersions} WHERE program_id = ${programId}
    )`);
  return (row?.highest ?? 0) + 1;
}

/** Derives an identifier unique among the program's live objectives (legacy `Objective#unique`). */
export function objectiveIdentifier(
  db: BetterSQLite3Database,
  programId: number,
  name: string,
  excludeObjectiveId?: number,
): string {
  return generateIdentifier(
    name,
    (candidate) => {
      const taken = db
        .select({ id: objectives.id })
        .from(objectives)
        .where(and(eq(objectives.programId, programId), eq(objectives.identifier, candidate)))
        .get();
      return Boolean(taken) && taken!.id !== excludeObjectiveId;
    },
    { digitPrefix: "objective_", fallback: "objective" },
  );
}

/** Legacy auto_strip_attributes squish: trimmed, inner whitespace collapsed. */
export function squish(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Validates an already-squished objective name: non-blank, at most
 * NAME_MAX_LENGTH, unused case-insensitively in the program across
 * both statuses (legacy validated a backlog name against the plan and
 * vice versa). `excludeObjectiveId` lets an objective keep its own name.
 *
 * @returns the legacy-phrased error, or null when the name is acceptable
 */
export function nameError(
  db: BetterSQLite3Database,
  programId: number,
  name: string,
  excludeObjectiveId?: number,
): string | null {
  if (!name) return "can't be blank";
  if (name.length > NAME_MAX_LENGTH) return `is too long (maximum is ${NAME_MAX_LENGTH} characters)`;
  const taken = db
    .select({ id: objectives.id })
    .from(objectives)
    .where(and(eq(objectives.programId, programId), sql`lower(${objectives.name}) = ${name.toLowerCase()}`))
    .get();
  if (taken && taken.id !== excludeObjectiveId) return "already used for an existing Objective in your Program.";
  return null;
}

/** Validates a size or value estimate: a whole number of 0 or more. */
export function estimateError(estimate: number): string | null {
  return Number.isInteger(estimate) && estimate >= 0 ? null : "must be a whole number of 0 or more";
}

/**
 * Appends the next version from the CURRENT row, bumping the row's
 * version and modifier unless it is the deletion version.
 *
 * @returns the objective row as stored after the bump
 */
export function appendVersion(
  tx: BetterSQLite3Database,
  objective: ObjectiveRow,
  actorUserId: number,
  options: { isDeletion?: boolean } = {},
): ObjectiveRow {
  const nextVersion = objective.version + 1;
  const current = options.isDeletion
    ? objective
    : tx
        .update(objectives)
        .set({ version: nextVersion, modifiedByUserId: actorUserId, updatedAt: new Date() })
        .where(eq(objectives.id, objective.id))
        .returning()
        .get();
  tx.insert(objectiveVersions)
    .values({
      objectiveId: current.id,
      programId: current.programId,
      number: current.number,
      version: nextVersion,
      name: current.name,
      identifier: current.identifier,
      valueStatement: current.valueStatement,
      startAt: current.startAt,
      endAt: current.endAt,
      verticalPosition: current.verticalPosition,
      size: current.size,
      value: current.value,
      status: current.status,
      position: current.position,
      isDeletion: options.isDeletion ?? false,
      modifiedByUserId: actorUserId,
    })
    .run();
  return current;
}

/** Makes room at position 1 in a status group (legacy `default_to_top_position`). */
export function shiftGroupDown(tx: BetterSQLite3Database, programId: number, status: ObjectiveStatus): void {
  tx.update(objectives)
    .set({ position: sql`${objectives.position} + 1` })
    .where(and(eq(objectives.programId, programId), eq(objectives.status, status)))
    .run();
}

/** Closes the gap left at `position` in a status group (legacy `update_positions`). */
export function compactGroupAfter(
  tx: BetterSQLite3Database,
  programId: number,
  status: ObjectiveStatus,
  position: number,
): void {
  tx.update(objectives)
    .set({ position: sql`${objectives.position} - 1` })
    .where(
      and(eq(objectives.programId, programId), eq(objectives.status, status), gt(objectives.position, position)),
    )
    .run();
}
