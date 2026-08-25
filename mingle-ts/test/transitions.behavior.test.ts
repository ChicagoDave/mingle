/**
 * Behavioral tests for transitions (Phase 14) — the REAL-PATH suite
 * for the transitions engine (rule 13a, "engine"-shaped phase).
 *
 * Derived line-by-line from the rule 12 Behavior Statements for
 * DefineTransition, DeleteTransition, and ExecuteTransition: every
 * DOES asserts on rows reloaded from the database (transition rows,
 * card_property_values, cards.version, the appended card_versions row
 * and its snapshot, domain_events), and every REJECTS WHEN has its own
 * rejection test proving nothing mutated — including the plan's exit
 * criteria: a satisfied transition persists its property changes and
 * ONE new card_versions row; a failing one is rejected with the unmet
 * requirement named and changes nothing.
 *
 * Runs against a real, file-backed SQLite database created fresh per
 * suite with the real generated migrations (0000–0009), seeded through
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
import { and, asc, desc, eq } from "drizzle-orm";
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
import {
  addTeamMember,
  addUserToGroup,
  createGroup,
} from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard, defineCardType } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import {
  availableTransitions,
  defineTransition,
  deleteTransition,
  describeAction,
  describePrerequisite,
  executeTransition,
  loadTransitionNames,
  loadTransitions,
  type DefineTransitionInput,
} from "../app/domain/cards/transitions.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-transitions-"));
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
let otherMemberId: number; //  another full_member
let readonlyId: number; //     readonly_member of the project
let projectId: number;
let storyTypeId: number; //    the default "Card" type
let bugTypeId: number; //      a second card type
let statusId: number; //       enumerated: New, Open, Closed
let ownerId: number; //        user
let estimateId: number; //     number
let doubleId: number; //       formula: Estimate * 2
let cardNumber: number; //     a card of the default type, Status = New

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
  otherMemberId = register("qa");
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
    [otherMemberId, "full_member"],
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
  cardNumber = mustOk(
    createCard(db, {
      projectId,
      name: "Story one",
      cardTypeId: storyTypeId,
      actorUserId: memberId,
    }),
    "card",
  ).number;
  mustOk(
    setCardPropertyValue(db, {
      projectId,
      cardNumber,
      propertyDefinitionId: statusId,
      value: "New",
      actorUserId: memberId,
    }),
    "Status = New",
  );
  db.delete(domainEvents).run(); // only events under test matter below
});

/** DefineTransition with the common defaults filled in. */
function define(overrides: Partial<DefineTransitionInput>) {
  return defineTransition(db, {
    projectId,
    name: "Open it",
    prerequisites: [{ kind: "has_specific_value", propertyDefinitionId: statusId, value: "New" }],
    actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" }],
    actorUserId: projectAdminId,
    ...overrides,
  });
}

function reloadCard() {
  return db
    .select()
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.number, cardNumber)))
    .get()!;
}

/** Current values keyed by definition id, as a plain object. */
function reloadValues(cardId: number): Record<string, string> {
  return Object.fromEntries(
    db
      .select({
        propertyDefinitionId: cardPropertyValues.propertyDefinitionId,
        value: cardPropertyValues.value,
      })
      .from(cardPropertyValues)
      .where(eq(cardPropertyValues.cardId, cardId))
      .all()
      .map((row) => [String(row.propertyDefinitionId), row.value]),
  );
}

function versionsOf(cardId: number) {
  return db
    .select()
    .from(cardVersions)
    .where(eq(cardVersions.cardId, cardId))
    .orderBy(asc(cardVersions.version))
    .all();
}

function eventsOfType(type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .orderBy(desc(domainEvents.id))
    .all();
}

function transitionRowCounts() {
  return {
    transitions: db.select().from(transitions).all().length,
    prerequisites: db.select().from(transitionPrerequisites).all().length,
    actions: db.select().from(transitionActions).all().length,
  };
}

/** Snapshot of everything ExecuteTransition may touch, for no-change assertions. */
function cardState() {
  const card = reloadCard();
  return {
    version: card.version,
    modifiedBy: card.modifiedByUserId,
    values: reloadValues(card.id),
    versionCount: versionsOf(card.id).length,
    executedEvents: eventsOfType("TransitionExecuted").length,
  };
}

// ---------------------------------------------------------------------------

describe("DefineTransition", () => {
  it("persists the transition with canonical prerequisite and action rows and emits TransitionDefined", () => {
    const row = mustOk(
      define({
        name: "  Assign and open  ",
        cardTypeId: storyTypeId,
        prerequisites: [
          { kind: "has_specific_value", propertyDefinitionId: statusId, value: "new" },
          { kind: "has_set_value", propertyDefinitionId: estimateId },
        ],
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "open" },
          { propertyDefinitionId: ownerId, inputMode: "fixed", value: String(memberId) },
          { propertyDefinitionId: estimateId, inputMode: "fixed", value: null },
        ],
      }),
      "define",
    );
    const stored = db.select().from(transitions).where(eq(transitions.id, row.id)).get()!;
    expect(stored).toMatchObject({ projectId, name: "Assign and open", cardTypeId: storyTypeId });
    const prerequisites = db
      .select()
      .from(transitionPrerequisites)
      .where(eq(transitionPrerequisites.transitionId, row.id))
      .orderBy(asc(transitionPrerequisites.id))
      .all();
    expect(prerequisites.map((p) => [p.kind, p.propertyDefinitionId, p.value])).toEqual([
      ["has_specific_value", statusId, "New"], // canonical casing
      ["has_set_value", estimateId, null],
    ]);
    const actions = db
      .select()
      .from(transitionActions)
      .where(eq(transitionActions.transitionId, row.id))
      .orderBy(asc(transitionActions.id))
      .all();
    expect(actions.map((a) => [a.propertyDefinitionId, a.inputMode, a.value])).toEqual([
      [statusId, "fixed", "Open"],
      [ownerId, "fixed", String(memberId)],
      [estimateId, "fixed", null],
    ]);
    const events = eventsOfType("TransitionDefined");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      projectId,
      name: "Assign and open",
      prerequisites: 2,
      actions: 3,
    });
  });

  it("stores user-input actions with their mode and no value", () => {
    const row = mustOk(
      define({
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
          { propertyDefinitionId: estimateId, inputMode: "user_input_optional", value: "ignored" },
        ],
      }),
      "define",
    );
    const actions = db
      .select()
      .from(transitionActions)
      .where(eq(transitionActions.transitionId, row.id))
      .orderBy(asc(transitionActions.id))
      .all();
    expect(actions.map((a) => [a.inputMode, a.value])).toEqual([
      ["fixed", "Open"],
      ["user_input_required", null],
      ["user_input_optional", null],
    ]);
  });

  it("stores is_user and in_group prerequisites", () => {
    const groupId = mustOk(
      createGroup(db, { projectId, name: "Testers", actorUserId: projectAdminId }),
      "group",
    ).id;
    const byUser = mustOk(
      define({ name: "By user", prerequisites: [{ kind: "is_user", userId: memberId }] }),
      "by user",
    );
    const byGroup = mustOk(
      define({ name: "By group", prerequisites: [{ kind: "in_group", groupId }] }),
      "by group",
    );
    const rows = db
      .select()
      .from(transitionPrerequisites)
      .orderBy(asc(transitionPrerequisites.id))
      .all();
    expect(rows.map((p) => [p.transitionId, p.kind, p.userId, p.groupId])).toEqual([
      [byUser.id, "is_user", memberId, null],
      [byGroup.id, "in_group", null, groupId],
    ]);
  });

  it("describes prerequisites and actions in legacy wording", () => {
    const row = mustOk(
      define({
        prerequisites: [
          { kind: "has_specific_value", propertyDefinitionId: ownerId, value: String(memberId) },
          { kind: "has_set_value", propertyDefinitionId: estimateId },
          { kind: "is_user", userId: otherMemberId },
        ],
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Closed" },
          { propertyDefinitionId: estimateId, inputMode: "fixed", value: null },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
        ],
      }),
      "define",
    );
    const names = loadTransitionNames(db, projectId);
    const [detail] = loadTransitions(db, projectId);
    expect(detail.transition.id).toBe(row.id);
    expect(detail.prerequisites.map((p) => describePrerequisite(p, names))).toEqual([
      "Has value of dev for Owner",
      "Has value set for Estimate",
      "User is qa",
    ]);
    expect(detail.actions.map((a) => describeAction(a, names))).toEqual([
      "Sets Status to Closed",
      "Sets Estimate to (not set)",
      "Sets Owner to (user input - required)",
    ]);
  });

  describe("rejects, writing nothing, when", () => {
    const cases: [string, () => CommandResult<unknown>, string, RegExp][] = [
      ["the project is unknown", () => define({ projectId: 999_999 }), "project", /does not exist/],
      [
        "the actor is only a full team member",
        () => define({ actorUserId: memberId }),
        "authorization",
        /Project administrator access/,
      ],
      ["the name is blank", () => define({ name: "   " }), "name", /can't be blank/],
      [
        "the card type is not in the project",
        () => define({ cardTypeId: 999_999 }),
        "cardType",
        /does not exist/,
      ],
      [
        "there are no actions",
        () => define({ actions: [] }),
        "actions",
        /Transition must set at least one property\./,
      ],
      [
        "an action targets a formula property",
        () => define({ actions: [{ propertyDefinitionId: doubleId, inputMode: "fixed", value: "4" }] }),
        "actions",
        /Double is a formula property and cannot be set by a transition/,
      ],
      [
        "an action targets an unknown property",
        () => define({ actions: [{ propertyDefinitionId: 999_999, inputMode: "fixed", value: "4" }] }),
        "actions",
        /does not exist/,
      ],
      [
        "the same property is set twice",
        () =>
          define({
            actions: [
              { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
              { propertyDefinitionId: statusId, inputMode: "fixed", value: "Closed" },
            ],
          }),
        "actions",
        /Status is set more than once/,
      ],
      [
        "a fixed action value is outside the enumeration",
        () => define({ actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Done" }] }),
        "value",
        /Status is restricted to New, Open, Closed/,
      ],
      [
        "a fixed action value is not numeric",
        () => define({ actions: [{ propertyDefinitionId: estimateId, inputMode: "fixed", value: "big" }] }),
        "value",
        /invalid numeric value/,
      ],
      [
        "a fixed user action names a non-member",
        () => define({ actions: [{ propertyDefinitionId: ownerId, inputMode: "fixed", value: String(adminId) }] }),
        "value",
        /is not a project member/,
      ],
      [
        "a required value is invalid for its kind",
        () =>
          define({
            prerequisites: [{ kind: "has_specific_value", propertyDefinitionId: statusId, value: "Done" }],
          }),
        "value",
        /Status is restricted to/,
      ],
      [
        "a required value is blank",
        () =>
          define({
            prerequisites: [{ kind: "has_specific_value", propertyDefinitionId: statusId, value: " " }],
          }),
        "prerequisites",
        /required value can't be blank/,
      ],
      [
        "a prerequisite names a formula property",
        () => define({ prerequisites: [{ kind: "has_set_value", propertyDefinitionId: doubleId }] }),
        "prerequisites",
        /Double is a formula property and cannot be required/,
      ],
      [
        "the same property is required twice",
        () =>
          define({
            prerequisites: [
              { kind: "has_set_value", propertyDefinitionId: statusId },
              { kind: "has_specific_value", propertyDefinitionId: statusId, value: "New" },
            ],
          }),
        "prerequisites",
        /Status is required more than once/,
      ],
      [
        "an is_user prerequisite names a non-member",
        () => define({ prerequisites: [{ kind: "is_user", userId: adminId }] }),
        "prerequisites",
        /not a project member/,
      ],
      [
        "an in_group prerequisite names an unknown group",
        () => define({ prerequisites: [{ kind: "in_group", groupId: 999_999 }] }),
        "prerequisites",
        /group does not exist/,
      ],
    ];
    for (const [when, run, field, message] of cases) {
      it(when, () => {
        const before = transitionRowCounts();
        const errors = mustReject(run(), when);
        expect(errors[field]?.[0]).toMatch(message);
        expect(transitionRowCounts()).toEqual(before);
        expect(eventsOfType("TransitionDefined")).toHaveLength(0);
      });
    }

    it("the name is already taken, case-insensitively", () => {
      mustOk(define({ name: "Open it" }), "first");
      const before = transitionRowCounts();
      const errors = mustReject(define({ name: "OPEN IT" }), "duplicate");
      expect(errors.name?.[0]).toBe("has already been taken");
      expect(transitionRowCounts()).toEqual(before);
    });

    it("both is_user and in_group prerequisites are given", () => {
      const groupId = mustOk(
        createGroup(db, { projectId, name: "Testers", actorUserId: projectAdminId }),
        "group",
      ).id;
      const errors = mustReject(
        define({
          prerequisites: [
            { kind: "is_user", userId: memberId },
            { kind: "in_group", groupId },
          ],
        }),
        "mixed",
      );
      expect(errors.prerequisites?.[0]).toBe(
        "Transition can't have both is user and in group prerequisites",
      );
      expect(transitionRowCounts()).toEqual({ transitions: 0, prerequisites: 0, actions: 0 });
    });
  });
});

// ---------------------------------------------------------------------------

describe("DeleteTransition", () => {
  it("removes the transition with its rows, emits TransitionDeleted, and keeps card history", () => {
    const row = mustOk(define({}), "define");
    mustOk(
      executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
      "execute",
    );
    const card = reloadCard();
    const versionsBefore = versionsOf(card.id).length;
    mustOk(
      deleteTransition(db, { projectId, transitionId: row.id, actorUserId: projectAdminId }),
      "delete",
    );
    expect(transitionRowCounts()).toEqual({ transitions: 0, prerequisites: 0, actions: 0 });
    expect(versionsOf(card.id)).toHaveLength(versionsBefore);
    const events = eventsOfType("TransitionDeleted");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ projectId, name: "Open it" });
  });

  it("rejects a full team member and deletes nothing", () => {
    const row = mustOk(define({}), "define");
    const before = transitionRowCounts();
    const errors = mustReject(
      deleteTransition(db, { projectId, transitionId: row.id, actorUserId: memberId }),
      "delete",
    );
    expect(errors.authorization?.[0]).toMatch(/Project administrator access/);
    expect(transitionRowCounts()).toEqual(before);
  });

  it("rejects an unknown transition", () => {
    const errors = mustReject(
      deleteTransition(db, { projectId, transitionId: 999_999, actorUserId: projectAdminId }),
      "delete",
    );
    expect(errors.transition?.[0]).toBe("does not exist");
  });
});

// ---------------------------------------------------------------------------

describe("ExecuteTransition (REAL-PATH — exit criteria)", () => {
  it("persists every action's property change as ONE new card_versions row and emits TransitionExecuted", () => {
    const row = mustOk(
      define({
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "fixed", value: String(otherMemberId) },
          { propertyDefinitionId: estimateId, inputMode: "fixed", value: "3" },
        ],
      }),
      "define",
    );
    const before = reloadCard(); // Status = New, version 2
    expect(before.version).toBe(2);

    const result = mustOk(
      executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
      "execute",
    );
    expect(result.transitionName).toBe("Open it");
    expect(result.changedProperties).toEqual(["Status", "Owner", "Estimate"]);

    const after = reloadCard();
    expect(after.version).toBe(3);
    expect(after.modifiedByUserId).toBe(memberId);
    expect(reloadValues(after.id)).toEqual({
      [statusId]: "Open",
      [ownerId]: String(otherMemberId),
      [estimateId]: "3",
      [doubleId]: "6", // formula recomputed in the same version
    });
    const versions = versionsOf(after.id);
    expect(versions).toHaveLength(3);
    const appended = versions[2];
    expect(appended.version).toBe(3);
    expect(appended.modifiedByUserId).toBe(memberId);
    expect(JSON.parse(appended.propertyValues)).toEqual({
      [statusId]: "Open",
      [ownerId]: String(otherMemberId),
      [estimateId]: "3",
      [doubleId]: "6",
    });
    const events = eventsOfType("TransitionExecuted");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: cardNumber,
      transitionId: row.id,
      transition: "Open it",
      changedProperties: ["Status", "Owner", "Estimate"],
      version: 3,
    });
    expect(eventsOfType("CardPropertyValueSet")).toHaveLength(0); // one command, one event
  });

  it("clears a property with a (not set) action", () => {
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber,
        propertyDefinitionId: estimateId,
        value: "5",
        actorUserId: memberId,
      }),
      "Estimate = 5",
    );
    const row = mustOk(
      define({
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: estimateId, inputMode: "fixed", value: null },
        ],
      }),
      "define",
    );
    mustOk(
      executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
      "execute",
    );
    const card = reloadCard();
    expect(reloadValues(card.id)).toEqual({ [statusId]: "Open" }); // Estimate and Double gone
    expect(JSON.parse(versionsOf(card.id).at(-1)!.propertyValues)).toEqual({ [statusId]: "Open" });
  });

  it("applies user-entered values for required and optional input actions", () => {
    const row = mustOk(
      define({
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
          { propertyDefinitionId: estimateId, inputMode: "user_input_optional" },
        ],
      }),
      "define",
    );
    mustOk(
      executeTransition(db, {
        projectId,
        cardNumber,
        transitionId: row.id,
        userInput: { [ownerId]: String(otherMemberId), [estimateId]: "8" },
        actorUserId: memberId,
      }),
      "execute",
    );
    const card = reloadCard();
    expect(card.version).toBe(3);
    expect(reloadValues(card.id)).toEqual({
      [statusId]: "Open",
      [ownerId]: String(otherMemberId),
      [estimateId]: "8",
      [doubleId]: "16",
    });
  });

  it("leaves a property unchanged when its optional input is blank", () => {
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber,
        propertyDefinitionId: estimateId,
        value: "5",
        actorUserId: memberId,
      }),
      "Estimate = 5",
    );
    const row = mustOk(
      define({
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: estimateId, inputMode: "user_input_optional" },
        ],
      }),
      "define",
    );
    mustOk(
      executeTransition(db, {
        projectId,
        cardNumber,
        transitionId: row.id,
        userInput: { [estimateId]: "  " },
        actorUserId: memberId,
      }),
      "execute",
    );
    const card = reloadCard();
    expect(reloadValues(card.id)).toEqual({
      [statusId]: "Open",
      [estimateId]: "5",
      [doubleId]: "10",
    });
  });

  it("appends no version but still records the execution when no action changes a value", () => {
    const row = mustOk(
      define({
        prerequisites: [],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "New" }],
      }),
      "define",
    );
    const before = cardState();
    const result = mustOk(
      executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
      "execute",
    );
    expect(result.changedProperties).toEqual([]);
    const after = cardState();
    expect(after.version).toBe(before.version);
    expect(after.versionCount).toBe(before.versionCount);
    expect(after.values).toEqual(before.values);
    expect(after.executedEvents).toBe(1);
  });

  it("is available only to a card whose type and property values satisfy every prerequisite", () => {
    const openIt = mustOk(define({ cardTypeId: storyTypeId }), "Open it");
    mustOk(
      define({
        name: "Close it",
        prerequisites: [
          { kind: "has_specific_value", propertyDefinitionId: statusId, value: "Open" },
          { kind: "has_set_value", propertyDefinitionId: ownerId },
        ],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Closed" }],
      }),
      "Close it",
    );
    mustOk(
      define({
        name: "Bug only",
        cardTypeId: bugTypeId,
        prerequisites: [],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" }],
      }),
      "Bug only",
    );
    expect(availableTransitions(db, projectId, cardNumber, memberId).map((t) => t.name)).toEqual([
      "Open it",
    ]);
    mustOk(
      executeTransition(db, { projectId, cardNumber, transitionId: openIt.id, actorUserId: memberId }),
      "execute",
    );
    // Status is now Open but Owner is unset: Close it still unavailable.
    expect(availableTransitions(db, projectId, cardNumber, memberId).map((t) => t.name)).toEqual([]);
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber,
        propertyDefinitionId: ownerId,
        value: String(memberId),
        actorUserId: memberId,
      }),
      "Owner",
    );
    expect(availableTransitions(db, projectId, cardNumber, memberId).map((t) => t.name)).toEqual([
      "Close it",
    ]);
  });

  it("restricts availability by is_user and in_group prerequisites, OR-ed together", () => {
    const groupId = mustOk(
      createGroup(db, { projectId, name: "Testers", actorUserId: projectAdminId }),
      "group",
    ).id;
    mustOk(
      addUserToGroup(db, { groupId, userId: otherMemberId, actorUserId: projectAdminId }),
      "group member",
    );
    mustOk(
      define({
        name: "Testers only",
        prerequisites: [{ kind: "in_group", groupId }],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" }],
      }),
      "group transition",
    );
    mustOk(
      define({
        name: "Dev or QA",
        prerequisites: [
          { kind: "is_user", userId: memberId },
          { kind: "is_user", userId: otherMemberId },
        ],
        actions: [{ propertyDefinitionId: statusId, inputMode: "fixed", value: "Closed" }],
      }),
      "user transition",
    );
    const names = (userId: number) =>
      availableTransitions(db, projectId, cardNumber, userId).map((t) => t.name);
    expect(names(memberId)).toEqual(["Dev or QA"]);
    expect(names(otherMemberId)).toEqual(["Dev or QA", "Testers only"]);
    expect(names(projectAdminId)).toEqual([]);
  });

  it("reports the user-input actions an available transition needs", () => {
    mustOk(
      define({
        actions: [
          { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
          { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
          { propertyDefinitionId: estimateId, inputMode: "user_input_optional" },
        ],
      }),
      "define",
    );
    const [available] = availableTransitions(db, projectId, cardNumber, memberId);
    expect(available.inputs).toEqual([
      { propertyDefinitionId: ownerId, propertyName: "Owner", kind: "user", required: true },
      { propertyDefinitionId: estimateId, propertyName: "Estimate", kind: "number", required: false },
    ]);
  });

  describe("rejects, changing nothing, when", () => {
    it("a property prerequisite is unmet — naming it", () => {
      const row = mustOk(
        define({
          prerequisites: [
            { kind: "has_specific_value", propertyDefinitionId: statusId, value: "Open" },
            { kind: "has_set_value", propertyDefinitionId: ownerId },
          ],
        }),
        "define",
      );
      const before = cardState();
      const errors = mustReject(
        executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
        "execute",
      );
      expect(errors.transition?.[0]).toBe(
        `Open it is not applicable to Card #${cardNumber}: requires Status to be Open; requires Owner to be set`,
      );
      expect(cardState()).toEqual(before);
    });

    it("the card is of another type — naming the required type", () => {
      const row = mustOk(define({ cardTypeId: bugTypeId, prerequisites: [] }), "define");
      const before = cardState();
      const errors = mustReject(
        executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
        "execute",
      );
      expect(errors.transition?.[0]).toBe(
        `Open it is not applicable to Card #${cardNumber}: applies only to cards of type Bug`,
      );
      expect(cardState()).toEqual(before);
    });

    it("the actor is not among the transition's users or groups — naming them", () => {
      const groupId = mustOk(
        createGroup(db, { projectId, name: "Testers", actorUserId: projectAdminId }),
        "group",
      ).id;
      const row = mustOk(
        define({
          prerequisites: [{ kind: "is_user", userId: otherMemberId }],
        }),
        "by user",
      );
      const byGroup = mustOk(
        define({ name: "By group", prerequisites: [{ kind: "in_group", groupId }] }),
        "by group",
      );
      const before = cardState();
      expect(
        mustReject(
          executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: memberId }),
          "by user",
        ).transition?.[0],
      ).toBe(`Open it is not applicable to Card #${cardNumber}: may only be used by qa`);
      expect(
        mustReject(
          executeTransition(db, { projectId, cardNumber, transitionId: byGroup.id, actorUserId: memberId }),
          "by group",
        ).transition?.[0],
      ).toBe(`By group is not applicable to Card #${cardNumber}: may only be used by members of Testers`);
      expect(cardState()).toEqual(before);
    });

    it("a required user input is missing or blank", () => {
      const row = mustOk(
        define({
          actions: [
            { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
            { propertyDefinitionId: ownerId, inputMode: "user_input_required" },
          ],
        }),
        "define",
      );
      const before = cardState();
      for (const userInput of [undefined, { [ownerId]: "" }, { [ownerId]: "   " }]) {
        const errors = mustReject(
          executeTransition(db, {
            projectId,
            cardNumber,
            transitionId: row.id,
            userInput,
            actorUserId: memberId,
          }),
          "execute",
        );
        expect(errors.transition?.[0]).toBe(
          "Value of Owner property for this transition must not be empty.",
        );
      }
      expect(cardState()).toEqual(before);
    });

    it("a user-entered value is invalid for its property — never coerced", () => {
      const row = mustOk(
        define({
          actions: [
            { propertyDefinitionId: statusId, inputMode: "fixed", value: "Open" },
            { propertyDefinitionId: estimateId, inputMode: "user_input_optional" },
          ],
        }),
        "define",
      );
      const before = cardState();
      const errors = mustReject(
        executeTransition(db, {
          projectId,
          cardNumber,
          transitionId: row.id,
          userInput: { [estimateId]: "lots" },
          actorUserId: memberId,
        }),
        "execute",
      );
      expect(errors.value?.[0]).toMatch(/Estimate: 'lots' is an invalid numeric value/);
      expect(cardState()).toEqual(before); // Status not set either: all or none
    });

    it("the actor is a readonly member", () => {
      const row = mustOk(define({}), "define");
      const before = cardState();
      const errors = mustReject(
        executeTransition(db, { projectId, cardNumber, transitionId: row.id, actorUserId: readonlyId }),
        "execute",
      );
      expect(errors.authorization?.[0]).toMatch(/Team member access/);
      expect(cardState()).toEqual(before);
    });

    it("the transition or card is unknown", () => {
      const row = mustOk(define({}), "define");
      const before = cardState();
      expect(
        mustReject(
          executeTransition(db, { projectId, cardNumber, transitionId: 999_999, actorUserId: memberId }),
          "unknown transition",
        ).transition?.[0],
      ).toBe("Couldn't find transition with id 999999.");
      expect(
        mustReject(
          executeTransition(db, { projectId, cardNumber: 999_999, transitionId: row.id, actorUserId: memberId }),
          "unknown card",
        ).card?.[0],
      ).toBe("does not exist");
      expect(cardState()).toEqual(before);
    });
  });
});
