/**
 * Behavioral tests for card defaults (P-2, project templates Phase 1).
 *
 * Derived from the rule 12 Behavior Statements for `setCardDefaults`
 * (app/domain/cards/card-defaults.server.ts) and the changed
 * `createCard` (app/domain/cards/commands.server.ts): every DOES
 * asserts on rows re-read from `card_defaults`, `card_property_values`,
 * `card_versions` and `domain_events`, never on return values alone;
 * every REJECTS WHEN proves nothing mutated. Also covers the API create
 * path inheriting the defaults through the same command, and the
 * settings page's `cardDefaults` intent.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Card Management verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-card-defaults-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "card-defaults-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const settingsRoute = await import("../app/routes/projects.settings");
const { users } = await import("../app/db/schema/identity");
const { projects } = await import("../app/db/schema/projects");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardPropertyValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { cardDefaults } = await import("../app/db/schema/card-defaults");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember, removeTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, defineCardType, deleteCardType } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition } = await import("../app/domain/cards/properties.server");
const { cardDefaultsFor, listCardDefaults, setCardDefaults } = await import("../app/domain/cards/card-defaults.server");
const { createCardViaApi } = await import("../app/api/card-writes.server");
const { CURRENT_USER_MARKER } = await import("../app/shared/wire-types");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number; // site admin (first registered user)
let projectAdminId: number;
let memberId: number; // full member — may create cards, may not set defaults
let projectId: number;
let workTypeId: number;
let statusId: number;
let ownerId: number;
let pointsId: number;
let velocityId: number; // formula — never defaultable

const defaultRows = (cardTypeId: number) =>
  db.select().from(cardDefaults).where(eq(cardDefaults.cardTypeId, cardTypeId)).orderBy(asc(cardDefaults.propertyDefinitionId)).all();
const valuesOf = (cardId: number) =>
  Object.fromEntries(
    db
      .select({ definitionId: cardPropertyValues.propertyDefinitionId, value: cardPropertyValues.value })
      .from(cardPropertyValues)
      .where(eq(cardPropertyValues.cardId, cardId))
      .all()
      .map((row) => [row.definitionId, row.value]),
  );
const versionsOf = (cardId: number) =>
  db.select().from(cardVersions).where(eq(cardVersions.cardId, cardId)).orderBy(asc(cardVersions.version)).all();
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

beforeEach(() => {
  for (const table of [domainEvents, cardDefaults, cardPropertyValues, cardVersions, cards, propertyDefinitions, cardTypes, teamMemberships, projects, users])
    db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "defaults-1!" }), "admin").id;
  projectAdminId = mustOk(registerUser(db, { login: "pa", name: "Project Admin", password: "defaults-1!" }), "pa").id;
  memberId = mustOk(registerUser(db, { login: "mem", name: "Member", password: "defaults-1!" }), "mem").id;
  projectId = mustOk(createProject(db, { name: "Kanban", identifier: "kanban", actorUserId: adminId }), "project").id;
  mustOk(addTeamMember(db, { projectId, userId: projectAdminId, role: "project_admin", actorUserId: adminId }), "pa membership");
  mustOk(addTeamMember(db, { projectId, userId: memberId, role: "full_member", actorUserId: adminId }), "member membership");
  workTypeId = mustOk(defineCardType(db, { projectId, name: "Work", actorUserId: adminId }), "Work").id;
  statusId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Status",
      kind: "enumerated",
      values: ["Proposed", "Ready", "Backlog", "In Progress", "In Test", "Completed"],
      actorUserId: adminId,
    }),
    "Status",
  ).id;
  ownerId = mustOk(definePropertyDefinition(db, { projectId, name: "Owner", kind: "user", actorUserId: adminId }), "Owner").id;
  pointsId = mustOk(definePropertyDefinition(db, { projectId, name: "Points", kind: "number", actorUserId: adminId }), "Points").id;
  velocityId = mustOk(
    definePropertyDefinition(db, { projectId, name: "Velocity", kind: "formula", formula: "Points * 2", actorUserId: adminId }),
    "Velocity",
  ).id;
  db.delete(domainEvents).run();
});

describe("SetCardDefaults", () => {
  it("replaces the card type's defaults with canonical values and the current-user marker, and emits CardDefaultsSet", () => {
    mustOk(
      setCardDefaults(db, { projectId, cardTypeId: workTypeId, defaults: { Status: "proposed", Points: "3" }, actorUserId: projectAdminId }),
      "first set",
    );
    expect(defaultRows(workTypeId).map((row) => [row.propertyDefinitionId, row.value])).toEqual([
      [statusId, "Proposed"], // defined casing, not the input's
      [pointsId, "3"],
    ]);

    // A second call replaces the set: Points drops out, Owner comes in.
    mustOk(
      setCardDefaults(db, {
        projectId,
        cardTypeId: workTypeId,
        defaults: { status: "Ready", Owner: "(Current User)", Points: "  " },
        actorUserId: projectAdminId,
      }),
      "second set",
    );
    expect(defaultRows(workTypeId).map((row) => [row.propertyDefinitionId, row.value])).toEqual([
      [statusId, "Ready"],
      [ownerId, CURRENT_USER_MARKER],
    ]);
    expect(cardDefaultsFor(db, workTypeId).map((entry) => [entry.definition.name, entry.value])).toEqual([
      ["Status", "Ready"],
      ["Owner", CURRENT_USER_MARKER],
    ]);
    expect(listCardDefaults(db, projectId)).toEqual([
      { cardTypeId: workTypeId, values: { [String(statusId)]: "Ready", [String(ownerId)]: CURRENT_USER_MARKER } },
    ]);
    const payloads = events("CardDefaultsSet").map((event) => JSON.parse(String(event.payload)));
    expect(payloads).toEqual([
      { cardTypeName: "Work", defaults: { Status: "Proposed", Points: "3" } },
      { cardTypeName: "Work", defaults: { Status: "Ready", Owner: CURRENT_USER_MARKER } },
    ]);
    // A concrete member is stored by id.
    mustOk(setCardDefaults(db, { projectId, cardTypeId: workTypeId, defaults: { Owner: String(memberId) }, actorUserId: adminId }), "member default");
    expect(defaultRows(workTypeId).map((row) => row.value)).toEqual([String(memberId)]);
  });

  it("rejects an unmanaged enumerated value, a non-member user, a formula property, an unknown property, and a full member — writing nothing", () => {
    const attempt = (defaults: Record<string, string | null>, actorUserId = projectAdminId) =>
      setCardDefaults(db, { projectId, cardTypeId: workTypeId, defaults, actorUserId });
    const cases: [Record<string, string | null>, string, RegExp][] = [
      [{ Status: "Done" }, "defaults.Status", /restricted to Proposed, Ready, Backlog, In Progress, In Test, Completed/],
      [{ Owner: String(adminId) }, "defaults.Owner", /is not a project member/],
      [{ Velocity: "4" }, "defaults.Velocity", /formula property and cannot have a default/],
      [{ Priority: "High" }, "defaults.Priority", /is not a property of this project/],
      [{ Points: "three" }, "defaults.Points", /invalid numeric value/],
      [{ Status: "Ready", status: "Backlog" }, "defaults.Status", /named more than once/],
    ];
    for (const [defaults, field, message] of cases) {
      const result = attempt(defaults);
      expect(result.ok, JSON.stringify(defaults)).toBe(false);
      if (!result.ok) expect(result.errors[field]?.join(" "), field).toMatch(message);
    }
    const denied = attempt({ Status: "Ready" }, memberId);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(Object.keys(denied.errors)).toEqual(["authorization"]);
    const noType = setCardDefaults(db, { projectId, cardTypeId: workTypeId + 999, defaults: { Status: "Ready" }, actorUserId: adminId });
    expect(noType.ok).toBe(false);
    expect(defaultRows(workTypeId)).toEqual([]);
    expect(events("CardDefaultsSet")).toEqual([]);
  });

  it("goes with the card type when the type is deleted", () => {
    const spareId = mustOk(defineCardType(db, { projectId, name: "Spare", actorUserId: adminId }), "Spare").id;
    mustOk(setCardDefaults(db, { projectId, cardTypeId: spareId, defaults: { Status: "Ready" }, actorUserId: adminId }), "spare defaults");
    mustOk(setCardDefaults(db, { projectId, cardTypeId: workTypeId, defaults: { Status: "Proposed" }, actorUserId: adminId }), "work defaults");
    mustOk(deleteCardType(db, { projectId, cardTypeId: spareId, actorUserId: adminId }), "delete Spare");
    expect(defaultRows(spareId)).toEqual([]);
    expect(defaultRows(workTypeId).map((row) => row.value)).toEqual(["Proposed"]);
  });
});

describe("CreateCard with defaults", () => {
  beforeEach(() => {
    mustOk(
      setCardDefaults(db, {
        projectId,
        cardTypeId: workTypeId,
        defaults: { Status: "Proposed", Owner: CURRENT_USER_MARKER, Points: "2" },
        actorUserId: projectAdminId,
      }),
      "defaults",
    );
    db.delete(domainEvents).run();
  });

  it("writes the defaults as the card's initial values — current user resolved to the actor, formulas computed — inside version 1", () => {
    const card = mustOk(createCard(db, { projectId, name: "First", cardTypeId: workTypeId, actorUserId: memberId }), "card");
    expect(valuesOf(card.id)).toEqual({
      [statusId]: "Proposed",
      [ownerId]: String(memberId),
      [pointsId]: "2",
      [velocityId]: "4",
    });
    const versions = versionsOf(card.id);
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0].propertyValues)).toEqual({
      [String(statusId)]: "Proposed",
      [String(ownerId)]: String(memberId),
      [String(pointsId)]: "2",
      [String(velocityId)]: "4",
    });
    expect(db.select({ version: cards.version }).from(cards).where(eq(cards.id, card.id)).get()).toEqual({ version: 1 });
    const [created] = events("CardCreated");
    expect(JSON.parse(String(created.payload)).defaultedProperties).toEqual(["Status", "Owner", "Points"]);
    // A different actor gets their own id.
    const second = mustOk(createCard(db, { projectId, name: "Second", cardTypeId: workTypeId, actorUserId: projectAdminId }), "second");
    expect(valuesOf(second.id)[ownerId]).toBe(String(projectAdminId));
  });

  it("leaves a type without defaults exactly as before: no values, an empty version-1 snapshot", () => {
    const plainId = db.select({ id: cardTypes.id }).from(cardTypes).where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.name, "Card"))).get()!.id;
    const card = mustOk(createCard(db, { projectId, name: "Plain", cardTypeId: plainId, actorUserId: memberId }), "plain");
    expect(valuesOf(card.id)).toEqual({});
    expect(versionsOf(card.id).map((row) => row.propertyValues)).toEqual(["{}"]);
    expect(JSON.parse(String(events("CardCreated")[0].payload)).defaultedProperties).toEqual([]);
  });

  it("lets an explicit value set through the API override the default, in its own version, and takes the default for the rest", () => {
    const explicit = mustOk(
      createCardViaApi(db, { projectId, actorUserId: memberId, name: "Via API", typeName: "Work", properties: { Status: "In Progress" } }),
      "api create",
    );
    expect(valuesOf(explicit.card.id)).toEqual({
      [statusId]: "In Progress",
      [ownerId]: String(memberId),
      [pointsId]: "2",
      [velocityId]: "4",
    });
    const versions = versionsOf(explicit.card.id);
    expect(versions.map((row) => JSON.parse(row.propertyValues)[String(statusId)])).toEqual(["Proposed", "In Progress"]);

    // An explicit value equal to the default is no change: one version.
    const same = mustOk(
      createCardViaApi(db, { projectId, actorUserId: memberId, name: "Same as default", typeName: "Work", properties: { Status: "Proposed" } }),
      "api same",
    );
    expect(versionsOf(same.card.id)).toHaveLength(1);
    expect(valuesOf(same.card.id)[statusId]).toBe("Proposed");
  });

  it("refuses to create a card whose stored default the property no longer accepts, inserting nothing", () => {
    mustOk(setCardDefaults(db, { projectId, cardTypeId: workTypeId, defaults: { Owner: String(memberId) }, actorUserId: adminId }), "member default");
    mustOk(removeTeamMember(db, { projectId, userId: memberId, actorUserId: adminId }), "remove member");
    const result = createCard(db, { projectId, name: "Orphaned default", cardTypeId: workTypeId, actorUserId: projectAdminId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.property?.[0]).toMatch(/^Unable to set default for Owner to \d+ because Owner: Member is not a project member$/);
    expect(db.select().from(cards).where(eq(cards.projectId, projectId)).all()).toEqual([]);
    expect(events("CardCreated")).toEqual([]);
  });
});

describe("the settings page's cardDefaults intent", () => {
  it("posts one field per defaultable property into SetCardDefaults and reports errors under defaults.<name>", async () => {
    const cookie = (await createUserSession(projectAdminId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const post = async (fields: Record<string, string>) => {
      const request = new Request("http://localhost/projects/kanban/settings", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "cardDefaults", cardTypeId: String(workTypeId), ...fields }),
      });
      return (await settingsRoute.action({ request, params: { identifier: "kanban" }, context: {} } as never)) as Record<string, unknown>;
    };
    expect(
      await post({ [`default_${statusId}`]: "Backlog", [`default_${ownerId}`]: CURRENT_USER_MARKER, [`default_${pointsId}`]: "" }),
    ).toEqual({ saved: "cardDefaults" });
    expect(defaultRows(workTypeId).map((row) => [row.propertyDefinitionId, row.value])).toEqual([
      [statusId, "Backlog"],
      [ownerId, CURRENT_USER_MARKER],
    ]);
    const refused = await post({ [`default_${statusId}`]: "Done" });
    expect((refused.errors as Record<string, string[]>)["defaults.Status"]?.[0]).toMatch(/restricted to/);
    expect(defaultRows(workTypeId).map((row) => row.value)).toEqual(["Backlog", CURRENT_USER_MARKER]);

    const loaded = (await settingsRoute.loader({
      request: new Request("http://localhost/projects/kanban/settings", { headers: { Cookie: cookie } }),
      params: { identifier: "kanban" },
      context: {},
    } as never)) as { cardDefaults: unknown; members: { id: number }[] };
    expect(loaded.cardDefaults).toEqual([{ cardTypeId: workTypeId, values: { [String(statusId)]: "Backlog", [String(ownerId)]: CURRENT_USER_MARKER } }]);
    expect(loaded.members.map((member) => member.id).sort()).toEqual([projectAdminId, memberId].sort());
  });
});
