/**
 * Behavioral tests for card import (Phase 29).
 *
 * Derived line-by-line from the rule 12 Behavior Statement for
 * `importCards` and the contract of `previewCardImport` /
 * `parseDelimited`: every DOES asserts on cards, their property
 * values, their version trails and the events reloaded from the
 * database, and every REJECTS WHEN proves nothing was written.
 * Includes the phase's exit criterion: importing a 5-row CSV creates 5
 * cards with correctly mapped property values, verified against the
 * DB; a malformed row is rejected with a specific error identifying
 * the row, not a silent skip.
 *
 * The route section drives the real import route with a Request
 * carrying a real session cookie, including a multipart file upload.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: Import/Export verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-card-import-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "card-import-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const importRoute = await import("../app/routes/projects.cards.import");

const { cards, cardVersions } = await import("../app/db/schema/cards");
const { cardPropertyValues } = await import("../app/db/schema/properties");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, defineCardType, deleteCard } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition, setCardPropertyValue } = await import("../app/domain/cards/properties.server");
const { parseDelimited } = await import("../app/domain/import-export/delimited.server");
const { formatColumnTarget, parseColumnTarget } = await import("../app/shared/wire-types");
const { importCards, previewCardImport, suggestMappings } = await import(
  "../app/domain/import-export/card-import.server"
);

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
function register(login: string): number {
  return mustOk(registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "import-29!" }), login).id;
}

const adminId = register("admin"); // site admin
const memberId = register("member"); // full team member
const outsiderId = register("outsider");

const project = mustOk(createProject(db, { name: "Import Target", identifier: "target", actorUserId: adminId }), "project");
mustOk(addTeamMember(db, { projectId: project.id, userId: memberId, actorUserId: adminId }), "member");
const a = { projectId: project.id, actorUserId: adminId };
const storyType = mustOk(defineCardType(db, { ...a, name: "Story" }), "Story");
const status = mustOk(definePropertyDefinition(db, { ...a, name: "Status", kind: "enumerated", values: ["New", "Done"] }), "Status");
const stage = mustOk(definePropertyDefinition(db, { ...a, name: "Stage", kind: "enumerated", values: ["Dev", "QA"], transitionOnly: true }), "Stage");
const estimate = mustOk(definePropertyDefinition(db, { ...a, name: "Estimate", kind: "number" }), "Estimate");
const owner = mustOk(definePropertyDefinition(db, { ...a, name: "Owner", kind: "user" }), "Owner");
const due = mustOk(definePropertyDefinition(db, { ...a, name: "Due", kind: "date" }), "Due");
const notes = mustOk(definePropertyDefinition(db, { ...a, name: "Notes", kind: "text" }), "Notes");
mustOk(definePropertyDefinition(db, { ...a, name: "Double", kind: "formula", formula: "Estimate * 2" }), "Double");
const existing = mustOk(createCard(db, { projectId: project.id, name: "Existing", cardTypeId: storyType.id, actorUserId: memberId }), "existing");
mustOk(setCardPropertyValue(db, { projectId: project.id, cardNumber: existing.number, propertyDefinitionId: status.id, value: "New", actorUserId: memberId }), "status");

function reload(number: number) {
  return db.select().from(cards).where(and(eq(cards.projectId, project.id), eq(cards.number, number))).get();
}
function valuesOf(number: number): Record<string, string> {
  const card = reload(number)!;
  const rows = db.select().from(cardPropertyValues).where(eq(cardPropertyValues.cardId, card.id)).all();
  const names = new Map([[status.id, "Status"], [stage.id, "Stage"], [estimate.id, "Estimate"], [owner.id, "Owner"], [due.id, "Due"], [notes.id, "Notes"]]);
  return Object.fromEntries(rows.filter((r) => names.has(r.propertyDefinitionId)).map((r) => [names.get(r.propertyDefinitionId)!, r.value]));
}
function versionsOf(number: number): number[] {
  return db.select({ v: cardVersions.version }).from(cardVersions).where(and(eq(cardVersions.projectId, project.id), eq(cardVersions.number, number))).orderBy(asc(cardVersions.version)).all().map((r) => r.v);
}
function cardNumbers(): number[] {
  return db.select({ n: cards.number }).from(cards).where(eq(cards.projectId, project.id)).orderBy(asc(cards.number)).all().map((r) => r.n);
}
function eventsOfType(type: string) {
  return db.select({ payload: domainEvents.payload }).from(domainEvents).where(eq(domainEvents.type, type)).orderBy(asc(domainEvents.id)).all().map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}
function eventCount(): number {
  return db.select({ id: domainEvents.id }).from(domainEvents).all().length;
}

const FIVE_ROWS = [
  "Number,Name,Type,Status,Estimate,Owner,Due,Notes,Description",
  '10,Login page,Story,New,3,member,2026-09-01,"Needs ""SSO"", later",First description',
  "11,Signup page,Story,Done,5,member,2026-09-02,plain,",
  "12,Password reset,Card,New,,,2026-09-03,-,",
  "#13,Profile,Story,,8,,,,Has a description",
  "14,Settings,story,done,1,member,,\"multi\nline\",",
].join("\n");

describe("parseDelimited", () => {
  it("detects tabs, honors quotes with doubled quotes and embedded newlines, drops blank lines, pads short rows", () => {
    expect(parseDelimited("a\tb\n1\t2\n\n3\n")).toEqual({ delimiter: "\t", header: ["a", "b"], rows: [["1", "2"], ["3", ""]] });
    expect(parseDelimited('﻿a,b\n"x, ""y""","1\n2"')).toEqual({ delimiter: ",", header: ["a", "b"], rows: [['x, "y"', "1\n2"]] });
    expect(parseDelimited("")).toEqual({ delimiter: ",", header: [], rows: [] });
  });
});

describe("mapping", () => {
  it("suggests standard columns and settable properties by name, ignores the rest, and round-trips the form encoding", () => {
    const suggested = suggestMappings(db, project.id, ["#", "name", "Card Type", "status", "Double", "Points", "Stage"]);
    expect(suggested).toEqual([
      { kind: "number" },
      { kind: "name" },
      { kind: "type" },
      { kind: "property", propertyDefinitionId: status.id },
      { kind: "ignore" }, // formula: not settable
      { kind: "ignore" },
      { kind: "property", propertyDefinitionId: stage.id },
    ]);
    for (const target of suggested) expect(parseColumnTarget(formatColumnTarget(target))).toEqual(target);
    expect(parseColumnTarget("bogus")).toBeNull();
  });
});

describe("previewCardImport", () => {
  it("resolves every row as the import will — creates, an update, and row errors with their messages — without writing", () => {
    const before = cardNumbers();
    const text = [
      "Number,Name,Type,Status,Points",
      "1,Existing renamed,,Done,2",
      ",Brand new,Story,New,",
      "x,Bad number,,,",
      "50,Bad type,Epic,,",
      "51,Bad value,,Bogus,",
      "52,,Story,,",
      "1,Twice,,,",
    ].join("\n");
    const preview = mustOk(
      previewCardImport(db, { projectId: project.id, text, mapping: [{ kind: "number" }, { kind: "name" }, { kind: "type" }, { kind: "property", propertyDefinitionId: status.id }, { kind: "property", propertyDefinitionId: estimate.id }], actorUserId: memberId }),
      "preview",
    );
    expect(preview.header).toEqual(["Number", "Name", "Type", "Status", "Points"]);
    expect({ creates: preview.creates, updates: preview.updates, errorCount: preview.errorCount }).toEqual({ creates: 1, updates: 1, errorCount: 5 });
    expect(preview.rows.map((r) => [r.row, r.action, r.number, r.name, r.cardType])).toEqual([
      [2, "update", 1, "Existing renamed", "Story"],
      [3, "create", null, "Brand new", "Story"],
      [4, "error", null, "Bad number", "Card"],
      [5, "error", 50, "Bad type", null],
      [6, "error", 51, "Bad value", "Card"],
      [7, "error", 52, null, "Story"],
      [8, "error", 1, "Twice", "Story"],
    ]);
    expect(preview.rows[0].values).toEqual([{ property: "Status", value: "Done" }, { property: "Estimate", value: "2" }]);
    expect(preview.rows[2].errors).toEqual(['Number "x" is not a valid card number']);
    expect(preview.rows[3].errors).toEqual(['Card type "Epic" does not exist']);
    expect(preview.rows[4].errors).toEqual([expect.stringContaining("Status")]);
    expect(preview.rows[5].errors).toEqual(["Name can't be blank"]);
    expect(preview.rows[6].errors).toEqual(["Number 1 appears more than once"]);
    expect(cardNumbers()).toEqual(before);
    expect(reload(1)).toMatchObject({ name: "Existing", version: 2 });
  });

  it("rejects an outsider, empty text, a header without rows, and an unusable mapping", () => {
    expect(mustReject(previewCardImport(db, { projectId: project.id, text: FIVE_ROWS, actorUserId: outsiderId }), "outsider").authorization).toBeDefined();
    expect(mustReject(previewCardImport(db, { projectId: project.id, text: "  ", actorUserId: memberId }), "empty").text).toEqual(["has no header row"]);
    expect(mustReject(previewCardImport(db, { projectId: project.id, text: "Name,Status\n", actorUserId: memberId }), "no rows").text).toEqual(["has no card rows"]);
    expect(mustReject(previewCardImport(db, { projectId: project.id, text: "A,B\n1,2", mapping: [{ kind: "name" }, { kind: "name" }], actorUserId: memberId }), "two names").mapping).toEqual([
      "more than one column is mapped as name",
    ]);
    expect(mustReject(previewCardImport(db, { projectId: project.id, text: "A,B\n1,2", mapping: [{ kind: "name" }], actorUserId: memberId }), "short").mapping).toEqual(["must name a target for every column"]);
    expect(mustReject(previewCardImport(db, { projectId: project.id, text: "A,B\n1,2", mapping: [{ kind: "name" }, { kind: "property", propertyDefinitionId: 9999 }], actorUserId: memberId }), "bad prop").mapping).toEqual([
      '"B" is mapped to a property that cannot be imported',
    ]);
  });
});

describe("importCards", () => {
  it("Phase 29 exit criterion: a 5-row CSV creates 5 cards with their mapped values, keeping the file's numbers, in one version each plus creation", () => {
    const events = eventCount();
    const outcome = mustOk(importCards(db, { projectId: project.id, text: FIVE_ROWS, actorUserId: memberId }), "import");
    expect(outcome).toEqual({ created: [10, 11, 12, 13, 14], updated: [] });
    expect(cardNumbers()).toEqual([1, 10, 11, 12, 13, 14]);
    expect(reload(10)).toMatchObject({ name: "Login page", cardTypeId: storyType.id, description: "First description", version: 2, createdByUserId: memberId });
    expect(valuesOf(10)).toEqual({ Status: "New", Estimate: "3", Owner: String(memberId), Due: "2026-09-01", Notes: 'Needs "SSO", later' });
    expect(valuesOf(11)).toEqual({ Status: "Done", Estimate: "5", Owner: String(memberId), Due: "2026-09-02", Notes: "plain" });
    expect(reload(12)!.cardTypeId).not.toBe(storyType.id); // "Card"
    expect(valuesOf(12)).toEqual({ Status: "New", Due: "2026-09-03" }); // "-" means no value for Notes
    expect(reload(13)).toMatchObject({ name: "Profile", description: "Has a description" });
    expect(valuesOf(13)).toEqual({ Estimate: "8" });
    expect(valuesOf(14)).toEqual({ Status: "Done", Estimate: "1", Owner: String(memberId), Notes: "multi\nline" }); // type and value matched case-insensitively
    expect(versionsOf(10)).toEqual([1, 2]);
    expect(eventsOfType("CardsImported").at(-1)).toEqual({ created: [10, 11, 12, 13, 14], updated: [] });
    expect(eventCount()).toBeGreaterThan(events);
    // The number sequence continues past the imported numbers.
    const next = mustOk(createCard(db, { projectId: project.id, name: "After import", cardTypeId: storyType.id, actorUserId: memberId }), "next");
    expect(next.number).toBe(15);
  });

  it("updates an existing card by number — name, type and changed values only — and creates a numberless row with the next number", () => {
    const text = ["Number,Name,Status,Estimate,Notes", "1,Existing renamed,Done,4,", ",No number,New,,note"].join("\n");
    const outcome = mustOk(importCards(db, { projectId: project.id, text, actorUserId: memberId }), "update");
    expect(outcome).toEqual({ created: [16], updated: [1] });
    expect(reload(1)).toMatchObject({ name: "Existing renamed", version: 4 }); // v3 rename, v4 values
    expect(valuesOf(1)).toEqual({ Status: "Done", Estimate: "4" });
    expect(valuesOf(16)).toEqual({ Status: "New", Notes: "note" });
    // Re-importing the same row changes nothing: no rename, no value change, no new version.
    mustOk(importCards(db, { projectId: project.id, text: "Number,Name,Status\n1,Existing renamed,Done", actorUserId: memberId }), "same");
    expect(reload(1)!.version).toBe(4);
    // A blank cell clears a set value on an update.
    mustOk(importCards(db, { projectId: project.id, text: "Number,Estimate\n1,", actorUserId: memberId }), "clear");
    expect(valuesOf(1)).toEqual({ Status: "Done" });
    expect(reload(1)!.version).toBe(5);
  });

  it("rejects the whole file when any row has an error, naming the row, writing nothing", () => {
    const before = cardNumbers();
    const events = eventCount();
    const text = ["Number,Name,Status", "20,Fine,New", "21,Broken,Bogus", "22,Also fine,Done"].join("\n");
    const errors = mustReject(importCards(db, { projectId: project.id, text, actorUserId: memberId }), "bad row");
    expect(errors.rows).toEqual([expect.stringMatching(/^Row 3: Status/)]);
    expect(cardNumbers()).toEqual(before);
    expect(eventCount()).toBe(events);
    const taken = mustReject(importCards(db, { projectId: project.id, text: "Number,Name,Type\n30,Epic,Epic", actorUserId: memberId }), "type");
    expect(taken.rows).toEqual(['Row 2: Card type "Epic" does not exist']);
  });

  it("preview and import agree on an over-long name and on a deleted card's number (never reused)", () => {
    const gone = mustOk(createCard(db, { projectId: project.id, name: "Doomed", cardTypeId: storyType.id, actorUserId: memberId }), "doomed");
    mustOk(deleteCard(db, { projectId: project.id, cardNumber: gone.number, actorUserId: adminId }), "delete");
    const text = ["Number,Name", `${gone.number},Reborn`, `70,${"x".repeat(256)}`].join("\n");
    const preview = mustOk(previewCardImport(db, { projectId: project.id, text, actorUserId: memberId }), "preview");
    expect(preview.rows.map((r) => r.errors)).toEqual([
      [`Number ${gone.number} belongs to a deleted card and cannot be reused`],
      ["Name is too long (maximum is 255 characters)"],
    ]);
    const before = cardNumbers();
    expect(mustReject(importCards(db, { projectId: project.id, text, actorUserId: memberId }), "import").rows).toEqual([
      `Row 2: Number ${gone.number} belongs to a deleted card and cannot be reused`,
      "Row 3: Name is too long (maximum is 255 characters)",
    ]);
    expect(cardNumbers()).toEqual(before);
  });

  it("refuses a transition-only value from a team member and accepts it from a project admin", () => {
    const text = "Number,Name,Stage\n40,Staged,QA";
    expect(mustReject(importCards(db, { projectId: project.id, text, actorUserId: memberId }), "member").rows).toEqual(["Row 2: Stage: is a transition only property."]);
    expect(reload(40)).toBeUndefined();
    mustOk(importCards(db, { projectId: project.id, text, actorUserId: adminId }), "admin");
    expect(valuesOf(40)).toEqual({ Stage: "QA" });
  });
});

describe("card import route (real route module)", () => {
  async function cookieFor(userId: number): Promise<string> {
    return (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
  }
  async function call(fn: (args: never) => Promise<unknown>, userId: number, body?: FormData | URLSearchParams) {
    const headers: Record<string, string> = { Cookie: await cookieFor(userId) };
    if (body instanceof URLSearchParams) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const request = new Request("http://localhost/projects/target/cards/import", { method: body ? "POST" : "GET", headers, body });
    try {
      const result = (await fn({ request, params: { identifier: "target" }, context: {} } as never)) as { data?: unknown; init?: { status?: number } | null };
      return { status: result?.init?.status ?? 200, location: null as string | null, data: result?.init === undefined ? result : result.data };
    } catch (thrown) {
      if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location"), data: null };
      throw thrown;
    }
  }
  interface PreviewData {
    ok: true;
    preview: { creates: number; updates: number; errorCount: number; rows: { row: number; action: string }[] };
    mapping: string[];
  }

  it("loads role-aware, previews with a posted mapping override, imports an uploaded file, and reports errors", async () => {
    expect((await call(importRoute.loader, memberId)).data).toMatchObject({ canImport: true, project: { identifier: "target" } });
    expect((await call(importRoute.loader, outsiderId)).data).toMatchObject({ canImport: false });

    const text = "Number,Name,Points\n60,Routed,7";
    const previewed = await call(importRoute.action, memberId, new URLSearchParams({ intent: "preview", text }));
    expect(previewed.status).toBe(200);
    expect((previewed.data as PreviewData).mapping).toEqual(["number", "name", "ignore"]);
    const remapped = await call(
      importRoute.action,
      memberId,
      new URLSearchParams({ intent: "preview", text, "mapping[0]": "number", "mapping[1]": "name", "mapping[2]": `property:${estimate.id}` }),
    );
    expect((remapped.data as PreviewData).preview).toMatchObject({ creates: 1, errorCount: 0 });
    expect((remapped.data as PreviewData).mapping).toEqual(["number", "name", `property:${estimate.id}`]);

    const upload = new FormData();
    upload.set("intent", "import");
    upload.set("file", new File([text], "cards.csv", { type: "text/csv" }));
    upload.set("mapping[0]", "number");
    upload.set("mapping[1]", "name");
    upload.set("mapping[2]", `property:${estimate.id}`);
    const imported = await call(importRoute.action, memberId, upload);
    expect(imported).toMatchObject({ status: 302, location: "/projects/target/cards?imported=1" });
    expect(valuesOf(60)).toEqual({ Estimate: "7" });

    const bad = await call(importRoute.action, memberId, new URLSearchParams({ intent: "import", text: "Number,Name,Status\n61,Bad,Bogus" }));
    expect(bad.status).toBe(400);
    expect((bad.data as { errors: Record<string, string[]> }).errors.rows).toEqual([expect.stringMatching(/^Row 2: Status/)]);
    const empty = await call(importRoute.action, memberId, new URLSearchParams({ intent: "preview", text: "" }));
    expect(empty.status).toBe(400);
  });
});
