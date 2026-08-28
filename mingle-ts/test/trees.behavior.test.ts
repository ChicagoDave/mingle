/**
 * Behavioral tests for card trees — configuration, placement, removal,
 * and the hierarchy read model (Phase 23).
 *
 * Derived from the phase's exit criterion: a 3-level hierarchy
 * (Release > Iteration > Story) persists correctly, a card's
 * tree-relationship property identifies its parent, and removing a
 * card from the tree detaches its children rather than deleting them —
 * all verified against real rows produced by the real commands over a
 * real file-backed SQLite database with the real migrations.
 *
 * The route section drives the actual tree route modules with a
 * Request carrying a real session cookie (the Phase 21 recipe).
 *
 * Owner context: Card Trees verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-trees-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "trees-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const treesRoute = await import("../app/routes/projects.trees");
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
const { createCard, defineCardType } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition, setCardPropertyValue } = await import(
  "../app/domain/cards/properties.server"
);
const { addCardToTree, defineTree, reconfigureTree, removeCardFromTree } = await import(
  "../app/domain/trees/commands.server"
);
const { listTrees, loadTree, treeHierarchy } = await import("../app/domain/trees/read.server");
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
let cardTypeId: number;

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
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "trees-phase-23!" }),
    login,
  ).id;
}

function card(name: string, typeId: number) {
  return mustOk(createCard(db, { projectId, name, cardTypeId: typeId, actorUserId: adminId }), name);
}

/** The standard Release > Iteration > Story tree. */
function planningTree() {
  return mustOk(
    defineTree(db, {
      projectId,
      name: "Planning",
      description: "Releases, iterations, stories",
      levels: [
        { cardTypeId: releaseTypeId, relationshipName: "Release" },
        { cardTypeId: iterationTypeId, relationshipName: "Iteration" },
        { cardTypeId: storyTypeId },
      ],
      actorUserId: adminId,
    }),
    "planning tree",
  );
}

/** The stored relationship values of a card: property name → value. */
function relationships(cardId: number): Record<string, string> {
  const rows = db
    .select({ name: propertyDefinitions.name, value: cardPropertyValues.value })
    .from(cardPropertyValues)
    .innerJoin(propertyDefinitions, eq(propertyDefinitions.id, cardPropertyValues.propertyDefinitionId))
    .where(and(eq(cardPropertyValues.cardId, cardId), eq(propertyDefinitions.kind, "tree_relationship")))
    .all();
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

function isMember(treeId: number, cardId: number): boolean {
  return Boolean(
    db
      .select()
      .from(treeBelongings)
      .where(and(eq(treeBelongings.treeConfigurationId, treeId), eq(treeBelongings.cardId, cardId)))
      .get(),
  );
}

function versionOf(cardId: number): number {
  return db.select({ version: cards.version }).from(cards).where(eq(cards.id, cardId)).get()!.version;
}

function eventsOfType(type: string) {
  return db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
}

/** Flattens a hierarchy to "parent>child" paths for terse assertions. */
function paths(nodes: ReturnType<typeof treeHierarchy>, prefix = ""): string[] {
  return nodes.flatMap((n) => {
    const here = `${prefix}${n.number}`;
    return [here, ...paths(n.children, `${here}>`)];
  });
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
    createProject(db, { name: "Tree Land", identifier: "tree_land", actorUserId: adminId }),
    "project",
  );
  projectId = project.id;
  projectIdentifier = project.identifier;
  mustOk(addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }), "member");
  cardTypeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
  releaseTypeId = mustOk(defineCardType(db, { projectId, name: "Release", actorUserId: adminId }), "Release").id;
  iterationTypeId = mustOk(defineCardType(db, { projectId, name: "Iteration", actorUserId: adminId }), "Iteration").id;
  storyTypeId = mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story").id;
});

// ---------------------------------------------------------- defineTree

describe("defineTree", () => {
  it("persists the tree, its ordered card types, and one tree_relationship property per non-leaf level", () => {
    const existing = mustOk(definePropertyDefinition(db, { projectId, name: "Status", kind: "text", actorUserId: adminId }), "Status");
    const tree = planningTree();
    const stored = db.select().from(treeConfigurations).where(eq(treeConfigurations.id, tree.id)).get()!;
    expect(stored).toMatchObject({ projectId, name: "Planning", description: "Releases, iterations, stories" });

    const levels = db
      .select()
      .from(treeCardTypes)
      .where(eq(treeCardTypes.treeConfigurationId, tree.id))
      .orderBy(treeCardTypes.position)
      .all();
    expect(levels.map((l) => [l.position, l.cardTypeId])).toEqual([
      [0, releaseTypeId],
      [1, iterationTypeId],
      [2, storyTypeId],
    ]);

    const rels = db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.treeConfigurationId, tree.id))
      .orderBy(propertyDefinitions.position)
      .all();
    expect(rels.map((r) => [r.name, r.kind, r.validCardTypeId])).toEqual([
      ["Release", "tree_relationship", releaseTypeId],
      ["Iteration", "tree_relationship", iterationTypeId],
    ]);
    // Relationships are appended after the project's existing properties.
    expect(rels[0].position).toBeGreaterThan(existing.position);
    expect(rels[1].position).toBe(rels[0].position + 1);

    const shape = loadTree(db, projectId, tree.id)!;
    expect(shape.levels.map((l) => [l.cardTypeName, l.relationship?.name ?? null])).toEqual([
      ["Release", "Release"],
      ["Iteration", "Iteration"],
      ["Story", null],
    ]);
    expect(listTrees(db, projectId)).toEqual([
      { id: tree.id, name: "Planning", description: "Releases, iterations, stories", cardTypeNames: ["Release", "Iteration", "Story"] },
    ]);
    const events = eventsOfType("TreeDefined");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ name: "Planning", relationshipNames: ["Release", "Iteration"] });
  });

  it("rejects bad names: blank, forbidden characters, 'none', taken by a tree, taken by a property", () => {
    mustOk(definePropertyDefinition(db, { projectId, name: "Status", kind: "text", actorUserId: adminId }), "Status");
    planningTree();
    const attempt = (name: string) =>
      mustReject(
        defineTree(db, { projectId, name, levels: [{ cardTypeId: releaseTypeId, relationshipName: "R" }, { cardTypeId: storyTypeId }], actorUserId: adminId }),
        name,
      ).name?.[0];
    expect(attempt("  ")).toBe("can't be blank");
    expect(attempt("A & B")).toContain("should not contain");
    expect(attempt("None")).toBe("cannot be None");
    expect(attempt("PLANNING")).toBe("has already been taken");
    expect(attempt("status")).toBe("has already been taken by a property");
    expect(db.select().from(treeConfigurations).all()).toHaveLength(1);
  });

  it("rejects bad levels and relationship names, and a non-admin", () => {
    mustOk(definePropertyDefinition(db, { projectId, name: "Owner", kind: "text", actorUserId: adminId }), "Owner");
    const levels = (l: { cardTypeId: number; relationshipName?: string }[]) =>
      mustReject(defineTree(db, { projectId, name: "T", levels: l, actorUserId: adminId }), "levels");
    expect(levels([{ cardTypeId: releaseTypeId }]).levels?.[0]).toContain("at least two");
    expect(levels([{ cardTypeId: releaseTypeId, relationshipName: "R" }, { cardTypeId: releaseTypeId }]).levels?.[0]).toContain("only once");
    expect(levels([{ cardTypeId: releaseTypeId, relationshipName: "R" }, { cardTypeId: 424242 }]).levels?.[0]).toContain("belong to this project");
    expect(levels([{ cardTypeId: releaseTypeId, relationshipName: " " }, { cardTypeId: storyTypeId }]).relationships?.[0]).toContain("blank");
    expect(levels([{ cardTypeId: releaseTypeId, relationshipName: "Owner" }, { cardTypeId: storyTypeId }]).relationships?.[0]).toContain("taken by a property");
    expect(
      levels([
        { cardTypeId: releaseTypeId, relationshipName: "Parent" },
        { cardTypeId: iterationTypeId, relationshipName: "parent" },
        { cardTypeId: storyTypeId },
      ]).relationships?.[0],
    ).toContain("not unique");
    expect(
      mustReject(
        defineTree(db, { projectId, name: "T", levels: [{ cardTypeId: releaseTypeId, relationshipName: "R" }, { cardTypeId: storyTypeId }], actorUserId: devId }),
        "dev",
      ).authorization,
    ).toBeDefined();
    expect(db.select().from(treeConfigurations).all()).toHaveLength(0);
    expect(db.select().from(propertyDefinitions).where(eq(propertyDefinitions.kind, "tree_relationship")).all()).toHaveLength(0);
  });

  it("a tree_relationship kind cannot be defined or set as an ordinary property", () => {
    const tree = planningTree();
    expect(
      mustReject(definePropertyDefinition(db, { projectId, name: "Parent", kind: "tree_relationship", actorUserId: adminId }), "define").kind?.[0],
    ).toContain("configuring a card tree");
    const story = card("S", storyTypeId);
    const release = loadTree(db, projectId, tree.id)!.levels[0].relationship!;
    expect(
      mustReject(
        setCardPropertyValue(db, { projectId, cardNumber: story.number, propertyDefinitionId: release.id, value: "1", actorUserId: adminId }),
        "set",
      ).property?.[0],
    ).toContain("placing the card in its tree");
    expect(relationships(story.id)).toEqual({});
  });
});

// ------------------------------------------------------- addCardToTree

describe("addCardToTree", () => {
  it("a 3-level hierarchy persists: each card's relationships identify its parent and inherited ancestors", () => {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const i1 = card("I1", iterationTypeId);
    const s1 = card("S1", storyTypeId);

    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: r1.number, parentCardNumber: null, actorUserId: devId }), "R1");
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: i1.number, parentCardNumber: r1.number, actorUserId: devId }), "I1");
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: s1.number, parentCardNumber: i1.number, actorUserId: devId }), "S1");

    expect(relationships(r1.id)).toEqual({});
    expect(relationships(i1.id)).toEqual({ Release: String(r1.number) });
    expect(relationships(s1.id)).toEqual({ Release: String(r1.number), Iteration: String(i1.number) });
    for (const c of [r1, i1, s1]) expect(isMember(tree.id, c.id)).toBe(true);
    // A placement is a card version; a root placement changes nothing and appends none.
    expect(versionOf(r1.id)).toBe(1);
    expect(versionOf(i1.id)).toBe(2);
    expect(versionOf(s1.id)).toBe(2);
    expect(paths(treeHierarchy(db, loadTree(db, projectId, tree.id)!))).toEqual([
      `${r1.number}`,
      `${r1.number}>${i1.number}`,
      `${r1.number}>${i1.number}>${s1.number}`,
    ]);
    const events = eventsOfType("CardAddedToTree");
    expect(events.map((e) => JSON.parse(e.payload).parentCardNumber)).toEqual([null, r1.number, i1.number]);
  });

  it("a story may sit directly under a release; the skipped level stays unset and the view nests it under the release", () => {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const s1 = card("S1", storyTypeId);
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: r1.number, parentCardNumber: null, actorUserId: devId }), "R1");
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: s1.number, parentCardNumber: r1.number, actorUserId: devId }), "S1");
    expect(relationships(s1.id)).toEqual({ Release: String(r1.number) });
    expect(paths(treeHierarchy(db, loadTree(db, projectId, tree.id)!))).toEqual([`${r1.number}`, `${r1.number}>${s1.number}`]);
  });

  it("moving a card under a new parent rewrites its ancestry and revises every descendant", () => {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const r2 = card("R2", releaseTypeId);
    const i1 = card("I1", iterationTypeId);
    const s1 = card("S1", storyTypeId);
    for (const [c, parent] of [
      [r1, null],
      [r2, null],
      [i1, r1.number],
      [s1, i1.number],
    ] as const) {
      mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: c.number, parentCardNumber: parent, actorUserId: devId }), c.name);
    }
    const storyVersionBefore = versionOf(s1.id);

    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: i1.number, parentCardNumber: r2.number, actorUserId: devId }), "move I1");
    expect(relationships(i1.id)).toEqual({ Release: String(r2.number) });
    expect(relationships(s1.id)).toEqual({ Release: String(r2.number), Iteration: String(i1.number) });
    expect(versionOf(s1.id)).toBe(storyVersionBefore + 1);
    expect(paths(treeHierarchy(db, loadTree(db, projectId, tree.id)!))).toEqual([
      `${r1.number}`,
      `${r2.number}`,
      `${r2.number}>${i1.number}`,
      `${r2.number}>${i1.number}>${s1.number}`,
    ]);

    // Moving to the root clears everything, on the card and below it.
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: i1.number, parentCardNumber: null, actorUserId: devId }), "root I1");
    expect(relationships(i1.id)).toEqual({});
    expect(relationships(s1.id)).toEqual({ Iteration: String(i1.number) });
  });

  it("rejects a type outside the tree, a parent that cannot contain the card, a parent not in the tree, self-parenting, and a no-op", () => {
    const tree = planningTree();
    const plain = card("Plain", cardTypeId);
    const r1 = card("R1", releaseTypeId);
    const i1 = card("I1", iterationTypeId);
    const s1 = card("S1", storyTypeId);
    const add = (c: { number: number }, parent: number | null) =>
      addCardToTree(db, { projectId, treeId: tree.id, cardNumber: c.number, parentCardNumber: parent, actorUserId: devId });

    expect(mustReject(add(plain, null), "plain").card?.[0]).toBe("Card tree Planning cannot contain Card cards.");
    expect(mustReject(add(i1, r1.number), "parent not member").parent?.[0]).toBe("is not in the tree");
    mustOk(add(r1, null), "R1");
    mustOk(add(s1, null), "S1 root");
    expect(mustReject(add(r1, s1.number), "release under story").parent?.[0]).toBe("type Story cannot contain type Release");
    expect(mustReject(add(i1, i1.number), "self").parent?.[0]).toBe("cannot be the card itself");
    expect(mustReject(add(r1, null), "noop").card?.[0]).toBe("is already in that position");
    expect(mustReject(add(s1, 999), "missing parent").parent?.[0]).toBe("does not exist");
    expect(isMember(tree.id, plain.id)).toBe(false);
    expect(isMember(tree.id, i1.id)).toBe(false);
  });

  it("MQL filters on a relationship by the ancestor card's number", () => {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const r2 = card("R2", releaseTypeId);
    const s1 = card("S1", storyTypeId);
    const s2 = card("S2", storyTypeId);
    for (const [c, parent] of [[r1, null], [r2, null], [s1, r1.number], [s2, r2.number]] as const) {
      mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: c.number, parentCardNumber: parent, actorUserId: devId }), c.name);
    }
    const numbers = (mql: string) => {
      const parsed = parseProjectMql(db, projectId, mql);
      if (!parsed.ok) throw new Error(parsed.errors.join(" | "));
      return queryCardsByMql(db, projectId, parsed.query, { currentUserId: devId, today: todayIso() }).map((c) => c.number);
    };
    expect(numbers(`Release = ${r1.number}`)).toEqual([s1.number]);
    expect(numbers(`Release = ${r2.number}`)).toEqual([s2.number]);
    expect(numbers(`Release != ${r2.number}`).sort()).toEqual([r1.number, r2.number, s1.number].sort());
    expect(parseProjectMql(db, projectId, "Release = banana").ok).toBe(false);
  });
});

// -------------------------------------------------- removeCardFromTree

describe("removeCardFromTree", () => {
  function hierarchy() {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const i1 = card("I1", iterationTypeId);
    const s1 = card("S1", storyTypeId);
    const s2 = card("S2", storyTypeId);
    for (const [c, parent] of [[r1, null], [i1, r1.number], [s1, i1.number], [s2, i1.number]] as const) {
      mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: c.number, parentCardNumber: parent, actorUserId: devId }), c.name);
    }
    return { tree, r1, i1, s1, s2 };
  }

  it("removing a card detaches its children to the card's parent — they stay in the tree, and no card is deleted", () => {
    const { tree, r1, i1, s1, s2 } = hierarchy();
    const touched = mustOk(
      removeCardFromTree(db, { projectId, treeId: tree.id, cardNumber: i1.number, withChildren: false, actorUserId: devId }),
      "remove I1",
    );
    expect(touched).toEqual([i1.number, s1.number, s2.number]);
    expect(isMember(tree.id, i1.id)).toBe(false);
    expect(relationships(i1.id)).toEqual({});
    for (const s of [s1, s2]) {
      expect(isMember(tree.id, s.id)).toBe(true);
      expect(relationships(s.id)).toEqual({ Release: String(r1.number) });
    }
    expect(db.select().from(cards).all()).toHaveLength(4);
    expect(paths(treeHierarchy(db, loadTree(db, projectId, tree.id)!))).toEqual([
      `${r1.number}`,
      `${r1.number}>${s1.number}`,
      `${r1.number}>${s2.number}`,
    ]);
    const events = eventsOfType("CardRemovedFromTree");
    expect(JSON.parse(events[0].payload)).toMatchObject({ cardNumber: i1.number, withChildren: false });
  });

  it("removing a card with its children takes the whole subtree out and clears every relationship on it", () => {
    const { tree, r1, i1, s1, s2 } = hierarchy();
    mustOk(removeCardFromTree(db, { projectId, treeId: tree.id, cardNumber: r1.number, withChildren: true, actorUserId: devId }), "remove R1 subtree");
    for (const c of [r1, i1, s1, s2]) {
      expect(isMember(tree.id, c.id)).toBe(false);
      expect(relationships(c.id)).toEqual({});
    }
    expect(db.select().from(cards).all()).toHaveLength(4);
    expect(treeHierarchy(db, loadTree(db, projectId, tree.id)!)).toEqual([]);
    // Each affected card got exactly one more version for the removal.
    expect(versionOf(s1.id)).toBe(3);
  });

  it("rejects a card that is not in the tree", () => {
    const { tree } = hierarchy();
    const loose = card("Loose", storyTypeId);
    expect(
      mustReject(removeCardFromTree(db, { projectId, treeId: tree.id, cardNumber: loose.number, withChildren: false, actorUserId: devId }), "loose").card?.[0],
    ).toBe("is not in the tree");
    expect(mustReject(removeCardFromTree(db, { projectId, treeId: 999, cardNumber: loose.number, withChildren: false, actorUserId: devId }), "tree").tree?.[0]).toBe(
      "does not exist",
    );
  });
});

// ----------------------------------------------------- reconfigureTree

describe("reconfigureTree", () => {
  function hierarchy() {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const i1 = card("I1", iterationTypeId);
    const s1 = card("S1", storyTypeId);
    for (const [c, parent] of [[r1, null], [i1, r1.number], [s1, i1.number]] as const) {
      mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: c.number, parentCardNumber: parent, actorUserId: devId }), c.name);
    }
    return { tree, r1, i1, s1 };
  }
  const levelsOf = (treeId: number) =>
    loadTree(db, projectId, treeId)!.levels.map((l) => [l.cardTypeName, l.relationship?.name ?? null]);

  it("dropping a card type takes its cards out with children moved up, and deletes its relationship", () => {
    const { tree, r1, i1, s1 } = hierarchy();
    const result = mustOk(
      reconfigureTree(db, {
        projectId,
        treeId: tree.id,
        name: "Planning",
        levels: [{ cardTypeId: releaseTypeId, relationshipName: "Release" }, { cardTypeId: storyTypeId }],
        actorUserId: adminId,
      }),
      "drop Iteration",
    );
    expect(result.name).toBe("Planning");
    expect(levelsOf(tree.id)).toEqual([["Release", "Release"], ["Story", null]]);
    expect(isMember(tree.id, i1.id)).toBe(false);
    expect(isMember(tree.id, s1.id)).toBe(true);
    expect(relationships(s1.id)).toEqual({ Release: String(r1.number) });
    expect(relationships(i1.id)).toEqual({});
    expect(db.select().from(propertyDefinitions).where(eq(propertyDefinitions.kind, "tree_relationship")).all().map((d) => d.name)).toEqual(["Release"]);
    expect(paths(treeHierarchy(db, loadTree(db, projectId, tree.id)!))).toEqual([`${r1.number}`, `${r1.number}>${s1.number}`]);
    expect(JSON.parse(eventsOfType("TreeReconfigured")[0].payload).removedCardNumbers).toEqual([i1.number, s1.number]);
  });

  it("adding a type on top creates its relationship, renames a surviving one, and keeps every card where it was", () => {
    const { tree, r1, i1, s1 } = hierarchy();
    const epicTypeId = mustOk(defineCardType(db, { projectId, name: "Epic", actorUserId: adminId }), "Epic").id;
    mustOk(
      reconfigureTree(db, {
        projectId,
        treeId: tree.id,
        name: "Roadmap",
        description: "now with epics",
        levels: [
          { cardTypeId: epicTypeId, relationshipName: "Epic" },
          { cardTypeId: releaseTypeId, relationshipName: "Planned release" },
          { cardTypeId: iterationTypeId, relationshipName: "Iteration" },
          { cardTypeId: storyTypeId },
        ],
        actorUserId: adminId,
      }),
      "add Epic",
    );
    expect(levelsOf(tree.id)).toEqual([["Epic", "Epic"], ["Release", "Planned release"], ["Iteration", "Iteration"], ["Story", null]]);
    expect(db.select().from(treeConfigurations).where(eq(treeConfigurations.id, tree.id)).get()).toMatchObject({ name: "Roadmap", description: "now with epics" });
    for (const c of [r1, i1, s1]) expect(isMember(tree.id, c.id)).toBe(true);
    expect(relationships(s1.id)).toEqual({ "Planned release": String(r1.number), Iteration: String(i1.number) });
    const e1 = card("E1", epicTypeId);
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: e1.number, parentCardNumber: null, actorUserId: devId }), "E1");
    mustOk(addCardToTree(db, { projectId, treeId: tree.id, cardNumber: r1.number, parentCardNumber: e1.number, actorUserId: devId }), "R1 under E1");
    expect(relationships(s1.id)).toEqual({ Epic: String(e1.number), "Planned release": String(r1.number), Iteration: String(i1.number) });
  });

  it("the leaf can change: the old leaf's parent type loses its relationship when it becomes the leaf", () => {
    const { tree, r1, i1, s1 } = hierarchy();
    mustOk(
      reconfigureTree(db, {
        projectId,
        treeId: tree.id,
        name: "Planning",
        levels: [{ cardTypeId: releaseTypeId, relationshipName: "Release" }, { cardTypeId: iterationTypeId }],
        actorUserId: adminId,
      }),
      "drop Story",
    );
    expect(levelsOf(tree.id)).toEqual([["Release", "Release"], ["Iteration", null]]);
    expect(isMember(tree.id, s1.id)).toBe(false);
    expect(relationships(s1.id)).toEqual({});
    expect(relationships(i1.id)).toEqual({ Release: String(r1.number) });
    expect(db.select().from(cardPropertyValues).all().every((v) => v.value !== String(i1.number))).toBe(true);
  });

  it("rejects reordering while the tree has cards, and a relationship name owned by another property", () => {
    const { tree } = hierarchy();
    mustOk(definePropertyDefinition(db, { projectId, name: "Owner", kind: "text", actorUserId: adminId }), "Owner");
    expect(
      mustReject(
        reconfigureTree(db, {
          projectId,
          treeId: tree.id,
          name: "Planning",
          levels: [{ cardTypeId: iterationTypeId, relationshipName: "Iteration" }, { cardTypeId: releaseTypeId, relationshipName: "Release" }, { cardTypeId: storyTypeId }],
          actorUserId: adminId,
        }),
        "reorder",
      ).levels?.[0],
    ).toContain("cannot reorder");
    expect(
      mustReject(
        reconfigureTree(db, {
          projectId,
          treeId: tree.id,
          name: "Planning",
          levels: [{ cardTypeId: releaseTypeId, relationshipName: "Owner" }, { cardTypeId: iterationTypeId, relationshipName: "Iteration" }, { cardTypeId: storyTypeId }],
          actorUserId: adminId,
        }),
        "clash",
      ).relationships?.[0],
    ).toContain("taken by a property");
    expect(
      mustReject(
        reconfigureTree(db, { projectId, treeId: tree.id, name: "Planning", levels: [{ cardTypeId: releaseTypeId, relationshipName: "Release" }, { cardTypeId: storyTypeId }], actorUserId: devId }),
        "dev",
      ).authorization,
    ).toBeDefined();
    expect(levelsOf(tree.id)).toEqual([["Release", "Release"], ["Iteration", "Iteration"], ["Story", null]]);
  });
});

// --------------------------------------------------------------- routes

describe("tree routes (real route modules)", () => {
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

  it("defining a tree through the form persists it and redirects to its hierarchy", async () => {
    const outcome = await run(treesRoute.action, adminId, `/projects/${projectIdentifier}/trees`, { identifier: projectIdentifier }, {
      intent: "define",
      name: "Planning",
      description: "",
      level_type_0: String(releaseTypeId),
      relationship_name_0: "Release",
      level_type_1: "",
      relationship_name_1: "",
      level_type_2: String(storyTypeId),
      relationship_name_2: "",
    });
    const tree = db.select().from(treeConfigurations).get()!;
    expect(tree.name).toBe("Planning");
    expect(outcome.status).toBe(302);
    expect(outcome.location).toBe(`/projects/${projectIdentifier}/trees/${tree.id}`);
    expect(db.select().from(treeCardTypes).all().map((l) => l.cardTypeId)).toEqual([releaseTypeId, storyTypeId]);
  });

  it("the hierarchy page adds and removes cards, and its loader nests them", async () => {
    const tree = planningTree();
    const r1 = card("R1", releaseTypeId);
    const s1 = card("S1", storyTypeId);
    const path = `/projects/${projectIdentifier}/trees/${tree.id}`;
    const params = { identifier: projectIdentifier, treeId: String(tree.id) };

    expect((await run(treeRoute.action, devId, path, params, { intent: "add", card_number: String(r1.number), parent_card_number: "" })).status).toBe(302);
    expect((await run(treeRoute.action, devId, path, params, { intent: "add", card_number: String(s1.number), parent_card_number: String(r1.number) })).status).toBe(302);
    const loaded = (await run(treeRoute.loader, devId, path, params)).data as { nodes: { number: number; children: { number: number }[] }[] };
    expect(loaded.nodes.map((n) => [n.number, n.children.map((c) => c.number)])).toEqual([[r1.number, [s1.number]]]);

    const rejected = await run(treeRoute.action, devId, path, params, { intent: "add", card_number: String(r1.number), parent_card_number: String(s1.number) });
    expect(rejected.status).toBe(400);
    expect((rejected.data as { errors: Record<string, string[]> }).errors.parent[0]).toContain("cannot contain");

    expect((await run(treeRoute.action, devId, path, params, { intent: "remove", card_number: String(r1.number), with_children: "false" })).status).toBe(302);
    expect(isMember(tree.id, r1.id)).toBe(false);
    expect(isMember(tree.id, s1.id)).toBe(true);
    expect((await run(treeRoute.loader, devId, `/projects/${projectIdentifier}/trees/999`, { identifier: projectIdentifier, treeId: "999" })).status).toBe(404);
  });

  it("the reconfigure form drops a type through the real action", async () => {
    const tree = planningTree();
    const path = `/projects/${projectIdentifier}/trees/${tree.id}`;
    const params = { identifier: projectIdentifier, treeId: String(tree.id) };
    const outcome = await run(treeRoute.action, adminId, path, params, {
      intent: "reconfigure",
      name: "Planning",
      description: "",
      level_type_0: String(releaseTypeId),
      relationship_name_0: "Release",
      level_type_1: String(storyTypeId),
      relationship_name_1: "",
    });
    expect(outcome.status).toBe(302);
    expect(loadTree(db, projectId, tree.id)!.levels.map((l) => l.cardTypeName)).toEqual(["Release", "Story"]);
    expect((await run(treeRoute.action, devId, path, params, { intent: "reconfigure", name: "Planning", level_type_0: String(releaseTypeId), relationship_name_0: "Release", level_type_1: String(storyTypeId) })).status).toBe(400);
  });
});
