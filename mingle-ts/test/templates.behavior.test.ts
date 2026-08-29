/**
 * Behavioral tests for the shipped project templates (P-4, project
 * templates Phase 4; ADR-0024 Consequences — "a data file with a test
 * each").
 *
 * The Kanban template file is validated by `parseBundle` in the suite,
 * so a hand-edit that breaks it fails the gate, and imported into a
 * fresh project through `importProject`, asserting on every entity the
 * template promises as re-read from the database: the card type, the
 * Status values in column order, the Owner/Pair user properties, the
 * Work defaults, the Kanban Board tab with its WIP limits, the four
 * seed cards, and the Overview Page whose template tokens resolved to
 * dates and whose cumulative-flow chart renders one series per column
 * through the real macro path.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Import/Export verification.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-templates-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "templates-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { cards, cardTypes } = await import("../app/db/schema/cards");
const { cardDefaults } = await import("../app/db/schema/card-defaults");
const { favorites } = await import("../app/db/schema/favorites");
const { pages } = await import("../app/db/schema/pages");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cardPropertyValues, enumerationValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { parseBundle } = await import("../app/domain/import-export/bundle.server");
const { importProject } = await import("../app/domain/import-export/import.server");
const { renderPageContent } = await import("../app/domain/pages/content.server");
const { pageRenderContext } = await import("../app/domain/pages/read.server");
const { pageMacroExpansion } = await import("../app/domain/pages/macros-registry.server");
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

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const COLUMNS = ["Proposed", "Ready", "Backlog", "In Progress", "In Test", "Completed"];
const adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "templates-4!" }), "admin").id;
const NOW = new Date("2026-08-29T12:00:00Z");

describe("the shipped templates", () => {
  it("every file under templates/ is a valid bundle", () => {
    const files = readdirSync(TEMPLATES_DIR).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(["kanban.json"]);
    for (const file of files) {
      const parsed = parseBundle(readFileSync(join(TEMPLATES_DIR, file), "utf8"));
      expect(parsed.ok, `${file}: ${JSON.stringify(!parsed.ok && parsed.errors)}`).toBe(true);
    }
  });
});

describe("the Kanban template", () => {
  const bundle = mustOk(parseBundle(readFileSync(join(TEMPLATES_DIR, "kanban.json"), "utf8")), "kanban.json");

  it("declares the board as proposed: one Work type, the six columns in order, Owner and Pair, defaults, the tab with WIP limits, four seed cards, and an overview with a token-dated chart", () => {
    expect(bundle.source).toMatchObject({ name: "Kanban", identifier: "kanban" });
    expect(bundle.cardTypes).toEqual(["Work"]);
    expect(bundle.properties.map((p) => [p.name, p.kind])).toEqual([["Status", "enumerated"], ["Owner", "user"], ["Pair", "user"]]);
    expect(bundle.properties[0].values).toEqual(COLUMNS);
    expect(bundle.cardDefaults).toEqual([{ cardType: "Work", values: { Status: "Proposed", Owner: CURRENT_USER_MARKER } }]);
    expect(bundle.favorites).toEqual([
      { name: "Kanban Board", style: "grid", filters: ["[Type][is][Work]"], columns: [], groupBy: "Status", tabView: true, wipLimits: { "In Progress": 2, "In Test": 2 } },
    ]);
    expect(bundle.cards.map((c) => [c.number, c.name, c.cardType, c.values.Status])).toEqual([
      [1, "Work 1", "Work", "In Progress"],
      [2, "Work 2", "Work", "In Progress"],
      [3, "Work 3", "Work", "Ready"],
      [4, "Work 4", "Work", "Proposed"],
    ]);
    expect(bundle.pages.map((p) => p.name)).toEqual(["Overview Page"]);
    const overview = bundle.pages[0].content ?? "";
    expect(overview).toContain("start-date: {{template:today-2}}");
    expect(overview).toContain("end-date: {{template:today+14}}");
    for (const column of COLUMNS) expect(overview).toContain(`label: ${column}`);
  });

  it("imports into a fresh project with every entity in place and the overview's dates resolved", () => {
    const outcome = mustOk(importProject(db, { bundle, actorUserId: adminId, now: NOW }), "import kanban");
    const projectId = outcome.projectId;
    expect(outcome.identifier).toBe("kanban");
    expect(outcome.counts).toMatchObject({ cardTypes: 1, properties: 3, favorites: 1, cards: 4, cardDefaults: 1, pages: 1 });

    const types = db.select().from(cardTypes).where(eq(cardTypes.projectId, projectId)).orderBy(asc(cardTypes.position)).all();
    expect(types.map((t) => t.name)).toEqual(["Card", "Work"]); // "Card" comes with every project
    const work = types[1];
    const definitions = db.select().from(propertyDefinitions).where(eq(propertyDefinitions.projectId, projectId)).orderBy(asc(propertyDefinitions.position)).all();
    expect(definitions.map((d) => [d.name, d.kind])).toEqual([["Status", "enumerated"], ["Owner", "user"], ["Pair", "user"]]);
    const status = definitions[0];
    const owner = definitions[1];
    expect(
      db.select({ value: enumerationValues.value }).from(enumerationValues).where(eq(enumerationValues.propertyDefinitionId, status.id)).orderBy(asc(enumerationValues.position)).all().map((v) => v.value),
    ).toEqual(COLUMNS);

    expect(
      db.select().from(cardDefaults).where(eq(cardDefaults.projectId, projectId)).all().map((d) => [d.cardTypeId, d.propertyDefinitionId, d.value]),
    ).toEqual([
      [work.id, status.id, "Proposed"],
      [work.id, owner.id, CURRENT_USER_MARKER],
    ]);

    const board = db.select().from(favorites).where(eq(favorites.projectId, projectId)).all();
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ name: "Kanban Board", userId: null, style: "grid", groupBy: "Status", tabView: true, filters: '["[Type][is][Work]"]', wipLimits: '{"In Progress":2,"In Test":2}' });

    const seeds = db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(asc(cards.number)).all();
    const values = db.select().from(cardPropertyValues).where(inArray(cardPropertyValues.cardId, seeds.map((c) => c.id))).all();
    const statusOf = (cardId: number) => values.find((v) => v.cardId === cardId && v.propertyDefinitionId === status.id)?.value ?? null;
    expect(seeds.map((c) => [c.number, c.name, c.cardTypeId, statusOf(c.id)])).toEqual([
      [1, "Work 1", work.id, "In Progress"],
      [2, "Work 2", work.id, "In Progress"],
      [3, "Work 3", work.id, "Ready"],
      [4, "Work 4", work.id, "Proposed"],
    ]);
    // Seed cards hold exactly the template's values — no Owner, since the defaults are set after them.
    expect(values.filter((v) => v.propertyDefinitionId === owner.id)).toEqual([]);

    const overview = db.select().from(pages).where(and(eq(pages.projectId, projectId), eq(pages.name, "Overview Page"))).get()!;
    expect(overview.content).not.toContain("{{template:");
    expect(overview.content).toContain("start-date: 2026-08-27");
    expect(overview.content).toContain("end-date: 2026-09-12");
    const rendered = renderPageContent(overview.content, pageRenderContext(db, "kanban"), pageMacroExpansion({ projectIdentifier: "kanban", projectId, db, currentUserId: adminId }));
    expect(rendered).toContain('<div class="macro chart daily-history-chart">');
    expect([...rendered.matchAll(/<polyline\b/g)]).toHaveLength(COLUMNS.length);
    expect(rendered).not.toContain("macro-error");

    // The importing administrator joined the team (the defaults name them), and a new Work card starts Proposed, owned by its creator.
    expect(db.select({ userId: teamMemberships.userId }).from(teamMemberships).where(eq(teamMemberships.projectId, projectId)).all()).toEqual([{ userId: adminId }]);
    const fresh = mustOk(createCard(db, { projectId, name: "Work 5", cardTypeId: work.id, actorUserId: adminId }), "fresh");
    expect(fresh.number).toBe(5);
    const freshValues = db.select().from(cardPropertyValues).where(eq(cardPropertyValues.cardId, fresh.id)).all();
    expect(Object.fromEntries(freshValues.map((v) => [v.propertyDefinitionId, v.value]))).toEqual({ [status.id]: "Proposed", [owner.id]: String(adminId) });
  });
});
