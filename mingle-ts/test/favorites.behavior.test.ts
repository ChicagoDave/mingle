/**
 * Behavioral tests for favorites, tabs, and saved views (Phase 11).
 *
 * Derived from the Behavior Statements for saveFavorite,
 * makeFavoriteTab / removeFavoriteTab, and deleteFavorite (session
 * log): every DOES line is asserted on the reloaded `favorites` row
 * and the appended `domain_events` row, every REJECTS WHEN line on the
 * rejection plus the absence of any state change. Includes the phase's
 * exit criterion: a favorite saved from a list or grid configuration,
 * reloaded from its persisted row, rebuilds the same filter/column and
 * lane state through the Phase 9/10 read models — and the canonical URL
 * it reopens into carries exactly the stored parameters.
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
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cardTypes } from "../app/db/schema/cards";
import { domainEvents } from "../app/db/schema/events";
import { favorites, type FavoriteRow } from "../app/db/schema/favorites";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard } from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import {
  deleteFavorite,
  favoriteHref,
  favoriteViewParams,
  findFavoriteByName,
  listFavorites,
  makeFavoriteTab,
  removeFavoriteTab,
  saveFavorite,
} from "../app/domain/cards/favorites.server";
import {
  buildCardListView,
  encodeFilterString,
  queryCardList,
} from "../app/domain/cards/list-view.server";
import { buildGridView } from "../app/domain/cards/grid-view.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-favorites-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number; //    site admin (MINGLE_ADMIN everywhere)
let memberId: number; //   full team member
let readonlyId: number; // readonly team member
let strangerId: number; // registered user, not on the team
let projectId: number;
let openCard: number;
let closedCard: number;

const statusOpen = encodeFilterString("Status", "is", "Open");

beforeAll(() => {
  const register = (login: string, name: string) =>
    mustOk(registerUser(db, { login, name, password: "favorites-2010!" }), login).id;
  adminId = register("admin", "Admin");
  memberId = register("member", "Mia Member");
  readonlyId = register("reader", "Ron Reader");
  strangerId = register("stranger", "Sam Stranger");
  projectId = mustOk(createProject(db, { name: "Favs", actorUserId: adminId }), "project").id;
  mustOk(addTeamMember(db, { projectId, userId: memberId, actorUserId: adminId }), "member");
  mustOk(
    addTeamMember(db, { projectId, userId: readonlyId, role: "readonly_member", actorUserId: adminId }),
    "readonly",
  );
  const statusId = mustOk(
    definePropertyDefinition(db, {
      projectId,
      name: "Status",
      kind: "enumerated",
      values: ["New", "Open", "Closed"],
      actorUserId: adminId,
    }),
    "Status",
  ).id;
  mustOk(
    definePropertyDefinition(db, { projectId, name: "Estimate", kind: "number", actorUserId: adminId }),
    "Estimate",
  );
  const cardType = db
    .select()
    .from(cardTypes)
    .where(and(eq(cardTypes.projectId, projectId), eq(cardTypes.name, "Card")))
    .get()!;
  const card = (name: string, status: string) => {
    const number = mustOk(
      createCard(db, { projectId, name, cardTypeId: cardType.id, actorUserId: adminId }),
      name,
    ).number;
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: number,
        propertyDefinitionId: statusId,
        value: status,
        actorUserId: adminId,
      }),
      `status of ${name}`,
    );
    return number;
  };
  openCard = card("Open story", "Open");
  closedCard = card("Closed story", "Closed");
});

beforeEach(() => {
  db.delete(favorites).run();
  db.delete(domainEvents).run();
});

function reload(id: number): FavoriteRow | undefined {
  return db.select().from(favorites).where(eq(favorites.id, id)).get();
}

function lastEvent() {
  return db.select().from(domainEvents).orderBy(desc(domainEvents.id)).get();
}

function saveTeamList(name: string, actorUserId = memberId) {
  return saveFavorite(db, {
    projectId,
    name,
    style: "list",
    filters: [statusOpen],
    columns: ["Status", "Estimate"],
    groupBy: "",
    personal: false,
    actorUserId,
  });
}

describe("SaveFavorite", () => {
  it("persists a team list favorite with its validated view parameters and emits FavoriteSaved", () => {
    const saved = mustOk(saveTeamList("  Open work  "), "save");

    const row = reload(saved.id)!;
    expect(row).toMatchObject({
      projectId,
      userId: null,
      kind: "card_view",
      name: "Open work",
      tabView: false,
      style: "list",
      groupBy: null,
    });
    expect(JSON.parse(row.filters)).toEqual([statusOpen]);
    expect(JSON.parse(row.columns)).toEqual(["Status", "Estimate"]);

    const event = lastEvent()!;
    expect(event.type).toBe("FavoriteSaved");
    expect(event.aggregateType).toBe("Favorite");
    expect(event.aggregateId).toBe(saved.id);
    expect(event.actorUserId).toBe(memberId);
    expect(JSON.parse(event.payload)).toMatchObject({
      name: "Open work",
      personal: false,
      replaced: false,
      style: "list",
    });
  });

  it("persists a grid favorite with the canonical group-by name and no columns", () => {
    const saved = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Wall",
        style: "grid",
        filters: [],
        columns: ["Status"], // ignored for grid
        groupBy: "status", // canonicalized to the defined casing
        personal: false,
        actorUserId: memberId,
      }),
      "save grid",
    );
    const row = reload(saved.id)!;
    expect(row.style).toBe("grid");
    expect(row.groupBy).toBe("Status");
    expect(JSON.parse(row.columns)).toEqual([]);
  });

  it("persists a personal favorite owned by the actor", () => {
    const saved = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Mine",
        style: "list",
        filters: [],
        columns: [],
        groupBy: "",
        personal: true,
        actorUserId: memberId,
      }),
      "save personal",
    );
    expect(reload(saved.id)!.userId).toBe(memberId);
    expect(JSON.parse(lastEvent()!.payload).personal).toBe(true);
  });

  it("replaces the view of a same-scope favorite carrying the same name (case-insensitively), keeping its id and tab flag", () => {
    const first = mustOk(saveTeamList("Open work"), "first");
    mustOk(makeFavoriteTab(db, { projectId, favoriteId: first.id, actorUserId: adminId }), "tab");

    const second = mustOk(
      saveFavorite(db, {
        projectId,
        name: "OPEN WORK",
        style: "grid",
        filters: [],
        columns: [],
        groupBy: "Status",
        personal: false,
        actorUserId: memberId,
      }),
      "replace",
    );

    expect(second.id).toBe(first.id);
    const rows = db.select().from(favorites).where(eq(favorites.projectId, projectId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, style: "grid", groupBy: "Status", tabView: true });
    expect(JSON.parse(lastEvent()!.payload).replaced).toBe(true);
  });

  it("lets a personal favorite and a team favorite share a name", () => {
    const team = mustOk(saveTeamList("Open work"), "team");
    const personal = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Open work",
        style: "list",
        filters: [],
        columns: [],
        groupBy: "",
        personal: true,
        actorUserId: memberId,
      }),
      "personal",
    );
    expect(personal.id).not.toBe(team.id);
    expect(findFavoriteByName(db, projectId, "open work", null)!.id).toBe(team.id);
    expect(findFavoriteByName(db, projectId, "open work", memberId)!.id).toBe(personal.id);
  });

  it("rejects a blank name and writes nothing", () => {
    const result = saveTeamList("   ");
    expect(result).toEqual({ ok: false, errors: { name: ["can't be blank"] } });
    expect(db.select().from(favorites).all()).toEqual([]);
    expect(lastEvent()).toBeUndefined();
  });

  it("rejects a name over 255 characters", () => {
    const result = saveTeamList("x".repeat(256));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name[0]).toMatch(/too long/);
    expect(db.select().from(favorites).all()).toEqual([]);
  });

  it("rejects view parameters that fail list-view validation, with the read model's messages", () => {
    const result = saveFavorite(db, {
      projectId,
      name: "Broken",
      style: "list",
      filters: [encodeFilterString("Nope", "is", "x")],
      columns: [],
      groupBy: "",
      personal: false,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.view.join(" ")).toMatch(/Nope/);
    expect(db.select().from(favorites).all()).toEqual([]);
  });

  it("rejects a grid favorite grouped by a non-groupable property", () => {
    const result = saveFavorite(db, {
      projectId,
      name: "Bad wall",
      style: "grid",
      filters: [],
      columns: [],
      groupBy: "Estimate",
      personal: false,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.view[0]).toMatch(/cannot be used to group/);
    expect(db.select().from(favorites).all()).toEqual([]);
  });

  it("rejects an unsupported style", () => {
    const result = saveFavorite(db, {
      projectId,
      name: "Tree",
      style: "tree" as never,
      filters: [],
      columns: [],
      groupBy: "",
      personal: false,
      actorUserId: memberId,
    });
    expect(result).toEqual({ ok: false, errors: { style: ["is not a supported view style"] } });
  });

  it("rejects actors below full team member (readonly member, non-member)", () => {
    for (const actor of [readonlyId, strangerId]) {
      const result = saveTeamList("Open work", actor);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)).toEqual(["authorization"]);
    }
    expect(db.select().from(favorites).all()).toEqual([]);
  });

  it("rejects an unknown project", () => {
    const result = saveFavorite(db, {
      projectId: 9999,
      name: "x",
      style: "list",
      filters: [],
      columns: [],
      groupBy: "",
      personal: false,
      actorUserId: adminId,
    });
    expect(result).toEqual({ ok: false, errors: { project: ["does not exist"] } });
  });
});

describe("MakeFavoriteTab / RemoveFavoriteTab", () => {
  it("promotes a team favorite to a tab and emits FavoritePromotedToTab", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    mustOk(makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId }), "tab");
    expect(reload(saved.id)!.tabView).toBe(true);
    expect(lastEvent()!.type).toBe("FavoritePromotedToTab");
    expect(listFavorites(db, projectId, memberId).tabs.map((f) => f.id)).toEqual([saved.id]);
  });

  it("demotes a tab back to a team favorite and emits FavoriteDemotedFromTab", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    mustOk(makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId }), "tab");
    mustOk(removeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId }), "untab");
    expect(reload(saved.id)!.tabView).toBe(false);
    expect(lastEvent()!.type).toBe("FavoriteDemotedFromTab");
  });

  it("rejects a full team member (project admin required) with no change", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    const result = makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: memberId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["authorization"]);
    expect(reload(saved.id)!.tabView).toBe(false);
  });

  it("rejects promoting a personal favorite", () => {
    const saved = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Mine",
        style: "list",
        filters: [],
        columns: [],
        groupBy: "",
        personal: true,
        actorUserId: adminId,
      }),
      "personal",
    );
    const result = makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId });
    expect(result).toEqual({
      ok: false,
      errors: { favorite: ["is a personal favorite and cannot be a tab"] },
    });
    expect(reload(saved.id)!.tabView).toBe(false);
  });

  it("rejects promoting an existing tab and demoting a non-tab", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    expect(removeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId })).toEqual({
      ok: false,
      errors: { favorite: ["is not a tab"] },
    });
    mustOk(makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId }), "tab");
    expect(makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId })).toEqual({
      ok: false,
      errors: { favorite: ["is already a tab"] },
    });
  });

  it("rejects an unknown favorite", () => {
    expect(makeFavoriteTab(db, { projectId, favoriteId: 424242, actorUserId: adminId })).toEqual({
      ok: false,
      errors: { favorite: ["does not exist"] },
    });
  });

  it("rejects an unknown project for both tab commands", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    const input = { projectId: 9999, favoriteId: saved.id, actorUserId: adminId };
    const expected = { ok: false, errors: { project: ["does not exist"] } };
    expect(makeFavoriteTab(db, input)).toEqual(expected);
    expect(removeFavoriteTab(db, input)).toEqual(expected);
    expect(reload(saved.id)!.tabView).toBe(false);
  });
});

describe("DeleteFavorite", () => {
  it("removes a team favorite for a full team member and emits FavoriteDeleted", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    mustOk(deleteFavorite(db, { projectId, favoriteId: saved.id, actorUserId: memberId }), "delete");
    expect(reload(saved.id)).toBeUndefined();
    const event = lastEvent()!;
    expect(event.type).toBe("FavoriteDeleted");
    expect(event.aggregateId).toBe(saved.id);
    expect(JSON.parse(event.payload)).toMatchObject({ name: "Open work", personal: false, wasTab: false });
  });

  it("requires a project admin to delete a tab", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    mustOk(makeFavoriteTab(db, { projectId, favoriteId: saved.id, actorUserId: adminId }), "tab");
    const denied = deleteFavorite(db, { projectId, favoriteId: saved.id, actorUserId: memberId });
    expect(denied.ok).toBe(false);
    expect(reload(saved.id)).toBeDefined();
    mustOk(deleteFavorite(db, { projectId, favoriteId: saved.id, actorUserId: adminId }), "admin delete");
    expect(reload(saved.id)).toBeUndefined();
    expect(JSON.parse(lastEvent()!.payload).wasTab).toBe(true);
  });

  it("lets only the owner delete a personal favorite", () => {
    const saved = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Mine",
        style: "list",
        filters: [],
        columns: [],
        groupBy: "",
        personal: true,
        actorUserId: memberId,
      }),
      "personal",
    );
    const denied = deleteFavorite(db, { projectId, favoriteId: saved.id, actorUserId: adminId });
    expect(denied).toEqual({
      ok: false,
      errors: { authorization: ["only the owner may delete a personal favorite"] },
    });
    expect(reload(saved.id)).toBeDefined();
    mustOk(deleteFavorite(db, { projectId, favoriteId: saved.id, actorUserId: memberId }), "owner delete");
    expect(reload(saved.id)).toBeUndefined();
  });

  it("rejects a readonly member and an unknown favorite", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    const denied = deleteFavorite(db, { projectId, favoriteId: saved.id, actorUserId: readonlyId });
    expect(denied.ok).toBe(false);
    expect(reload(saved.id)).toBeDefined();
    expect(deleteFavorite(db, { projectId, favoriteId: 424242, actorUserId: adminId })).toEqual({
      ok: false,
      errors: { favorite: ["does not exist"] },
    });
  });

  it("rejects an unknown project and leaves the favorite in place", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    expect(deleteFavorite(db, { projectId: 9999, favoriteId: saved.id, actorUserId: adminId })).toEqual({
      ok: false,
      errors: { project: ["does not exist"] },
    });
    expect(reload(saved.id)).toBeDefined();
  });
});

describe("reopening a favorite (exit criterion)", () => {
  it("rebuilds the same list filter and column state from the persisted row", () => {
    const saved = mustOk(saveTeamList("Open work"), "save");
    const live = buildCardListView(db, projectId, [statusOpen], ["Status", "Estimate"]);

    const params = favoriteViewParams(reload(saved.id)!);
    const reopened = buildCardListView(db, projectId, params.filters, params.columns);

    expect(reopened.errors).toEqual([]);
    expect(reopened.filters).toEqual(live.filters);
    expect(reopened.columns.map((c) => c.name)).toEqual(["Status", "Estimate"]);
    expect(queryCardList(db, projectId, reopened.filters).map((c) => c.number)).toEqual([openCard]);
  });

  it("rebuilds the same lane state from a persisted grid favorite", () => {
    const saved = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Wall",
        style: "grid",
        filters: [encodeFilterString("Status", "is not", "New")],
        columns: [],
        groupBy: "Status",
        personal: false,
        actorUserId: memberId,
      }),
      "save grid",
    );
    const params = favoriteViewParams(reload(saved.id)!);
    const reopened = buildGridView(db, projectId, params.groupBy, params.filters);

    expect(reopened.errors).toEqual([]);
    expect(reopened.groupBy?.name).toBe("Status");
    expect(
      Object.fromEntries(reopened.lanes.map((l) => [l.title, l.cards.map((c) => c.number)])),
    ).toEqual({ "(not set)": [], New: [], Open: [openCard], Closed: [closedCard] });
  });

  it("builds the canonical reopen URL from the stored parameters", () => {
    const list = mustOk(saveTeamList("Open work"), "list");
    const listUrl = new URL(favoriteHref("favs", reload(list.id)!), "http://x");
    expect(listUrl.pathname).toBe("/projects/favs/cards");
    expect(listUrl.searchParams.getAll("filters[]")).toEqual([statusOpen]);
    expect(listUrl.searchParams.get("columns")).toBe("Status,Estimate");
    expect(listUrl.searchParams.get("favorite_id")).toBe(String(list.id));

    const grid = mustOk(
      saveFavorite(db, {
        projectId,
        name: "Wall",
        style: "grid",
        filters: [],
        columns: [],
        groupBy: "Status",
        personal: false,
        actorUserId: memberId,
      }),
      "grid",
    );
    const gridUrl = new URL(favoriteHref("favs", reload(grid.id)!), "http://x");
    expect(gridUrl.pathname).toBe("/projects/favs/cards/grid");
    expect(gridUrl.searchParams.get("group_by")).toBe("Status");
    expect(gridUrl.searchParams.has("columns")).toBe(false);
  });

  it("lists tabs, team favorites, and only the viewer's personal favorites, by name", () => {
    const b = mustOk(saveTeamList("beta"), "b");
    mustOk(saveTeamList("Alpha"), "a");
    mustOk(makeFavoriteTab(db, { projectId, favoriteId: b.id, actorUserId: adminId }), "tab");
    const personal = (name: string, actorUserId: number) =>
      mustOk(
        saveFavorite(db, { projectId, name, style: "list", filters: [], columns: [], groupBy: "", personal: true, actorUserId }),
        name,
      );
    personal("mine", memberId);
    personal("theirs", adminId);

    const seen = listFavorites(db, projectId, memberId);
    expect(seen.tabs.map((f) => f.name)).toEqual(["beta"]);
    expect(seen.team.map((f) => f.name)).toEqual(["Alpha"]);
    expect(seen.personal.map((f) => f.name)).toEqual(["mine"]);
  });
});
