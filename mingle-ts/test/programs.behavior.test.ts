/**
 * Behavioral tests for programs, plans and objectives (Phase 26).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * `createProgram`, `updateProgramSettings`, `deleteProgram`,
 * `addProgramProject`, `removeProgramProject`, `updatePlan`,
 * `createObjective`, `updateObjective`, `deleteObjective`,
 * `addProgramMember` and `removeProgramMember`: every DOES asserts on
 * rows reloaded from the database — the program, plan, link,
 * membership and objective rows, the version trail, the domain event
 * — never on a return value alone, and every REJECTS WHEN has its own
 * test that also proves nothing was written. Includes the phase's exit
 * criterion: creating a program, adding two member projects and
 * defining an objective with a date range persists and is queryable
 * per program against real rows.
 *
 * The route section drives the real route modules with a Request
 * carrying a real session cookie (the Phase 21 recipe).
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

const dir = mkdtempSync(join(tmpdir(), "mingle-programs-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "programs-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const listRoute = await import("../app/routes/programs");
const programRoute = await import("../app/routes/programs.program");
const objectiveRoute = await import("../app/routes/programs.objectives.show");
const teamRoute = await import("../app/routes/programs.team");
const settingsRoute = await import("../app/routes/programs.settings");

const { projects } = await import("../app/db/schema/projects");
const { programMemberships } = await import("../app/db/schema/membership");
const { objectives, objectiveVersions, plans, programProjects, programs } = await import(
  "../app/db/schema/programs"
);
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addProgramMember, removeProgramMember } = await import("../app/domain/identity/program-membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { addProgramProject, createProgram, deleteProgram, removeProgramProject, updateProgramSettings } =
  await import("../app/domain/programs/commands.server");
const { createObjective, deleteObjective, updateObjective } = await import("../app/domain/programs/objectives.server");
const { defaultPlanWindow, updatePlan } = await import("../app/domain/programs/plan.server");
const { addMonths, isoDateError } = await import("../app/domain/programs/dates.server");
const {
  addableProjects,
  findObjectiveByNumber,
  findProgramByIdentifier,
  listPrograms,
  objectiveHistory,
  programMembers,
  programOverview,
} = await import("../app/domain/programs/read.server");
const { privilegeLevelForProgram, PrivilegeLevel } = await import("../app/domain/identity/authorization.server");

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
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "programs-26!" }),
    login,
  ).id;
}

// The first registered user is the site admin (install parity).
const adminId = register("admin");
const plannerId = register("planner"); // program member of `portfolio`
const leadId = register("lead"); //       program admin of `portfolio`
const outsiderId = register("outsider"); // registered, on no program

function project(name: string, identifier: string) {
  const row = mustOk(createProject(db, { name, identifier, actorUserId: adminId }), name);
  return { id: row.id, identifier: row.identifier, name: row.name };
}

const alpha = project("Alpha", "alpha");
const beta = project("Beta", "beta");
const gamma = project("Gamma", "gamma");

const TODAY = "2026-08-28";

function program(name: string, identifier?: string) {
  return mustOk(createProgram(db, { name, identifier, actorUserId: adminId, today: TODAY }), name);
}

function reloadProgram(id: number) {
  return db.select().from(programs).where(eq(programs.id, id)).get();
}

function planOf(programId: number) {
  return db.select().from(plans).where(eq(plans.programId, programId)).get();
}

function memberProjectIds(programId: number): number[] {
  return db
    .select({ projectId: programProjects.projectId })
    .from(programProjects)
    .where(eq(programProjects.programId, programId))
    .orderBy(asc(programProjects.projectId))
    .all()
    .map((row) => row.projectId);
}

function membershipOf(programId: number, userId: number) {
  return db
    .select()
    .from(programMemberships)
    .where(and(eq(programMemberships.programId, programId), eq(programMemberships.userId, userId)))
    .get();
}

function reloadObjective(programId: number, number: number) {
  return db
    .select()
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.number, number)))
    .get();
}

/** The program's PLANNED objectives as [number, position], in position order. */
function plannedOrder(programId: number): [number, number][] {
  return db
    .select({ number: objectives.number, position: objectives.position })
    .from(objectives)
    .where(and(eq(objectives.programId, programId), eq(objectives.status, "PLANNED")))
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
      startAt: objectiveVersions.startAt,
      endAt: objectiveVersions.endAt,
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

// ── The shared program: admin creates it, lead administers, planner plans ──
const portfolio = program("Portfolio 2026", "portfolio");
mustOk(addProgramMember(db, { programId: portfolio.id, userId: leadId, role: "program_admin", actorUserId: adminId }), "lead");
mustOk(addProgramMember(db, { programId: portfolio.id, userId: plannerId, actorUserId: adminId }), "planner");

describe("date helpers", () => {
  it("validates real calendar dates only", () => {
    expect(isoDateError("")).toBe("can't be blank");
    expect(isoDateError("2026/08/28")).toBe("is not a valid date");
    expect(isoDateError("2026-02-30")).toBe("is not a valid date");
    expect(isoDateError("2026-02-28")).toBeNull();
  });

  it("clamps month arithmetic to the target month's length", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-08-28", 11)).toBe("2027-07-28");
    expect(defaultPlanWindow("2026-08-28")).toEqual({ startAt: "2026-07-28", endAt: "2027-07-28" });
  });
});

describe("createProgram", () => {
  it("persists the program, its plan with the default window, and the creator as program admin", () => {
    const row = program("Growth Initiative");
    const reloaded = reloadProgram(row.id)!;
    expect(reloaded.name).toBe("Growth Initiative");
    expect(reloaded.identifier).toBe("growth_initiative");
    expect(reloaded.createdByUserId).toBe(adminId);
    expect(planOf(row.id)).toMatchObject({ startAt: "2026-07-28", endAt: "2027-07-28", precision: 2 });
    expect(membershipOf(row.id, adminId)?.role).toBe("program_admin");
    expect(eventsFor(row.id)).toEqual([
      {
        type: "ProgramCreated",
        payload: { name: "Growth Initiative", identifier: "growth_initiative", plan: { startAt: "2026-07-28", endAt: "2027-07-28" } },
      },
    ]);
  });

  it("squishes the name before storing it", () => {
    const row = program("  Squished   Name  ");
    expect(reloadProgram(row.id)!.name).toBe("Squished Name");
    expect(reloadProgram(row.id)!.identifier).toBe("squished_name");
  });

  it("rejects a non-admin actor and writes nothing", () => {
    const before = db.select({ id: programs.id }).from(programs).all().length;
    const errors = mustReject(createProgram(db, { name: "Rogue", actorUserId: leadId }), "non-admin create");
    expect(errors.authorization).toEqual(["requires Mingle administrator access"]);
    expect(db.select({ id: programs.id }).from(programs).all().length).toBe(before);
  });

  it("rejects a blank name, a case-insensitively taken name, and a bad or taken identifier", () => {
    expect(mustReject(createProgram(db, { name: "   ", actorUserId: adminId }), "blank").name).toEqual(["can't be blank"]);
    expect(mustReject(createProgram(db, { name: "PORTFOLIO 2026", actorUserId: adminId }), "taken").name).toEqual([
      "has already been taken",
    ]);
    expect(
      mustReject(createProgram(db, { name: "Fresh", identifier: "9lives", actorUserId: adminId }), "digit").identifier,
    ).toEqual(["may not start with a digit"]);
    expect(
      mustReject(createProgram(db, { name: "Fresh", identifier: "Bad-Slug", actorUserId: adminId }), "format").identifier,
    ).toEqual(["may contain only lower case letters, numbers and underscore ('_')"]);
    expect(
      mustReject(createProgram(db, { name: "Fresh", identifier: "portfolio", actorUserId: adminId }), "taken id").identifier,
    ).toEqual(["has already been taken"]);
    expect(findProgramByIdentifier(db, "fresh")).toBeUndefined();
  });
});

describe("createProgram (generated identifier collision)", () => {
  it("suffixes a colliding generated identifier", () => {
    const row = mustOk(createProgram(db, { name: "Growth-Initiative", actorUserId: adminId, today: TODAY }), "collide");
    expect(reloadProgram(row.id)!.identifier).toBe("growth_initiative2");
  });
});

describe("updateProgramSettings", () => {
  it("persists changed fields and names them in the event; program admin suffices", () => {
    const row = program("Rename Me", "rename_me");
    mustOk(addProgramMember(db, { programId: row.id, userId: leadId, role: "program_admin", actorUserId: adminId }), "lead");
    mustOk(
      updateProgramSettings(db, { programId: row.id, name: "Renamed", identifier: "renamed", description: "now", actorUserId: leadId }),
      "update",
    );
    expect(reloadProgram(row.id)).toMatchObject({ name: "Renamed", identifier: "renamed", description: "now" });
    expect(eventsFor(row.id).at(-1)).toEqual({
      type: "ProgramSettingsUpdated",
      payload: { changed: ["name", "identifier", "description"] },
    });
  });

  it("writes nothing and emits nothing when the stored values are submitted", () => {
    const before = eventCount();
    const row = reloadProgram(portfolio.id)!;
    mustOk(
      updateProgramSettings(db, { programId: portfolio.id, name: "Portfolio 2026", identifier: "portfolio", actorUserId: leadId }),
      "no-op",
    );
    expect(eventCount()).toBe(before);
    expect(reloadProgram(portfolio.id)).toEqual(row);
  });

  it("rejects a program member, and a name taken by another program", () => {
    expect(
      mustReject(
        updateProgramSettings(db, { programId: portfolio.id, name: "X", identifier: "portfolio", actorUserId: plannerId }),
        "member",
      ).authorization,
    ).toEqual(["requires Program administrator access to this program"]);
    expect(
      mustReject(
        updateProgramSettings(db, { programId: portfolio.id, name: "renamed", identifier: "portfolio", actorUserId: leadId }),
        "taken",
      ).name,
    ).toEqual(["has already been taken"]);
    expect(reloadProgram(portfolio.id)!.name).toBe("Portfolio 2026");
  });
});

describe("addProgramProject / removeProgramProject", () => {
  it("persists the membership link and rejects a duplicate", () => {
    mustOk(addProgramProject(db, { programId: portfolio.id, projectId: alpha.id, actorUserId: leadId }), "add alpha");
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id]);
    expect(eventsFor(portfolio.id).at(-1)).toEqual({ type: "ProjectAddedToProgram", payload: { projectId: alpha.id } });
    expect(
      mustReject(addProgramProject(db, { programId: portfolio.id, projectId: alpha.id, actorUserId: leadId }), "dup").project,
    ).toEqual(["is already a member of this program"]);
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id]);
  });

  it("rejects an unknown project and a program member (not admin) without writing", () => {
    expect(
      mustReject(addProgramProject(db, { programId: portfolio.id, projectId: 9999, actorUserId: leadId }), "unknown").project,
    ).toEqual(["does not exist"]);
    expect(
      mustReject(addProgramProject(db, { programId: portfolio.id, projectId: beta.id, actorUserId: plannerId }), "member")
        .authorization,
    ).toEqual(["requires Program administrator access to this program"]);
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id]);
  });

  it("removes the link and rejects removing a non-member", () => {
    mustOk(addProgramProject(db, { programId: portfolio.id, projectId: gamma.id, actorUserId: adminId }), "add gamma");
    mustOk(removeProgramProject(db, { programId: portfolio.id, projectId: gamma.id, actorUserId: leadId }), "remove gamma");
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id]);
    expect(eventsFor(portfolio.id).at(-1)).toEqual({ type: "ProjectRemovedFromProgram", payload: { projectId: gamma.id } });
    expect(
      mustReject(removeProgramProject(db, { programId: portfolio.id, projectId: gamma.id, actorUserId: leadId }), "again").project,
    ).toEqual(["is not a member of this program"]);
    expect(addableProjects(db, portfolio.id).map((p) => p.identifier)).toEqual(["beta", "gamma"]);
  });
});

describe("updatePlan", () => {
  it("persists the window for a program member and emits PlanUpdated", () => {
    mustOk(updatePlan(db, { programId: portfolio.id, startAt: "2026-01-01", endAt: "2026-12-31", actorUserId: plannerId }), "move");
    expect(planOf(portfolio.id)).toMatchObject({ startAt: "2026-01-01", endAt: "2026-12-31" });
    expect(eventsFor(portfolio.id).at(-1)).toEqual({ type: "PlanUpdated", payload: { startAt: "2026-01-01", endAt: "2026-12-31" } });
  });

  it("writes nothing on an unchanged window", () => {
    const before = eventCount();
    mustOk(updatePlan(db, { programId: portfolio.id, startAt: "2026-01-01", endAt: "2026-12-31", actorUserId: plannerId }), "same");
    expect(eventCount()).toBe(before);
  });

  it("rejects an end before the start, an invalid date, and an outsider — window untouched", () => {
    expect(
      mustReject(updatePlan(db, { programId: portfolio.id, startAt: "2026-06-01", endAt: "2026-05-31", actorUserId: plannerId }), "order")
        .end_at,
    ).toEqual(["should be after start date"]);
    expect(
      mustReject(updatePlan(db, { programId: portfolio.id, startAt: "2026-13-01", endAt: "2026-12-31", actorUserId: plannerId }), "bad")
        .start_at,
    ).toEqual(["is not a valid date"]);
    expect(
      mustReject(updatePlan(db, { programId: portfolio.id, startAt: "2026-01-01", endAt: "2026-12-30", actorUserId: outsiderId }), "outsider")
        .authorization,
    ).toEqual(["requires Program member access to this program"]);
    expect(planOf(portfolio.id)).toMatchObject({ startAt: "2026-01-01", endAt: "2026-12-31" });
  });
});

describe("createObjective", () => {
  it("persists the objective at the top position with number 1, identifier from the name, a version-1 trail row, and the event", () => {
    const { objective, planWidened } = mustOk(
      createObjective(db, {
        programId: portfolio.id,
        name: "  Launch   Mobile App ",
        valueStatement: "Reach mobile users",
        startAt: "2026-03-01",
        endAt: "2026-06-30",
        actorUserId: plannerId,
      }),
      "first objective",
    );
    expect(planWidened).toBeNull();
    const row = reloadObjective(portfolio.id, 1)!;
    expect(row).toMatchObject({
      id: objective.id,
      number: 1,
      name: "Launch Mobile App",
      identifier: "launch_mobile_app",
      valueStatement: "Reach mobile users",
      startAt: "2026-03-01",
      endAt: "2026-06-30",
      verticalPosition: 6,
      size: 0,
      value: 0,
      status: "PLANNED",
      position: 1,
      version: 1,
      modifiedByUserId: plannerId,
    });
    expect(trail(row.id)).toEqual([
      {
        version: 1,
        name: "Launch Mobile App",
        identifier: "launch_mobile_app",
        startAt: "2026-03-01",
        endAt: "2026-06-30",
        isDeletion: false,
        modifiedByUserId: plannerId,
      },
    ]);
    expect(eventsFor(portfolio.id).at(-1)).toEqual({
      type: "ObjectiveCreated",
      payload: { number: 1, name: "Launch Mobile App", startAt: "2026-03-01", endAt: "2026-06-30", planWidened: null },
    });
  });

  it("puts a second objective on top, shifting the first down, and widens the plan to fit its range", () => {
    const { planWidened } = mustOk(
      createObjective(db, {
        programId: portfolio.id,
        name: "Expand to EU",
        startAt: "2026-10-01",
        endAt: "2027-03-31",
        verticalPosition: 2,
        size: 8,
        value: 13,
        actorUserId: plannerId,
      }),
      "second objective",
    );
    expect(planWidened).toEqual({ startAt: "2026-01-01", endAt: "2027-03-31" });
    expect(planOf(portfolio.id)).toMatchObject({ startAt: "2026-01-01", endAt: "2027-03-31" });
    expect(plannedOrder(portfolio.id)).toEqual([
      [2, 1],
      [1, 2],
    ]);
    expect(reloadObjective(portfolio.id, 2)).toMatchObject({ identifier: "expand_to_eu", verticalPosition: 2, size: 8, value: 13 });
  });

  it("rejects each field rule and an outsider, writing nothing", () => {
    const base = { programId: portfolio.id, startAt: "2026-04-01", endAt: "2026-05-01", actorUserId: plannerId };
    const before = plannedOrder(portfolio.id);
    expect(mustReject(createObjective(db, { ...base, name: "  " }), "blank").name).toEqual(["can't be blank"]);
    expect(mustReject(createObjective(db, { ...base, name: "x".repeat(81) }), "long").name).toEqual([
      "is too long (maximum is 80 characters)",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "LAUNCH MOBILE APP" }), "dup").name).toEqual([
      "already used for an existing Objective in your Program.",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "New", startAt: "" }), "no start").start_at).toEqual(["can't be blank"]);
    expect(mustReject(createObjective(db, { ...base, name: "New", endAt: "2026-03-31" }), "order").end_at).toEqual([
      "should be after start date",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "New", verticalPosition: 15 }), "row").vertical_position).toEqual([
      "must be a row between 1 and 14",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "New", size: -1 }), "size").size).toEqual([
      "must be a whole number of 0 or more",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "New", value: 1.5 }), "value").value).toEqual([
      "must be a whole number of 0 or more",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "New", actorUserId: outsiderId }), "outsider").authorization).toEqual([
      "requires Program member access to this program",
    ]);
    expect(mustReject(createObjective(db, { ...base, name: "New", programId: 9999 }), "no program").program).toEqual([
      "does not exist",
    ]);
    expect(plannedOrder(portfolio.id)).toEqual(before);
    expect(reloadObjective(portfolio.id, 3)).toBeUndefined();
  });

  it("allows equal start and end dates and prefixes an identifier that would start with a digit", () => {
    const { objective } = mustOk(
      createObjective(db, { programId: portfolio.id, name: "2027 kickoff", startAt: "2027-01-04", endAt: "2027-01-04", actorUserId: leadId }),
      "same-day",
    );
    expect(reloadObjective(portfolio.id, objective.number)).toMatchObject({ identifier: "objective_2027_kickoff", number: 3 });
    mustOk(deleteObjective(db, { programId: portfolio.id, number: 3, actorUserId: leadId }), "tidy");
  });
});

describe("updateObjective", () => {
  it("persists the changes, regenerates the identifier on rename, appends version 2, and widens the plan", () => {
    const { objective, planWidened } = mustOk(
      updateObjective(db, {
        programId: portfolio.id,
        number: 1,
        name: "Launch Mobile App v2",
        valueStatement: "Reach mobile users",
        startAt: "2025-12-01",
        endAt: "2026-06-30",
        verticalPosition: 4,
        size: 5,
        value: 8,
        actorUserId: leadId,
      }),
      "update",
    );
    expect(planWidened).toEqual({ startAt: "2025-12-01", endAt: "2027-03-31" });
    expect(planOf(portfolio.id)).toMatchObject({ startAt: "2025-12-01", endAt: "2027-03-31" });
    const row = reloadObjective(portfolio.id, 1)!;
    expect(row).toMatchObject({
      id: objective.id,
      name: "Launch Mobile App v2",
      identifier: "launch_mobile_app_v2",
      startAt: "2025-12-01",
      verticalPosition: 4,
      size: 5,
      value: 8,
      version: 2,
      modifiedByUserId: leadId,
      position: 2,
    });
    expect(trail(row.id).map((v) => [v.version, v.identifier, v.startAt])).toEqual([
      [1, "launch_mobile_app", "2026-03-01"],
      [2, "launch_mobile_app_v2", "2025-12-01"],
    ]);
    expect(eventsFor(portfolio.id).at(-1)).toEqual({
      type: "ObjectiveUpdated",
      payload: {
        number: 1,
        changed: ["name", "startAt", "verticalPosition", "size", "value"],
        planWidened: { startAt: "2025-12-01", endAt: "2027-03-31" },
      },
    });
  });

  it("appends no version and no event when the stored values are submitted", () => {
    const before = eventCount();
    mustOk(
      updateObjective(db, {
        programId: portfolio.id,
        number: 1,
        name: "Launch Mobile App v2",
        valueStatement: "Reach mobile users",
        startAt: "2025-12-01",
        endAt: "2026-06-30",
        verticalPosition: 4,
        size: 5,
        value: 8,
        actorUserId: plannerId,
      }),
      "no-op",
    );
    expect(eventCount()).toBe(before);
    expect(reloadObjective(portfolio.id, 1)!.version).toBe(2);
  });

  it("rejects taking another objective's name, an unknown objective, and an outsider — row untouched", () => {
    const base = { programId: portfolio.id, number: 1, startAt: "2025-12-01", endAt: "2026-06-30", actorUserId: plannerId };
    expect(mustReject(updateObjective(db, { ...base, name: "expand to eu" }), "dup").name).toEqual([
      "already used for an existing Objective in your Program.",
    ]);
    expect(mustReject(updateObjective(db, { ...base, number: 99, name: "Any" }), "unknown").objective).toEqual(["does not exist"]);
    expect(mustReject(updateObjective(db, { ...base, name: "Any", actorUserId: outsiderId }), "outsider").authorization).toEqual([
      "requires Program member access to this program",
    ]);
    expect(reloadObjective(portfolio.id, 1)).toMatchObject({ name: "Launch Mobile App v2", version: 2 });
  });
});

describe("deleteObjective", () => {
  it("appends the deletion version, removes the row, compacts positions, and never reuses the number", () => {
    const { objective: third } = mustOk(
      createObjective(db, { programId: portfolio.id, name: "Third", startAt: "2026-05-01", endAt: "2026-05-31", actorUserId: plannerId }),
      "third",
    );
    expect(third.number).toBe(4); // 3 was used and deleted above
    expect(plannedOrder(portfolio.id)).toEqual([
      [4, 1],
      [2, 2],
      [1, 3],
    ]);
    const secondId = reloadObjective(portfolio.id, 2)!.id;
    mustOk(deleteObjective(db, { programId: portfolio.id, number: 2, actorUserId: leadId }), "delete #2");
    expect(reloadObjective(portfolio.id, 2)).toBeUndefined();
    expect(plannedOrder(portfolio.id)).toEqual([
      [4, 1],
      [1, 2],
    ]);
    expect(trail(secondId).map((v) => [v.version, v.isDeletion, v.modifiedByUserId])).toEqual([
      [1, false, plannerId],
      [2, true, leadId],
    ]);
    expect(eventsFor(portfolio.id).at(-1)).toEqual({ type: "ObjectiveDeleted", payload: { number: 2, name: "Expand to EU" } });
    const { objective: next } = mustOk(
      createObjective(db, { programId: portfolio.id, name: "Fifth", startAt: "2026-05-01", endAt: "2026-05-31", actorUserId: plannerId }),
      "fifth",
    );
    expect(next.number).toBe(5);
    mustOk(deleteObjective(db, { programId: portfolio.id, number: 5, actorUserId: adminId }), "tidy");
  });

  it("rejects a program member and an unknown number without writing", () => {
    expect(mustReject(deleteObjective(db, { programId: portfolio.id, number: 1, actorUserId: plannerId }), "member").authorization).toEqual([
      "requires Program administrator access to this program",
    ]);
    expect(mustReject(deleteObjective(db, { programId: portfolio.id, number: 42, actorUserId: leadId }), "unknown").objective).toEqual([
      "does not exist",
    ]);
    expect(reloadObjective(portfolio.id, 1)).toBeDefined();
  });
});

describe("program membership", () => {
  it("persists a member with the default role and computes the privilege ladder from it", () => {
    const row = program("Membership Program", "membership");
    mustOk(addProgramMember(db, { programId: row.id, userId: plannerId, actorUserId: adminId }), "add");
    expect(membershipOf(row.id, plannerId)?.role).toBe("program_member");
    expect(privilegeLevelForProgram(db, plannerId, row.id)).toBe(PrivilegeLevel.FULL_TEAM_MEMBER);
    expect(privilegeLevelForProgram(db, outsiderId, row.id)).toBe(PrivilegeLevel.REGISTERED_USER);
    expect(privilegeLevelForProgram(db, adminId, row.id)).toBe(PrivilegeLevel.MINGLE_ADMIN);
    expect(privilegeLevelForProgram(db, 424242, row.id)).toBe(PrivilegeLevel.ANONYMOUS);
    expect(eventsFor(row.id).at(-1)).toEqual({ type: "ProgramMemberAdded", payload: { userId: plannerId, role: "program_member" } });
    expect(programMembers(db, row.id).map((m) => [m.login, m.role])).toEqual([
      ["admin", "program_admin"],
      ["planner", "program_member"],
    ]);
  });

  it("rejects an invalid role, a duplicate, an unknown user, and a member acting as admin", () => {
    const row = findProgramByIdentifier(db, "membership")!;
    expect(mustReject(addProgramMember(db, { programId: row.id, userId: leadId, role: "owner", actorUserId: adminId }), "role").role).toEqual([
      "is not a valid role",
    ]);
    expect(mustReject(addProgramMember(db, { programId: row.id, userId: plannerId, actorUserId: adminId }), "dup").user).toEqual([
      "is already a member of this program",
    ]);
    expect(mustReject(addProgramMember(db, { programId: row.id, userId: 9999, actorUserId: adminId }), "unknown").user).toEqual([
      "does not exist",
    ]);
    expect(mustReject(addProgramMember(db, { programId: row.id, userId: leadId, actorUserId: plannerId }), "member").authorization).toEqual([
      "requires Program administrator access to this program",
    ]);
    expect(membershipOf(row.id, leadId)).toBeUndefined();
  });

  it("removes a member, refuses self-removal by a non-site-admin, and allows it for a site admin", () => {
    const row = findProgramByIdentifier(db, "membership")!;
    mustOk(addProgramMember(db, { programId: row.id, userId: leadId, role: "program_admin", actorUserId: adminId }), "lead");
    expect(mustReject(removeProgramMember(db, { programId: row.id, userId: leadId, actorUserId: leadId }), "self").user).toEqual([
      "Cannot remove yourself from program.",
    ]);
    expect(membershipOf(row.id, leadId)).toBeDefined();
    mustOk(removeProgramMember(db, { programId: row.id, userId: plannerId, actorUserId: leadId }), "remove planner");
    expect(membershipOf(row.id, plannerId)).toBeUndefined();
    expect(eventsFor(row.id).at(-1)).toEqual({ type: "ProgramMemberRemoved", payload: { userId: plannerId } });
    expect(mustReject(removeProgramMember(db, { programId: row.id, userId: plannerId, actorUserId: leadId }), "again").user).toEqual([
      "is not a member of this program",
    ]);
    mustOk(removeProgramMember(db, { programId: row.id, userId: adminId, actorUserId: adminId }), "admin self-removal");
    expect(membershipOf(row.id, adminId)).toBeUndefined();
  });
});

describe("deleteProgram", () => {
  it("removes the program, plan, links and memberships, keeps objective deletion versions, leaves projects alone", () => {
    const row = program("Doomed", "doomed");
    mustOk(addProgramProject(db, { programId: row.id, projectId: beta.id, actorUserId: adminId }), "beta");
    mustOk(addProgramMember(db, { programId: row.id, userId: plannerId, actorUserId: adminId }), "planner");
    const { objective } = mustOk(
      createObjective(db, { programId: row.id, name: "Goal", startAt: "2026-09-01", endAt: "2026-09-30", actorUserId: plannerId }),
      "goal",
    );
    expect(mustReject(deleteProgram(db, { programId: row.id, actorUserId: plannerId }), "member").authorization).toEqual([
      "requires Mingle administrator access",
    ]);
    expect(reloadProgram(row.id)).toBeDefined();

    mustOk(deleteProgram(db, { programId: row.id, actorUserId: adminId }), "delete");
    expect(reloadProgram(row.id)).toBeUndefined();
    expect(planOf(row.id)).toBeUndefined();
    expect(memberProjectIds(row.id)).toEqual([]);
    expect(programMembers(db, row.id)).toEqual([]);
    expect(db.select().from(objectives).where(eq(objectives.programId, row.id)).all()).toEqual([]);
    expect(trail(objective.id).map((v) => [v.version, v.isDeletion])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(db.select({ id: projects.id }).from(projects).where(eq(projects.id, beta.id)).get()).toBeDefined();
    expect(eventsFor(row.id).at(-1)).toEqual({
      type: "ProgramDeleted",
      payload: { name: "Doomed", identifier: "doomed", objectiveNumbers: [1] },
    });
    expect(mustReject(deleteProgram(db, { programId: row.id, actorUserId: adminId }), "again").program).toEqual(["does not exist"]);
  });
});

describe("Phase 26 exit criterion", () => {
  it("a program with two member projects and a dated objective persists and is queryable per program", () => {
    const row = program("Exit Criterion", "exit");
    mustOk(addProgramProject(db, { programId: row.id, projectId: alpha.id, actorUserId: adminId }), "alpha");
    mustOk(addProgramProject(db, { programId: row.id, projectId: gamma.id, actorUserId: adminId }), "gamma");
    mustOk(
      createObjective(db, {
        programId: row.id,
        name: "Ship the thing",
        startAt: "2026-09-01",
        endAt: "2026-11-30",
        actorUserId: adminId,
      }),
      "objective",
    );

    // Real rows, scoped to this program only.
    expect(memberProjectIds(row.id)).toEqual([alpha.id, gamma.id]);
    expect(db.select().from(objectives).where(eq(objectives.programId, row.id)).all()).toHaveLength(1);
    expect(reloadObjective(row.id, 1)).toMatchObject({ name: "Ship the thing", startAt: "2026-09-01", endAt: "2026-11-30" });

    // And the read model the program page uses agrees, per program.
    const overview = programOverview(db, row.id)!;
    expect(overview.projects.map((p) => p.identifier)).toEqual(["alpha", "gamma"]);
    expect(overview.objectives.map((o) => [o.number, o.name, o.startAt, o.endAt])).toEqual([
      [1, "Ship the thing", "2026-09-01", "2026-11-30"],
    ]);
    expect(overview.plan).toMatchObject({ startAt: "2026-07-28", endAt: "2027-07-28" });
    // Portfolio's objectives are not visible through this program.
    expect(findObjectiveByNumber(db, row.id, 4)).toBeUndefined();
    expect(listPrograms(db).find((p) => p.identifier === "exit")).toMatchObject({ projectCount: 2, objectiveCount: 1 });
  });
});

describe("program read model", () => {
  it("orders objectives PLANNED-first by position and reports history newest first with the modifier", () => {
    const overview = programOverview(db, portfolio.id)!;
    expect(overview.objectives.map((o) => [o.number, o.position])).toEqual([
      [4, 1],
      [1, 2],
    ]);
    const first = reloadObjective(portfolio.id, 1)!;
    const history = objectiveHistory(db, first.id);
    expect(history.map((h) => [h.version, h.modifiedBy?.name])).toEqual([
      [2, "LEAD"],
      [1, "PLANNER"],
    ]);
    expect(programOverview(db, 9999)).toBeUndefined();
  });
});

describe("program routes (real route modules)", () => {
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
    fields?: Record<string, string>,
  ): Promise<Outcome> {
    const headers: Record<string, string> = {};
    if (userId !== null) headers.Cookie = await cookieFor(userId);
    let body: URLSearchParams | undefined;
    if (fields) {
      body = new URLSearchParams(fields);
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

  interface ListData {
    programs: { identifier: string; projectCount: number; objectiveCount: number }[];
    canCreate: boolean;
  }
  interface ProgramData {
    program: { identifier: string };
    plan: { startAt: string; endAt: string };
    projects: { identifier: string }[];
    objectives: { number: number }[];
    addableProjects: { identifier: string }[];
    canPlan: boolean;
    canAdminister: boolean;
  }
  interface ObjectiveData {
    objective: { number: number; name: string; version: number };
    history: { version: number }[];
    canEdit: boolean;
    canDelete: boolean;
  }
  interface TeamData {
    members: { login: string; role: string }[];
    addableUsers: { id: number }[];
    canAdminister: boolean;
  }
  interface SettingsData {
    program: { identifier: string };
    canEdit: boolean;
    canDelete: boolean;
  }
  interface ErrorData {
    ok: false;
    errors: Record<string, string[]>;
  }

  it("anonymous requests redirect to login", async () => {
    const outcome = await run(listRoute.loader, null, "/programs", {});
    expect(outcome.status).toBe(302);
    expect(outcome.location).toContain("/login");
  });

  it("the list shows every program with counts; only a site admin may create", async () => {
    const asAdmin = (await run(listRoute.loader, adminId, "/programs", {})).data as ListData;
    expect(asAdmin.canCreate).toBe(true);
    expect(asAdmin.programs.find((p) => p.identifier === "exit")).toMatchObject({ projectCount: 2, objectiveCount: 1 });
    const asPlanner = (await run(listRoute.loader, plannerId, "/programs", {})).data as ListData;
    expect(asPlanner.canCreate).toBe(false);
  });

  it("the create form persists a program and redirects to it; a member's attempt is a 400 with no row", async () => {
    const outcome = await run(listRoute.action, adminId, "/programs", {}, { intent: "create", name: "Routed Program", identifier: "", description: "" });
    expect(outcome.status).toBe(302);
    expect(outcome.location).toBe("/programs/routed_program");
    expect(findProgramByIdentifier(db, "routed_program")).toMatchObject({ name: "Routed Program", createdByUserId: adminId });
    const denied = await run(listRoute.action, plannerId, "/programs", {}, { intent: "create", name: "Nope", identifier: "", description: "" });
    expect(denied.status).toBe(400);
    expect((denied.data as ErrorData).errors.authorization).toEqual(["requires Mingle administrator access"]);
    expect(findProgramByIdentifier(db, "nope")).toBeUndefined();
  });

  it("the program page loads the overview with role-aware flags, and 404s an unknown program", async () => {
    const asPlanner = (await run(programRoute.loader, plannerId, "/programs/portfolio", { identifier: "portfolio" })).data as ProgramData;
    expect(asPlanner.program.identifier).toBe("portfolio");
    expect(asPlanner.plan).toMatchObject({ startAt: "2025-12-01", endAt: "2027-03-31" });
    expect(asPlanner.projects.map((p) => p.identifier)).toEqual(["alpha"]);
    expect(asPlanner.objectives.map((o) => o.number)).toEqual([4, 1]);
    expect(asPlanner).toMatchObject({ canPlan: true, canAdminister: false, addableProjects: [] });
    const asLead = (await run(programRoute.loader, leadId, "/programs/portfolio", { identifier: "portfolio" })).data as ProgramData;
    expect(asLead.canAdminister).toBe(true);
    expect(asLead.addableProjects.map((p) => p.identifier)).toEqual(["beta", "gamma"]);
    expect((await run(programRoute.loader, plannerId, "/programs/nope", { identifier: "nope" })).status).toBe(404);
  });

  it("program page forms: add/remove project, move plan, create objective — each persists or is refused", async () => {
    const params = { identifier: "portfolio" };
    const added = await run(programRoute.action, leadId, "/programs/portfolio", params, { intent: "add_project", project_id: String(beta.id) });
    expect(added).toMatchObject({ status: 302, location: "/programs/portfolio" });
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id, beta.id]);

    const removed = await run(programRoute.action, leadId, "/programs/portfolio", params, { intent: "remove_project", project_id: String(beta.id) });
    expect(removed.status).toBe(302);
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id]);

    const refused = await run(programRoute.action, plannerId, "/programs/portfolio", params, { intent: "add_project", project_id: String(beta.id) });
    expect(refused.status).toBe(400);
    expect(memberProjectIds(portfolio.id)).toEqual([alpha.id]);

    const moved = await run(programRoute.action, plannerId, "/programs/portfolio", params, { intent: "update_plan", start_at: "2025-11-01", end_at: "2027-03-31" });
    expect(moved.status).toBe(302);
    expect(planOf(portfolio.id)).toMatchObject({ startAt: "2025-11-01", endAt: "2027-03-31" });

    const badPlan = await run(programRoute.action, plannerId, "/programs/portfolio", params, { intent: "update_plan", start_at: "2027-04-01", end_at: "2027-03-31" });
    expect(badPlan.status).toBe(400);
    expect((badPlan.data as ErrorData).errors.end_at).toEqual(["should be after start date"]);

    const created = await run(programRoute.action, plannerId, "/programs/portfolio", params, {
      intent: "create_objective",
      name: "Routed objective",
      value_statement: "",
      start_at: "2026-07-01",
      end_at: "2026-07-31",
      vertical_position: "3",
      size: "",
      value: "2",
    });
    expect(created).toMatchObject({ status: 302, location: "/programs/portfolio/objectives/6" });
    expect(reloadObjective(portfolio.id, 6)).toMatchObject({ name: "Routed objective", verticalPosition: 3, size: 0, value: 2, position: 1 });

    const badObjective = await run(programRoute.action, plannerId, "/programs/portfolio", params, {
      intent: "create_objective", name: "", value_statement: "", start_at: "2026-07-01", end_at: "2026-07-31", vertical_position: "", size: "", value: "",
    });
    expect(badObjective.status).toBe(400);
    expect((badObjective.data as ErrorData).errors.name).toEqual(["can't be blank"]);

    expect((await run(programRoute.action, plannerId, "/programs/portfolio", params, { intent: "explode" })).status).toBe(400);
  });

  it("the objective page loads the row and trail, updates, and deletes (admin only)", async () => {
    const params = { identifier: "portfolio", number: "6" };
    const page = (await run(objectiveRoute.loader, plannerId, "/programs/portfolio/objectives/6", params)).data as ObjectiveData;
    expect(page.objective).toMatchObject({ number: 6, name: "Routed objective", version: 1 });
    expect(page.history.map((h) => h.version)).toEqual([1]);
    expect(page).toMatchObject({ canEdit: true, canDelete: false });
    expect((await run(objectiveRoute.loader, plannerId, "/programs/portfolio/objectives/99", { identifier: "portfolio", number: "99" })).status).toBe(404);

    const updated = await run(objectiveRoute.action, plannerId, "/programs/portfolio/objectives/6", params, {
      intent: "update", name: "Routed objective!", value_statement: "why", start_at: "2026-07-01", end_at: "2026-08-15", vertical_position: "3", size: "1", value: "2",
    });
    expect(updated).toMatchObject({ status: 302, location: "/programs/portfolio/objectives/6" });
    expect(reloadObjective(portfolio.id, 6)).toMatchObject({ name: "Routed objective!", valueStatement: "why", endAt: "2026-08-15", version: 2 });

    const memberDelete = await run(objectiveRoute.action, plannerId, "/programs/portfolio/objectives/6", params, { intent: "delete" });
    expect(memberDelete.status).toBe(400);
    expect(reloadObjective(portfolio.id, 6)).toBeDefined();

    const adminDelete = await run(objectiveRoute.action, leadId, "/programs/portfolio/objectives/6", params, { intent: "delete" });
    expect(adminDelete).toMatchObject({ status: 302, location: "/programs/portfolio" });
    expect(reloadObjective(portfolio.id, 6)).toBeUndefined();
  });

  it("the team page lists members and adds/removes them for administrators", async () => {
    const params = { identifier: "portfolio" };
    const asPlanner = (await run(teamRoute.loader, plannerId, "/programs/portfolio/team", params)).data as TeamData;
    expect(asPlanner.members.map((m) => [m.login, m.role])).toEqual([
      ["admin", "program_admin"],
      ["lead", "program_admin"],
      ["planner", "program_member"],
    ]);
    expect(asPlanner).toMatchObject({ canAdminister: false, addableUsers: [] });

    const added = await run(teamRoute.action, leadId, "/programs/portfolio/team", params, { intent: "add", user_id: String(outsiderId), role: "program_member" });
    expect(added).toMatchObject({ status: 302, location: "/programs/portfolio/team" });
    expect(membershipOf(portfolio.id, outsiderId)?.role).toBe("program_member");

    const refused = await run(teamRoute.action, plannerId, "/programs/portfolio/team", params, { intent: "remove", user_id: String(outsiderId) });
    expect(refused.status).toBe(400);
    expect(membershipOf(portfolio.id, outsiderId)).toBeDefined();

    const removed = await run(teamRoute.action, leadId, "/programs/portfolio/team", params, { intent: "remove", user_id: String(outsiderId) });
    expect(removed.status).toBe(302);
    expect(membershipOf(portfolio.id, outsiderId)).toBeUndefined();
  });

  it("the settings page renames (redirecting to the new identifier) and deletes (site admin only)", async () => {
    const row = program("Settings Program", "settings_program");
    mustOk(addProgramMember(db, { programId: row.id, userId: leadId, role: "program_admin", actorUserId: adminId }), "lead");
    const params = { identifier: "settings_program" };
    const asLead = (await run(settingsRoute.loader, leadId, "/programs/settings_program/settings", params)).data as SettingsData;
    expect(asLead).toMatchObject({ canEdit: true, canDelete: false });

    const renamed = await run(settingsRoute.action, leadId, "/programs/settings_program/settings", params, {
      intent: "update", name: "Settings Program", identifier: "settings_prog", description: "d",
    });
    expect(renamed).toMatchObject({ status: 302, location: "/programs/settings_prog/settings" });
    expect(reloadProgram(row.id)).toMatchObject({ identifier: "settings_prog", description: "d" });

    const leadDelete = await run(settingsRoute.action, leadId, "/programs/settings_prog/settings", { identifier: "settings_prog" }, { intent: "delete" });
    expect(leadDelete.status).toBe(400);
    expect(reloadProgram(row.id)).toBeDefined();

    const adminDelete = await run(settingsRoute.action, adminId, "/programs/settings_prog/settings", { identifier: "settings_prog" }, { intent: "delete" });
    expect(adminDelete).toMatchObject({ status: 302, location: "/programs" });
    expect(reloadProgram(row.id)).toBeUndefined();
    expect((await run(settingsRoute.loader, adminId, "/programs/settings_prog/settings", { identifier: "settings_prog" })).status).toBe(404);
  });
});
