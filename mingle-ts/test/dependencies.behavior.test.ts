/**
 * Behavioral tests for cross-project dependencies (Phase 25).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * `raiseDependency`, `linkResolvingCards`, `unlinkResolvingCard`,
 * `toggleDependencyResolved`, `updateDependency` and
 * `deleteDependency`: every DOES asserts on rows reloaded from the
 * database — the dependency row, its link rows, its version trail,
 * the domain event — never on a return value alone, and every REJECTS
 * WHEN has its own test that also proves nothing was written. Includes
 * the phase's exit criterion: a dependency raised from project A on a
 * card in project B, accepted in B and then resolved, persists the
 * NEW → ACCEPTED → RESOLVED trail and is listed from both projects.
 *
 * The history section pins the fourth trail: the same versions appear
 * in BOTH projects' history feeds, cursors and counts. The route
 * section drives the real route modules with a Request carrying a
 * real session cookie (the Phase 21 recipe).
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Cross-Project Dependencies verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-dependencies-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "dependencies-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const listRoute = await import("../app/routes/projects.dependencies");
const showRoute = await import("../app/routes/projects.dependencies.show");
const cardRoute = await import("../app/routes/projects.cards.card");

const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { dependencies, dependencyResolvingCards, dependencyVersions } = await import(
  "../app/db/schema/dependencies"
);
const { historySubscriptions } = await import("../app/db/schema/subscriptions");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, deleteCard } = await import("../app/domain/cards/commands.server");
const {
  deleteDependency,
  linkResolvingCards,
  raiseDependency,
  recalculatedStatus,
  toggleDependencyResolved,
  unlinkResolvingCard,
  updateDependency,
} = await import("../app/domain/dependencies/commands.server");
const { cardDependencies, dependencyHistory, findDependencyForProject, listDependencies } = await import(
  "../app/domain/dependencies/read.server"
);
const { historyCursor, historyEntriesAfter, projectHistory, projectHistoryCount } = await import(
  "../app/domain/history/read.server"
);
const { subscribe } = await import("../app/domain/subscriptions/commands.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number; //   site admin; creates both projects (not a team member of either)
let devAId: number; //    full member of A only
let devBId: number; //    full member of B only
let bothId: number; //    full member of A and B
let leadAId: number; //   project admin of A
let viewerBId: number; // readonly member of B
let outsiderId: number; // registered, on no team
let alpha: { id: number; identifier: string; name: string };
let beta: { id: number; identifier: string; name: string };
let gamma: { id: number; identifier: string; name: string };
let aLogin: number; // card #1 in A
let bApi: number; //   card #1 in B
let bSchema: number; // card #2 in B

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
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "deps-phase-25!" }),
    login,
  ).id;
}

function project(name: string, identifier: string) {
  const row = mustOk(createProject(db, { name, identifier, actorUserId: adminId }), name);
  return { id: row.id, identifier: row.identifier, name: row.name };
}

function card(projectId: number, name: string): number {
  const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
  return mustOk(createCard(db, { projectId, name, cardTypeId: typeId, actorUserId: adminId }), name).number;
}

/** The one dependency row, reloaded. */
function reload(number: number) {
  return db.select().from(dependencies).where(eq(dependencies.number, number)).get();
}

function linksOf(dependencyId: number): number[] {
  return db
    .select({ n: dependencyResolvingCards.cardNumber })
    .from(dependencyResolvingCards)
    .where(eq(dependencyResolvingCards.dependencyId, dependencyId))
    .orderBy(asc(dependencyResolvingCards.cardNumber))
    .all()
    .map((r) => r.n);
}

function trail(dependencyId: number) {
  return db
    .select({
      version: dependencyVersions.version,
      status: dependencyVersions.status,
      resolvingCardNumbers: dependencyVersions.resolvingCardNumbers,
      isDeletion: dependencyVersions.isDeletion,
      modifiedByUserId: dependencyVersions.modifiedByUserId,
      name: dependencyVersions.name,
    })
    .from(dependencyVersions)
    .where(eq(dependencyVersions.dependencyId, dependencyId))
    .orderBy(asc(dependencyVersions.version))
    .all();
}

function eventTypes(): string[] {
  return db.select({ type: domainEvents.type }).from(domainEvents).orderBy(asc(domainEvents.id)).all().map((e) => e.type);
}

/** Raises D1: A#1 → B, by devA. */
function raiseStandard(overrides: Partial<Parameters<typeof raiseDependency>[1]> = {}) {
  return raiseDependency(db, {
    raisingProjectId: alpha.id,
    raisingCardNumber: aLogin,
    name: "Need the API",
    description: "Login needs the auth endpoint",
    desiredEndDate: "2026-09-30",
    resolvingProjectId: beta.id,
    actorUserId: devAId,
    ...overrides,
  });
}

beforeEach(() => {
  for (const table of [
    jobs, domainEvents, historySubscriptions, dependencyResolvingCards, dependencyVersions, dependencies,
    cardVersions, cards, cardTypes, teamMemberships, projects, users,
  ]) db.delete(table).run();
  adminId = register("admin");
  devAId = register("deva");
  devBId = register("devb");
  bothId = register("both");
  leadAId = register("leada");
  viewerBId = register("viewerb");
  outsiderId = register("outsider");
  alpha = project("Alpha", "alpha");
  beta = project("Beta", "beta");
  gamma = project("Gamma", "gamma");
  for (const [projectId, userId, role] of [
    [alpha.id, devAId, "full_member"],
    [alpha.id, bothId, "full_member"],
    [alpha.id, leadAId, "project_admin"],
    [beta.id, devBId, "full_member"],
    [beta.id, bothId, "full_member"],
    [beta.id, viewerBId, "readonly_member"],
  ] as const) {
    mustOk(addTeamMember(db, { projectId, userId, role, actorUserId: adminId }), `membership ${userId}`);
  }
  aLogin = card(alpha.id, "Login");
  bApi = card(beta.id, "API");
  bSchema = card(beta.id, "Schema");
  db.delete(domainEvents).run();
});

// ---------------------------------------------------------------- raise

describe("raiseDependency", () => {
  it("persists the dependency as NEW at version 1 with its first version row and event", () => {
    const raised = mustOk(raiseStandard(), "raise");
    const row = reload(raised.number)!;
    expect(row.number).toBe(1);
    expect(row.status).toBe("NEW");
    expect(row.version).toBe(1);
    expect(row.name).toBe("Need the API");
    expect(row.description).toBe("Login needs the auth endpoint");
    expect(row.desiredEndDate).toBe("2026-09-30");
    expect(row.raisingProjectId).toBe(alpha.id);
    expect(row.raisingCardNumber).toBe(aLogin);
    expect(row.raisingUserId).toBe(devAId);
    expect(row.resolvingProjectId).toBe(beta.id);
    expect(trail(row.id)).toEqual([
      { version: 1, status: "NEW", resolvingCardNumbers: "[]", isDeletion: false, modifiedByUserId: devAId, name: "Need the API" },
    ]);
    expect(eventTypes()).toEqual(["DependencyRaised"]);
    const event = db.select().from(domainEvents).get()!;
    expect(event.aggregateType).toBe("Dependency");
    expect(event.aggregateId).toBe(row.id);
    expect(JSON.parse(event.payload)).toEqual({
      number: 1,
      raisingProjectId: alpha.id,
      raisingCardNumber: aLogin,
      resolvingProjectId: beta.id,
    });
  });

  it("numbers dependencies globally across projects, never per project", () => {
    const first = mustOk(raiseStandard(), "first");
    const second = mustOk(
      raiseDependency(db, {
        raisingProjectId: beta.id,
        raisingCardNumber: bApi,
        name: "Need a schema review",
        desiredEndDate: "2026-10-01",
        resolvingProjectId: alpha.id,
        actorUserId: devBId,
      }),
      "second",
    );
    expect([first.number, second.number]).toEqual([1, 2]);
  });

  it("allows a project to raise a dependency on itself (legacy parity)", () => {
    const raised = mustOk(raiseStandard({ resolvingProjectId: alpha.id }), "self");
    expect(reload(raised.number)!.resolvingProjectId).toBe(alpha.id);
  });

  it("trims the name and stores a blank description as null", () => {
    const raised = mustOk(raiseStandard({ name: "  Padded  ", description: "   " }), "raise");
    const row = reload(raised.number)!;
    expect(row.name).toBe("Padded");
    expect(row.description).toBeNull();
  });

  it("rejects when the raising card does not exist in the raising project", () => {
    const errors = mustReject(raiseStandard({ raisingCardNumber: 99 }), "missing card");
    expect(errors.raising_card).toEqual(["does not exist"]);
    expect(db.select().from(dependencies).all()).toHaveLength(0);
    expect(db.select().from(dependencyVersions).all()).toHaveLength(0);
    expect(eventTypes()).toEqual([]);
  });

  it("rejects a card number that belongs to the resolving project, not the raising one", () => {
    // B#2 exists, but A has no #2 — the raising card must be in A.
    expect(card(alpha.id, "Second") === 2 ? "ok" : "unexpected").toBe("ok");
    mustOk(deleteCard(db, { projectId: alpha.id, cardNumber: 2, actorUserId: adminId }), "delete A#2");
    const errors = mustReject(raiseStandard({ raisingCardNumber: bSchema }), "foreign card");
    expect(errors.raising_card).toEqual(["does not exist"]);
    expect(db.select().from(dependencies).all()).toHaveLength(0);
  });

  it("rejects a blank name and writes nothing", () => {
    expect(mustReject(raiseStandard({ name: "   " }), "blank").name).toEqual(["can't be blank"]);
    expect(db.select().from(dependencies).all()).toHaveLength(0);
  });

  it("rejects a missing or malformed desired end date and writes nothing", () => {
    expect(mustReject(raiseStandard({ desiredEndDate: "" }), "blank date").desired_end_date).toEqual(["can't be blank"]);
    expect(mustReject(raiseStandard({ desiredEndDate: "30/09/2026" }), "bad date").desired_end_date).toEqual(["is not a valid date"]);
    expect(mustReject(raiseStandard({ desiredEndDate: "2026-13-45" }), "impossible date").desired_end_date).toEqual(["is not a valid date"]);
    expect(db.select().from(dependencies).all()).toHaveLength(0);
  });

  it("rejects an unknown resolving project and writes nothing", () => {
    expect(mustReject(raiseStandard({ resolvingProjectId: 999 }), "no project").resolving_project).toEqual(["does not exist"]);
    expect(db.select().from(dependencies).all()).toHaveLength(0);
  });

  it("rejects an actor who may not edit the raising project (member elsewhere, or nowhere)", () => {
    expect(mustReject(raiseStandard({ actorUserId: devBId }), "devB in A").authorization).toBeDefined();
    expect(mustReject(raiseStandard({ actorUserId: outsiderId }), "outsider").authorization).toBeDefined();
    expect(db.select().from(dependencies).all()).toHaveLength(0);
    expect(eventTypes()).toEqual([]);
  });
});

// ----------------------------------------------------------------- link

describe("linkResolvingCards", () => {
  it("links the resolving project's cards, moves the status to ACCEPTED, and appends a version snapshotting the links", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bSchema, bApi], actorUserId: devBId }), "link");
    const row = reload(1)!;
    expect(row.status).toBe("ACCEPTED");
    expect(row.version).toBe(2);
    expect(linksOf(raised.id)).toEqual([bApi, bSchema]);
    expect(
      db.select({ p: dependencyResolvingCards.projectId }).from(dependencyResolvingCards).all().map((r) => r.p),
    ).toEqual([beta.id, beta.id]);
    expect(trail(raised.id).map((v) => [v.version, v.status, v.resolvingCardNumbers, v.modifiedByUserId])).toEqual([
      [1, "NEW", "[]", devAId],
      [2, "ACCEPTED", `[${bApi},${bSchema}]`, devBId],
    ]);
    expect(eventTypes()).toEqual(["DependencyRaised", "ResolvingCardsLinked"]);
    const event = db.select().from(domainEvents).where(eq(domainEvents.type, "ResolvingCardsLinked")).get()!;
    expect(JSON.parse(event.payload)).toEqual({ number: 1, resolvingProjectId: beta.id, cardNumbers: [bApi, bSchema], status: "ACCEPTED" });
  });

  it("linking a card already linked changes nothing and appends no version", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "first");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi, bApi], actorUserId: devBId }), "again");
    expect(reload(1)!.version).toBe(2);
    expect(linksOf(raised.id)).toEqual([bApi]);
    expect(trail(raised.id)).toHaveLength(2);
    expect(eventTypes()).toEqual(["DependencyRaised", "ResolvingCardsLinked"]);
  });

  it("links only the cards not yet linked when the set overlaps", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "first");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi, bSchema], actorUserId: devBId }), "overlap");
    expect(linksOf(raised.id)).toEqual([bApi, bSchema]);
    expect(reload(1)!.version).toBe(3);
    const event = db.select().from(domainEvents).orderBy(asc(domainEvents.id)).all().at(-1)!;
    expect(JSON.parse(event.payload).cardNumbers).toEqual([bSchema]);
  });

  it("rejects linking from the raising project — only the resolving project accepts", () => {
    const raised = mustOk(raiseStandard(), "raise");
    const errors = mustReject(
      linkResolvingCards(db, { projectId: alpha.id, dependencyNumber: 1, cardNumbers: [aLogin], actorUserId: devAId }),
      "from A",
    );
    expect(errors.dependency).toEqual(["can only be resolved from its resolving project"]);
    expect(linksOf(raised.id)).toEqual([]);
    expect(reload(1)!.status).toBe("NEW");
    expect(trail(raised.id)).toHaveLength(1);
  });

  it("rejects a card that does not exist in the resolving project, linking none of the set", () => {
    const raised = mustOk(raiseStandard(), "raise");
    const errors = mustReject(
      linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi, 42], actorUserId: devBId }),
      "missing",
    );
    expect(errors.cards).toEqual(["#42 does not exist"]);
    expect(linksOf(raised.id)).toEqual([]);
    expect(reload(1)!.status).toBe("NEW");
  });

  it("rejects an empty card set", () => {
    mustOk(raiseStandard(), "raise");
    expect(mustReject(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [], actorUserId: devBId }), "empty").cards).toEqual(["can't be blank"]);
    expect(db.select().from(dependencyResolvingCards).all()).toHaveLength(0);
  });

  it("rejects the raising card as a resolving card when the projects are the same", () => {
    const raised = mustOk(raiseStandard({ resolvingProjectId: alpha.id }), "self");
    const other = card(alpha.id, "Helper");
    const errors = mustReject(
      linkResolvingCards(db, { projectId: alpha.id, dependencyNumber: 1, cardNumbers: [other, aLogin], actorUserId: devAId }),
      "self-link",
    );
    expect(errors.cards).toEqual(["Cannot link raising card as resolving card."]);
    expect(linksOf(raised.id)).toEqual([]);
    // The same card is fine when it is not the raising card.
    mustOk(linkResolvingCards(db, { projectId: alpha.id, dependencyNumber: 1, cardNumbers: [other], actorUserId: devAId }), "other");
    expect(linksOf(raised.id)).toEqual([other]);
  });

  it("rejects an unknown dependency, a readonly member, and a non-member of the resolving project", () => {
    mustOk(raiseStandard(), "raise");
    expect(mustReject(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 7, cardNumbers: [bApi], actorUserId: devBId }), "unknown").dependency).toEqual(["does not exist"]);
    expect(mustReject(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: viewerBId }), "viewer").authorization).toBeDefined();
    expect(mustReject(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devAId }), "devA in B").authorization).toBeDefined();
    expect(db.select().from(dependencyResolvingCards).all()).toHaveLength(0);
    expect(eventTypes()).toEqual(["DependencyRaised"]);
  });
});

// --------------------------------------------------------------- unlink

describe("unlinkResolvingCard", () => {
  it("removes the link and drops the status back to NEW when no card remains, appending a version", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi, bSchema], actorUserId: devBId }), "link");
    mustOk(unlinkResolvingCard(db, { projectId: beta.id, dependencyNumber: 1, cardNumber: bApi, actorUserId: devBId }), "unlink one");
    expect(linksOf(raised.id)).toEqual([bSchema]);
    expect(reload(1)!.status).toBe("ACCEPTED");
    mustOk(unlinkResolvingCard(db, { projectId: beta.id, dependencyNumber: 1, cardNumber: bSchema, actorUserId: devBId }), "unlink last");
    expect(linksOf(raised.id)).toEqual([]);
    const row = reload(1)!;
    expect(row.status).toBe("NEW");
    expect(row.version).toBe(4);
    expect(trail(raised.id).map((v) => [v.status, v.resolvingCardNumbers])).toEqual([
      ["NEW", "[]"],
      ["ACCEPTED", `[${bApi},${bSchema}]`],
      ["ACCEPTED", `[${bSchema}]`],
      ["NEW", "[]"],
    ]);
    expect(eventTypes().slice(-2)).toEqual(["ResolvingCardUnlinked", "ResolvingCardUnlinked"]);
  });

  it("keeps a RESOLVED dependency resolved when its cards are unlinked (resolution is sticky)", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    mustOk(toggleDependencyResolved(db, { projectId: beta.id, dependencyNumber: 1, actorUserId: devBId }), "resolve");
    mustOk(unlinkResolvingCard(db, { projectId: beta.id, dependencyNumber: 1, cardNumber: bApi, actorUserId: devBId }), "unlink");
    expect(reload(1)!.status).toBe("RESOLVED");
    expect(linksOf(raised.id)).toEqual([]);
  });

  it("rejects a card that is not linked, the raising side, and an unauthorized actor — nothing written", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    expect(mustReject(unlinkResolvingCard(db, { projectId: beta.id, dependencyNumber: 1, cardNumber: bSchema, actorUserId: devBId }), "not linked").card).toEqual(["is not a resolving card of this dependency"]);
    expect(mustReject(unlinkResolvingCard(db, { projectId: alpha.id, dependencyNumber: 1, cardNumber: bApi, actorUserId: devAId }), "from A").dependency).toBeDefined();
    expect(mustReject(unlinkResolvingCard(db, { projectId: beta.id, dependencyNumber: 1, cardNumber: bApi, actorUserId: viewerBId }), "viewer").authorization).toBeDefined();
    expect(linksOf(raised.id)).toEqual([bApi]);
    expect(reload(1)!.version).toBe(2);
  });
});

// --------------------------------------------------------------- toggle

describe("toggleDependencyResolved", () => {
  it("resolves an ACCEPTED dependency and reopens a RESOLVED one to ACCEPTED while cards are linked", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    mustOk(toggleDependencyResolved(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: devAId }), "resolve from A");
    expect(reload(1)!.status).toBe("RESOLVED");
    expect(reload(1)!.version).toBe(3);
    mustOk(toggleDependencyResolved(db, { projectId: beta.id, dependencyNumber: 1, actorUserId: devBId }), "reopen from B");
    expect(reload(1)!.status).toBe("ACCEPTED");
    expect(trail(raised.id).map((v) => [v.version, v.status, v.modifiedByUserId])).toEqual([
      [1, "NEW", devAId],
      [2, "ACCEPTED", devBId],
      [3, "RESOLVED", devAId],
      [4, "ACCEPTED", devBId],
    ]);
    const events = db.select().from(domainEvents).where(eq(domainEvents.type, "DependencyStatusChanged")).orderBy(asc(domainEvents.id)).all();
    expect(events.map((e) => JSON.parse(e.payload))).toEqual([
      { number: 1, projectId: alpha.id, from: "ACCEPTED", to: "RESOLVED" },
      { number: 1, projectId: beta.id, from: "RESOLVED", to: "ACCEPTED" },
    ]);
  });

  it("reopens to NEW when the resolved dependency has no cards linked", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    mustOk(toggleDependencyResolved(db, { projectId: beta.id, dependencyNumber: 1, actorUserId: devBId }), "resolve");
    mustOk(unlinkResolvingCard(db, { projectId: beta.id, dependencyNumber: 1, cardNumber: bApi, actorUserId: devBId }), "unlink");
    mustOk(toggleDependencyResolved(db, { projectId: beta.id, dependencyNumber: 1, actorUserId: devBId }), "reopen");
    expect(reload(1)!.status).toBe("NEW");
  });

  it("leaves a NEW dependency with no cards untouched — no version, no event", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(toggleDependencyResolved(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: devAId }), "toggle NEW");
    expect(reload(1)!.status).toBe("NEW");
    expect(reload(1)!.version).toBe(1);
    expect(trail(raised.id)).toHaveLength(1);
    expect(eventTypes()).toEqual(["DependencyRaised"]);
  });

  it("rejects from a project on neither side, and from a non-member of the acting side", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    expect(mustReject(toggleDependencyResolved(db, { projectId: gamma.id, dependencyNumber: 1, actorUserId: adminId }), "gamma").dependency).toEqual(["does not belong to this project"]);
    expect(mustReject(toggleDependencyResolved(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: devBId }), "devB in A").authorization).toBeDefined();
    expect(mustReject(toggleDependencyResolved(db, { projectId: beta.id, dependencyNumber: 9, actorUserId: devBId }), "unknown").dependency).toEqual(["does not exist"]);
    expect(reload(1)!.status).toBe("ACCEPTED");
    expect(reload(1)!.version).toBe(2);
  });

  it("recalculatedStatus pins the legacy table", () => {
    expect(recalculatedStatus("NEW", false)).toBe("NEW");
    expect(recalculatedStatus("NEW", true)).toBe("ACCEPTED");
    expect(recalculatedStatus("ACCEPTED", false)).toBe("NEW");
    expect(recalculatedStatus("ACCEPTED", true)).toBe("ACCEPTED");
    expect(recalculatedStatus("RESOLVED", false)).toBe("RESOLVED");
    expect(recalculatedStatus("RESOLVED", true)).toBe("RESOLVED");
  });
});

// --------------------------------------------------------------- update

describe("updateDependency", () => {
  it("changes the request's fields from the raising project and appends a version", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(
      updateDependency(db, { projectId: alpha.id, dependencyNumber: 1, name: "Need the auth API", description: "", desiredEndDate: "2026-10-15", actorUserId: bothId }),
      "update",
    );
    const row = reload(1)!;
    expect(row.name).toBe("Need the auth API");
    expect(row.description).toBeNull();
    expect(row.desiredEndDate).toBe("2026-10-15");
    expect(row.version).toBe(2);
    expect(trail(raised.id).map((v) => [v.version, v.name, v.modifiedByUserId])).toEqual([
      [1, "Need the API", devAId],
      [2, "Need the auth API", bothId],
    ]);
    expect(eventTypes()).toEqual(["DependencyRaised", "DependencyUpdated"]);
  });

  it("submitting the stored values appends nothing", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(
      updateDependency(db, { projectId: alpha.id, dependencyNumber: 1, name: " Need the API ", description: "Login needs the auth endpoint", desiredEndDate: "2026-09-30", actorUserId: devAId }),
      "same",
    );
    expect(reload(1)!.version).toBe(1);
    expect(trail(raised.id)).toHaveLength(1);
  });

  it("rejects from the resolving project, an invalid field, and an unauthorized actor — nothing written", () => {
    mustOk(raiseStandard(), "raise");
    expect(mustReject(updateDependency(db, { projectId: beta.id, dependencyNumber: 1, name: "X", desiredEndDate: "2026-10-15", actorUserId: devBId }), "from B").dependency).toEqual(["can only be edited from the project that raised it"]);
    expect(mustReject(updateDependency(db, { projectId: alpha.id, dependencyNumber: 1, name: "", desiredEndDate: "2026-10-15", actorUserId: devAId }), "blank").name).toEqual(["can't be blank"]);
    expect(mustReject(updateDependency(db, { projectId: alpha.id, dependencyNumber: 1, name: "X", desiredEndDate: "soon", actorUserId: devAId }), "date").desired_end_date).toEqual(["is not a valid date"]);
    expect(mustReject(updateDependency(db, { projectId: alpha.id, dependencyNumber: 1, name: "X", desiredEndDate: "2026-10-15", actorUserId: outsiderId }), "outsider").authorization).toBeDefined();
    expect(reload(1)!.name).toBe("Need the API");
    expect(reload(1)!.version).toBe(1);
  });
});

// --------------------------------------------------------------- delete

describe("deleteDependency", () => {
  it("removes the dependency and its links, keeps a deletion version, and reserves the number", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    mustOk(deleteDependency(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: leadAId }), "delete");
    expect(reload(1)).toBeUndefined();
    expect(db.select().from(dependencyResolvingCards).all()).toHaveLength(0);
    expect(trail(raised.id).map((v) => [v.version, v.status, v.isDeletion, v.modifiedByUserId])).toEqual([
      [1, "NEW", false, devAId],
      [2, "ACCEPTED", false, devBId],
      [3, "ACCEPTED", true, leadAId],
    ]);
    expect(eventTypes().at(-1)).toBe("DependencyDeleted");
    // The number is never reused.
    const next = mustOk(raiseStandard(), "raise again");
    expect(next.number).toBe(2);
  });

  it("rejects from the resolving project, from a non-admin of the raising project, and for an unknown number", () => {
    const raised = mustOk(raiseStandard(), "raise");
    expect(mustReject(deleteDependency(db, { projectId: beta.id, dependencyNumber: 1, actorUserId: devBId }), "from B").dependency).toEqual(["can only be deleted from the project that raised it"]);
    expect(mustReject(deleteDependency(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: devAId }), "devA").authorization).toBeDefined();
    expect(mustReject(deleteDependency(db, { projectId: alpha.id, dependencyNumber: 3, actorUserId: leadAId }), "unknown").dependency).toEqual(["does not exist"]);
    expect(reload(1)).toBeDefined();
    expect(trail(raised.id)).toHaveLength(1);
  });

  it("a site admin who is on no team may delete from the raising project", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(deleteDependency(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: adminId }), "site admin delete");
    expect(reload(1)).toBeUndefined();
  });
});

// ----------------------------------------------------------- read model

describe("dependency read model", () => {
  it("lists a dependency from the raising project's raising side and the resolving project's resolving side only", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");

    const fromA = listDependencies(db, alpha.id, "raising");
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({
      number: 1,
      prefixedNumber: "D1",
      name: "Need the API",
      status: "ACCEPTED",
      version: 2,
      raisingProject: { id: alpha.id, identifier: "alpha", name: "Alpha" },
      resolvingProject: { id: beta.id, identifier: "beta", name: "Beta" },
      raisingCard: { number: aLogin, name: "Login" },
      raisingUserName: "DEVA",
      resolvingCards: [{ number: bApi, name: "API" }],
    });
    expect(listDependencies(db, beta.id, "resolving").map((d) => d.number)).toEqual([1]);
    expect(listDependencies(db, alpha.id, "resolving")).toEqual([]);
    expect(listDependencies(db, beta.id, "raising")).toEqual([]);
    expect(listDependencies(db, gamma.id, "raising")).toEqual([]);
  });

  it("finds a dependency only from a project that is one of its sides", () => {
    mustOk(raiseStandard(), "raise");
    expect(findDependencyForProject(db, alpha.id, 1)?.number).toBe(1);
    expect(findDependencyForProject(db, beta.id, 1)?.number).toBe(1);
    expect(findDependencyForProject(db, gamma.id, 1)).toBeUndefined();
    expect(findDependencyForProject(db, alpha.id, 2)).toBeUndefined();
  });

  it("keeps a deleted card's number and blanks its name", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    mustOk(deleteCard(db, { projectId: beta.id, cardNumber: bApi, actorUserId: adminId }), "delete B#1");
    mustOk(deleteCard(db, { projectId: alpha.id, cardNumber: aLogin, actorUserId: adminId }), "delete A#1");
    const shown = findDependencyForProject(db, alpha.id, 1)!;
    expect(shown.raisingCard).toEqual({ number: aLogin, name: null });
    expect(shown.resolvingCards).toEqual([{ number: bApi, name: null }]);
  });

  it("answers a card's raised and resolving dependencies", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    expect(cardDependencies(db, alpha.id, aLogin).raised.map((d) => d.number)).toEqual([1]);
    expect(cardDependencies(db, alpha.id, aLogin).resolving).toEqual([]);
    expect(cardDependencies(db, beta.id, bApi).resolving.map((d) => d.number)).toEqual([1]);
    expect(cardDependencies(db, beta.id, bApi).raised).toEqual([]);
    expect(cardDependencies(db, beta.id, bSchema).resolving).toEqual([]);
  });

  it("reads the version trail newest first with authors and parsed card numbers", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    const history = dependencyHistory(db, raised.id);
    expect(history.map((v) => [v.version, v.status, v.resolvingCardNumbers, v.modifiedByName])).toEqual([
      [2, "ACCEPTED", [bApi], "DEVB"],
      [1, "NEW", [], "DEVA"],
    ]);
  });
});

// -------------------------------------------------------------- history

describe("dependency versions in the project history (fourth trail)", () => {
  it("shows every version in BOTH projects' feeds with the historical name, and in neither for an unrelated project", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(updateDependency(db, { projectId: alpha.id, dependencyNumber: 1, name: "Renamed", desiredEndDate: "2026-09-30", actorUserId: devAId }), "rename");
    for (const p of [alpha, beta]) {
      const entries = projectHistory(db, p).filter((e) => e.kind === "dependency");
      expect(entries.map((e) => [e.action, e.title, e.version, e.dependencyNumber, e.href, e.authorName])).toEqual([
        ["changed", "Dependency D1 Renamed", 2, 1, `/projects/${p.identifier}/dependencies/1`, "DEVA"],
        ["created", "Dependency D1 Need the API", 1, 1, `/projects/${p.identifier}/dependencies/1`, "DEVA"],
      ]);
      const versionIds = db
        .select({ id: dependencyVersions.id })
        .from(dependencyVersions)
        .where(eq(dependencyVersions.dependencyId, raised.id))
        .orderBy(asc(dependencyVersions.id))
        .all()
        .map((v) => `dependency-${v.id}`);
      expect(entries.map((e) => e.id)).toEqual([...versionIds].reverse());
      expect(entries.every((e) => e.cardNumber === null)).toBe(true);
    }
    expect(projectHistory(db, gamma).filter((e) => e.kind === "dependency")).toEqual([]);
  });

  it("marks the deletion version as deleted and counts the trail into both projects' totals", () => {
    mustOk(raiseStandard(), "raise");
    const before = { a: projectHistoryCount(db, alpha.id), b: projectHistoryCount(db, beta.id) };
    mustOk(deleteDependency(db, { projectId: alpha.id, dependencyNumber: 1, actorUserId: leadAId }), "delete");
    expect(projectHistoryCount(db, alpha.id)).toBe(before.a + 1);
    expect(projectHistoryCount(db, beta.id)).toBe(before.b + 1);
    const latest = projectHistory(db, beta).find((e) => e.kind === "dependency")!;
    expect(latest.action).toBe("deleted");
    expect(latest.authorName).toBe("LEADA");
  });

  it("advances the cursor on both sides and delivers fresh dependency entries after it", () => {
    const cursorA = historyCursor(db, alpha.id);
    const cursorB = historyCursor(db, beta.id);
    expect(cursorA.dependencyVersionId).toBe(0);
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    const after = historyCursor(db, beta.id);
    expect(after.dependencyVersionId).toBeGreaterThan(0);
    expect(historyEntriesAfter(db, alpha, cursorA).filter((e) => e.kind === "dependency").map((e) => e.action)).toEqual(["created", "changed"]);
    expect(historyEntriesAfter(db, beta, cursorB).filter((e) => e.kind === "dependency").map((e) => e.action)).toEqual(["created", "changed"]);
    expect(historyEntriesAfter(db, beta, after).filter((e) => e.kind === "dependency")).toEqual([]);
  });

  it("a new project subscription starts past the dependency trail's current end", () => {
    mustOk(raiseStandard(), "raise");
    mustOk(subscribe(db, { projectId: beta.id, filter: { kind: "project" }, actorUserId: devBId }), "subscribe");
    const sub = db.select().from(historySubscriptions).get()!;
    expect(sub.lastDependencyVersionId).toBe(historyCursor(db, beta.id).dependencyVersionId);
    expect(sub.lastDependencyVersionId).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------- exit criterion

describe("Phase 25 exit criterion", () => {
  it("raise from A on a card in B, accept in B, resolve — the trail and both lists agree, from real rows in both scopes", () => {
    const raised = mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: raised.number, cardNumbers: [bApi], actorUserId: devBId }), "accept");
    mustOk(toggleDependencyResolved(db, { projectId: beta.id, dependencyNumber: raised.number, actorUserId: devBId }), "resolve");

    const row = reload(raised.number)!;
    expect(row.status).toBe("RESOLVED");
    expect(row.version).toBe(3);
    expect(trail(raised.id).map((v) => v.status)).toEqual(["NEW", "ACCEPTED", "RESOLVED"]);

    const fromA = listDependencies(db, alpha.id, "raising");
    const fromB = listDependencies(db, beta.id, "resolving");
    expect(fromA.map((d) => [d.prefixedNumber, d.status, d.resolvingCards.map((c) => c.number)])).toEqual([["D1", "RESOLVED", [bApi]]]);
    expect(fromB.map((d) => [d.prefixedNumber, d.status, d.raisingCard.number])).toEqual([["D1", "RESOLVED", aLogin]]);
    expect(
      db.select().from(dependencies).where(and(eq(dependencies.raisingProjectId, alpha.id), eq(dependencies.status, "RESOLVED"))).all(),
    ).toHaveLength(1);
    expect(
      db.select().from(dependencies).where(and(eq(dependencies.resolvingProjectId, beta.id), eq(dependencies.status, "RESOLVED"))).all(),
    ).toHaveLength(1);
  });
});

// --------------------------------------------------------------- routes

describe("dependency routes (real route modules)", () => {
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

  const listPath = (p: { identifier: string }, query = "") => `/projects/${p.identifier}/dependencies${query}`;
  const showPath = (p: { identifier: string }, number: number) => `/projects/${p.identifier}/dependencies/${number}`;

  interface ListData {
    filter: string;
    dependencies: { number: number; status: string }[];
    projects: { id: number; name: string }[];
    canRaise: boolean;
  }
  interface ShowData {
    dependency: { number: number; status: string; resolvingCards: { number: number }[] };
    history: { version: number }[];
    canLink: boolean;
    canToggle: boolean;
    canEdit: boolean;
    canDelete: boolean;
  }

  it("the raise form persists the dependency and redirects to it", async () => {
    const outcome = await run(listRoute.action, devAId, listPath(alpha), { identifier: alpha.identifier }, {
      intent: "raise",
      raising_card_number: String(aLogin),
      name: "Need the API",
      description: "",
      desired_end_date: "2026-09-30",
      resolving_project_id: String(beta.id),
    });
    expect(outcome.status).toBe(302);
    expect(outcome.location).toBe(`/projects/alpha/dependencies/1`);
    const row = reload(1)!;
    expect(row.raisingUserId).toBe(devAId);
    expect(row.resolvingProjectId).toBe(beta.id);
    expect(row.description).toBeNull();
  });

  it("the raise form re-renders with errors on rejection and writes nothing", async () => {
    const outcome = await run(listRoute.action, devAId, listPath(alpha), { identifier: alpha.identifier }, {
      intent: "raise",
      raising_card_number: "99",
      name: "Need the API",
      desired_end_date: "2026-09-30",
      resolving_project_id: String(beta.id),
    });
    expect(outcome.status).toBe(400);
    expect((outcome.data as { errors: Record<string, string[]> }).errors.raising_card).toEqual(["does not exist"]);
    expect(db.select().from(dependencies).all()).toHaveLength(0);
    expect((await run(listRoute.action, devAId, listPath(alpha), { identifier: alpha.identifier }, { intent: "nope" })).status).toBe(400);
  });

  it("the list defaults to the resolving side, switches with ?filter=raising, and offers every project", async () => {
    mustOk(raiseStandard(), "raise");
    const resolvingB = (await run(listRoute.loader, devBId, listPath(beta), { identifier: beta.identifier })).data as ListData;
    expect(resolvingB.filter).toBe("resolving");
    expect(resolvingB.dependencies.map((d) => d.number)).toEqual([1]);
    expect(resolvingB.projects.map((p) => p.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(resolvingB.canRaise).toBe(true);

    const resolvingA = (await run(listRoute.loader, devAId, listPath(alpha), { identifier: alpha.identifier })).data as ListData;
    expect(resolvingA.dependencies).toEqual([]);
    const raisingA = (await run(listRoute.loader, devAId, listPath(alpha, "?filter=raising"), { identifier: alpha.identifier })).data as ListData;
    expect(raisingA.filter).toBe("raising");
    expect(raisingA.dependencies.map((d) => d.number)).toEqual([1]);
    const bogus = (await run(listRoute.loader, devAId, listPath(alpha, "?filter=bogus"), { identifier: alpha.identifier })).data as ListData;
    expect(bogus.filter).toBe("resolving");

    const viewer = (await run(listRoute.loader, viewerBId, listPath(beta), { identifier: beta.identifier })).data as ListData;
    expect(viewer.canRaise).toBe(false);
  });

  it("the show page offers each side its own actions and 404s from an unrelated project", async () => {
    mustOk(raiseStandard(), "raise");
    const fromB = (await run(showRoute.loader, devBId, showPath(beta, 1), { identifier: beta.identifier, number: "1" })).data as ShowData;
    expect(fromB.dependency.number).toBe(1);
    expect([fromB.canLink, fromB.canToggle, fromB.canEdit, fromB.canDelete]).toEqual([true, true, false, false]);
    const fromA = (await run(showRoute.loader, devAId, showPath(alpha, 1), { identifier: alpha.identifier, number: "1" })).data as ShowData;
    expect([fromA.canLink, fromA.canToggle, fromA.canEdit, fromA.canDelete]).toEqual([false, true, true, false]);
    const fromLead = (await run(showRoute.loader, leadAId, showPath(alpha, 1), { identifier: alpha.identifier, number: "1" })).data as ShowData;
    expect(fromLead.canDelete).toBe(true);
    const viewer = (await run(showRoute.loader, viewerBId, showPath(beta, 1), { identifier: beta.identifier, number: "1" })).data as ShowData;
    expect([viewer.canLink, viewer.canToggle]).toEqual([false, false]);
    expect(fromB.history.map((v) => v.version)).toEqual([1]);

    expect((await run(showRoute.loader, adminId, showPath(gamma, 1), { identifier: gamma.identifier, number: "1" })).status).toBe(404);
    expect((await run(showRoute.loader, devAId, showPath(alpha, 9), { identifier: alpha.identifier, number: "9" })).status).toBe(404);
    expect((await run(showRoute.loader, null, showPath(alpha, 1), { identifier: alpha.identifier, number: "1" })).location).toBe("/login");
  });

  it("link, unlink, toggle and update forms drive the commands and redirect back to the page", async () => {
    const raised = mustOk(raiseStandard(), "raise");
    const paramsB = { identifier: beta.identifier, number: "1" };
    const paramsA = { identifier: alpha.identifier, number: "1" };

    const linked = await run(showRoute.action, devBId, showPath(beta, 1), paramsB, { intent: "link", card_numbers: `#${bApi}, ${bSchema}` });
    expect(linked.status).toBe(302);
    expect(linked.location).toBe(showPath(beta, 1));
    expect(linksOf(raised.id)).toEqual([bApi, bSchema]);
    expect(reload(1)!.status).toBe("ACCEPTED");

    expect((await run(showRoute.action, devBId, showPath(beta, 1), paramsB, { intent: "unlink", card_number: String(bSchema) })).status).toBe(302);
    expect(linksOf(raised.id)).toEqual([bApi]);

    expect((await run(showRoute.action, devAId, showPath(alpha, 1), paramsA, { intent: "toggle-resolved" })).status).toBe(302);
    expect(reload(1)!.status).toBe("RESOLVED");

    expect((await run(showRoute.action, devAId, showPath(alpha, 1), paramsA, { intent: "update", name: "Renamed", description: "d", desired_end_date: "2026-11-01" })).status).toBe(302);
    expect(reload(1)!.name).toBe("Renamed");
    expect(reload(1)!.desiredEndDate).toBe("2026-11-01");

    // Rejections come back as 400 with the command's errors.
    const wrongSide = await run(showRoute.action, devAId, showPath(alpha, 1), paramsA, { intent: "link", card_numbers: String(aLogin) });
    expect(wrongSide.status).toBe(400);
    expect((wrongSide.data as { errors: Record<string, string[]> }).errors.dependency).toEqual(["can only be resolved from its resolving project"]);
    const empty = await run(showRoute.action, devBId, showPath(beta, 1), paramsB, { intent: "link", card_numbers: "abc" });
    expect((empty.data as { errors: Record<string, string[]> }).errors.cards).toEqual(["can't be blank"]);
    expect((await run(showRoute.action, devBId, showPath(beta, 1), paramsB, { intent: "explode" })).status).toBe(400);
  });

  it("the card page lists what the card raised and what it resolves", async () => {
    mustOk(raiseStandard(), "raise");
    mustOk(linkResolvingCards(db, { projectId: beta.id, dependencyNumber: 1, cardNumbers: [bApi], actorUserId: devBId }), "link");
    type CardData = { dependencies: { raised: { prefixedNumber: string; status: string }[]; resolving: { prefixedNumber: string }[] } };
    const a = (await run(cardRoute.loader, devAId, `/projects/alpha/cards/${aLogin}`, { identifier: "alpha", number: String(aLogin) })).data as CardData;
    expect(a.dependencies.raised.map((d) => [d.prefixedNumber, d.status])).toEqual([["D1", "ACCEPTED"]]);
    expect(a.dependencies.resolving).toEqual([]);
    const b = (await run(cardRoute.loader, devBId, `/projects/beta/cards/${bApi}`, { identifier: "beta", number: String(bApi) })).data as CardData;
    expect(b.dependencies.raised).toEqual([]);
    expect(b.dependencies.resolving.map((d) => d.prefixedNumber)).toEqual(["D1"]);
    const untouched = (await run(cardRoute.loader, devBId, `/projects/beta/cards/${bSchema}`, { identifier: "beta", number: String(bSchema) })).data as CardData;
    expect(untouched.dependencies).toEqual({ raised: [], resolving: [] });
  });

  it("the delete form removes the dependency for a raising-project admin and redirects to the raising list", async () => {
    mustOk(raiseStandard(), "raise");
    const refused = await run(showRoute.action, devAId, showPath(alpha, 1), { identifier: alpha.identifier, number: "1" }, { intent: "delete" });
    expect(refused.status).toBe(400);
    expect(reload(1)).toBeDefined();
    const outcome = await run(showRoute.action, leadAId, showPath(alpha, 1), { identifier: alpha.identifier, number: "1" }, { intent: "delete" });
    expect(outcome.status).toBe(302);
    expect(outcome.location).toBe(`/projects/alpha/dependencies?filter=raising`);
    expect(reload(1)).toBeUndefined();
    expect(db.select().from(dependencyVersions).all().at(-1)!.isDeletion).toBe(true);
  });
});
