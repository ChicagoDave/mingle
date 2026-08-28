/**
 * Program Management command handlers — Objectives (Phase 26).
 *
 * Purpose: the write path for `objectives` (legacy `Objective`). An
 * objective is a dated goal on a program's plan timeline: a name
 * (unique in the program), a value statement, a start/end range, the
 * timeline row it sits on, and size/value estimates. Numbers are per
 * program and never reused (legacy `program_N_objective_numbers`);
 * identifiers derive from the name (legacy `generate_identifier`) and
 * are regenerated on rename. Objectives keep a dense 1-based
 * `position` within their status group, a new one taking the top
 * (legacy `default_to_top_position`) and deletion closing the gap
 * (legacy `update_positions`). Every change appends an
 * `objective_versions` row in the same transaction, with a final
 * deletion version when the objective goes (ADR-0004; legacy
 * `acts_as_versioned_ext :keep_versions_on_destroy`). Scheduling an
 * objective outside the plan window widens the window (legacy
 * `resize_plan_to_accomodate_objective`).
 *
 * This module handles PLANNED objectives (a date range is required);
 * BACKLOG objectives, their ordering and the move onto the plan live
 * in backlog.server.ts (Phase 27). The primitives both share —
 * numbering, identifiers, name rules, the version append and group
 * positioning — are objective-support.server.ts.
 *
 * Commands → events:
 *   CreateObjective → ObjectiveCreated
 *   UpdateObjective → ObjectiveUpdated
 *   DeleteObjective → ObjectiveDeleted
 *
 * Public interface: `createObjective`, `updateObjective`,
 * `deleteObjective`, `eraseProgramObjectives` (for DeleteProgram),
 * `TIMELINE_ROWS`, `VERTICALLY_MIDDLE_OF_TIMELINE`.
 *
 * Owner context: Program Management. Handlers take the Drizzle handle
 * as a parameter — no module-level infrastructure imports.
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { objectives, objectiveVersions, type ObjectiveRow } from "~/db/schema/programs";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProgramAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { isoDateError } from "~/domain/programs/dates.server";
import {
  appendVersion,
  compactGroupAfter,
  estimateError,
  findObjective,
  nameError,
  nextObjectiveNumber,
  objectiveIdentifier,
  programExists,
  shiftGroupDown,
  squish,
} from "~/domain/programs/objective-support.server";
import { widenPlanToFit, type PlanWindow } from "~/domain/programs/plan.server";
import type { ObjectiveStatus } from "~/shared/wire-types";

/** Legacy Plan::Constants — rows on the timeline and the one a new objective lands on. */
export const TIMELINE_ROWS = 14;
export const VERTICALLY_MIDDLE_OF_TIMELINE = 6;
/** The fields a member supplies for a planned objective. */
interface ObjectiveFields {
  name: string;
  valueStatement: string | null;
  startAt: string;
  endAt: string;
  verticalPosition: number;
  size: number;
  value: number;
}

/**
 * Normalizes and validates the supplied fields against the legacy
 * rules; `excludeObjectiveId` lets an objective keep its own name.
 */
function normalizeFields(
  db: BetterSQLite3Database,
  programId: number,
  input: {
    name: string;
    valueStatement?: string | null;
    startAt: string;
    endAt: string;
    verticalPosition?: number | null;
    size?: number | null;
    value?: number | null;
  },
  excludeObjectiveId?: number,
): CommandResult<ObjectiveFields> {
  const name = squish(input.name);
  const badName = nameError(db, programId, name, excludeObjectiveId);
  if (badName) return reject("name", badName);

  const startAt = input.startAt.trim();
  const invalidStart = isoDateError(startAt);
  if (invalidStart) return reject("start_at", invalidStart);
  const endAt = input.endAt.trim();
  const invalidEnd = isoDateError(endAt);
  if (invalidEnd) return reject("end_at", invalidEnd);
  if (startAt > endAt) return reject("end_at", "should be after start date");

  const verticalPosition = input.verticalPosition ?? VERTICALLY_MIDDLE_OF_TIMELINE;
  if (!Number.isInteger(verticalPosition) || verticalPosition < 1 || verticalPosition > TIMELINE_ROWS)
    return reject("vertical_position", `must be a row between 1 and ${TIMELINE_ROWS}`);
  const size = input.size ?? 0;
  const badSize = estimateError(size);
  if (badSize) return reject("size", badSize);
  const value = input.value ?? 0;
  const badValue = estimateError(value);
  if (badValue) return reject("value", badValue);

  return {
    ok: true,
    value: { name, valueStatement: input.valueStatement?.trim() || null, startAt, endAt, verticalPosition, size, value },
  };
}

export interface CreateObjectiveInput {
  programId: number;
  name: string;
  valueStatement?: string | null;
  /** ISO `YYYY-MM-DD`. */
  startAt: string;
  /** ISO `YYYY-MM-DD`. */
  endAt: string;
  /** Timeline row 1..TIMELINE_ROWS; defaults to the middle. */
  verticalPosition?: number | null;
  size?: number | null;
  value?: number | null;
  actorUserId: number;
}

/** What a create or update reports about the plan it may have widened. */
export interface ObjectiveOutcome {
  objective: ObjectiveRow;
  /** The plan's new window when the objective's range fell outside it, else null. */
  planWidened: PlanWindow | null;
}

/**
 * CreateObjective — puts a new objective on the program's plan.
 *
 * DOES: shifts the program's PLANNED objectives down one position,
 * inserts an `objectives` row at position 1 with the program's next
 * number, an identifier derived from the name, status PLANNED, version
 * 1 and the actor as modifier; inserts its version-1
 * `objective_versions` row; widens the plan window when the range
 * falls outside it; appends an ObjectiveCreated event — all in one
 * transaction.
 * WHEN: the program exists, the actor is at least a program member,
 * the name is non-blank, at most 80 characters and unused
 * (case-insensitively) in the program, both dates are valid with the
 * end not before the start, the timeline row is 1..14, and size and
 * value are whole numbers of 0 or more.
 * BECAUSE: a planned objective is drawn on the timeline by its range
 * and row, so it must have both; the plan must be wide enough to show
 * everything planned on it.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function createObjective(
  db: BetterSQLite3Database,
  input: CreateObjectiveInput,
): CommandResult<ObjectiveOutcome> {
  if (!programExists(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const normalized = normalizeFields(db, input.programId, input);
  if (!normalized.ok) return normalized;
  const fields = normalized.value;

  return db.transaction((tx) => {
    shiftGroupDown(tx, input.programId, "PLANNED");
    const row = tx
      .insert(objectives)
      .values({
        programId: input.programId,
        number: nextObjectiveNumber(tx, input.programId),
        identifier: objectiveIdentifier(tx, input.programId, fields.name),
        ...fields,
        status: "PLANNED",
        position: 1,
        version: 1,
        modifiedByUserId: input.actorUserId,
      })
      .returning()
      .get();
    tx.insert(objectiveVersions)
      .values({
        objectiveId: row.id,
        programId: row.programId,
        number: row.number,
        version: 1,
        name: row.name,
        identifier: row.identifier,
        valueStatement: row.valueStatement,
        startAt: row.startAt,
        endAt: row.endAt,
        verticalPosition: row.verticalPosition,
        size: row.size,
        value: row.value,
        status: row.status,
        position: row.position,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    const planWidened = widenPlanToFit(tx, input.programId, fields.startAt, fields.endAt);
    emitEvent(tx, {
      type: "ObjectiveCreated",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { number: row.number, name: row.name, startAt: row.startAt, endAt: row.endAt, planWidened },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { objective: row, planWidened } };
  });
}

export interface UpdateObjectiveInput {
  programId: number;
  number: number;
  name: string;
  valueStatement?: string | null;
  startAt: string;
  endAt: string;
  verticalPosition?: number | null;
  size?: number | null;
  value?: number | null;
  actorUserId: number;
}

/**
 * UpdateObjective — changes a planned objective's fields.
 *
 * DOES: updates name (regenerating the identifier when the name
 * changed), value statement, range, timeline row, size and value on
 * the `objectives` row, bumps the version and stamps the actor as
 * modifier, appends a version row, widens the plan window when the
 * new range falls outside it, and appends an ObjectiveUpdated event
 * naming the changed fields — in one transaction. Submitting the
 * stored values changes nothing and appends no version.
 * WHEN: the objective exists in the program, the actor is at least a
 * program member, and the fields pass the CreateObjective rules (the
 * objective may keep its own name).
 * BECAUSE: the trail records what changed, not what was attempted;
 * the identifier follows the name so links stay meaningful.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function updateObjective(
  db: BetterSQLite3Database,
  input: UpdateObjectiveInput,
): CommandResult<ObjectiveOutcome> {
  const objective = findObjective(db, input.programId, input.number);
  if (!objective) return reject("objective", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const normalized = normalizeFields(db, input.programId, input, objective.id);
  if (!normalized.ok) return normalized;
  const fields = normalized.value;

  const changed = (Object.keys(fields) as (keyof ObjectiveFields)[]).filter(
    (key) => fields[key] !== objective[key],
  );
  if (changed.length === 0) return { ok: true, value: { objective, planWidened: null } };

  return db.transaction((tx) => {
    const identifier =
      fields.name !== objective.name
        ? objectiveIdentifier(tx, input.programId, fields.name, objective.id)
        : objective.identifier;
    tx.update(objectives)
      .set({ ...fields, identifier })
      .where(eq(objectives.id, objective.id))
      .run();
    const row = appendVersion(tx, { ...objective, ...fields, identifier }, input.actorUserId);
    const planWidened = widenPlanToFit(tx, input.programId, fields.startAt, fields.endAt);
    emitEvent(tx, {
      type: "ObjectiveUpdated",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { number: objective.number, changed, planWidened },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { objective: row, planWidened } };
  });
}

export interface DeleteObjectiveInput {
  programId: number;
  number: number;
  actorUserId: number;
}

/**
 * DeleteObjective — removes an objective from the program.
 *
 * DOES: appends a final `objective_versions` row flagged as the
 * deletion (the number stays reserved), deletes the `objectives` row,
 * closes the position gap in its status group, and appends an
 * ObjectiveDeleted event — in one transaction.
 * WHEN: the objective exists in the program and the actor is a program
 * administrator.
 * BECAUSE: deletion is history, not erasure (legacy
 * `keep_versions_on_destroy`), and the remaining objectives keep a
 * dense order.
 * REJECTS WHEN: the objective is unknown or the actor is below program
 * administrator — nothing written.
 */
export function deleteObjective(
  db: BetterSQLite3Database,
  input: DeleteObjectiveInput,
): CommandResult<{ number: number }> {
  const objective = findObjective(db, input.programId, input.number);
  if (!objective) return reject("objective", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;

  return db.transaction((tx) => {
    appendVersion(tx, objective, input.actorUserId, { isDeletion: true });
    tx.delete(objectives).where(eq(objectives.id, objective.id)).run();
    compactGroupAfter(tx, input.programId, objective.status as ObjectiveStatus, objective.position);
    emitEvent(tx, {
      type: "ObjectiveDeleted",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { number: objective.number, name: objective.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { number: objective.number } };
  });
}

/**
 * Removes every objective of a program on the caller's transaction,
 * appending each one's deletion version first — DeleteProgram's
 * counterpart of legacy `has_many :objectives, :dependent => :destroy`.
 * Emits no event of its own; the surrounding command's event carries
 * the numbers.
 *
 * @returns the numbers of the objectives removed
 */
export function eraseProgramObjectives(tx: BetterSQLite3Database, programId: number, actorUserId: number): number[] {
  const rows = tx.select().from(objectives).where(eq(objectives.programId, programId)).all();
  for (const row of rows) {
    appendVersion(tx, row, actorUserId, { isDeletion: true });
    tx.delete(objectives).where(eq(objectives.id, row.id)).run();
  }
  return rows.map((row) => row.number);
}
