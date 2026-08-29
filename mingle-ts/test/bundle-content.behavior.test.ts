/**
 * Behavioral tests for bundle version 2 — content sections, export on
 * request, import through the existing writers, and template tokens
 * (P-1, project templates Phase 3, ADR-0024).
 *
 * Derived from the rule 12 Behavior Statement for the widened
 * `importProject` and `exportProject`'s `includeContent` branch: the
 * export is asserted against the source project's rows (and what it
 * must drop), the import against the rows it creates — `card_defaults`,
 * `favorites` (with `wip_limits`, the P-3 round-trip), `cards` /
 * `card_property_values` / `card_versions`, `pages` — and every
 * rejection proves the transaction rolled back. Also covers the
 * version-1 document still importing unchanged, `(current user)`
 * resolution, `{{template:today±N}}` expansion, and the export route's
 * `?content=1`.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Import/Export verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-bundle-content-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "bundle-content-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const exportRoute = await import("../app/routes/projects.export");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardDefaults } = await import("../app/db/schema/card-defaults");
const { favorites } = await import("../app/db/schema/favorites");
const { pages } = await import("../app/db/schema/pages");
const { projects } = await import("../app/db/schema/projects");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cardPropertyValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, defineCardType } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition, setCardPropertyValue } = await import("../app/domain/cards/properties.server");
const { setCardDefaults } = await import("../app/domain/cards/card-defaults.server");
const { makeFavoriteTab, saveFavorite, setLaneWipLimit } = await import("../app/domain/cards/favorites.server");
const { createPage } = await import("../app/domain/pages/commands.server");
const { BUNDLE_FORMAT, BUNDLE_VERSION, expandTemplateTokens, parseBundle } = await import("../app/domain/import-export/bundle.server");
const { exportProject } = await import("../app/domain/import-export/export.server");
const { importProject } = await import("../app/domain/import-export/import.server");
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
function mustReject<T>(result: CommandResult<T>, what: string): Record<string, string[]> {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return result.errors;
}

const adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "bundle-2!" }), "admin").id;
const memberId = mustOk(registerUser(db, { login: "member", name: "Member", password: "bundle-2!" }), "member").id;

// ── The source project: configuration plus every content kind ──
const source = mustOk(createProject(db, { name: "Source", identifier: "source", actorUserId: adminId }), "source");
const a = { projectId: source.id, actorUserId: adminId };
mustOk(addTeamMember(db, { ...a, userId: memberId }), "member");
const work = mustOk(defineCardType(db, { ...a, name: "Work" }), "Work");
const cardType = db.select().from(cardTypes).where(and(eq(cardTypes.projectId, source.id), eq(cardTypes.name, "Card"))).get()!;
const status = mustOk(definePropertyDefinition(db, { ...a, name: "Status", kind: "enumerated", values: ["Proposed", "In Progress", "Completed"] }), "Status");
const owner = mustOk(definePropertyDefinition(db, { ...a, name: "Owner", kind: "user" }), "Owner");
const points = mustOk(definePropertyDefinition(db, { ...a, name: "Points", kind: "number" }), "Points");
mustOk(setCardDefaults(db, { ...a, cardTypeId: work.id, defaults: { Status: "Proposed", Owner: CURRENT_USER_MARKER, Points: "1" } }), "Work defaults");
mustOk(setCardDefaults(db, { ...a, cardTypeId: cardType.id, defaults: { Owner: String(memberId) } }), "Card defaults"); // a concrete user: must not travel
const board = mustOk(
  saveFavorite(db, { ...a, name: "Kanban Board", style: "grid", filters: ["[Type][is][Work]"], columns: [], groupBy: "Status", personal: false }),
  "board",
);
mustOk(makeFavoriteTab(db, { ...a, favoriteId: board.id }), "tab");
mustOk(setLaneWipLimit(db, { ...a, favoriteId: board.id, laneValue: "In Progress", limit: 2 }), "wip");
mustOk(saveFavorite(db, { ...a, name: "Open", style: "list", filters: [], columns: ["Status", "Points"], groupBy: "", mql: "Status != Completed", personal: false }), "open");
const byOwner = mustOk(saveFavorite(db, { ...a, name: "By owner", style: "grid", filters: [], columns: [], groupBy: "Owner", personal: false }), "by owner");
mustOk(setLaneWipLimit(db, { ...a, favoriteId: byOwner.id, laneValue: String(memberId), limit: 1 }), "user-lane wip"); // keyed by a user id: must not travel
mustOk(saveFavorite(db, { ...a, name: "Mine", style: "list", filters: [], columns: ["Status"], groupBy: "", personal: true }), "personal"); // must not travel
// Seed cards: created on the "Card" type (whose only default, Owner, is a concrete user) so their values are exactly what is set here.
const c1 = mustOk(createCard(db, { ...a, name: "Work 1", description: "<p>first</p>", cardTypeId: cardType.id }), "c1");
mustOk(setCardPropertyValue(db, { ...a, cardNumber: c1.number, propertyDefinitionId: status.id, value: "In Progress" }), "c1 status");
mustOk(setCardPropertyValue(db, { ...a, cardNumber: c1.number, propertyDefinitionId: points.id, value: "3" }), "c1 points");
const c2 = mustOk(createCard(db, { ...a, name: "Work 2", cardTypeId: cardType.id }), "c2");
mustOk(setCardPropertyValue(db, { ...a, cardNumber: c2.number, propertyDefinitionId: status.id, value: "Proposed" }), "c2 status");
mustOk(createCard(db, { ...a, name: "Work 3", cardTypeId: work.id }), "c3"); // takes Work's defaults: Status, Owner (admin), Points
mustOk(createPage(db, { ...a, name: "Overview Page", content: "<h2>Flow</h2><p>{{ daily-history-chart start-date: 2026-08-01 end-date: 2026-08-31 }}</p>" }), "overview");
mustOk(createPage(db, { ...a, name: "Empty", content: null }), "empty");
void owner;

const NOW = new Date("2026-08-29T12:00:00Z");
const contentBundle = () => mustOk(exportProject(db, { ...a, now: NOW, includeContent: true }), "export with content");

/** A project's content as comparable rows, cross-references resolved to names. */
function contentOf(projectId: number) {
  const types = db.select().from(cardTypes).where(eq(cardTypes.projectId, projectId)).all();
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const definitions = db.select().from(propertyDefinitions).where(eq(propertyDefinitions.projectId, projectId)).all();
  const definitionName = new Map(definitions.map((d) => [d.id, d.name]));
  const cardRows = db.select().from(cards).where(eq(cards.projectId, projectId)).orderBy(asc(cards.number)).all();
  const values = cardRows.length ? db.select().from(cardPropertyValues).where(inArray(cardPropertyValues.cardId, cardRows.map((c) => c.id))).all() : [];
  const versions = cardRows.length ? db.select().from(cardVersions).where(inArray(cardVersions.cardId, cardRows.map((c) => c.id))).all() : [];
  return {
    defaults: db
      .select()
      .from(cardDefaults)
      .where(eq(cardDefaults.projectId, projectId))
      .orderBy(asc(cardDefaults.id))
      .all()
      .map((d) => [typeName.get(d.cardTypeId), definitionName.get(d.propertyDefinitionId), d.value]),
    favorites: db
      .select()
      .from(favorites)
      .where(eq(favorites.projectId, projectId))
      .orderBy(asc(favorites.name))
      .all()
      .map((f) => ({ name: f.name, personal: f.userId !== null, style: f.style, filters: f.filters, columns: f.columns, groupBy: f.groupBy, mql: f.mql, tabView: f.tabView, wipLimits: f.wipLimits })),
    cards: cardRows.map((c) => ({
      number: c.number,
      name: c.name,
      description: c.description,
      type: typeName.get(c.cardTypeId),
      version: c.version,
      versions: versions.filter((v) => v.cardId === c.id).length,
      values: Object.fromEntries(values.filter((v) => v.cardId === c.id).map((v) => [definitionName.get(v.propertyDefinitionId), v.value])),
    })),
    pages: db.select({ name: pages.name, content: pages.content, version: pages.version }).from(pages).where(eq(pages.projectId, projectId)).orderBy(asc(pages.name)).all(),
  };
}

describe("exportProject with content", () => {
  it("stays configuration-only by default and emits the four sections on request, dropping what carries identity", () => {
    const plain = mustOk(exportProject(db, { ...a, now: NOW }), "plain export");
    expect(plain.version).toBe(BUNDLE_VERSION);
    expect({ cardDefaults: plain.cardDefaults, favorites: plain.favorites, cards: plain.cards, pages: plain.pages }).toEqual({ cardDefaults: [], favorites: [], cards: [], pages: [] });

    const bundle = contentBundle();
    expect(bundle.cardDefaults).toEqual([
      // "Card"'s concrete-user default is dropped, leaving nothing to carry for that type.
      { cardType: "Work", values: { Status: "Proposed", Owner: CURRENT_USER_MARKER, Points: "1" } },
    ]);
    expect(bundle.favorites).toEqual([
      { name: "By owner", style: "grid", filters: [], columns: [], groupBy: "Owner", tabView: false, wipLimits: {} }, // user-lane limits dropped
      { name: "Kanban Board", style: "grid", filters: ["[Type][is][Work]"], columns: [], groupBy: "Status", tabView: true, wipLimits: { "In Progress": 2 } },
      { name: "Open", style: "list", filters: [], columns: ["Status", "Points"], groupBy: "", mql: "Status != Completed", tabView: false, wipLimits: {} },
    ]);
    expect(bundle.cards).toEqual([
      { name: "Work 1", cardType: "Card", number: 1, description: "<p>first</p>", values: { Status: "In Progress", Points: "3" } }, // Owner (a user) dropped
      { name: "Work 2", cardType: "Card", number: 2, values: { Status: "Proposed" } },
      { name: "Work 3", cardType: "Work", number: 3, values: { Status: "Proposed", Points: "1" } },
    ]);
    expect(bundle.pages).toEqual([
      { name: "Empty", content: null },
      { name: "Overview Page", content: "<h2>Flow</h2><p>{{ daily-history-chart start-date: 2026-08-01 end-date: 2026-08-31 }}</p>" },
    ]);
    // The document round-trips through the parser as a version-2 bundle.
    expect(parseBundle(JSON.stringify(bundle))).toEqual({ ok: true, value: bundle });
  });

  it("the export route adds the content sections with ?content=1 and names the file accordingly", async () => {
    const cookie = (await createUserSession(adminId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const get = async (query: string) =>
      (await exportRoute.loader({ request: new Request(`http://localhost/projects/source/export${query}`, { headers: { Cookie: cookie } }), params: { identifier: "source" }, context: {} } as never)) as Response;
    const plain = await get("");
    expect(plain.headers.get("Content-Disposition")).toBe('attachment; filename="source-template.json"');
    expect((await plain.json()).cards).toEqual([]);
    const full = await get("?content=1");
    expect(full.headers.get("Content-Disposition")).toBe('attachment; filename="source-template-with-content.json"');
    expect((await full.json()).cards).toHaveLength(3);
  });
});

describe("importProject with content", () => {
  it("P-1/P-3 round trip: the exported content lands in a fresh project row for row through the existing writers", () => {
    const bundle = contentBundle();
    const outcome = mustOk(importProject(db, { bundle, name: "Copy", identifier: "copy", actorUserId: adminId, now: NOW }), "import");
    expect(outcome.counts).toMatchObject({ favorites: 3, cards: 3, cardDefaults: 1, pages: 2 });
    const copy = contentOf(outcome.projectId);
    expect(copy.defaults).toEqual([
      ["Work", "Status", "Proposed"],
      ["Work", "Owner", CURRENT_USER_MARKER],
      ["Work", "Points", "1"],
    ]);
    expect(copy.favorites).toEqual([
      { name: "By owner", personal: false, style: "grid", filters: "[]", columns: "[]", groupBy: "Owner", mql: null, tabView: false, wipLimits: "{}" },
      { name: "Kanban Board", personal: false, style: "grid", filters: '["[Type][is][Work]"]', columns: "[]", groupBy: "Status", mql: null, tabView: true, wipLimits: '{"In Progress":2}' },
      { name: "Open", personal: false, style: "list", filters: "[]", columns: '["Status","Points"]', groupBy: null, mql: "Status != Completed", tabView: false, wipLimits: "{}" },
    ]);
    expect(copy.cards).toEqual([
      // Seed cards are imported before the defaults are set, so they hold exactly the template's values; ImportCards gives a values version to each card with values.
      { number: 1, name: "Work 1", description: "<p>first</p>", type: "Card", version: 2, versions: 2, values: { Status: "In Progress", Points: "3" } },
      { number: 2, name: "Work 2", description: null, type: "Card", version: 2, versions: 2, values: { Status: "Proposed" } },
      { number: 3, name: "Work 3", description: null, type: "Work", version: 2, versions: 2, values: { Status: "Proposed", Points: "1" } },
    ]);
    expect(copy.pages).toEqual([
      { name: "Empty", content: null, version: 1 },
      { name: "Overview Page", content: "<h2>Flow</h2><p>{{ daily-history-chart start-date: 2026-08-01 end-date: 2026-08-31 }}</p>", version: 1 },
    ]);
    // The defaults now apply to new cards of the copy's Work type — the engine feature, not the import, sets them.
    const workId = db.select({ id: cardTypes.id }).from(cardTypes).where(and(eq(cardTypes.projectId, outcome.projectId), eq(cardTypes.name, "Work"))).get()!.id;
    const fresh = mustOk(createCard(db, { projectId: outcome.projectId, name: "Fresh", cardTypeId: workId, actorUserId: adminId }), "fresh");
    expect(contentOf(outcome.projectId).cards.find((c) => c.number === fresh.number)?.values).toEqual({ Status: "Proposed", Owner: String(adminId), Points: "1" });
    const imported = db.select().from(domainEvents).where(and(eq(domainEvents.type, "ProjectImported"), eq(domainEvents.aggregateId, outcome.projectId))).get()!;
    expect(JSON.parse(String(imported.payload)).counts).toEqual(outcome.counts);
  });

  it("resolves (current user) to the importing actor on seed cards, stores the marker on defaults, and expands template tokens against the instantiation date", () => {
    const bundle = mustOk(
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT,
          version: 2,
          exportedAt: NOW.toISOString(),
          source: { name: "Tokens", identifier: "tokens", description: null },
          cardTypes: ["Work"],
          properties: [
            { name: "Status", kind: "enumerated", values: ["Proposed", "Completed"], transitionOnly: false },
            { name: "Owner", kind: "user", transitionOnly: false },
          ],
          trees: [],
          aggregates: [],
          transitions: [],
          variables: [],
          cardDefaults: [{ cardType: "Work", values: { Owner: "(Current User)" } }],
          cards: [{ name: "Seed", cardType: "Work", values: { status: "completed", Owner: CURRENT_USER_MARKER } }],
          pages: [
            { name: "Overview Page", content: "<p>From {{template:today-2}} to {{ template:today + 14 }}, as of {{template:today}}.</p>" },
          ],
        }),
      ),
      "parse",
    );
    // Only a site administrator creates projects; the marker resolves to that actor.
    const outcome = mustOk(importProject(db, { bundle, actorUserId: adminId, now: NOW }), "import");
    const content = contentOf(outcome.projectId);
    expect(content.cards).toEqual([{ number: 1, name: "Seed", description: null, type: "Work", version: 2, versions: 2, values: { Status: "Completed", Owner: String(adminId) } }]);
    expect(content.defaults).toEqual([["Work", "Owner", CURRENT_USER_MARKER]]);
    // The actor joined the team so the seed card's user value could name them (legacy ProjectCreator add_member).
    expect(db.select({ userId: teamMemberships.userId }).from(teamMemberships).where(eq(teamMemberships.projectId, outcome.projectId)).all()).toEqual([{ userId: adminId }]);
    expect(content.pages).toEqual([{ name: "Overview Page", content: "<p>From 2026-08-27 to 2026-09-12, as of 2026-08-29.</p>", version: 1 }]);
    expect(expandTemplateTokens("{{template:today+366}}", new Date("2027-12-31T23:30:00Z"))).toBe("2028-12-31"); // 2028 is a leap year
  });

  it("still imports a version-1 document unchanged, with empty content", () => {
    const v1 = mustOk(exportProject(db, { ...a, now: NOW }), "plain");
    const { cardDefaults: _d, favorites: _f, cards: _c, pages: _p, ...document } = v1;
    const parsed = mustOk(parseBundle(JSON.stringify({ ...document, version: 1 })), "parse v1");
    expect(parsed.version).toBe(1);
    expect({ cardDefaults: parsed.cardDefaults, favorites: parsed.favorites, cards: parsed.cards, pages: parsed.pages }).toEqual({ cardDefaults: [], favorites: [], cards: [], pages: [] });
    const outcome = mustOk(importProject(db, { bundle: parsed, name: "V1", identifier: "v1", actorUserId: adminId }), "import v1");
    expect(outcome.counts).toMatchObject({ cardTypes: 1, properties: 3, favorites: 0, cards: 0, cardDefaults: 0, pages: 0 });
    expect(contentOf(outcome.projectId)).toEqual({ defaults: [], favorites: [], cards: [], pages: [] });
  });

  it("rejects by bundle path and rolls back when content names something unknown or breaks a rule", () => {
    const before = db.select({ id: projects.id }).from(projects).all().length;
    const base = contentBundle();
    const attempt = (patch: Partial<typeof base>, what: string) =>
      mustReject(importProject(db, { bundle: { ...base, ...patch }, name: what, identifier: what, actorUserId: adminId }), what);
    expect(attempt({ cards: [{ name: "X", cardType: "Work", values: { Nope: "1" } }] }, "unknownprop")).toEqual({ "cards[0].values.Nope": ['refers to an unknown property "Nope"'] });
    expect(attempt({ cards: [{ name: "X", cardType: "Bug", values: {} }] }, "unknowntype")).toEqual({ "cards[0].cardType": ['refers to an unknown card type "Bug"'] });
    expect(attempt({ cards: [{ name: "X", cardType: "Work", values: { Status: "Done" } }] }, "badvalue")["cards.rows"]?.[0]).toMatch(/Row 2: Status is restricted to/);
    const board = base.favorites.find((f) => f.name === "Kanban Board")!;
    expect(attempt({ favorites: [{ ...board, wipLimits: { Done: 1 } }] }, "badlane")).toEqual({ "favorites[0].wipLimits.Done.lane": ["Status is restricted to Proposed, In Progress, Completed"] });
    expect(attempt({ cardDefaults: [{ cardType: "Work", values: { Points: "lots" } }] }, "baddefault")).toEqual({ "cardDefaults[0].defaults.Points": ["Points: 'lots' is an invalid numeric value"] });
    expect(attempt({ pages: [{ name: "a/b", content: null }] }, "badpage")).toHaveProperty("pages[0].name");
    expect(db.select({ id: projects.id }).from(projects).all().length).toBe(before);
    // Only the source and the earlier round-trip copy hold the board; every rejected import left no favorite behind.
    expect(db.select().from(favorites).where(eq(favorites.name, "Kanban Board")).all()).toHaveLength(2);
  });
});

describe("parseBundle version 2", () => {
  it("rejects an unsupported version, a user value other than (current user), a bad WIP limit, and a bad card number", () => {
    const base = { ...contentBundle() };
    const parse = (patch: Record<string, unknown>) => parseBundle(JSON.stringify({ ...base, ...patch }));
    expect(mustReject(parse({ version: 3 }), "v3").bundle?.[0]).toMatch(/version must be one of 1, 2/);
    expect(mustReject(parse({ cardDefaults: [{ cardType: "Work", values: { Owner: "member" } }] }), "user default").bundle?.[0]).toMatch(/cardDefaults\[0\].values.Owner a user property may only default to "\(current user\)"/);
    expect(mustReject(parse({ cards: [{ name: "X", cardType: "Work", values: { Owner: "42" } }] }), "user value").bundle?.[0]).toMatch(/cards\[0\].values.Owner/);
    expect(mustReject(parse({ favorites: [{ name: "F", style: "grid", groupBy: "Status", wipLimits: { Proposed: 0 } }] }), "wip").bundle?.[0]).toMatch(/favorites\[0\].wipLimits.Proposed must be a positive whole number/);
    expect(mustReject(parse({ cards: [{ name: "X", cardType: "Work", number: 0, values: {} }] }), "number").bundle?.[0]).toMatch(/cards\[0\].number must be a positive whole number/);
    // Minimal favorite and card entries fill in their defaults.
    const minimal = mustOk(parse({ favorites: [{ name: "F", style: "list" }], cards: [{ name: "X", cardType: "Work" }] }), "minimal");
    expect(minimal.favorites).toEqual([{ name: "F", style: "list", filters: [], columns: [], groupBy: "", tabView: false, wipLimits: {} }]);
    expect(minimal.cards).toEqual([{ name: "X", cardType: "Work", values: {} }]);
  });
});
