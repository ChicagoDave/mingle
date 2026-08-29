/**
 * Program Management command handlers — Backlog (Phase 27).
 *
 * Purpose: the write path for BACKLOG objectives (legacy
 * `BacklogObjective`, merged into `objectives` with status BACKLOG).
 * A backlog item is a proposed objective awaiting planning: a name
 * (unique in the program across both statuses), a value statement and
 * size/value estimates, but no dates. The backlog is an explicitly
 * ordered list — `position` is the order, dense and 1-based, a new
 * item taking the top (legacy `default_to_top_position`) and deletion
 * closing the gap — never an implicit created-at order. Reordering
 * follows legacy `ListReorderingSupport#reorder`: the caller names the
 * items in their new order, every named item must be in the backlog,
 * and unnamed items keep their relative order, backfilled around the
 * named ones (`backfill_values` — see `backfillOrder` for the exact
 * walk; naming a single item never moves it). Planning an item (legacy
 * `Plan#plan_backlog_objective`) moves it onto the plan at the top of
 * the PLANNED group, dated to the current month on the nearest free
 * timeline row.
 *
 * Commands → events:
 *   CreateBacklogObjective → BacklogObjectiveCreated
 *   UpdateBacklogObjective → ObjectiveUpdated
 *   ReorderBacklog         → BacklogReordered
 *   PlanBacklogObjective   → ObjectivePlanned
 *
 * Deleting a backlog item is DeleteObjective (objectives.server.ts),
 * which already compacts the item's status group.
 *
 * Public interface: `createBacklogObjective`, `updateBacklogObjective`,
 * `reorderBacklog`, `planBacklogObjective`, `backfillOrder`,
 * `nextAvailableTimelineRow`.
 *
 * Owner context: Program Management. Handlers take the Drizzle handle
 * as a parameter — no module-level infrastructure imports.
 */
import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { objectives, objectiveVersions, type ObjectiveRow } from "~/db/schema/programs";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProgramAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { addDays, endOfMonth, startOfMonth, todayIso } from "~/domain/programs/dates.server";
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
import { TIMELINE_ROWS, VERTICALLY_MIDDLE_OF_TIMELINE } from "~/shared/wire-types";
import { widenPlanToFit, type PlanWindow } from "~/domain/programs/plan.server";

/** The program's backlog rows in position order. */
function backlogRows(db: BetterSQLite3Database, programId: number): ObjectiveRow[] {
  return db
    .select()
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.status, "BACKLOG")))
    .orderBy(asc(objectives.position))
    .all();
}

/** The fields a member supplies for a backlog item. */
interface BacklogFields {
  name: string;
  valueStatement: string | null;
  size: number;
  value: number;
}

/** Normalizes and validates the supplied fields; `excludeObjectiveId` lets an item keep its own name. */
function normalizeFields(
  db: BetterSQLite3Database,
  programId: number,
  input: { name: string; valueStatement?: string | null; size?: number | null; value?: number | null },
  excludeObjectiveId?: number,
): CommandResult<BacklogFields> {
  const name = squish(input.name);
  const badName = nameError(db, programId, name, excludeObjectiveId);
  if (badName) return reject("name", badName);
  const size = input.size ?? 0;
  const badSize = estimateError(size);
  if (badSize) return reject("size", badSize);
  const value = input.value ?? 0;
  const badValue = estimateError(value);
  if (badValue) return reject("value", badValue);
  return { ok: true, value: { name, valueStatement: input.valueStatement?.trim() || null, size, value } };
}

export interface CreateBacklogObjectiveInput {
  programId: number;
  name: string;
  valueStatement?: string | null;
  size?: number | null;
  value?: number | null;
  actorUserId: number;
}

/**
 * CreateBacklogObjective — adds a proposed objective to the top of the
 * program's backlog.
 *
 * DOES: shifts the program's BACKLOG objectives down one position,
 * inserts an `objectives` row with status BACKLOG at position 1, the
 * program's next number, an identifier derived from the name, no
 * dates, the default timeline row, version 1 and the actor as
 * modifier; inserts its version-1 `objective_versions` row; appends a
 * BacklogObjectiveCreated event — all in one transaction. PLANNED
 * positions and the plan window are untouched.
 * WHEN: the program exists, the actor is at least a program member,
 * the name is non-blank, at most 80 characters and unused
 * (case-insensitively) among the program's objectives of either
 * status, and size and value are whole numbers of 0 or more.
 * BECAUSE: the backlog is the intake queue for the plan; the newest
 * proposal is the one being discussed, so it goes on top (legacy).
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function createBacklogObjective(
  db: BetterSQLite3Database,
  input: CreateBacklogObjectiveInput,
): CommandResult<ObjectiveRow> {
  if (!programExists(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const normalized = normalizeFields(db, input.programId, input);
  if (!normalized.ok) return normalized;
  const fields = normalized.value;

  return db.transaction((tx) => {
    shiftGroupDown(tx, input.programId, "BACKLOG");
    const row = tx
      .insert(objectives)
      .values({
        programId: input.programId,
        number: nextObjectiveNumber(tx, input.programId),
        identifier: objectiveIdentifier(tx, input.programId, fields.name),
        ...fields,
        startAt: null,
        endAt: null,
        verticalPosition: VERTICALLY_MIDDLE_OF_TIMELINE,
        status: "BACKLOG",
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
    emitEvent(tx, {
      type: "BacklogObjectiveCreated",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { number: row.number, name: row.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface UpdateBacklogObjectiveInput {
  programId: number;
  number: number;
  name: string;
  valueStatement?: string | null;
  size?: number | null;
  value?: number | null;
  actorUserId: number;
}

/**
 * UpdateBacklogObjective — changes a backlog item's fields.
 *
 * DOES: updates name (regenerating the identifier when the name
 * changed), value statement, size and value on the `objectives` row,
 * bumps the version and stamps the actor as modifier, appends a
 * version row, and appends an ObjectiveUpdated event naming the
 * changed fields — in one transaction. Position and status are never
 * touched. Submitting the stored values changes nothing and appends
 * no version.
 * WHEN: the objective exists in the program with status BACKLOG, the
 * actor is at least a program member, and the fields pass the
 * CreateBacklogObjective rules (the item may keep its own name).
 * BECAUSE: a backlog item has no dates or row to edit; the trail
 * records what changed, not what was attempted.
 * REJECTS WHEN: the objective is unknown or not in the backlog, the
 * actor is below program member, or a field rule fails — nothing written.
 */
export function updateBacklogObjective(
  db: BetterSQLite3Database,
  input: UpdateBacklogObjectiveInput,
): CommandResult<ObjectiveRow> {
  const objective = findObjective(db, input.programId, input.number);
  if (!objective) return reject("objective", "does not exist");
  if (objective.status !== "BACKLOG") return reject("objective", "is not in the backlog");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const normalized = normalizeFields(db, input.programId, input, objective.id);
  if (!normalized.ok) return normalized;
  const fields = normalized.value;

  const changed = (Object.keys(fields) as (keyof BacklogFields)[]).filter((key) => fields[key] !== objective[key]);
  if (changed.length === 0) return { ok: true, value: objective };

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
    emitEvent(tx, {
      type: "ObjectiveUpdated",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { number: objective.number, changed, planWidened: null },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

/**
 * Merges a partial new order into the full current order (legacy
 * `ListReorderingSupport#backfill_values`, ported walk for walk): scan
 * the current order; an unnamed item is emitted the moment the scan
 * reaches it, and when the scan reaches the first still-unplaced named
 * item that item is emitted and the scan restarts from the top. So the
 * named items come out in the order given, unnamed items keep their
 * relative order, and naming one item alone changes nothing — to move
 * an item up, name it together with everything it should precede.
 * Pure.
 *
 * @param current - every item, in its current order
 * @param named - a subset (possibly all) of `current`, in the desired order; no unknowns, no duplicates
 * @returns every item of `current` exactly once, in the merged order
 */
export function backfillOrder<T>(current: readonly T[], named: readonly T[]): T[] {
  const result: T[] = [];
  const remaining = [...named];
  while (remaining.length > 0) {
    for (const item of current) {
      if (item === remaining[0]) {
        remaining.shift();
        result.push(item);
        if (remaining.length > 0) break;
      } else if (!remaining.includes(item) && !result.includes(item)) {
        result.push(item);
      }
    }
  }
  for (const item of current) if (!result.includes(item)) result.push(item);
  return result;
}

export interface ReorderBacklogInput {
  programId: number;
  /** Objective numbers in their desired order — all of the backlog, or a subset (see `backfillOrder` for how the rest fall in). */
  numbers: number[];
  actorUserId: number;
}

/**
 * ReorderBacklog — sets the explicit order of the program's backlog.
 *
 * DOES: computes the full new order by backfilling the unnamed items
 * around the named ones, rewrites `position` (1-based, dense) on every
 * backlog row whose position changed, and appends a BacklogReordered
 * event carrying the resulting sequence of numbers — in one
 * transaction. An order identical to the stored one writes nothing
 * and emits nothing.
 * WHEN: the program exists, the actor is at least a program member,
 * and every named number is a distinct BACKLOG objective of the
 * program.
 * BECAUSE: the backlog order is a deliberate, persisted ranking — it
 * must survive reload exactly and never fall back to creation order.
 * REJECTS WHEN: the program is unknown, the actor is below program
 * member, a number is repeated, or a number is not in the backlog
 * (naming the offenders) — positions untouched.
 */
export function reorderBacklog(
  db: BetterSQLite3Database,
  input: ReorderBacklogInput,
): CommandResult<{ order: number[] }> {
  if (!programExists(db, input.programId)) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const duplicates = input.numbers.filter((n, i) => input.numbers.indexOf(n) !== i);
  if (duplicates.length > 0) return reject("numbers", `repeats objective ${[...new Set(duplicates)].join(", ")}`);

  const rows = backlogRows(db, input.programId);
  const current = rows.map((row) => row.number);
  const unknown = input.numbers.filter((n) => !current.includes(n));
  if (unknown.length > 0)
    return reject("numbers", `${unknown.length === 1 ? "is" : "are"} not in the backlog: ${unknown.join(", ")}`);

  const order = backfillOrder(current, input.numbers);
  const moves = rows
    .map((row) => ({ id: row.id, from: row.position, to: order.indexOf(row.number) + 1 }))
    .filter((move) => move.from !== move.to);
  if (moves.length === 0) return { ok: true, value: { order } };

  return db.transaction((tx) => {
    for (const move of moves) {
      tx.update(objectives).set({ position: move.to }).where(eq(objectives.id, move.id)).run();
    }
    emitEvent(tx, {
      type: "BacklogReordered",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { order },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { order } };
  });
}

/**
 * The timeline row a newly planned objective lands on (legacy
 * `Plan#next_available_position`): the middle row if free, else the
 * nearest free row alternating above and below the middle, else the
 * middle. A row counts as occupied when a PLANNED objective on it
 * overlaps the month containing `today`. Legacy let the search reach
 * row 0; rows are 1..TIMELINE_ROWS here, so the search stops at 1.
 */
export function nextAvailableTimelineRow(db: BetterSQLite3Database, programId: number, today: string): number {
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const occupiedThisMonth = new Set(
    db
      .select({ row: objectives.verticalPosition, startAt: objectives.startAt, endAt: objectives.endAt })
      .from(objectives)
      .where(and(eq(objectives.programId, programId), eq(objectives.status, "PLANNED")))
      .all()
      .filter((o) => o.startAt !== null && o.endAt !== null && o.startAt <= monthEnd && o.endAt >= monthStart)
      .map((o) => o.row),
  );
  for (let i = 0; i <= TIMELINE_ROWS / 2; i += 1) {
    const above = VERTICALLY_MIDDLE_OF_TIMELINE - i;
    if (above >= 1 && !occupiedThisMonth.has(above)) return above;
    const below = VERTICALLY_MIDDLE_OF_TIMELINE + i;
    if (below <= TIMELINE_ROWS && !occupiedThisMonth.has(below)) return below;
  }
  return VERTICALLY_MIDDLE_OF_TIMELINE;
}

/**
 * The date range a newly planned objective gets (legacy
 * `Plan#offset_date`): the current month, unless it lands on the
 * middle row while other PLANNED objectives already sit there, in
 * which case it is staggered after the latest of those — starting two
 * weeks and ending six weeks after that objective's start.
 */
function plannedRange(db: BetterSQLite3Database, programId: number, today: string, row: number): [string, string] {
  const monthRange: [string, string] = [startOfMonth(today), endOfMonth(today)];
  if (row !== VERTICALLY_MIDDLE_OF_TIMELINE) return monthRange;
  const latestStart = db
    .select({ startAt: objectives.startAt })
    .from(objectives)
    .where(
      and(
        eq(objectives.programId, programId),
        eq(objectives.status, "PLANNED"),
        eq(objectives.verticalPosition, VERTICALLY_MIDDLE_OF_TIMELINE),
      ),
    )
    .all()
    .map((o) => o.startAt)
    .filter((s): s is string => s !== null)
    .sort()
    .at(-1);
  if (!latestStart) return monthRange;
  return [addDays(latestStart, 14), addDays(latestStart, 42)];
}

export interface PlanBacklogObjectiveInput {
  programId: number;
  number: number;
  actorUserId: number;
  /** ISO date standing in for "now"; defaults to today (UTC). */
  today?: string;
}

/**
 * PlanBacklogObjective — moves a backlog item onto the plan.
 *
 * DOES: closes the item's gap in the BACKLOG order, shifts the PLANNED
 * objectives down one position, and rewrites the row with status
 * PLANNED, position 1, the nearest free timeline row and a date range
 * (the current month, staggered after the latest middle-row objective
 * when it lands on the middle row); bumps the version and modifier
 * and appends a version row; widens the plan window when the range
 * falls outside it; appends an ObjectivePlanned event — all in one
 * transaction.
 * WHEN: the objective exists in the program with status BACKLOG and
 * the actor is at least a program member.
 * BECAUSE: planning is the backlog's exit — the item becomes a dated
 * objective drawn on the timeline, and both ordered groups stay dense.
 * REJECTS WHEN: the objective is unknown or already planned, or the
 * actor is below program member — nothing written.
 */
export function planBacklogObjective(
  db: BetterSQLite3Database,
  input: PlanBacklogObjectiveInput,
): CommandResult<{ objective: ObjectiveRow; planWidened: PlanWindow | null }> {
  const objective = findObjective(db, input.programId, input.number);
  if (!objective) return reject("objective", "does not exist");
  if (objective.status !== "BACKLOG") return reject("objective", "is already planned");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const today = input.today ?? todayIso();

  return db.transaction((tx) => {
    const verticalPosition = nextAvailableTimelineRow(tx, input.programId, today);
    const [startAt, endAt] = plannedRange(tx, input.programId, today, verticalPosition);
    compactGroupAfter(tx, input.programId, "BACKLOG", objective.position);
    shiftGroupDown(tx, input.programId, "PLANNED");
    const placed = { status: "PLANNED" as const, position: 1, verticalPosition, startAt, endAt };
    tx.update(objectives).set(placed).where(eq(objectives.id, objective.id)).run();
    const row = appendVersion(tx, { ...objective, ...placed }, input.actorUserId);
    const planWidened = widenPlanToFit(tx, input.programId, startAt, endAt);
    emitEvent(tx, {
      type: "ObjectivePlanned",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { number: row.number, name: row.name, startAt, endAt, verticalPosition, planWidened },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { objective: row, planWidened } };
  });
}
