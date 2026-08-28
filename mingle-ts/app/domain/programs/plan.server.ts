/**
 * Program Management — the Plan: a program's timeline window (Phase 26).
 *
 * Purpose: the write path for `plans` (legacy `Plan`). Every program
 * has exactly one plan, created with it and defaulting to a year-long
 * window starting a month ago (legacy `assign_default_plan_dates`).
 * Members may move the window; the window also widens on its own to
 * fit any objective scheduled outside it (legacy
 * `resize_plan_to_accomodate_objective`) — it never shrinks on its own.
 *
 * Commands → events:
 *   UpdatePlan → PlanUpdated
 *
 * Public interface: `defaultPlanWindow`, `findPlan`, `updatePlan`,
 * `widenPlanToFit`.
 *
 * Owner context: Program Management. Handlers take the Drizzle handle
 * as a parameter — no module-level infrastructure imports.
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { plans, programs, type PlanRow } from "~/db/schema/programs";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProgramAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { addMonths, isoDateError } from "~/domain/programs/dates.server";

/** A plan's window. */
export interface PlanWindow {
  startAt: string;
  endAt: string;
}

/**
 * The window a new plan gets: a month before `today` to eleven months
 * after it (legacy `Clock.now - 1.month` … `Clock.now + 11.months`).
 *
 * @param today - ISO date the defaults are computed from
 */
export function defaultPlanWindow(today: string): PlanWindow {
  return { startAt: addMonths(today, -1), endAt: addMonths(today, 11) };
}

/** The program's one plan row. */
export function findPlan(db: BetterSQLite3Database, programId: number): PlanRow | undefined {
  return db.select().from(plans).where(eq(plans.programId, programId)).get();
}

/** Both dates valid and the end not before the start; errors keyed as the legacy form did. */
function windowError(startAt: string, endAt: string): CommandResult<never> | null {
  const invalidStart = isoDateError(startAt);
  if (invalidStart) return reject("start_at", invalidStart);
  const invalidEnd = isoDateError(endAt);
  if (invalidEnd) return reject("end_at", invalidEnd);
  if (startAt > endAt) return reject("end_at", "should be after start date");
  return null;
}

export interface UpdatePlanInput {
  programId: number;
  /** ISO `YYYY-MM-DD`. */
  startAt: string;
  /** ISO `YYYY-MM-DD`. */
  endAt: string;
  actorUserId: number;
}

/**
 * UpdatePlan — moves a program's timeline window.
 *
 * DOES: updates the plan's `start_at`/`end_at` (updated_at stamped) and
 * appends a PlanUpdated event. Submitting the stored window changes
 * nothing and emits nothing.
 * WHEN: the program exists, the actor is at least a program member,
 * both dates are valid ISO dates and the end is not before the start.
 * BECAUSE: the window is what the timeline draws; a plan that ends
 * before it starts cannot be drawn (legacy `end_at_date_should_be_after_start_at_date`).
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function updatePlan(db: BetterSQLite3Database, input: UpdatePlanInput): CommandResult<PlanRow> {
  const program = db.select({ id: programs.id }).from(programs).where(eq(programs.id, input.programId)).get();
  if (!program) return reject("program", "does not exist");
  const denied = authorizeProgramAction(db, input.actorUserId, input.programId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const startAt = input.startAt.trim();
  const endAt = input.endAt.trim();
  const invalid = windowError(startAt, endAt);
  if (invalid) return invalid;
  const plan = findPlan(db, input.programId);
  if (!plan) return reject("plan", "does not exist");
  if (plan.startAt === startAt && plan.endAt === endAt) return { ok: true, value: plan };

  return db.transaction((tx) => {
    const row = tx
      .update(plans)
      .set({ startAt, endAt, updatedAt: new Date() })
      .where(eq(plans.id, plan.id))
      .returning()
      .get();
    emitEvent(tx, {
      type: "PlanUpdated",
      aggregateType: "Program",
      aggregateId: input.programId,
      payload: { startAt, endAt },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

/**
 * Widens the plan window so `startAt`…`endAt` fits inside it, on the
 * caller's transaction (legacy `resize_plan_to_accomodate_objective`).
 * Never narrows.
 *
 * @returns the new window when it changed, else null
 */
export function widenPlanToFit(
  tx: BetterSQLite3Database,
  programId: number,
  startAt: string,
  endAt: string,
): PlanWindow | null {
  const plan = findPlan(tx, programId);
  if (!plan) return null;
  const window: PlanWindow = {
    startAt: startAt < plan.startAt ? startAt : plan.startAt,
    endAt: endAt > plan.endAt ? endAt : plan.endAt,
  };
  if (window.startAt === plan.startAt && window.endAt === plan.endAt) return null;
  tx.update(plans).set({ ...window, updatedAt: new Date() }).where(eq(plans.id, plan.id)).run();
  return window;
}
