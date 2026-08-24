/**
 * Behavioral tests for the Card Management project commands (Phase 3).
 *
 * Derived line-by-line from the rule 12 Behavior Statements: every DOES
 * asserts on the persisted row reloaded from the database (never on the
 * return value alone), and every REJECTS WHEN has a rejection test that
 * also proves nothing mutated.
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations — no stubs, no fakes.
 *
 * Owner context: Card Management verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { projects, projectVariables } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import {
  createProject,
  defineProjectVariable,
  generateProjectIdentifier,
  updateProjectSettings,
} from "../app/domain/projects/commands.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-projects-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let actorId: number;

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(projectVariables).run();
  db.delete(projects).run();
  db.delete(users).run();
  const registered = registerUser(db, {
    login: "dave",
    name: "David",
    password: "card-wall-2010!",
  });
  if (!registered.ok) throw new Error("test actor registration failed");
  actorId = registered.value.id;
  db.delete(domainEvents).run(); // only project events matter below
});

function reloadByIdentifier(identifier: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.identifier, identifier))
    .get();
}

function eventsOfType(type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all();
}

function makeProject(name = "Card Wall", identifier?: string) {
  const result = createProject(db, {
    name,
    identifier: identifier ?? null,
    actorUserId: actorId,
  });
  if (!result.ok) throw new Error("test project creation failed");
  return result.value;
}

describe("createProject (CreateProject → ProjectCreated)", () => {
  it("persists the project row with the supplied identifier and creator", () => {
    const result = createProject(db, {
      name: "Card Wall",
      identifier: "card_wall",
      description: "  agile board  ",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(true);
    const row = reloadByIdentifier("card_wall");
    expect(row).toBeDefined();
    expect(row!.name).toBe("Card Wall");
    expect(row!.description).toBe("agile board");
    expect(row!.createdByUserId).toBe(actorId);
  });

  it("generates the identifier from the name when none is supplied", () => {
    const result = createProject(db, {
      name: "2010 Card Wall!",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(true);
    // non-alphanumerics → "_", lowercased, digit-leading gets "project_",
    // trailing underscore (from "!") trimmed
    const row = reloadByIdentifier("project_2010_card_wall");
    expect(row).toBeDefined();
    expect(row!.name).toBe("2010 Card Wall!");
  });

  it("suffixes a generated identifier that is already taken", () => {
    makeProject("Card Wall");
    const result = createProject(db, { name: "Card-Wall", actorUserId: actorId });
    expect(result.ok).toBe(true);
    expect(reloadByIdentifier("card_wall2")).toBeDefined();
  });

  it("appends a ProjectCreated event in the same write", () => {
    createProject(db, { name: "Card Wall", actorUserId: actorId });
    const events = eventsOfType("ProjectCreated");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateType).toBe("Project");
    expect(events[0].actorUserId).toBe(actorId);
    expect(JSON.parse(events[0].payload)).toEqual({
      name: "Card Wall",
      identifier: "card_wall",
    });
  });

  function expectCreateRejected(
    input: { name: string; identifier?: string | null },
    field: string,
    message: string,
  ) {
    const before = db.select().from(projects).all().length;
    const result = createProject(db, { ...input, actorUserId: actorId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toContain(message);
    expect(db.select().from(projects).all()).toHaveLength(before);
    expect(eventsOfType("ProjectCreated")).toHaveLength(before);
  }

  it("rejects a blank name and writes nothing", () => {
    expectCreateRejected({ name: "   " }, "name", "can't be blank");
  });

  it("rejects a name over 255 characters", () => {
    expectCreateRejected(
      { name: "x".repeat(256) },
      "name",
      "is too long (maximum is 255 characters)",
    );
  });

  it("rejects a case-insensitively taken name", () => {
    makeProject("Card Wall");
    expectCreateRejected(
      { name: "CARD WALL", identifier: "other" },
      "name",
      "has already been taken",
    );
  });

  it("rejects an identifier with upper case or punctuation", () => {
    expectCreateRejected(
      { name: "P1", identifier: "Card-Wall" },
      "identifier",
      "may contain only lower case letters, numbers and underscore ('_')",
    );
  });

  it("rejects an identifier starting with a digit", () => {
    expectCreateRejected(
      { name: "P1", identifier: "1card" },
      "identifier",
      "may not start with a digit",
    );
  });

  it("rejects an identifier over 30 characters", () => {
    expectCreateRejected(
      { name: "P1", identifier: "a".repeat(31) },
      "identifier",
      "is too long (maximum is 30 characters)",
    );
  });

  it("rejects the internal mi_NNNNNN identifier prefix", () => {
    expectCreateRejected(
      { name: "P1", identifier: "mi_123456_cards" },
      "identifier",
      "reserved for internal Mingle use",
    );
  });

  it("rejects a taken identifier", () => {
    makeProject("Card Wall", "card_wall");
    expectCreateRejected(
      { name: "Other", identifier: "card_wall" },
      "identifier",
      "has already been taken",
    );
  });
});

describe("updateProjectSettings (UpdateProjectSettings → ProjectSettingsUpdated)", () => {
  it("persists changed name, identifier, and description", () => {
    const project = makeProject("Card Wall", "card_wall");
    const before = reloadByIdentifier("card_wall")!;
    const result = updateProjectSettings(db, {
      projectId: project.id,
      name: "Kanban Wall",
      identifier: "kanban_wall",
      description: "renamed",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(true);
    expect(reloadByIdentifier("card_wall")).toBeUndefined();
    const row = reloadByIdentifier("kanban_wall")!;
    expect(row.name).toBe("Kanban Wall");
    expect(row.description).toBe("renamed");
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
  });

  it("appends a ProjectSettingsUpdated event naming exactly the changed fields", () => {
    const project = makeProject("Card Wall", "card_wall");
    updateProjectSettings(db, {
      projectId: project.id,
      name: "Kanban Wall",
      identifier: "card_wall",
      description: null,
      actorUserId: actorId,
    });
    const events = eventsOfType("ProjectSettingsUpdated");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(project.id);
    expect(JSON.parse(events[0].payload)).toEqual({ changed: ["name"] });
  });

  it("accepts an unchanged submit (uniqueness excludes the project itself)", () => {
    const project = makeProject("Card Wall", "card_wall");
    const result = updateProjectSettings(db, {
      projectId: project.id,
      name: "Card Wall",
      identifier: "card_wall",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(true);
    expect(reloadByIdentifier("card_wall")).toBeDefined();
  });

  it("rejects an unknown project", () => {
    const result = updateProjectSettings(db, {
      projectId: 9999,
      name: "X",
      identifier: "x",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.project).toContain("does not exist");
  });

  it("rejects a blank identifier and leaves the row unchanged", () => {
    const project = makeProject("Card Wall", "card_wall");
    const result = updateProjectSettings(db, {
      projectId: project.id,
      name: "Kanban Wall",
      identifier: "  ",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.identifier).toContain("can't be blank");
    expect(reloadByIdentifier("card_wall")!.name).toBe("Card Wall");
    expect(eventsOfType("ProjectSettingsUpdated")).toHaveLength(0);
  });

  it("rejects a name taken by another project and leaves the row unchanged", () => {
    makeProject("Kanban Wall", "kanban_wall");
    const project = makeProject("Card Wall", "card_wall");
    const result = updateProjectSettings(db, {
      projectId: project.id,
      name: "kanban wall",
      identifier: "card_wall",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toContain("has already been taken");
    expect(reloadByIdentifier("card_wall")!.name).toBe("Card Wall");
  });

  // The shared projectFieldError() rules must also hold at this call
  // site (the handler's REJECTS WHEN contract), not only via createProject.
  function expectUpdateRejected(
    projectId: number,
    input: { name: string; identifier: string },
    field: string,
    message: string,
  ) {
    const result = updateProjectSettings(db, {
      projectId,
      ...input,
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toContain(message);
    const row = reloadByIdentifier("card_wall")!;
    expect(row.name).toBe("Card Wall");
    expect(eventsOfType("ProjectSettingsUpdated")).toHaveLength(0);
  }

  it("rejects a blank name and leaves the row unchanged", () => {
    const project = makeProject("Card Wall", "card_wall");
    expectUpdateRejected(
      project.id,
      { name: "  ", identifier: "card_wall" },
      "name",
      "can't be blank",
    );
  });

  it("rejects a name over 255 characters and leaves the row unchanged", () => {
    const project = makeProject("Card Wall", "card_wall");
    expectUpdateRejected(
      project.id,
      { name: "x".repeat(256), identifier: "card_wall" },
      "name",
      "is too long (maximum is 255 characters)",
    );
  });

  it("rejects each invalid identifier form and leaves the row unchanged", () => {
    const project = makeProject("Card Wall", "card_wall");
    expectUpdateRejected(
      project.id,
      { name: "Card Wall", identifier: "Card-Wall" },
      "identifier",
      "may contain only lower case letters, numbers and underscore ('_')",
    );
    expectUpdateRejected(
      project.id,
      { name: "Card Wall", identifier: "1card" },
      "identifier",
      "may not start with a digit",
    );
    expectUpdateRejected(
      project.id,
      { name: "Card Wall", identifier: "a".repeat(31) },
      "identifier",
      "is too long (maximum is 30 characters)",
    );
    expectUpdateRejected(
      project.id,
      { name: "Card Wall", identifier: "mi_123456_cards" },
      "identifier",
      "reserved for internal Mingle use",
    );
  });

  it("rejects an identifier taken by another project", () => {
    makeProject("Kanban Wall", "kanban_wall");
    const project = makeProject("Card Wall", "card_wall");
    const result = updateProjectSettings(db, {
      projectId: project.id,
      name: "Card Wall",
      identifier: "kanban_wall",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.identifier).toContain("has already been taken");
    expect(reloadByIdentifier("card_wall")).toBeDefined();
  });
});

describe("defineProjectVariable (DefineProjectVariable → ProjectVariableDefined)", () => {
  function variablesOf(projectId: number) {
    return db
      .select()
      .from(projectVariables)
      .where(eq(projectVariables.projectId, projectId))
      .all();
  }

  it("persists the variable row scoped to the project", () => {
    const project = makeProject();
    const result = defineProjectVariable(db, {
      projectId: project.id,
      name: "  Current Release  ",
      dataType: "StringType",
      value: "Release 1",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(true);
    const rows = variablesOf(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Current Release");
    expect(rows[0].dataType).toBe("StringType");
    expect(rows[0].value).toBe("Release 1");
  });

  it("persists a null value when none is supplied", () => {
    const project = makeProject();
    defineProjectVariable(db, {
      projectId: project.id,
      name: "Current Release",
      dataType: "StringType",
      actorUserId: actorId,
    });
    expect(variablesOf(project.id)[0].value).toBeNull();
  });

  it("accepts a valid numeric, date, and user value", () => {
    const project = makeProject();
    for (const [name, dataType, value] of [
      ["Velocity", "NumericType", "21.5"],
      ["Release Date", "DateType", "2026-09-01"],
      ["Release Owner", "UserType", String(actorId)],
      ["Release Card", "CardType", "42"],
    ] as const) {
      const result = defineProjectVariable(db, {
        projectId: project.id,
        name,
        dataType,
        value,
        actorUserId: actorId,
      });
      expect(result.ok).toBe(true);
    }
    expect(variablesOf(project.id)).toHaveLength(4);
  });

  it("allows the same variable name in a different project", () => {
    const first = makeProject("First", "first");
    const second = makeProject("Second", "second");
    for (const projectId of [first.id, second.id]) {
      const result = defineProjectVariable(db, {
        projectId,
        name: "Current Release",
        dataType: "StringType",
        actorUserId: actorId,
      });
      expect(result.ok).toBe(true);
    }
    expect(variablesOf(second.id)).toHaveLength(1);
  });

  it("appends a ProjectVariableDefined event on the project aggregate", () => {
    const project = makeProject();
    defineProjectVariable(db, {
      projectId: project.id,
      name: "Current Release",
      dataType: "StringType",
      value: "Release 1",
      actorUserId: actorId,
    });
    const events = eventsOfType("ProjectVariableDefined");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateType).toBe("Project");
    expect(events[0].aggregateId).toBe(project.id);
    expect(JSON.parse(events[0].payload)).toEqual({
      name: "Current Release",
      dataType: "StringType",
      value: "Release 1",
    });
  });

  function expectDefineRejected(
    projectId: number,
    input: { name: string; dataType: string; value?: string | null },
    field: string,
    message: string,
  ) {
    const before = variablesOf(projectId).length;
    const result = defineProjectVariable(db, {
      projectId,
      ...input,
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toContain(message);
    expect(variablesOf(projectId)).toHaveLength(before);
    expect(eventsOfType("ProjectVariableDefined")).toHaveLength(before);
  }

  it("rejects an unknown project", () => {
    const result = defineProjectVariable(db, {
      projectId: 9999,
      name: "X",
      dataType: "StringType",
      actorUserId: actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.project).toContain("does not exist");
    expect(db.select().from(projectVariables).all()).toHaveLength(0);
  });

  it("rejects a blank name", () => {
    const project = makeProject();
    expectDefineRejected(
      project.id,
      { name: "  ", dataType: "StringType" },
      "name",
      "can't be blank",
    );
  });

  it("rejects reserved property-value names case-insensitively", () => {
    const project = makeProject();
    for (const reserved of ["Not Set", "CURRENT USER", "any", "today"]) {
      expectDefineRejected(
        project.id,
        { name: reserved, dataType: "StringType" },
        "name",
        "is a reserved property value",
      );
    }
  });

  it("rejects a name already taken in the project, case-insensitively", () => {
    const project = makeProject();
    defineProjectVariable(db, {
      projectId: project.id,
      name: "Current Release",
      dataType: "StringType",
      actorUserId: actorId,
    });
    expectDefineRejected(
      project.id,
      { name: "CURRENT RELEASE", dataType: "StringType" },
      "name",
      "has already been taken",
    );
  });

  it("rejects an unknown data type", () => {
    const project = makeProject();
    expectDefineRejected(
      project.id,
      { name: "X", dataType: "BooleanType" },
      "dataType",
      "must be selected",
    );
  });

  it("rejects a value wrapped in parentheses", () => {
    const project = makeProject();
    expectDefineRejected(
      project.id,
      { name: "X", dataType: "StringType", value: "(sneaky)" },
      "value",
      "cannot both start with '(' and end with ')'",
    );
  });

  it("rejects a non-numeric value for a numeric variable", () => {
    const project = makeProject();
    expectDefineRejected(
      project.id,
      { name: "Velocity", dataType: "NumericType", value: "fast" },
      "value",
      "is an invalid numeric value",
    );
  });

  it("rejects an unparseable date for a date variable", () => {
    const project = makeProject();
    for (const bad of ["someday", "2026-13-99"]) {
      expectDefineRejected(
        project.id,
        { name: "Release Date", dataType: "DateType", value: bad },
        "value",
        "is an invalid date",
      );
    }
  });

  it("rejects a user value that is not an existing user", () => {
    const project = makeProject();
    expectDefineRejected(
      project.id,
      { name: "Owner", dataType: "UserType", value: "9999" },
      "value",
      "must select a team member",
    );
  });
});

describe("generateProjectIdentifier", () => {
  it("mirrors the legacy generation rules", () => {
    const never = () => false;
    expect(generateProjectIdentifier("Card Wall", never)).toBe("card_wall");
    expect(generateProjectIdentifier("2010 Plan", never)).toBe(
      "project_2010_plan",
    );
    expect(generateProjectIdentifier("!!!", never)).toBe("proj");
    expect(
      generateProjectIdentifier("A".repeat(40), never).length,
    ).toBeLessThanOrEqual(30);
  });
});
