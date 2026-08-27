/**
 * Behavioral tests for bulk transitions, transition workflows, and
 * auto-transitions (Phase 15) — the REAL-PATH suite for this phase
 * (rule 13a: the phase is named after an engine and a workflow, so its
 * acceptance gate runs the production code path, not a stand-in).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * ExecuteBulkTransition, GenerateTransitionWorkflow,
 * ApplyCardPropertyValue, and SetPropertyTransitionOnly: every DOES
 * asserts on rows reloaded from the database (card_property_values,
 * cards.version, the appended card_versions rows, transition rows,
 * property_definitions.transition_only, domain_events), and every
 * REJECTS WHEN has its own test proving nothing mutated — including
 * the plan's two exit criteria: bulk-transitioning 3+ selected cards
 * updates all of them atomically (all-or-none on a shared requirement
 * failure), and an auto-transition fires without the user naming a
 * transition when its trigger condition becomes true.
 *
 * Runs against a real, file-backed SQLite database created fresh per
 * suite with the real generated migrations (0000–0010), seeded through
 * the real domain commands — no stubs, no fakes, nothing injected.
 *
 * Owner context: Card Management (workflow) verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { projects } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import {
  groupMemberships,
  groups,
  teamMemberships,
} from "../app/db/schema/membership";
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
} from "../app/db/schema/properties";
import {
  transitionActions,
  transitionPrerequisites,
  transitions,
} from "../app/db/schema/transitions";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard, defineCardType } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
  setPropertyTransitionOnly,
} from "../app/domain/cards/properties.server";
import {
  commonTransitions,
  defineTransition,
  executeBulkTransition,
  type DefineTransitionInput,
} from "../app/domain/cards/transitions.server";
import {
  applyCardPropertyValue,
  generateTransitionWorkflow,
  previewTransitionWorkflow,
} from "../app/domain/cards/transition-workflows.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-workflows-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number; //        site admin (first registered user)
let projectAdminId: number; // project_admin of the project
let memberId: number; //       full_member of the project
let readonlyId: number; //     readonly_member of the project
let projectId: number;
let storyTypeId: number; //    the default "Card" type
let bugTypeId: number; //      a second card type
let statusId: number; //       enumerated: New, Open, Closed
let ownerId: number; //        user
let estimateId: number; //     number
let doubleId: number; //       formula: Estimate * 2
let first: number; //          three cards of the default type, Status = New
let second: number;
let third: number;

function register(login: string): number {
  const result = registerUser(db, { login, name: login, password: "card-wall-2010!" });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function mustReject<T>(result: CommandResult<T>, what: string) {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return result.errors;
}

/** A card seeded with Status = New. */
function seedCard(name: string): number {
  const number = mustOk(
    createCard(db, { projectId, name, cardTypeId: storyTypeId, actorUserId: memberId }),
    `card ${name}`,
  ).number;
  mustOk(
    setCardPropertyValue(db, {
      projectId,
      cardNumber: number,
      propertyDefinitionId: statusId,
      value: "New",
      actorUserId: memberId,
    }),
    `${name} Status = New`,
  );
  return number;
}

beforeEach(() => {
  for (const table of [
    domainEvents,
    transitionActions,
    transitionPrerequisites,
    transitions,
    cardPropertyValues,
    enumerationValues,
    propertyDefinitions,
    cardVersions,
    cards,
    cardTypes,
    groupMemberships,
    groups,
    teamMemberships,
    projects,
    users,
  ])
    db.delete(table).run();
  adminId = register("boss");
  projectAdminId = register("lead");
  memberId = register("dev");
  readonlyId = register("viewer");
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "project",
  ).id;
  storyTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  bugTypeId = mustOk(
    defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }),
    "bug type",
  ).id;
  for (const [userId, role] of [
    [projectAdminId, "project_admin"],
    [memberId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const)
    mustOk(addTeamMember(db, { projectId, userId, role, actorUserId: adminId }), "member");
  statusId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Status",
      kind: "enumerated",
      values: ["New", "Open", "Closed"],
      actorUserId: projectAdminId,
    }),
    "Status",
  ).id;
  ownerId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Owner",
      kind: "user",
      actorUserId: projectAdminId,
    }),
    "Owner",
  ).id;
  estimateId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Estimate",
      kind: "number",
      actorUserId: projectAdminId,
    }),
    "Estimate",
  ).id;
  doubleId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Double",
      kind: "formula",
      formula: "Estimate * 2",
      actorUserId: projectAdminId,
    }),
    "Double",
  ).id;
  first = seedCard("Story one");
  second = seedCard("Story two");
  third = seedCard("Story three");
  db.delete(domainEvents).run(); // only events under test matter below
});

/** DefineTransition with the common defaults filled in. */
function define(overrides: Partial<DefineTransitionInput>) {
  return defineTransition(db, {
    projectId,
    name: "Open it",
    prerequisites: [
      { kind: "has_specific_value", propertyDefinitionId: statusId, value: "New" },
    ],
    actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" }],
    actorUserId: projectAdminId,
    ...overrides,
  });
}

function reloadCard(number: number) {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
    .get()!;
}

/** Current values keyed by definition id, as a plain object. */
function reloadValues(number: number): Record<string, string> {
  const card = reloadCard(number);
  return Object.fromEntries(
    db
      .select({
        propertyDefinitionId: cardPropertyValues.propertyDefinitionId,
        value: cardPropertyValues.value,
      })
      .from(cardPropertyValues)
      .where(eq(cardPropertyValues.cardId, card.id))
      .all()
      .map((row) => [String(row.propertyDefinitionId), row.value]),
  );
}

function versionRows(number: number) {
  return db
    .select()
    .from(cardVersions)
    .where(and(eq(cardVersions.projectId, projectId), eq(cardVersions.number, number)))
    .orderBy(asc(cardVersions.version))
    .all();
}

function eventsOfType(type: string) {
  return db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
}

function transitionRows() {
  return db
    .select()
    .from(transitions)
    .where(eq(transitions.projectId, projectId))
    .orderBy(asc(transitions.id))
    .all();
}

// ===========================================================================
// ExecuteBulkTransition
// ===========================================================================

describe("ExecuteBulkTransition", () => {
  it("applies the transition to every selected card, one new version each", () => {
    const transition = mustOk(define({}), "transition");
    const before = [first, second, third].map((number) => reloadCard(number).version);

    const result = mustOk(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second, third],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "bulk",
    );

    expect(result.cardNumbers).toEqual([first, second, third]);
    expect(result.changedCardNumbers).toEqual([first, second, third]);
    [first, second, third].forEach((number, index) => {
      expect(reloadValues(number)[String(statusId)]).toBe("Open");
      expect(reloadCard(number).version).toBe(before[index] + 1);
      const versions = versionRows(number);
      const latest = versions[versions.length - 1];
      expect(latest.version).toBe(before[index] + 1);
      expect(JSON.parse(latest.propertyValues)).toMatchObject({
        [String(statusId)]: "Open",
      });
    });
  });

  it("emits one TransitionExecuted per card and one BulkTransitionExecuted for the set", () => {
    const transition = mustOk(define({}), "transition");
    mustOk(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second, third],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "bulk",
    );

    expect(eventsOfType("TransitionExecuted")).toHaveLength(3);
    const bulk = eventsOfType("BulkTransitionExecuted");
    expect(bulk).toHaveLength(1);
    expect(JSON.parse(bulk[0].payload)).toMatchObject({
      transition: "Open it",
      cardNumbers: [first, second, third],
      changedCardNumbers: [first, second, third],
    });
    expect(bulk[0].actorUserId).toBe(memberId);
  });

  it("collapses duplicate card numbers so a card gains only one version", () => {
    const transition = mustOk(define({}), "transition");
    const before = reloadCard(first).version;

    const result = mustOk(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, first, first],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "bulk",
    );

    expect(result.cardNumbers).toEqual([first]);
    expect(reloadCard(first).version).toBe(before + 1);
  });

  it("applies the same user-entered value to every card in the selection", () => {
    const transition = mustOk(
      define({
        name: "Assign and open",
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
        ],
      }),
      "transition",
    );

    mustOk(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second],
        transitionId: transition.id,
        userInput: { [String(ownerId)]: String(memberId) },
        actorUserId: memberId,
      }),
      "bulk",
    );

    for (const number of [first, second])
      expect(reloadValues(number)[String(ownerId)]).toBe(String(memberId));
  });

  it("reports a card whose values did not change as applied but unchanged", () => {
    // "Open it" leaves Status alone on a card already Open, so that card
    // gets no version row (legacy card.save if altered?).
    const transition = mustOk(
      define({
        name: "Touch",
        prerequisites: [],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "New" }],
      }),
      "transition",
    );
    const before = reloadCard(first).version;

    const result = mustOk(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "bulk",
    );

    expect(result.changedCardNumbers).toEqual([]);
    expect(reloadCard(first).version).toBe(before);
  });

  it("rejects an unknown project and changes nothing", () => {
    const transition = mustOk(define({}), "transition");
    const before = reloadCard(first).version;
    const errors = mustReject(
      executeBulkTransition(db, {
        projectId: projectId + 999,
        cardNumbers: [first],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "unknown project",
    );
    expect(errors.project).toEqual(["does not exist"]);
    expect(reloadCard(first).version).toBe(before);
  });

  it("rejects an actor below full team member and changes nothing", () => {
    const transition = mustOk(define({}), "transition");
    const before = reloadCard(first).version;
    const errors = mustReject(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second],
        transitionId: transition.id,
        actorUserId: readonlyId,
      }),
      "readonly actor",
    );
    expect(errors.authorization?.[0]).toMatch(/team member/i);
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
  });

  it("rejects an empty selection", () => {
    const transition = mustOk(define({}), "transition");
    const errors = mustReject(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "empty selection",
    );
    expect(errors.cards).toEqual(["Please select at least one card."]);
  });

  it("rejects an unknown transition and changes nothing", () => {
    const before = reloadCard(first).version;
    const errors = mustReject(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first],
        transitionId: 4242,
        actorUserId: memberId,
      }),
      "unknown transition",
    );
    expect(errors.transition).toEqual(["Couldn't find transition with id 4242."]);
    expect(reloadCard(first).version).toBe(before);
  });

  it("rejects a selection naming a card that does not exist, before writing anything", () => {
    const transition = mustOk(define({}), "transition");
    const before = reloadCard(first).version;
    const errors = mustReject(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, 9999],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "unknown card",
    );
    expect(errors.cards).toEqual(["Couldn't find card with number 9999."]);
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
  });

  it("cancels the whole selection when the transition is not applicable to one card", () => {
    // The plan's exit criterion: 3 selected cards, one of them already
    // Closed, so the shared requirement (Status = New) fails on it.
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: third,
        propertyDefinitionId: statusId,
        value: "Closed",
        actorUserId: memberId,
      }),
      "third Closed",
    );
    const transition = mustOk(define({}), "transition");
    const before = [first, second, third].map((number) => reloadCard(number).version);

    const errors = mustReject(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second, third],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "one card not applicable",
    );

    expect(errors.transition?.[0]).toContain(`not applicable to Card #${third}`);
    expect(errors.transition?.[0]).toContain("requires Status to be New");
    expect(errors.transition?.[0]).toContain("All work was cancelled.");
    // Nothing was written for ANY card, including the two that qualified.
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadValues(second)[String(statusId)]).toBe("New");
    expect(reloadValues(third)[String(statusId)]).toBe("Closed");
    [first, second, third].forEach((number, index) => {
      expect(reloadCard(number).version).toBe(before[index]);
      expect(versionRows(number)).toHaveLength(before[index]);
    });
    expect(eventsOfType("TransitionExecuted")).toHaveLength(0);
    expect(eventsOfType("BulkTransitionExecuted")).toHaveLength(0);
  });

  it("cancels the whole selection when a required user input is missing", () => {
    const transition = mustOk(
      define({
        name: "Assign and open",
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
        ],
      }),
      "transition",
    );
    const before = reloadCard(first).version;

    const errors = mustReject(
      executeBulkTransition(db, {
        projectId,
        cardNumbers: [first, second],
        transitionId: transition.id,
        actorUserId: memberId,
      }),
      "missing required input",
    );

    expect(errors.transition?.[0]).toContain(
      "Value of Owner property for this transition must not be empty.",
    );
    expect(errors.transition?.[0]).toContain("All work was cancelled.");
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadValues(second)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
  });
});

// ===========================================================================
// commonTransitions (read model)
// ===========================================================================

describe("commonTransitions", () => {
  it("offers only the transitions available on every selected card", () => {
    mustOk(define({ name: "Open it" }), "open");
    mustOk(
      define({
        name: "Close it",
        prerequisites: [
          { kind: "has_specific_value", propertyDefinitionId: statusId, value: "Open" },
        ],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Closed" }],
      }),
      "close",
    );
    // second moves to Open, so "Open it" no longer applies to it.
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: second,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "second Open",
    );

    expect(commonTransitions(db, projectId, [first], memberId).map((t) => t.name)).toEqual([
      "Open it",
    ]);
    expect(commonTransitions(db, projectId, [second], memberId).map((t) => t.name)).toEqual([
      "Close it",
    ]);
    expect(commonTransitions(db, projectId, [first, second], memberId)).toEqual([]);
  });

  it("is empty for an empty selection and for an unknown card", () => {
    mustOk(define({}), "transition");
    expect(commonTransitions(db, projectId, [], memberId)).toEqual([]);
    expect(commonTransitions(db, projectId, [first, 9999], memberId)).toEqual([]);
  });
});

// ===========================================================================
// GenerateTransitionWorkflow
// ===========================================================================

describe("GenerateTransitionWorkflow", () => {
  it("generates one transition per value, chained from the previous value", () => {
    const result = mustOk(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "workflow",
    );

    expect(result.transitions.map((entry) => entry.name)).toEqual([
      "Move Card to New",
      "Move Card to Open",
      "Move Card to Closed",
    ]);

    const rows = transitionRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.cardTypeId).toBe(storyTypeId);

    const prerequisitesOf = (transitionId: number) =>
      db
        .select()
        .from(transitionPrerequisites)
        .where(eq(transitionPrerequisites.transitionId, transitionId))
        .all();
    const actionsOf = (transitionId: number) =>
      db
        .select()
        .from(transitionActions)
        .where(eq(transitionActions.transitionId, transitionId))
        .all();

    // First step requires the property to be UNSET (value null).
    const [toNew, toOpen, toClosed] = rows;
    expect(prerequisitesOf(toNew.id)).toMatchObject([
      { kind: "has_specific_value", propertyDefinitionId: statusId, value: null },
    ]);
    expect(actionsOf(toNew.id)).toMatchObject([
      { propertyDefinitionId: statusId, inputMode: "fixed", value: "New" },
    ]);
    expect(prerequisitesOf(toOpen.id)).toMatchObject([
      { kind: "has_specific_value", propertyDefinitionId: statusId, value: "New" },
    ]);
    expect(actionsOf(toOpen.id)).toMatchObject([
      { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
    ]);
    expect(prerequisitesOf(toClosed.id)).toMatchObject([
      { kind: "has_specific_value", propertyDefinitionId: statusId, value: "Open" },
    ]);
    expect(actionsOf(toClosed.id)).toMatchObject([
      { propertyDefinitionId: statusId, inputMode: "fixed", value: "Closed" },
    ]);
  });

  it("emits a TransitionDefined per step plus one TransitionWorkflowGenerated", () => {
    mustOk(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "workflow",
    );

    expect(eventsOfType("TransitionDefined")).toHaveLength(3);
    const generated = eventsOfType("TransitionWorkflowGenerated");
    expect(generated).toHaveLength(1);
    expect(JSON.parse(generated[0].payload)).toMatchObject({
      cardType: "Card",
      property: "Status",
      transitions: ["Move Card to New", "Move Card to Open", "Move Card to Closed"],
    });
    expect(generated[0].actorUserId).toBe(projectAdminId);
  });

  it("uniquifies a generated name that an existing transition already holds", () => {
    mustOk(
      define({
        name: "Move Card to Open",
        prerequisites: [],
        actions: [{ propertyDefinitionId: ownerId, inputMode: "fixed", value: String(memberId) }],
      }),
      "colliding transition",
    );

    const result = mustOk(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "workflow",
    );

    expect(result.transitions.map((entry) => entry.name)).toEqual([
      "Move Card to New",
      "Move Card to Open 1",
      "Move Card to Closed",
    ]);
    expect(transitionRows()).toHaveLength(4);
  });

  it("generates a second chain alongside the first rather than replacing it", () => {
    mustOk(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "first chain",
    );
    const preview = mustOk(
      previewTransitionWorkflow(db, projectId, storyTypeId, statusId),
      "preview",
    );
    expect(preview.existingTransitionsCount).toBe(3);

    mustOk(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "second chain",
    );
    expect(transitionRows()).toHaveLength(6);
  });

  it("rejects an actor below project administrator and writes no transition", () => {
    const errors = mustReject(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: memberId,
      }),
      "non-admin",
    );
    expect(errors.authorization?.[0]).toMatch(/project admin/i);
    expect(transitionRows()).toHaveLength(0);
  });

  it("rejects an unknown project and writes no transition", () => {
    const errors = mustReject(
      generateTransitionWorkflow(db, {
        projectId: projectId + 999,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "unknown project",
    );
    expect(errors.project).toEqual(["does not exist"]);
    expect(transitionRows()).toHaveLength(0);
  });

  it("rejects an unknown card type", () => {
    const errors = mustReject(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: 9999,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "unknown card type",
    );
    expect(errors.cardType).toEqual(["does not exist"]);
    expect(transitionRows()).toHaveLength(0);
  });

  it("rejects a property that is not a managed list", () => {
    const errors = mustReject(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: estimateId,
        actorUserId: projectAdminId,
      }),
      "non-enumerated property",
    );
    expect(errors.property?.[0]).toContain("not a managed list property");
    expect(transitionRows()).toHaveLength(0);
  });

  it("rejects a managed list with no values", () => {
    const emptyId = mustOk(
      definePropertyDefinition(db, {
        projectId,
        name: "Phase",
        kind: "enumerated",
        values: [],
        actorUserId: projectAdminId,
      }),
      "empty list",
    ).id;

    const errors = mustReject(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: emptyId,
        actorUserId: projectAdminId,
      }),
      "no values",
    );
    expect(errors.property?.[0]).toContain("has no values");
    expect(transitionRows()).toHaveLength(0);
  });

  it("rolls the whole chain back when one generated step is rejected", () => {
    // A 255-char card type name makes every generated name exceed the
    // 255-char transition name limit, so step 1 is rejected — and the
    // chain must not exist even partially.
    const longTypeId = mustOk(
      defineCardType(db, { projectId, name: "T".repeat(255), actorUserId: adminId }),
      "long-named card type",
    ).id;

    const errors = mustReject(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: longTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "over-long generated name",
    );

    expect(errors.name?.[0]).toContain("too long");
    expect(transitionRows()).toHaveLength(0);
    expect(eventsOfType("TransitionDefined")).toHaveLength(0);
    expect(eventsOfType("TransitionWorkflowGenerated")).toHaveLength(0);
  });
});

// ===========================================================================
// ApplyCardPropertyValue — auto-transitions
// ===========================================================================

describe("ApplyCardPropertyValue", () => {
  /** Makes Status transition-only and generates its workflow. */
  function seedWorkflow() {
    mustOk(
      generateTransitionWorkflow(db, {
        projectId,
        cardTypeId: storyTypeId,
        propertyDefinitionId: statusId,
        actorUserId: projectAdminId,
      }),
      "workflow",
    );
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition only",
    );
  }

  it("writes an ordinary property directly, appending one card version", () => {
    const before = reloadCard(first).version;
    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: estimateId,
        value: "5",
        actorUserId: memberId,
      }),
      "ordinary property",
    );

    expect(result.kind).toBe("value_set");
    expect(reloadValues(first)[String(estimateId)]).toBe("5");
    expect(reloadCard(first).version).toBe(before + 1);
    expect(eventsOfType("CardPropertyValueSet")).toHaveLength(1);
  });

  it("reports a value the card already holds as unchanged, writing nothing", () => {
    const before = reloadCard(first).version;
    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "New",
        actorUserId: memberId,
      }),
      "same value",
    );

    expect(result.kind).toBe("unchanged");
    expect(reloadCard(first).version).toBe(before);
    expect(versionRows(first)).toHaveLength(before);
    expect(eventsOfType("CardPropertyValueSet")).toHaveLength(0);
  });

  it("fires the matching transition for a transition-only property without it being named", () => {
    // The plan's second exit criterion. The caller asks for a VALUE; the
    // transition that produces it runs on its own.
    seedWorkflow();
    const before = reloadCard(first).version;

    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "auto transition",
    );

    expect(result).toMatchObject({
      kind: "transition_applied",
      transition: { name: "Move Card to Open" },
    });
    expect(reloadValues(first)[String(statusId)]).toBe("Open");
    expect(reloadCard(first).version).toBe(before + 1);
    const versions = versionRows(first);
    expect(versions[versions.length - 1].version).toBe(before + 1);
    expect(JSON.parse(versions[versions.length - 1].propertyValues)).toMatchObject({
      [String(statusId)]: "Open",
    });
    const executed = eventsOfType("TransitionExecuted");
    expect(executed).toHaveLength(1);
    expect(JSON.parse(executed[0].payload)).toMatchObject({
      transition: "Move Card to Open",
      number: first,
    });
    // The value change went through the transition, not the direct path.
    expect(eventsOfType("CardPropertyValueSet")).toHaveLength(0);
  });

  it("satisfies a not-set prerequisite: an unset card enters the chain's first step", () => {
    // The generated first step requires the property to be UNSET
    // (a has_specific_value row with value NULL). Every other card in
    // this suite is seeded with Status already set, so this is the only
    // test that evaluates that prerequisite at run time rather than
    // asserting on the stored row.
    seedWorkflow();
    const fresh = mustOk(
      createCard(db, {
        projectId,
        name: "Untouched",
        cardTypeId: storyTypeId,
        actorUserId: memberId,
      }),
      "card with no Status",
    ).number;
    expect(reloadValues(fresh)[String(statusId)]).toBeUndefined();
    const before = reloadCard(fresh).version;

    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: fresh,
        propertyDefinitionId: statusId,
        value: "New",
        actorUserId: memberId,
      }),
      "first step",
    );

    expect(result).toMatchObject({
      kind: "transition_applied",
      transition: { name: "Move Card to New" },
    });
    expect(reloadValues(fresh)[String(statusId)]).toBe("New");
    expect(reloadCard(fresh).version).toBe(before + 1);
  });

  it("stops satisfying the not-set prerequisite once the property holds a value", () => {
    // The same first step must NOT be available to a card whose Status
    // is already set — the null prerequisite means unset, not "any".
    seedWorkflow();
    // `first` is seeded Status = New, so the step whose prerequisite is
    // "Status unset" must have dropped out of what it can run, while the
    // step that requires New is offered.
    const available = commonTransitions(db, projectId, [first], memberId).map(
      (entry) => entry.name,
    );
    expect(available).not.toContain("Move Card to New");
    expect(available).toContain("Move Card to Open");
  });

  it("applies the fired transition's OTHER actions in the same card version", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition only",
    );
    mustOk(
      define({
        name: "Open and assign",
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "fixed", value: String(memberId) },
        ],
      }),
      "transition",
    );
    const before = reloadCard(first).version;

    mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "auto transition",
    );

    const values = reloadValues(first);
    expect(values[String(statusId)]).toBe("Open");
    expect(values[String(ownerId)]).toBe(String(memberId));
    // Both actions landed in ONE version (ADR-0007 Decision 4).
    expect(reloadCard(first).version).toBe(before + 1);
  });

  it("reports no match when no available transition produces the value", () => {
    seedWorkflow();
    const before = reloadCard(first).version;

    // The card is New; "Move Card to Closed" requires Open, so it is not
    // available and nothing can carry the card straight to Closed.
    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Closed",
        actorUserId: memberId,
      }),
      "unreachable value",
    );

    expect(result.kind).toBe("no_transition_matched");
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
    expect(eventsOfType("TransitionExecuted")).toHaveLength(0);
  });

  it("reports every candidate when more than one transition produces the value", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition only",
    );
    mustOk(define({ name: "Open it" }), "first");
    mustOk(define({ name: "Start work" }), "second");
    const before = reloadCard(first).version;

    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "ambiguous",
    );

    expect(result.kind).toBe("multi_transitions_matched");
    if (result.kind !== "multi_transitions_matched") throw new Error("unreachable");
    expect(result.transitions.map((entry) => entry.name).sort()).toEqual([
      "Open it",
      "Start work",
    ]);
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
  });

  it("asks for input rather than firing when the matching transition needs it", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition only",
    );
    mustOk(
      define({
        name: "Open and assign",
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
        ],
      }),
      "transition",
    );
    const before = reloadCard(first).version;

    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "needs input",
    );

    expect(result).toMatchObject({
      kind: "require_user_input",
      transition: { name: "Open and assign" },
    });
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
  });

  it("does not fire a transition the actor may not use", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition only",
    );
    mustOk(
      define({
        name: "Lead opens it",
        prerequisites: [
          { kind: "has_specific_value", propertyDefinitionId: statusId, value: "New" },
          { kind: "is_user", userId: projectAdminId },
        ],
      }),
      "restricted transition",
    );

    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "restricted",
    );

    expect(result.kind).toBe("no_transition_matched");
    expect(reloadValues(first)[String(statusId)]).toBe("New");
  });

  it("routes a project admin through the transition too, instead of writing the value", () => {
    // ADR-0009: the admin bypass lives in setCardPropertyValue's guard,
    // NOT in this dispatcher, which routes on the transitionOnly flag
    // regardless of role. A project admin dragging a card takes the
    // workflow step exactly as a full team member does. This is the
    // fourth of the four role/path cases and the one a future reader is
    // most likely to "fix" wrongly by adding a role check here.
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition only",
    );
    mustOk(
      define({
        name: "Open and assign",
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "fixed", value: String(memberId) },
        ],
      }),
      "transition",
    );
    const before = reloadCard(first).version;
    const executedBefore = eventsOfType("TransitionExecuted").length;
    const directWritesBefore = eventsOfType("CardPropertyValueSet").length;

    const result = mustOk(
      applyCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: projectAdminId,
      }),
      "admin through dispatcher",
    );

    expect(result).toMatchObject({
      kind: "transition_applied",
      transition: { name: "Open and assign" },
    });
    // The transition's OTHER action landed as well — that is what
    // separates "the transition fired" from "the value was written":
    // a direct write would set Status alone and leave Owner unset.
    const values = reloadValues(first);
    expect(values[String(statusId)]).toBe("Open");
    expect(values[String(ownerId)]).toBe(String(memberId));
    expect(reloadCard(first).version).toBe(before + 1);
    expect(eventsOfType("TransitionExecuted")).toHaveLength(executedBefore + 1);
    expect(eventsOfType("CardPropertyValueSet")).toHaveLength(directWritesBefore);
  });

  it("rejects an unknown project and changes no property value", () => {
    const errors = mustReject(
      applyCardPropertyValue(db, {
        projectId: projectId + 999,
        cardNumber: first,
        propertyDefinitionId: estimateId,
        value: "5",
        actorUserId: memberId,
      }),
      "unknown project",
    );
    expect(errors.project).toEqual(["does not exist"]);
    expect(reloadValues(first)[String(estimateId)]).toBeUndefined();
  });

  it("rejects a formula property, an invalid value, an unknown card, and a readonly actor", () => {
    expect(
      mustReject(
        applyCardPropertyValue(db, {
          projectId,
          cardNumber: first,
          propertyDefinitionId: doubleId,
          value: "9",
          actorUserId: memberId,
        }),
        "formula",
      ).property?.[0],
    ).toContain("formula property");

    expect(
      mustReject(
        applyCardPropertyValue(db, {
          projectId,
          cardNumber: first,
          propertyDefinitionId: estimateId,
          value: "not-a-number",
          actorUserId: memberId,
        }),
        "invalid value",
      ),
    ).toBeTruthy();

    expect(
      mustReject(
        applyCardPropertyValue(db, {
          projectId,
          cardNumber: 9999,
          propertyDefinitionId: estimateId,
          value: "5",
          actorUserId: memberId,
        }),
        "unknown card",
      ).card,
    ).toEqual(["does not exist"]);

    expect(
      mustReject(
        applyCardPropertyValue(db, {
          projectId,
          cardNumber: first,
          propertyDefinitionId: estimateId,
          value: "5",
          actorUserId: readonlyId,
        }),
        "readonly actor",
      ).authorization?.[0],
    ).toMatch(/team member/i);

    expect(reloadValues(first)[String(estimateId)]).toBeUndefined();
  });
});

// ===========================================================================
// SetPropertyTransitionOnly and the direct-write guard
// ===========================================================================

describe("SetPropertyTransitionOnly", () => {
  function reloadDefinition(id: number) {
    return db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.id, id))
      .get()!;
  }

  it("persists the flag and emits PropertyDefinitionTransitionOnlySet", () => {
    expect(reloadDefinition(statusId).transitionOnly).toBe(false);

    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "flag on",
    );

    expect(reloadDefinition(statusId).transitionOnly).toBe(true);
    const events = eventsOfType("PropertyDefinitionTransitionOnlySet");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      property: "Status",
      transitionOnly: true,
    });
  });

  it("turns the flag back off", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "flag on",
    );
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: false,
        actorUserId: projectAdminId,
      }),
      "flag off",
    );
    expect(reloadDefinition(statusId).transitionOnly).toBe(false);
  });

  it("rejects an unknown project and leaves the flag alone", () => {
    expect(
      mustReject(
        setPropertyTransitionOnly(db, {
          projectId: projectId + 999,
          propertyDefinitionId: statusId,
          transitionOnly: true,
          actorUserId: projectAdminId,
        }),
        "unknown project",
      ).project,
    ).toEqual(["does not exist"]);
    expect(reloadDefinition(statusId).transitionOnly).toBe(false);
  });

  it("rejects a non-admin, a formula property, an unknown property, and a no-op", () => {
    expect(
      mustReject(
        setPropertyTransitionOnly(db, {
          projectId,
          propertyDefinitionId: statusId,
          transitionOnly: true,
          actorUserId: memberId,
        }),
        "non-admin",
      ).authorization?.[0],
    ).toMatch(/project admin/i);

    expect(
      mustReject(
        setPropertyTransitionOnly(db, {
          projectId,
          propertyDefinitionId: doubleId,
          transitionOnly: true,
          actorUserId: projectAdminId,
        }),
        "formula",
      ).property?.[0],
    ).toContain("never set directly");

    expect(
      mustReject(
        setPropertyTransitionOnly(db, {
          projectId,
          propertyDefinitionId: 9999,
          transitionOnly: true,
          actorUserId: projectAdminId,
        }),
        "unknown property",
      ).property,
    ).toEqual(["does not exist"]);

    expect(
      mustReject(
        setPropertyTransitionOnly(db, {
          projectId,
          propertyDefinitionId: statusId,
          transitionOnly: false,
          actorUserId: projectAdminId,
        }),
        "no-op",
      ).property,
    ).toEqual(["has no changes to save"]);

    expect(reloadDefinition(statusId).transitionOnly).toBe(false);
  });

  it("refuses a member's direct write to a transition-only property, changing nothing", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "flag on",
    );
    const before = reloadCard(first).version;

    const errors = mustReject(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: memberId,
      }),
      "direct write",
    );

    expect(errors.property).toEqual(["Status: is a transition only property."]);
    expect(reloadValues(first)[String(statusId)]).toBe("New");
    expect(reloadCard(first).version).toBe(before);
  });

  it("lets a project admin write a transition-only property directly", () => {
    mustOk(
      setPropertyTransitionOnly(db, {
        projectId,
        propertyDefinitionId: statusId,
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "flag on",
    );
    const before = reloadCard(first).version;

    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: first,
        propertyDefinitionId: statusId,
        value: "Open",
        actorUserId: projectAdminId,
      }),
      "admin direct write",
    );

    expect(reloadValues(first)[String(statusId)]).toBe("Open");
    expect(reloadCard(first).version).toBe(before + 1);
  });

  it("persists the flag when it is set at definition time, and refuses it on a formula", () => {
    const gateId = mustOk(
      definePropertyDefinition(db, {
        projectId,
        name: "Gate",
        kind: "enumerated",
        values: ["Shut", "Open"],
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "transition-only at definition",
    ).id;
    expect(reloadDefinition(gateId).transitionOnly).toBe(true);

    const errors = mustReject(
      definePropertyDefinition(db, {
        projectId,
        name: "Triple",
        kind: "formula",
        formula: "Estimate * 3",
        transitionOnly: true,
        actorUserId: projectAdminId,
      }),
      "formula with transitionOnly",
    );
    expect(errors.transitionOnly?.[0]).toContain("not available for a formula property");
    expect(
      db
        .select()
        .from(propertyDefinitions)
        .where(
          and(
            eq(propertyDefinitions.projectId, projectId),
            eq(propertyDefinitions.name, "Triple"),
          ),
        )
        .get(),
    ).toBeUndefined();
  });
});
