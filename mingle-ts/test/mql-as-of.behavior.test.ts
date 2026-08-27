/**
 * REAL-PATH behavioral tests for MQL `AS OF` — the historical card
 * source added in Phase 18.
 *
 * Every test runs against a real, file-backed SQLite database created
 * with the real generated migrations and seeded through the real domain
 * commands, so the `card_versions` rows under test are the ones the
 * production write path actually appends. Nothing here hand-builds a
 * snapshot or stubs the query (rule 13a).
 *
 * The ONE thing the seed does that a user would not: it backdates the
 * version rows a command just wrote. There is no clock seam in this
 * codebase and a multi-day history cannot otherwise exist inside a test
 * run. The domain still wrote every row; the seed only moves them in
 * time, once, before any assertion runs.
 *
 * Owner context: Query verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import {
  createCard,
  defineCardType,
  deleteCard,
  updateCard,
} from "../app/domain/cards/commands.server";
import {
  definePropertyDefinition,
  setCardPropertyValue,
} from "../app/domain/cards/properties.server";
import { parseProjectMql } from "../app/domain/cards/mql-schema.server";
import { queryMqlProjection } from "../app/domain/cards/mql-projection.server";
import { queryCardsByMql } from "../app/domain/cards/mql-evaluator.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-as-of-"));
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let devId: number;
let projectId: number;
let storyTypeId: number;
let bugTypeId: number;
const propertyIds: Record<string, number> = {};
const cardNumbers: Record<string, number> = {};

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

/**
 * Runs seed commands and backdates every card version they wrote to
 * noon UTC on the given day — see this file's header for why.
 */
function at(day: string, seed: () => void): void {
  const before = (
    sqlite.prepare("select coalesce(max(id), 0) as m from card_versions").get() as { m: number }
  ).m;
  seed();
  sqlite
    .prepare("update card_versions set created_at = ? where id > ?")
    .run(Date.parse(`${day}T12:00:00.000Z`), before);
}

/** Creates a card and sets the given properties, returning its number. */
function card(name: string, cardTypeId: number, values: Record<string, string>): number {
  const number = mustOk(
    createCard(db, { projectId, name, cardTypeId, actorUserId: devId }),
    name,
  ).number;
  cardNumbers[name] = number;
  for (const [key, value] of Object.entries(values)) {
    mustOk(
      setCardPropertyValue(db, {
        projectId,
        cardNumber: number,
        propertyDefinitionId: propertyIds[key],
        value,
        actorUserId: devId,
      }),
      `${name}.${key}`,
    );
  }
  return number;
}

/** Sets one property on an existing card. */
function set(name: string, key: string, value: string): void {
  mustOk(
    setCardPropertyValue(db, {
      projectId,
      cardNumber: cardNumbers[name],
      propertyDefinitionId: propertyIds[key],
      value,
      actorUserId: devId,
    }),
    `${name}.${key}`,
  );
}

/** Runs one MQL query and returns the first cell, as a number. */
function count(mql: string): number {
  const parsed = parseProjectMql(db, projectId, mql);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.errors.join(" ")}`);
  const projection = queryMqlProjection(db, projectId, parsed.query, {
    currentUserId: devId,
    today: "2026-03-05",
  });
  return Number(projection.rows[0]?.cells[0] ?? 0);
}

/** Runs one MQL query and returns every first-column cell. */
function cells(mql: string): string[] {
  const parsed = parseProjectMql(db, projectId, mql);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.errors.join(" ")}`);
  return queryMqlProjection(db, projectId, parsed.query, {
    currentUserId: devId,
    today: "2026-03-05",
  }).rows.map((row) => row.cells[0]);
}

beforeAll(() => {
  adminId = mustOk(
    registerUser(db, { login: "boss", name: "BOSS", password: "as-of-history-2010!" }),
    "admin",
  ).id;
  devId = mustOk(
    registerUser(db, { login: "dev", name: "DEV", password: "as-of-history-2010!" }),
    "dev",
  ).id;
  projectId = mustOk(
    createProject(db, { name: "History", identifier: "history", actorUserId: adminId }),
    "project",
  ).id;
  mustOk(
    addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }),
    "membership",
  );

  storyTypeId = mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story").id;
  bugTypeId = mustOk(defineCardType(db, { projectId, name: "Bug", actorUserId: adminId }), "Bug").id;

  propertyIds.status = mustOk(
    definePropertyDefinition(db, {
      projectId,
      actorUserId: adminId,
      name: "Status",
      kind: "enumerated",
      values: ["open", "closed"],
    }),
    "Status",
  ).id;
  propertyIds.estimate = mustOk(
    definePropertyDefinition(db, {
      projectId,
      actorUserId: adminId,
      name: "Estimate",
      kind: "number",
    }),
    "Estimate",
  ).id;

  // A four-day history. Every expectation below is hand-computed from
  // this seed, not read back from the implementation.
  at("2026-03-01", () => {
    card("Login", storyTypeId, { status: "open", estimate: "2" });
    card("Search", storyTypeId, { status: "open", estimate: "5" });
    card("Crash", bugTypeId, { status: "open", estimate: "1" });
    card("Orphan", storyTypeId, {});
  });
  at("2026-03-02", () => {
    set("Login", "status", "closed");
  });
  at("2026-03-03", () => {
    set("Search", "status", "closed");
    card("Reports", storyTypeId, { status: "open", estimate: "8" });
  });
  at("2026-03-04", () => {
    mustOk(
      deleteCard(db, { projectId, cardNumber: cardNumbers.Crash, actorUserId: adminId }),
      "delete Crash",
    );
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: cardNumbers.Login,
        name: "Login page",
        cardTypeId: storyTypeId,
        actorUserId: devId,
      }),
      "rename Login",
    );
  });
});

describe("AS OF reconstructs the state of a day", () => {
  it("counts open stories per day as the property changes move cards between them", () => {
    const perDay = (day: string) =>
      count(`SELECT COUNT(*) AS OF '${day}' WHERE type = Story AND status = open`);
    // 03-01 Login+Search open; 03-02 Login closed; 03-03 Search closed
    // but Reports created open; 03-04 unchanged.
    expect([
      perDay("2026-03-01"),
      perDay("2026-03-02"),
      perDay("2026-03-03"),
      perDay("2026-03-04"),
    ]).toEqual([2, 1, 1, 1]);
  });

  it("returns nothing for a date before the first card existed", () => {
    expect(count("SELECT COUNT(*) AS OF '2026-02-28'")).toBe(0);
  });

  it("excludes a card created after the as-of date", () => {
    // Reports was created on 03-03.
    expect(count("SELECT COUNT(*) AS OF '2026-03-02'")).toBe(4);
    expect(count("SELECT COUNT(*) AS OF '2026-03-03'")).toBe(5);
  });

  it("keeps a deleted card in the days it was alive and drops it after", () => {
    const bugs = (day: string) => count(`SELECT COUNT(*) AS OF '${day}' WHERE type = Bug`);
    expect([bugs("2026-03-03"), bugs("2026-03-04")]).toEqual([1, 0]);
  });

  it("aggregates a numeric property over the state of each day", () => {
    const total = (day: string) =>
      count(`SELECT SUM(estimate) AS OF '${day}' WHERE status = open`);
    // 03-01 2+5+1; 03-02 5+1; 03-03 1+8; 03-04 Crash deleted, 8 left.
    expect([
      total("2026-03-01"),
      total("2026-03-02"),
      total("2026-03-03"),
      total("2026-03-04"),
    ]).toEqual([8, 6, 9, 8]);
  });
});

describe("AS OF applies the same unset semantics the live filters do", () => {
  it("matches an unset property with != , as a live query does", () => {
    // As of 03-02: Search and Crash are open, Orphan has no Status at
    // all — and an unset property is not 'closed'.
    expect(count("SELECT COUNT(*) AS OF '2026-03-02' WHERE status != closed")).toBe(3);
  });

  it("matches an unset property with = NULL and not with != NULL", () => {
    expect(count("SELECT COUNT(*) AS OF '2026-03-02' WHERE status = NULL")).toBe(1);
    expect(count("SELECT COUNT(*) AS OF '2026-03-02' WHERE status != NULL")).toBe(3);
  });

  it("refuses a second AS OF inside a nested IN, rather than ignoring it", () => {
    const parsed = parseProjectMql(
      db,
      projectId,
      "SELECT COUNT(*) AS OF '2026-03-02' WHERE estimate IN (SELECT estimate AS OF '2026-03-01' WHERE status = closed)",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join(" "));
    expect(() =>
      queryMqlProjection(db, projectId, parsed.query, { currentUserId: devId, today: "2026-03-05" }),
    ).toThrow("AS OF is not allowed in a nested IN clause.");
  });

  it("reads a nested IN (SELECT …) as of the SAME day, not today", () => {
    const q = (day: string) =>
      count(`SELECT COUNT(*) AS OF '${day}' WHERE estimate IN (SELECT estimate WHERE status = closed)`);
    // Nothing was closed on 03-01, so the inner query is empty; on
    // 03-02 Login is closed with estimate 2, which only Login has.
    expect([q("2026-03-01"), q("2026-03-02")]).toEqual([0, 1]);
  });
});

describe("AS OF reads the card's own columns from the snapshot", () => {
  it("shows the name the card had that day, not the name it has now", () => {
    expect(cells(`SELECT name AS OF '2026-03-03' WHERE number = ${cardNumbers.Login}`)).toEqual(["Login"]);
    expect(cells(`SELECT name AS OF '2026-03-04' WHERE number = ${cardNumbers.Login}`)).toEqual(["Login page"]);
  });

  it("reads Modified On from the version that day, and Created On from the card's first", () => {
    expect(
      cells(`SELECT 'modified on' AS OF '2026-03-02' WHERE number = ${cardNumbers.Login}`),
    ).toEqual(["2026-03-02"]);
    expect(
      cells(`SELECT 'created on' AS OF '2026-03-04' WHERE number = ${cardNumbers.Login}`),
    ).toEqual(["2026-03-01"]);
  });

  it("groups by the type name the version snapshotted", () => {
    const parsed = parseProjectMql(
      db,
      projectId,
      "SELECT type, COUNT(*) AS OF '2026-03-03' GROUP BY type",
    );
    if (!parsed.ok) throw new Error(parsed.errors.join(" "));
    const rows = queryMqlProjection(db, projectId, parsed.query, {
      currentUserId: devId,
      today: "2026-03-05",
    }).rows.map((row) => row.cells);
    expect(rows.sort()).toEqual([
      ["Bug", "1"],
      ["Story", "4"],
    ]);
  });

  it("queryCardsByMql answers with that day's rows", () => {
    const parsed = parseProjectMql(db, projectId, "AS OF '2026-03-01' WHERE status = open");
    if (!parsed.ok) throw new Error(parsed.errors.join(" "));
    const names = queryCardsByMql(db, projectId, parsed.query, {
      currentUserId: devId,
      today: "2026-03-05",
    })
      .map((row) => row.name)
      .sort();
    expect(names).toEqual(["Crash", "Login", "Search"]);
  });
});

describe("a query without AS OF still reads the live cards", () => {
  it("answers about today, not about any snapshot", () => {
    expect(count("SELECT COUNT(*) WHERE type = Story AND status = open")).toBe(1);
    expect(count("SELECT COUNT(*)")).toBe(4);
    expect(cells(`SELECT name WHERE number = ${cardNumbers.Login}`)).toEqual(["Login page"]);
  });
});
