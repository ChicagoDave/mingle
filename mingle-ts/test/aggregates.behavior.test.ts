/**
 * Behavioral tests for aggregate properties over card trees (Phase 24)
 * and for the Phase 23 gap they depend on — a card whose type changes
 * or that is deleted must leave its trees consistently.
 *
 * Derived from the phase's exit criterion: changing a leaf card's
 * property recomputes and persists the correct aggregate value on its
 * ancestor, verified against real seeded tree data with a
 * hand-computed expected total — every assertion reads
 * `card_property_values` / `card_versions` / `tree_belongings` rows
 * back from a real file-backed SQLite database with the real
 * migrations, after the real commands ran.
 *
 * The route section drives the actual tree route module with a Request
 * carrying a real session cookie (the Phase 21 recipe).
 *
 * Owner context: Card Management / Card Trees verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-aggregates-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "aggregates-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const treeRoute = await import("../app/routes/projects.trees.tree");

const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardPropertyValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { treeBelongings, treeCardTypes, treeConfigurations } = await import("../app/db/schema/trees");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, defineCardType, deleteCard, updateCard } = await import("../app/domain/cards/commands.server");
const { defineAggregateProperty, definePropertyDefinition, setCardPropertyValue } = await import(
  "../app/domain/cards/properties.server"
);
const { addCardToTree, defineTree, reconfigureTree, removeCardFromTree } = await import(
  "../app/domain/trees/commands.server"
);
const { parseProjectMql } = await import("../app/domain/cards/mql-schema.server");
const { queryCardsByMql, todayIso } = await import("../app/domain/cards/mql-evaluator.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let devId: number;
let projectId: number;
let projectIdentifier: string;
let releaseTypeId: number;
let iterationTypeId: number;
let storyTypeId: number;
let treeId: number;
let pointsId: number;
let statusId: number;

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
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "aggregates-24!" }),
    login,
  ).id;
}

function card(name: string, typeId: number) {
  return mustOk(createCard(db, { projectId, name, cardTypeId: typeId, actorUserId: adminId }), name);
}

function place(cardNumber: number, parentCardNumber: number | null) {
  return mustOk(addCardToTree(db, { projectId, treeId, cardNumber, parentCardNumber, actorUserId: adminId }), `place #${cardNumber}`);
}

function set(cardNumber: number, propertyDefinitionId: number, value: string | null) {
  return setCardPropertyValue(db, { projectId, cardNumber, propertyDefinitionId, value, actorUserId: adminId });
}

function defineAggregate(input: Partial<Parameters<typeof defineAggregateProperty>[1]> & { name: string }) {
  return defineAggregateProperty(db, {
    projectId,
    treeId,
    aggregateCardTypeId: releaseTypeId,
    aggregateType: "sum",
    targetPropertyDefinitionId: pointsId,
    actorUserId: adminId,
    ...input,
  });
}

/** The stored value of a property on a card, read straight from the table. */
function stored(cardId: number, definitionId: number): string | null {
  return (
    db
      .select({ value: cardPropertyValues.value })
      .from(cardPropertyValues)
      .where(and(eq(cardPropertyValues.cardId, cardId), eq(cardPropertyValues.propertyDefinitionId, definitionId)))
      .get()?.value ?? null
  );
}

function versionOf(cardId: number): number {
  return db.select({ version: cards.version }).from(cards).where(eq(cards.id, cardId)).get()!.version;
}

function versionCount(cardId: number): number {
  return db.select().from(cardVersions).where(eq(cardVersions.cardId, cardId)).all().length;
}

function isMember(cardId: number): boolean {
  return Boolean(
    db.select().from(treeBelongings).where(and(eq(treeBelongings.treeConfigurationId, treeId), eq(treeBelongings.cardId, cardId))).get(),
  );
}

/** The card's tree-relationship values: property name → ancestor number. */
function relationships(cardId: number): Record<string, string> {
  const rows = db
    .select({ name: propertyDefinitions.name, value: cardPropertyValues.value })
    .from(cardPropertyValues)
    .innerJoin(propertyDefinitions, eq(propertyDefinitions.id, cardPropertyValues.propertyDefinitionId))
    .where(and(eq(cardPropertyValues.cardId, cardId), eq(propertyDefinitions.kind, "tree_relationship")))
    .all();
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(jobs).run();
  db.delete(treeBelongings).run();
  db.delete(treeCardTypes).run();
  db.delete(treeConfigurations).run();
  db.delete(cardPropertyValues).run();
  db.delete(propertyDefinitions).run();
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss");
  devId = register("dev");
  const project = mustOk(
    createProject(db, { name: "Sum Land", identifier: "sum_land", actorUserId: adminId }),
    "project",
  );
  projectId = project.id;
  projectIdentifier = project.identifier;
  mustOk(addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }), "member");
  releaseTypeId = mustOk(defineCardType(db, { projectId, name: "Release", actorUserId: adminId }), "Release").id;
  iterationTypeId = mustOk(defineCardType(db, { projectId, name: "Iteration", actorUserId: adminId }), "Iteration").id;
  storyTypeId = mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story").id;
  pointsId = mustOk(definePropertyDefinition(db, { projectId, name: "Points", kind: "number", actorUserId: adminId }), "Points").id;
  statusId = mustOk(
    definePropertyDefinition(db, { projectId, name: "Status", kind: "enumerated", values: ["Open", "Closed"], actorUserId: adminId }),
    "Status",
  ).id;
  treeId = mustOk(
    defineTree(db, {
      projectId,
      name: "Planning",
      levels: [
        { cardTypeId: releaseTypeId, relationshipName: "Release" },
        { cardTypeId: iterationTypeId, relationshipName: "Iteration" },
        { cardTypeId: storyTypeId },
      ],
      actorUserId: adminId,
    }),
    "tree",
  ).id;
});

/**
 * Seeds R1 > (I1 > S1[3], S2[5]; I2 > S3[8]) plus S4[100] under R1
 * directly and S5[7] not in the tree. Hand-computed: R1 all-descendant
 * SUM of Points = 3 + 5 + 8 + 100 = 116; I1 = 8; I2 = 8.
 */
function seedTree() {
  const r1 = card("R1", releaseTypeId);
  const i1 = card("I1", iterationTypeId);
  const i2 = card("I2", iterationTypeId);
  const s1 = card("S1", storyTypeId);
  const s2 = card("S2", storyTypeId);
  const s3 = card("S3", storyTypeId);
  const s4 = card("S4", storyTypeId);
  const s5 = card("S5", storyTypeId);
  place(r1.number, null);
  place(i1.number, r1.number);
  place(i2.number, r1.number);
  place(s1.number, i1.number);
  place(s2.number, i1.number);
  place(s3.number, i2.number);
  place(s4.number, r1.number);
  for (const [c, points] of [[s1, "3"], [s2, "5"], [s3, "8"], [s4, "100"], [s5, "7"]] as const) {
    mustOk(set(c.number, pointsId, points), `Points on ${c.name}`);
  }
  mustOk(set(s1.number, statusId, "Closed"), "S1 closed");
  mustOk(set(s3.number, statusId, "Closed"), "S3 closed");
  return { r1, i1, i2, s1, s2, s3, s4, s5 };
}

// ------------------------------------------------- defineAggregateProperty

describe("defineAggregateProperty", () => {
  it("persists the definition, backfills every current holder with a hand-computed total, appends no versions, and emits the event", () => {
    const { r1, i1, i2, s1 } = seedTree();
    const versionsBefore = [r1, i1, i2].map((c) => versionOf(c.id));
    const total = mustOk(defineAggregate({ name: "Total Points" }), "define");

    const row = db.select().from(propertyDefinitions).where(eq(propertyDefinitions.id, total.id)).get()!;
    expect(row).toMatchObject({
      projectId,
      name: "Total Points",
      kind: "aggregate",
      treeConfigurationId: treeId,
      aggregateCardTypeId: releaseTypeId,
      aggregateType: "sum",
      aggregateTargetId: pointsId,
      aggregateScopeCardTypeId: null,
      aggregateCondition: null,
    });
    // Positioned after every existing property.
    const positions = db.select({ position: propertyDefinitions.position }).from(propertyDefinitions).where(eq(propertyDefinitions.projectId, projectId)).all();
    expect(row.position).toBe(Math.max(...positions.map((p) => p.position)));

    // Backfilled on the holder: 3 + 5 + 8 + 100.
    expect(stored(r1.id, total.id)).toBe("116");
    // Not on cards of other types, not on a story — not even a count's "0".
    const count = mustOk(defineAggregate({ name: "Descendants", aggregateType: "count", targetPropertyDefinitionId: null }), "count");
    expect(stored(r1.id, count.id)).toBe("6");
    expect(stored(i1.id, total.id)).toBeNull();
    expect(stored(i1.id, count.id)).toBeNull();
    expect(stored(s1.id, total.id)).toBeNull();
    expect(stored(s1.id, count.id)).toBeNull();
    // No version churn on any holder.
    expect([r1, i1, i2].map((c) => versionOf(c.id))).toEqual(versionsBefore);

    const payloads = db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.type, "PropertyDefinitionDefined"))
      .all()
      .map((event) => JSON.parse(event.payload as string) as { name: string; kind: string });
    expect(payloads.find((p) => p.name === "Total Points")).toMatchObject({ kind: "aggregate", tree: "Planning", cardType: "Release", aggregateType: "sum", target: "Points", scope: null, condition: null });
    expect(payloads.find((p) => p.name === "Descendants")).toMatchObject({ kind: "aggregate", aggregateType: "count", target: null });
  });

  it("count needs no target and reports 0 for a holder with no descendants; sum over none is unset", () => {
    const { r1, i2 } = seedTree();
    const empty = card("R-empty", releaseTypeId);
    place(empty.number, null);
    const count = mustOk(defineAggregate({ name: "Story Count", aggregateType: "count", targetPropertyDefinitionId: null, scopeCardTypeId: storyTypeId }), "count");
    const sum = mustOk(defineAggregate({ name: "Iteration Sum", aggregateCardTypeId: iterationTypeId }), "sum");
    expect(stored(r1.id, count.id)).toBe("4"); // S1 S2 S3 S4
    expect(stored(empty.id, count.id)).toBe("0");
    expect(stored(i2.id, sum.id)).toBe("8");
    const lonely = card("I-lonely", iterationTypeId);
    place(lonely.number, r1.number);
    expect(stored(lonely.id, sum.id)).toBeNull();
    // count stored null target
    expect(db.select().from(propertyDefinitions).where(eq(propertyDefinitions.id, count.id)).get()!.aggregateTargetId).toBeNull();
  });

  it("avg, min and max use the canonical precision-2 form; a scope restricts to one card type", () => {
    const { r1 } = seedTree();
    const avg = mustOk(defineAggregate({ name: "Avg", aggregateType: "avg", scopeCardTypeId: storyTypeId }), "avg");
    const min = mustOk(defineAggregate({ name: "Min", aggregateType: "min" }), "min");
    const max = mustOk(defineAggregate({ name: "Max", aggregateType: "max" }), "max");
    // (3 + 5 + 8 + 100) / 4 = 29
    expect(stored(r1.id, avg.id)).toBe("29");
    expect(stored(r1.id, min.id)).toBe("3");
    expect(stored(r1.id, max.id)).toBe("100");
    // Iterations carry no Points, so scoping to them makes the sum unset.
    const iterOnly = mustOk(defineAggregate({ name: "Iter Points", scopeCardTypeId: iterationTypeId }), "iter");
    expect(stored(r1.id, iterOnly.id)).toBeNull();
    mustOk(set(1 + r1.number, pointsId, "2.5"), "I1 points"); // I1 is the card after R1
    expect(stored(r1.id, iterOnly.id)).toBe("2.5");
  });

  it("an MQL condition restricts the contributing descendants", () => {
    const { r1 } = seedTree();
    const closed = mustOk(defineAggregate({ name: "Closed Points", condition: "Status = Closed" }), "closed");
    // S1 (3) and S3 (8) are closed.
    expect(stored(r1.id, closed.id)).toBe("11");
    expect(db.select().from(propertyDefinitions).where(eq(propertyDefinitions.id, closed.id)).get()!.aggregateCondition).toBe("Status = Closed");
  });

  it("a formula target is accepted when number-valued and the aggregate reads its materialized values", () => {
    const { r1 } = seedTree();
    const doubled = mustOk(
      definePropertyDefinition(db, { projectId, name: "Doubled", kind: "formula", formula: "Points * 2", actorUserId: adminId }),
      "formula",
    );
    const sum = mustOk(defineAggregate({ name: "Doubled Total", targetPropertyDefinitionId: doubled.id }), "sum of formula");
    expect(stored(r1.id, sum.id)).toBe("232");
  });

  it("rejects a holder off the tree or at the leaf, a missing or non-numeric target, an aggregate target, and a bad scope — persisting nothing", () => {
    seedTree();
    const other = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug").id;
    expect(mustReject(defineAggregate({ name: "A", aggregateCardTypeId: other }), "off tree").aggregateCardType).toEqual([
      "Aggregate properties cannot be defined since Bug is not on the tree",
    ]);
    expect(mustReject(defineAggregate({ name: "A", aggregateCardTypeId: storyTypeId }), "leaf").aggregateCardType).toEqual([
      "Aggregate properties cannot be defined since Story does not have any children",
    ]);
    expect(mustReject(defineAggregate({ name: "A", targetPropertyDefinitionId: null }), "no target").target).toEqual([
      "Target property definition is required unless aggregate type is 'count'",
    ]);
    expect(mustReject(defineAggregate({ name: "A", targetPropertyDefinitionId: statusId }), "text target").target).toEqual([
      "Aggregate property definition must be numeric",
    ]);
    expect(mustReject(defineAggregate({ name: "A", aggregateType: "median" }), "bad fn").aggregateType).toEqual(["must be selected"]);
    expect(mustReject(defineAggregate({ name: "A", scopeCardTypeId: releaseTypeId }), "scope above").scope).toEqual([
      "Aggregate properties must have a valid scope",
    ]);
    expect(mustReject(defineAggregate({ name: "A", aggregateCardTypeId: iterationTypeId, scopeCardTypeId: iterationTypeId }), "scope self").scope).toEqual([
      "Aggregate properties must have a valid scope",
    ]);
    expect(mustReject(defineAggregate({ name: "Points" }), "taken").name).toEqual(["has already been taken"]);
    expect(mustReject(defineAggregate({ name: "A", actorUserId: devId }), "non-admin")).toEqual({ authorization: ["requires Project administrator access to this project"] });

    const total = mustOk(defineAggregate({ name: "Total" }), "total");
    expect(mustReject(defineAggregate({ name: "Nested", targetPropertyDefinitionId: total.id }), "aggregate target").target).toEqual([
      "Aggregate properties cannot have another aggregate property (Total) as a target",
    ]);
    mustOk(definePropertyDefinition(db, { projectId, name: "Due", kind: "date", actorUserId: adminId }), "date");
    const dueLater = mustOk(
      definePropertyDefinition(db, { projectId, name: "Due Later", kind: "formula", formula: "Due + 1", actorUserId: adminId }),
      "date formula",
    );
    expect(mustReject(defineAggregate({ name: "A", targetPropertyDefinitionId: dueLater.id }), "date formula target").target).toEqual([
      "Aggregate property definition must be numeric",
    ]);
    const names = db.select({ name: propertyDefinitions.name }).from(propertyDefinitions).where(eq(propertyDefinitions.kind, "aggregate")).all();
    expect(names).toEqual([{ name: "Total" }]);
  });

  it("rejects conditions that do not parse, are not plain conditions, or bind to a viewer/moment/aggregate", () => {
    seedTree();
    expect(mustReject(defineAggregate({ name: "A", condition: "Status = " }), "unparseable").condition?.[0]).toMatch(/^is not valid\./);
    expect(mustReject(defineAggregate({ name: "A", condition: "SELECT Points" }), "select").condition).toEqual([
      "An aggregate condition is a condition only — no SELECT, GROUP BY, ORDER BY or AS OF.",
    ]);
    mustOk(definePropertyDefinition(db, { projectId, name: "Owner", kind: "user", actorUserId: adminId }), "Owner");
    expect(mustReject(defineAggregate({ name: "A", condition: "Owner = CURRENT USER" }), "current user").condition).toEqual([
      "CURRENT USER is not supported in aggregate condition",
    ]);
    mustOk(definePropertyDefinition(db, { projectId, name: "Due", kind: "date", actorUserId: adminId }), "Due");
    expect(mustReject(defineAggregate({ name: "A", condition: "Due < TODAY" }), "today").condition).toEqual([
      "TODAY is not supported in aggregate condition",
    ]);
    mustOk(defineAggregate({ name: "Total" }), "total");
    expect(mustReject(defineAggregate({ name: "A", condition: "Total > 1" }), "aggregate in condition").condition).toEqual([
      "Total is an aggregate property and cannot be used in an aggregate condition",
    ]);
  });

  it("the define-property form cannot create an aggregate, and an aggregate can never be set directly", () => {
    const { r1 } = seedTree();
    expect(
      mustReject(definePropertyDefinition(db, { projectId, name: "A", kind: "aggregate", actorUserId: adminId }), "define kind").kind,
    ).toEqual(["is defined on a card tree's page, not here"]);
    const total = mustOk(defineAggregate({ name: "Total" }), "total");
    const before = versionOf(r1.id);
    expect(mustReject(set(r1.number, total.id, "1"), "set aggregate").property).toEqual([
      "Total is an aggregate property and cannot be set directly",
    ]);
    expect(stored(r1.id, total.id)).toBe("116");
    expect(versionOf(r1.id)).toBe(before);
  });
});

// ---------------------------------------------------------- recomputation

describe("aggregate recomputation", () => {
  it("EXIT CRITERION (real path): changing a leaf card's property recomputes and persists the ancestor's total with no ancestor version", () => {
    const { r1, i1, s1 } = seedTree();
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");
    expect(stored(r1.id, releaseTotal.id)).toBe("116");
    expect(stored(i1.id, iterationTotal.id)).toBe("8");
    const r1Versions = versionCount(r1.id);
    const i1Versions = versionCount(i1.id);

    // S1: 3 → 10. Hand-computed: R1 = 10 + 5 + 8 + 100 = 123; I1 = 10 + 5 = 15.
    mustOk(set(s1.number, pointsId, "10"), "change S1");
    expect(stored(r1.id, releaseTotal.id)).toBe("123");
    expect(stored(i1.id, iterationTotal.id)).toBe("15");
    // The holders were refreshed in place — no version appended to either.
    expect(versionCount(r1.id)).toBe(r1Versions);
    expect(versionCount(i1.id)).toBe(i1Versions);
    // The next version R1 takes snapshots the fresh aggregate under its id.
    mustOk(updateCard(db, { projectId, cardNumber: r1.number, name: "R1 renamed", cardTypeId: releaseTypeId, actorUserId: adminId }), "rename");
    const latest = db.select().from(cardVersions).where(eq(cardVersions.cardId, r1.id)).all().at(-1)!;
    expect(JSON.parse(latest.propertyValues)[String(releaseTotal.id)]).toBe("123");

    // Clearing the last contributing value makes a sum unset (row gone).
    for (const number of [s1.number, s1.number + 1, s1.number + 2, s1.number + 3]) mustOk(set(number, pointsId, null), `clear #${number}`);
    expect(stored(r1.id, releaseTotal.id)).toBeNull();
    expect(stored(i1.id, iterationTotal.id)).toBeNull();
  });

  it("a condition is applied at recomputation: closing a story moves its points into the conditional total", () => {
    const { r1, s2 } = seedTree();
    const closed = mustOk(defineAggregate({ name: "Closed Points", condition: "Status = Closed" }), "closed");
    expect(stored(r1.id, closed.id)).toBe("11");
    mustOk(set(s2.number, statusId, "Closed"), "close S2");
    expect(stored(r1.id, closed.id)).toBe("16");
    mustOk(set(s2.number, statusId, "Open"), "reopen S2");
    expect(stored(r1.id, closed.id)).toBe("11");
  });

  it("placing a card in the tree counts it, and both sides of a move are refreshed", () => {
    const { r1, i1, i2, s5 } = seedTree();
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");
    const releaseCount = mustOk(defineAggregate({ name: "Stories", aggregateType: "count", targetPropertyDefinitionId: null, scopeCardTypeId: storyTypeId }), "count");
    expect(stored(r1.id, releaseCount.id)).toBe("4");
    expect(stored(i2.id, iterationTotal.id)).toBe("8");

    // S5 (7 points, outside the tree) placed under I2: I2 = 15, R1 stories = 5.
    place(s5.number, i2.number);
    expect(stored(i2.id, iterationTotal.id)).toBe("15");
    expect(stored(r1.id, releaseCount.id)).toBe("5");

    // Moved from I2 to I1: I2 back to 8, I1 up from 8 to 15.
    place(s5.number, i1.number);
    expect(stored(i2.id, iterationTotal.id)).toBe("8");
    expect(stored(i1.id, iterationTotal.id)).toBe("15");

    // A newly placed release computes its own aggregates at once.
    const r2 = card("R2", releaseTypeId);
    expect(stored(r2.id, releaseCount.id)).toBeNull();
    place(r2.number, null);
    expect(stored(r2.id, releaseCount.id)).toBe("0");
  });

  it("removing a card refreshes what it contributed to and clears the aggregates it carried", () => {
    const { r1, i1, s1 } = seedTree();
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");
    const iterationCount = mustOk(defineAggregate({ name: "Iteration Stories", aggregateType: "count", targetPropertyDefinitionId: null, aggregateCardTypeId: iterationTypeId }), "iteration count");
    expect(stored(i1.id, iterationCount.id)).toBe("2");

    // S1 leaves: R1 = 116 - 3 = 113; I1 = 5, one story.
    mustOk(removeCardFromTree(db, { projectId, treeId, cardNumber: s1.number, withChildren: false, actorUserId: adminId }), "remove S1");
    expect(stored(r1.id, releaseTotal.id)).toBe("113");
    expect(stored(i1.id, iterationTotal.id)).toBe("5");
    expect(stored(i1.id, iterationCount.id)).toBe("1");

    // I1 leaves with its children (S2): R1 = 113 - 5 = 108; I1 carries
    // nothing — not even a count of 0, since it is no longer a holder.
    mustOk(removeCardFromTree(db, { projectId, treeId, cardNumber: i1.number, withChildren: true, actorUserId: adminId }), "remove I1 subtree");
    expect(stored(r1.id, releaseTotal.id)).toBe("108");
    expect(stored(i1.id, iterationTotal.id)).toBeNull();
    expect(stored(i1.id, iterationCount.id)).toBeNull();

    // I2 leaves WITHOUT children: S3 rolls up to R1 and still counts.
    mustOk(removeCardFromTree(db, { projectId, treeId, cardNumber: i1.number + 1, withChildren: false, actorUserId: adminId }), "remove I2");
    expect(stored(r1.id, releaseTotal.id)).toBe("108");
  });

  it("deleting a descendant refreshes its former ancestors and detaches its children", () => {
    const { r1, i1, s1, s2 } = seedTree();
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");

    mustOk(deleteCard(db, { projectId, cardNumber: s1.number, actorUserId: adminId }), "delete S1");
    expect(stored(r1.id, releaseTotal.id)).toBe("113");
    expect(stored(i1.id, iterationTotal.id)).toBe("5");
    expect(db.select().from(treeBelongings).where(eq(treeBelongings.cardId, s1.id)).all()).toHaveLength(0);

    // Deleting I1 detaches S2 to R1 (Iteration cleared, Release kept) — R1's total is unchanged.
    const s2Version = versionOf(s2.id);
    mustOk(deleteCard(db, { projectId, cardNumber: i1.number, actorUserId: adminId }), "delete I1");
    expect(relationships(s2.id)).toEqual({ Release: String(r1.number) });
    expect(versionOf(s2.id)).toBe(s2Version + 1);
    expect(isMember(s2.id)).toBe(true);
    expect(db.select().from(treeBelongings).where(eq(treeBelongings.cardId, i1.id)).all()).toHaveLength(0);
    expect(stored(r1.id, releaseTotal.id)).toBe("113");
  });

  it("reconfiguring the tree drops aggregates whose holder or scope type left and refreshes the rest", () => {
    const { r1, i1 } = seedTree();
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");
    const iterationCount = mustOk(defineAggregate({ name: "Iterations", aggregateType: "count", targetPropertyDefinitionId: null, scopeCardTypeId: iterationTypeId }), "iteration count");
    expect(stored(r1.id, iterationCount.id)).toBe("2");

    mustOk(
      reconfigureTree(db, {
        projectId,
        treeId,
        name: "Planning",
        levels: [
          { cardTypeId: releaseTypeId, relationshipName: "Release" },
          { cardTypeId: storyTypeId },
        ],
        actorUserId: adminId,
      }),
      "drop Iteration",
    );
    const remaining = db.select({ id: propertyDefinitions.id }).from(propertyDefinitions).where(eq(propertyDefinitions.kind, "aggregate")).all().map((r) => r.id);
    expect(remaining).toEqual([releaseTotal.id]);
    expect(stored(i1.id, iterationTotal.id)).toBeNull();
    expect(stored(r1.id, iterationCount.id)).toBeNull();
    // Stories rolled up to R1 and still count: 116 unchanged.
    expect(stored(r1.id, releaseTotal.id)).toBe("116");
  });

  it("an aggregate is read by MQL as a number and stays unset for a holder outside the tree", () => {
    const { r1 } = seedTree();
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const r2 = card("R2", releaseTypeId);
    const parsed = parseProjectMql(db, projectId, "'Total Points' > 99");
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const rows = queryCardsByMql(db, projectId, parsed.query, { currentUserId: adminId, today: todayIso() });
    expect(rows.map((row) => row.number)).toEqual([r1.number]);
    expect(stored(r2.id, releaseTotal.id)).toBeNull();
    const bad = parseProjectMql(db, projectId, "'Total Points' = soon");
    expect(bad.ok).toBe(false);
  });
});

// ------------------------------------------- card type change (Phase 23 gap)

describe("card type change in a tree", () => {
  it("a card whose new type is off the tree leaves it, children detached to its parent, aggregates refreshed", () => {
    const { r1, i1, s1, s2 } = seedTree();
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");
    const bugTypeId = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug").id;

    // I1 becomes a Bug: out of the tree; S1/S2 keep Release, lose Iteration.
    const s1Version = versionOf(s1.id);
    mustOk(updateCard(db, { projectId, cardNumber: i1.number, name: "I1", cardTypeId: bugTypeId, actorUserId: adminId }), "retype I1");
    expect(isMember(i1.id)).toBe(false);
    expect(relationships(i1.id)).toEqual({});
    expect(stored(i1.id, iterationTotal.id)).toBeNull();
    expect(relationships(s1.id)).toEqual({ Release: String(r1.number) });
    expect(relationships(s2.id)).toEqual({ Release: String(r1.number) });
    expect(versionOf(s1.id)).toBe(s1Version + 1);
    expect(isMember(s1.id)).toBe(true);
    // R1 still sums every story: 116.
    expect(stored(r1.id, releaseTotal.id)).toBe("116");
    // The card row itself took the new type with a single further version.
    const row = db.select().from(cards).where(eq(cards.id, i1.id)).get()!;
    expect(row.cardTypeId).toBe(bugTypeId);
    const versions = db.select().from(cardVersions).where(eq(cardVersions.cardId, i1.id)).all();
    expect(versions.at(-1)!.version).toBe(row.version);
    expect(versions.at(-1)!.cardTypeName).toBe("Bug");

    // S1 becomes a Bug: R1's total drops by 3.
    mustOk(updateCard(db, { projectId, cardNumber: s1.number, name: "S1", cardTypeId: bugTypeId, actorUserId: adminId }), "retype S1");
    expect(isMember(s1.id)).toBe(false);
    expect(stored(r1.id, releaseTotal.id)).toBe("113");
  });

  it("a card whose new type stays on the tree keeps the ancestry above its new level and sheds what named it through the old type", () => {
    const { r1, i1, i2, s1, s2, s3 } = seedTree();
    const iterationTotal = mustOk(defineAggregate({ name: "Iteration Points", aggregateCardTypeId: iterationTypeId }), "iteration total");
    const iterationCount = mustOk(defineAggregate({ name: "Iteration Stories", aggregateType: "count", targetPropertyDefinitionId: null, aggregateCardTypeId: iterationTypeId }), "iteration count");
    const releaseTotal = mustOk(defineAggregate({ name: "Total Points" }), "release total");
    const storyCount = mustOk(defineAggregate({ name: "Stories", aggregateType: "count", targetPropertyDefinitionId: null, scopeCardTypeId: storyTypeId }), "story count");
    expect(stored(r1.id, storyCount.id)).toBe("4");

    // S3 (under I2) becomes an Iteration: stays under R1, no longer names I2.
    mustOk(updateCard(db, { projectId, cardNumber: s3.number, name: "S3", cardTypeId: iterationTypeId, actorUserId: adminId }), "S3 → Iteration");
    expect(isMember(s3.id)).toBe(true);
    expect(relationships(s3.id)).toEqual({ Release: String(r1.number) });
    // It now holds the iteration aggregates (no children → sum unset, count 0) and no longer counts toward I2.
    expect(stored(s3.id, iterationTotal.id)).toBeNull();
    expect(stored(s3.id, iterationCount.id)).toBe("0");
    expect(stored(i2.id, iterationTotal.id)).toBeNull();
    // Its Points still count toward R1's all-descendant sum: 116 — but
    // it is no longer a Story, so the story-scoped count sees 3.
    expect(stored(r1.id, releaseTotal.id)).toBe("116");
    expect(stored(r1.id, storyCount.id)).toBe("3");

    // I1 becomes a Story: S1/S2 detach to R1; I1 itself stays under R1 as a story.
    mustOk(updateCard(db, { projectId, cardNumber: i1.number, name: "I1", cardTypeId: storyTypeId, actorUserId: adminId }), "I1 → Story");
    expect(relationships(s1.id)).toEqual({ Release: String(r1.number) });
    expect(relationships(s2.id)).toEqual({ Release: String(r1.number) });
    expect(relationships(i1.id)).toEqual({ Release: String(r1.number) });
    expect(stored(i1.id, iterationTotal.id)).toBeNull();
    expect(isMember(i1.id)).toBe(true);
  });
});

// ------------------------------------------------------------------ route

describe("tree page route (real loader/action)", () => {
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
    userId: number,
    path: string,
    params: Record<string, string>,
    fields?: Record<string, string>,
  ): Promise<Outcome> {
    const headers: Record<string, string> = { Cookie: await cookieFor(userId) };
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

  it("defines an aggregate through the form, lists it, and rejects a bad definition with field errors", async () => {
    const { r1 } = seedTree();
    const path = `/projects/${projectIdentifier}/trees/${treeId}`;
    const params = { identifier: projectIdentifier, treeId: String(treeId) };
    const outcome = await run(treeRoute.action, adminId, path, params, {
      intent: "define-aggregate",
      name: "Closed Points",
      aggregate_card_type: String(releaseTypeId),
      aggregate_type: "sum",
      target: String(pointsId),
      scope: String(storyTypeId),
      condition: "Status = Closed",
    });
    expect(outcome.status).toBe(302);
    expect(outcome.location).toBe(path);
    const definition = db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, "Closed Points")).get()!;
    expect(definition).toMatchObject({ kind: "aggregate", aggregateType: "sum", aggregateTargetId: pointsId, aggregateScopeCardTypeId: storyTypeId, aggregateCondition: "Status = Closed" });
    expect(stored(r1.id, definition.id)).toBe("11");

    const loaded = (await run(treeRoute.loader, devId, path, params)).data as {
      aggregates: { name: string; holderTypeName: string; targetName: string; scopeTypeName: string; condition: string }[];
      targetCandidates: { name: string }[];
    };
    expect(loaded.aggregates).toEqual([
      { id: definition.id, name: "Closed Points", aggregateType: "sum", holderTypeName: "Release", targetName: "Points", scopeTypeName: "Story", condition: "Status = Closed" },
    ]);
    expect(loaded.targetCandidates.map((c) => c.name)).toEqual(["Points"]);

    const rejected = await run(treeRoute.action, adminId, path, params, {
      intent: "define-aggregate",
      name: "Leaf Sum",
      aggregate_card_type: String(storyTypeId),
      aggregate_type: "sum",
      target: String(pointsId),
    });
    expect(rejected.status).toBe(400);
    expect((rejected.data as { errors: Record<string, string[]> }).errors.aggregateCardType).toEqual([
      "Aggregate properties cannot be defined since Story does not have any children",
    ]);
    // A non-admin cannot define one.
    const denied = await run(treeRoute.action, devId, path, params, {
      intent: "define-aggregate",
      name: "Nope",
      aggregate_card_type: String(releaseTypeId),
      aggregate_type: "count",
    });
    expect(denied.status).toBe(400);
    expect(db.select().from(propertyDefinitions).where(eq(propertyDefinitions.kind, "aggregate")).all()).toHaveLength(1);
  });
});
