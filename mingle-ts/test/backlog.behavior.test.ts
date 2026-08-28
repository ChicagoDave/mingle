/**
 * Behavioral tests for the program backlog (Phase 27).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * `createBacklogObjective`, `updateBacklogObjective`, `reorderBacklog`
 * and `planBacklogObjective`, plus the pure `backfillOrder` ported from
 * legacy `ListReorderingSupport#backfill_values`: every DOES asserts
 * on rows reloaded from the database — the objective rows and their
 * positions, the version trail, the plan window, the domain event —
 * never on a return value alone, and every REJECTS WHEN has its own
 * test that also proves nothing was written. Includes the phase's exit
 * criterion: reordering backlog items persists the new order, verified
 * by reloading and asserting the exact sequence.
 *
 * The route section drives the real backlog and objective route
 * modules with a Request carrying a real session cookie.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Program Management verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-backlog-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "backlog-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const backlogRoute = await import("../app/routes/programs.backlog");
const objectiveRoute = await import("../app/routes/programs.objectives.show");

const { objectives, objectiveVersions, plans } = await import("../app/db/schema/programs");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addProgramMember } = await import("../app/domain/identity/program-membership.server");
const { createProgram } = await import("../app/domain/programs/commands.server");
const { createObjective, deleteObjective } = await import("../app/domain/programs/objectives.server");
const { backfillOrder, createBacklogObjective, nextAvailableTimelineRow, planBacklogObjective, reorderBacklog, updateBacklogObjective } =
  await import("../app/domain/programs/backlog.server");
const { addDays, endOfMonth, startOfMonth } = await import("../app/domain/programs/dates.server");
const { backlogObjectives, programOverview } = await import("../app/domain/programs/read.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function mustReject<T>(result: CommandResult<T>, what: string): Record<string, string[]> {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return result.errors;
}

function register(login: string): number {
  return mustOk(
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "backlog-27!" }),
    login,
  ).id;
}

const adminId = register("admin"); // site admin
const plannerId = register("planner"); // program member
const outsiderId = register("outsider"); // on no program

const TODAY = "2026-08-28";
const MONTH_START = "2026-08-01";
const MONTH_END = "2026-08-31";

function program(name: string, identifier: string) {
  const row = mustOk(createProgram(db, { name, identifier, actorUserId: adminId, today: TODAY }), name);
  mustOk(addProgramMember(db, { programId: row.id, userId: plannerId, actorUserId: adminId }), "planner");
  return row;
}

function reload(programId: number, number: number) {
  return db
    .select()
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.number, number)))
    .get();
}

/** [number, position] of the program's objectives with this status, in position order. */
function orderOf(programId: number, status: "BACKLOG" | "PLANNED"): [number, number][] {
  return db
    .select({ number: objectives.number, position: objectives.position })
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.status, status)))
    .orderBy(asc(objectives.position))
    .all()
    .map((row) => [row.number, row.position]);
}

function trail(objectiveId: number) {
  return db
    .select({
      version: objectiveVersions.version,
      name: objectiveVersions.name,
      identifier: objectiveVersions.identifier,
      status: objectiveVersions.status,
      position: objectiveVersions.position,
      startAt: objectiveVersions.startAt,
      endAt: objectiveVersions.endAt,
      verticalPosition: objectiveVersions.verticalPosition,
      isDeletion: objectiveVersions.isDeletion,
      modifiedByUserId: objectiveVersions.modifiedByUserId,
    })
    .from(objectiveVersions)
    .where(eq(objectiveVersions.objectiveId, objectiveId))
    .orderBy(asc(objectiveVersions.version))
    .all();
}

function eventsFor(programId: number): { type: string; payload: Record<string, unknown> }[] {
  return db
    .select({ type: domainEvents.type, payload: domainEvents.payload })
    .from(domainEvents)
    .where(and(eq(domainEvents.aggregateType, "Program"), eq(domainEvents.aggregateId, programId)))
    .orderBy(asc(domainEvents.id))
    .all()
    .map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

function eventCount(): number {
  return db.select({ id: domainEvents.id }).from(domainEvents).all().length;
}

function planOf(programId: number) {
  return db.select({ startAt: plans.startAt, endAt: plans.endAt }).from(plans).where(eq(plans.programId, programId)).get()!;
}

function backlogItem(programId: number, name: string, extra: { size?: number; value?: number; valueStatement?: string } = {}) {
  return mustOk(createBacklogObjective(db, { programId, name, actorUserId: plannerId, ...extra }), name);
}

describe("backfillOrder (legacy backfill_values)", () => {
  it("returns the named items in the given order with unnamed items keeping their relative places", () => {
    expect(backfillOrder(["A", "B", "C", "D"], ["C", "A"])).toEqual(["B", "C", "A", "D"]);
    expect(backfillOrder(["A", "B", "C", "D"], ["D", "C", "B", "A"])).toEqual(["D", "C", "B", "A"]);
    expect(backfillOrder(["A", "B", "C", "D"], ["D", "A"])).toEqual(["B", "C", "D", "A"]);
    expect(backfillOrder(["A", "B", "C", "D"], ["B", "A"])).toEqual(["B", "A", "C", "D"]);
    expect(backfillOrder(["A", "B", "C", "D"], ["C", "A", "B"])).toEqual(["C", "A", "B", "D"]);
    expect(backfillOrder(["A", "B", "C", "D"], [])).toEqual(["A", "B", "C", "D"]);
  });

  it("naming a single item never moves it (legacy walk): moving up means naming everything it should precede", () => {
    expect(backfillOrder(["A", "B", "C", "D"], ["D"])).toEqual(["A", "B", "C", "D"]);
    expect(backfillOrder(["A", "B", "C", "D"], ["B"])).toEqual(["A", "B", "C", "D"]);
    expect(backfillOrder(["A", "B", "C", "D"], ["D", "A", "B", "C"])).toEqual(["D", "A", "B", "C"]);
  });
});

describe("date helpers", () => {
  it("computes month bounds and day offsets", () => {
    expect(startOfMonth(TODAY)).toBe(MONTH_START);
    expect(endOfMonth(TODAY)).toBe(MONTH_END);
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(addDays("2026-08-25", 14)).toBe("2026-09-08");
  });
});

describe("createBacklogObjective", () => {
  const p = program("Intake", "intake");

  it("persists the item at the top of the backlog with no dates, a version-1 trail row and the event; PLANNED untouched", () => {
    const planned = mustOk(
      createObjective(db, { programId: p.id, name: "Planned one", startAt: "2026-09-01", endAt: "2026-09-30", actorUserId: plannerId }),
      "planned",
    ).objective;
    const first = backlogItem(p.id, "  Ship   search ", { size: 3, value: 5, valueStatement: " find things " });
    const row = reload(p.id, first.number)!;
    expect(row).toMatchObject({
      number: 2,
      name: "Ship search",
      identifier: "ship_search",
      valueStatement: "find things",
      status: "BACKLOG",
      position: 1,
      startAt: null,
      endAt: null,
      verticalPosition: 6,
      size: 3,
      value: 5,
      version: 1,
      modifiedByUserId: plannerId,
    });
    expect(trail(row.id)).toEqual([expect.objectContaining({ version: 1, status: "BACKLOG", position: 1, startAt: null, isDeletion: false })]);

    const second = backlogItem(p.id, "Second idea");
    expect(orderOf(p.id, "BACKLOG")).toEqual([
      [second.number, 1],
      [first.number, 2],
    ]);
    expect(orderOf(p.id, "PLANNED")).toEqual([[planned.number, 1]]);
    expect(planOf(p.id)).toEqual({ startAt: "2026-07-28", endAt: "2027-07-28" });
    expect(eventsFor(p.id).filter((e) => e.type === "BacklogObjectiveCreated").map((e) => e.payload)).toEqual([
      { number: 2, name: "Ship search" },
      { number: 3, name: "Second idea" },
    ]);
  });

  it("rejects a blank name, a name used by a PLANNED objective, a bad estimate, and an outsider — nothing written", () => {
    const before = orderOf(p.id, "BACKLOG");
    const events = eventCount();
    expect(mustReject(createBacklogObjective(db, { programId: p.id, name: "   ", actorUserId: plannerId }), "blank").name).toEqual(["can't be blank"]);
    expect(mustReject(createBacklogObjective(db, { programId: p.id, name: "planned ONE", actorUserId: plannerId }), "dup").name).toEqual([
      "already used for an existing Objective in your Program.",
    ]);
    expect(mustReject(createBacklogObjective(db, { programId: p.id, name: "x".repeat(81), actorUserId: plannerId }), "long").name).toEqual([
      "is too long (maximum is 80 characters)",
    ]);
    expect(mustReject(createBacklogObjective(db, { programId: p.id, name: "Sized", size: -1, actorUserId: plannerId }), "size").size).toEqual([
      "must be a whole number of 0 or more",
    ]);
    expect(mustReject(createBacklogObjective(db, { programId: p.id, name: "Valued", value: 1.5, actorUserId: plannerId }), "value").value).toEqual([
      "must be a whole number of 0 or more",
    ]);
    expect(mustReject(createBacklogObjective(db, { programId: p.id, name: "Sneaky", actorUserId: outsiderId }), "outsider").authorization).toEqual([expect.stringContaining("access to this program")]);
    expect(mustReject(createBacklogObjective(db, { programId: 9999, name: "Nowhere", actorUserId: adminId }), "program").program).toEqual(["does not exist"]);
    expect(orderOf(p.id, "BACKLOG")).toEqual(before);
    expect(eventCount()).toBe(events);
  });
});

describe("updateBacklogObjective", () => {
  const p = program("Edits", "edits");
  const item = backlogItem(p.id, "Rough idea", { size: 1 });
  const other = backlogItem(p.id, "Other idea");

  it("persists the fields, regenerates the identifier on rename, appends version 2 and the event; position untouched", () => {
    const result = mustOk(
      updateBacklogObjective(db, { programId: p.id, number: item.number, name: "Polished idea", valueStatement: "worth it", size: 1, value: 4, actorUserId: plannerId }),
      "update",
    );
    expect(result.version).toBe(2);
    const row = reload(p.id, item.number)!;
    expect(row).toMatchObject({ name: "Polished idea", identifier: "polished_idea", valueStatement: "worth it", size: 1, value: 4, version: 2, status: "BACKLOG", position: 2 });
    expect(trail(row.id).map((v) => [v.version, v.identifier])).toEqual([
      [1, "rough_idea"],
      [2, "polished_idea"],
    ]);
    expect(eventsFor(p.id).at(-1)).toEqual({
      type: "ObjectiveUpdated",
      payload: { number: item.number, changed: ["name", "valueStatement", "value"], planWidened: null },
    });
  });

  it("appends nothing when the stored values are submitted", () => {
    const events = eventCount();
    mustOk(updateBacklogObjective(db, { programId: p.id, number: item.number, name: "Polished idea", valueStatement: "worth it", size: 1, value: 4, actorUserId: plannerId }), "same");
    expect(reload(p.id, item.number)!.version).toBe(2);
    expect(eventCount()).toBe(events);
  });

  it("rejects a planned objective, another item's name, an unknown number and an outsider — row untouched", () => {
    const planned = mustOk(createObjective(db, { programId: p.id, name: "On plan", startAt: "2026-09-01", endAt: "2026-09-30", actorUserId: plannerId }), "planned").objective;
    const before = reload(p.id, item.number);
    expect(mustReject(updateBacklogObjective(db, { programId: p.id, number: planned.number, name: "Renamed", actorUserId: plannerId }), "planned").objective).toEqual(["is not in the backlog"]);
    expect(mustReject(updateBacklogObjective(db, { programId: p.id, number: item.number, name: other.name, actorUserId: plannerId }), "dup").name).toEqual([
      "already used for an existing Objective in your Program.",
    ]);
    expect(mustReject(updateBacklogObjective(db, { programId: p.id, number: 77, name: "Ghost", actorUserId: plannerId }), "unknown").objective).toEqual(["does not exist"]);
    expect(mustReject(updateBacklogObjective(db, { programId: p.id, number: item.number, name: "Taken over", actorUserId: outsiderId }), "outsider").authorization).toEqual([expect.stringContaining("access to this program")]);
    expect(reload(p.id, item.number)).toEqual(before);
    expect(reload(p.id, planned.number)!.name).toBe("On plan");
  });
});

describe("reorderBacklog", () => {
  const p = program("Ranking", "ranking");
  // Created in this order, so the initial backlog (top first) is D, C, B, A.
  const a = backlogItem(p.id, "A").number;
  const b = backlogItem(p.id, "B").number;
  const c = backlogItem(p.id, "C").number;
  const d = backlogItem(p.id, "D").number;

  it("Phase 27 exit criterion: a full reorder persists the exact sequence on reload and emits BacklogReordered", () => {
    expect(orderOf(p.id, "BACKLOG")).toEqual([[d, 1], [c, 2], [b, 3], [a, 4]]);
    mustOk(reorderBacklog(db, { programId: p.id, numbers: [b, d, a, c], actorUserId: plannerId }), "reorder");
    expect(orderOf(p.id, "BACKLOG")).toEqual([[b, 1], [d, 2], [a, 3], [c, 4]]);
    expect(backlogObjectives(db, p.id).map((item) => item.number)).toEqual([b, d, a, c]);
    expect(eventsFor(p.id).at(-1)).toEqual({ type: "BacklogReordered", payload: { order: [b, d, a, c] } });
  });

  it("a subset is merged into the current order by the legacy walk", () => {
    // Current: B, D, A, C. Naming [C, B]: the walk emits D and A (unnamed) before reaching C, then restarts for B.
    mustOk(reorderBacklog(db, { programId: p.id, numbers: [c, b], actorUserId: plannerId }), "subset");
    expect(orderOf(p.id, "BACKLOG")).toEqual([[d, 1], [a, 2], [c, 3], [b, 4]]);
    // Naming A alone leaves it where it is; "move A to top" names A and everything it must precede.
    const events = eventCount();
    mustOk(reorderBacklog(db, { programId: p.id, numbers: [a], actorUserId: plannerId }), "alone");
    expect(orderOf(p.id, "BACKLOG")).toEqual([[d, 1], [a, 2], [c, 3], [b, 4]]);
    expect(eventCount()).toBe(events);
    mustOk(reorderBacklog(db, { programId: p.id, numbers: [a, d], actorUserId: plannerId }), "top");
    expect(orderOf(p.id, "BACKLOG")).toEqual([[a, 1], [d, 2], [c, 3], [b, 4]]);
  });

  it("writes nothing and emits nothing when the order is unchanged", () => {
    const events = eventCount();
    const result = mustOk(reorderBacklog(db, { programId: p.id, numbers: [a, d, c, b], actorUserId: plannerId }), "same");
    expect(result.order).toEqual([a, d, c, b]);
    mustOk(reorderBacklog(db, { programId: p.id, numbers: [], actorUserId: plannerId }), "empty");
    expect(orderOf(p.id, "BACKLOG")).toEqual([[a, 1], [d, 2], [c, 3], [b, 4]]);
    expect(eventCount()).toBe(events);
  });

  it("rejects a repeated number, a number outside the backlog (planned or unknown), and an outsider — positions untouched", () => {
    const planned = mustOk(createObjective(db, { programId: p.id, name: "Planned", startAt: "2026-09-01", endAt: "2026-09-30", actorUserId: plannerId }), "planned").objective;
    const events = eventCount();
    expect(mustReject(reorderBacklog(db, { programId: p.id, numbers: [a, b, a], actorUserId: plannerId }), "dup").numbers).toEqual([`repeats objective ${a}`]);
    expect(mustReject(reorderBacklog(db, { programId: p.id, numbers: [planned.number, 42], actorUserId: plannerId }), "unknown").numbers).toEqual([
      `are not in the backlog: ${planned.number}, 42`,
    ]);
    expect(mustReject(reorderBacklog(db, { programId: p.id, numbers: [42], actorUserId: plannerId }), "one unknown").numbers).toEqual(["is not in the backlog: 42"]);
    expect(mustReject(reorderBacklog(db, { programId: p.id, numbers: [d], actorUserId: outsiderId }), "outsider").authorization).toEqual([expect.stringContaining("access to this program")]);
    expect(mustReject(reorderBacklog(db, { programId: 9999, numbers: [], actorUserId: adminId }), "program").program).toEqual(["does not exist"]);
    expect(orderOf(p.id, "BACKLOG")).toEqual([[a, 1], [d, 2], [c, 3], [b, 4]]);
    expect(orderOf(p.id, "PLANNED")).toEqual([[planned.number, 1]]);
    expect(eventCount()).toBe(events);
  });

  it("deleting a backlog item closes its gap (DeleteObjective compacts the BACKLOG group)", () => {
    mustOk(deleteObjective(db, { programId: p.id, number: c, actorUserId: adminId }), "delete");
    expect(orderOf(p.id, "BACKLOG")).toEqual([[a, 1], [d, 2], [b, 3]]);
  });
});

describe("planBacklogObjective", () => {
  const p = program("Planning", "planning");
  const x = backlogItem(p.id, "X");
  const y = backlogItem(p.id, "Y");
  const z = backlogItem(p.id, "Z");

  it("moves the item to the top of PLANNED on the middle row dated to the current month, compacts the backlog, appends a version and the event", () => {
    // Backlog is Z, Y, X. Planning Y leaves Z, X dense.
    const result = mustOk(planBacklogObjective(db, { programId: p.id, number: y.number, actorUserId: plannerId, today: TODAY }), "plan");
    expect(result.planWidened).toBeNull(); // the plan window (today−1mo…+11mo) already covers this month
    const row = reload(p.id, y.number)!;
    expect(row).toMatchObject({ status: "PLANNED", position: 1, verticalPosition: 6, startAt: MONTH_START, endAt: MONTH_END, version: 2, modifiedByUserId: plannerId });
    expect(orderOf(p.id, "BACKLOG")).toEqual([[z.number, 1], [x.number, 2]]);
    expect(orderOf(p.id, "PLANNED")).toEqual([[y.number, 1]]);
    expect(trail(row.id).map((v) => [v.version, v.status, v.position, v.startAt])).toEqual([
      [1, "BACKLOG", 1, null],
      [2, "PLANNED", 1, MONTH_START],
    ]);
    expect(eventsFor(p.id).at(-1)).toEqual({
      type: "ObjectivePlanned",
      payload: { number: y.number, name: "Y", startAt: MONTH_START, endAt: MONTH_END, verticalPosition: 6, planWidened: null },
    });
    expect(programOverview(db, p.id)!.objectives.map((o) => [o.number, o.status])).toEqual([
      [y.number, "PLANNED"],
      [z.number, "BACKLOG"],
      [x.number, "BACKLOG"],
    ]);
  });

  it("takes the nearest free row above the middle when the middle is occupied this month, and shifts the planned group down", () => {
    expect(nextAvailableTimelineRow(db, p.id, TODAY)).toBe(5);
    mustOk(planBacklogObjective(db, { programId: p.id, number: z.number, actorUserId: plannerId, today: TODAY }), "plan z");
    expect(reload(p.id, z.number)).toMatchObject({ status: "PLANNED", verticalPosition: 5, startAt: MONTH_START, endAt: MONTH_END });
    expect(orderOf(p.id, "PLANNED")).toEqual([[z.number, 1], [y.number, 2]]);
    expect(orderOf(p.id, "BACKLOG")).toEqual([[x.number, 1]]);
    // Row 5 and 6 taken this month → 7 next; a different month sees them all free again.
    expect(nextAvailableTimelineRow(db, p.id, TODAY)).toBe(7);
    expect(nextAvailableTimelineRow(db, p.id, "2027-01-15")).toBe(6);
  });

  it("staggers after the latest middle-row objective when landing on the middle row in another month, widening the plan", () => {
    // In January 2027 the middle row is free, but a middle-row objective exists (Y, starting 2026-08-01),
    // so the range is +2w..+6w after that start rather than the calendar month.
    const result = mustOk(planBacklogObjective(db, { programId: p.id, number: x.number, actorUserId: plannerId, today: "2027-01-15" }), "plan x");
    expect(reload(p.id, x.number)).toMatchObject({ status: "PLANNED", position: 1, verticalPosition: 6, startAt: "2026-08-15", endAt: "2026-09-12" });
    expect(result.planWidened).toBeNull();
    expect(orderOf(p.id, "BACKLOG")).toEqual([]);

    // A backlog item planned far outside the window widens it.
    const q = program("Quarters", "quarters");
    const w = backlogItem(q.id, "W");
    const far = mustOk(planBacklogObjective(db, { programId: q.id, number: w.number, actorUserId: plannerId, today: "2030-03-10" }), "far");
    expect(far.planWidened).toEqual({ startAt: "2026-07-28", endAt: "2030-03-31" });
    expect(planOf(q.id)).toEqual({ startAt: "2026-07-28", endAt: "2030-03-31" });
  });

  it("rejects an already planned objective, an unknown number and an outsider — nothing written", () => {
    const q = program("Refusals", "refusals");
    const item = backlogItem(q.id, "Item");
    const events = eventCount();
    expect(mustReject(planBacklogObjective(db, { programId: p.id, number: y.number, actorUserId: plannerId }), "planned").objective).toEqual(["is already planned"]);
    expect(mustReject(planBacklogObjective(db, { programId: q.id, number: 55, actorUserId: plannerId }), "unknown").objective).toEqual(["does not exist"]);
    expect(mustReject(planBacklogObjective(db, { programId: q.id, number: item.number, actorUserId: outsiderId }), "outsider").authorization).toEqual([expect.stringContaining("access to this program")]);
    expect(reload(q.id, item.number)).toMatchObject({ status: "BACKLOG", position: 1, version: 1 });
    expect(eventCount()).toBe(events);
  });
});

describe("backlog routes (real route modules)", () => {
  const p = program("Routed", "routed");

  interface Outcome {
    status: number;
    location: string | null;
    data: unknown;
  }

  async function cookieFor(userId: number): Promise<string> {
    return (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
  }

  async function run(
    fn: (args: never) => Promise<unknown>,
    userId: number | null,
    path: string,
    params: Record<string, string>,
    fields?: Record<string, string> | URLSearchParams,
  ): Promise<Outcome> {
    const headers: Record<string, string> = {};
    if (userId !== null) headers.Cookie = await cookieFor(userId);
    let body: URLSearchParams | undefined;
    if (fields) {
      body = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const request = new Request(`http://localhost${path}`, { method: fields ? "POST" : "GET", headers, body });
    try {
      const result = (await fn({ request, params, context: {} } as never)) as { data?: unknown; init?: { status?: number } | null };
      return { status: result?.init?.status ?? 200, location: null, data: result?.init === undefined ? result : result.data };
    } catch (thrown) {
      if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location"), data: null };
      throw thrown;
    }
  }

  interface BacklogData {
    program: { identifier: string };
    backlog: { number: number; name: string; position: number }[];
    canPlan: boolean;
  }
  interface ErrorData {
    ok: false;
    errors: Record<string, string[]>;
  }

  const params = { identifier: "routed" };
  const path = "/programs/routed/backlog";

  it("anonymous requests redirect to login; an unknown program is a 404", async () => {
    const anon = await run(backlogRoute.loader, null, path, params);
    expect(anon.status).toBe(302);
    expect(anon.location).toMatch(/^\/login/);
    expect((await run(backlogRoute.loader, plannerId, "/programs/nope/backlog", { identifier: "nope" })).status).toBe(404);
  });

  it("the create form persists items top-first; the page lists them in order with role-aware flags", async () => {
    for (const name of ["First", "Second", "Third"]) {
      const created = await run(backlogRoute.action, plannerId, path, params, { intent: "create", name, value_statement: "", size: "2", value: "" });
      expect(created).toMatchObject({ status: 302, location: path });
    }
    const page = (await run(backlogRoute.loader, plannerId, path, params)).data as BacklogData;
    expect(page.backlog.map((i) => [i.name, i.position])).toEqual([["Third", 1], ["Second", 2], ["First", 3]]);
    expect(page.canPlan).toBe(true);
    const outsiderView = (await run(backlogRoute.loader, outsiderId, path, params)).data as BacklogData;
    expect(outsiderView.canPlan).toBe(false);

    const bad = await run(backlogRoute.action, plannerId, path, params, { intent: "create", name: "first", value_statement: "", size: "", value: "" });
    expect(bad.status).toBe(400);
    expect((bad.data as ErrorData).errors.name).toEqual(["already used for an existing Objective in your Program."]);
  });

  it("the reorder form persists the sequence from `order` or repeated `number` fields, and refuses bad input", async () => {
    const [third, second, first] = backlogObjectives(db, p.id).map((i) => i.number);
    const byOrder = await run(backlogRoute.action, plannerId, path, params, { intent: "reorder", order: `${first}, ${third} ${second}` });
    expect(byOrder).toMatchObject({ status: 302, location: path });
    expect(orderOf(p.id, "BACKLOG")).toEqual([[first, 1], [third, 2], [second, 3]]);

    const fields = new URLSearchParams([["intent", "reorder"], ["number", String(second)], ["number", String(first)], ["number", String(third)]]);
    const toTop = await run(backlogRoute.action, plannerId, path, params, fields);
    expect(toTop.status).toBe(302);
    expect(orderOf(p.id, "BACKLOG")).toEqual([[second, 1], [first, 2], [third, 3]]);

    const garbage = await run(backlogRoute.action, plannerId, path, params, { intent: "reorder", order: "one,two" });
    expect(garbage.status).toBe(400);
    expect((garbage.data as ErrorData).errors.numbers).toEqual(["must be objective numbers"]);
    const unknown = await run(backlogRoute.action, plannerId, path, params, { intent: "reorder", order: "999" });
    expect(unknown.status).toBe(400);
    expect((unknown.data as ErrorData).errors.numbers).toEqual(["is not in the backlog: 999"]);
    const refused = await run(backlogRoute.action, outsiderId, path, params, { intent: "reorder", order: String(third) });
    expect(refused.status).toBe(400);
    expect(orderOf(p.id, "BACKLOG")).toEqual([[second, 1], [first, 2], [third, 3]]);
    expect((await run(backlogRoute.action, plannerId, path, params, { intent: "explode" })).status).toBe(400);
  });

  it("the objective page edits a backlog item without dates and plans it; the backlog page plans too", async () => {
    const [second, first, third] = backlogObjectives(db, p.id).map((i) => i.number);
    const objectivePath = `/programs/routed/objectives/${first}`;
    const objectiveParams = { identifier: "routed", number: String(first) };
    const edited = await run(objectiveRoute.action, plannerId, objectivePath, objectiveParams, { intent: "update", name: "First!", value_statement: "v", size: "2", value: "9" });
    expect(edited).toMatchObject({ status: 302, location: objectivePath });
    expect(reload(p.id, first)).toMatchObject({ name: "First!", value: 9, status: "BACKLOG", position: 2, version: 2 });

    const plannedFromPage = await run(objectiveRoute.action, plannerId, objectivePath, objectiveParams, { intent: "plan" });
    expect(plannedFromPage).toMatchObject({ status: 302, location: "/programs/routed" });
    expect(reload(p.id, first)).toMatchObject({ status: "PLANNED", position: 1 });
    expect(orderOf(p.id, "BACKLOG")).toEqual([[second, 1], [third, 2]]);

    const plannedFromBacklog = await run(backlogRoute.action, plannerId, path, params, { intent: "plan", number: String(third) });
    expect(plannedFromBacklog).toMatchObject({ status: 302, location: "/programs/routed" });
    expect(orderOf(p.id, "BACKLOG")).toEqual([[second, 1]]);
    expect(orderOf(p.id, "PLANNED").map(([n]) => n)).toEqual([third, first]);

    const again = await run(backlogRoute.action, plannerId, path, params, { intent: "plan", number: String(third) });
    expect(again.status).toBe(400);
    expect((again.data as ErrorData).errors.objective).toEqual(["is already planned"]);
  });
});
