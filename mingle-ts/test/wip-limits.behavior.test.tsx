/**
 * Behavioral tests for WIP limits on grid lanes (P-3, project templates
 * Phase 2).
 *
 * Derived from the rule 12 Behavior Statement for `setLaneWipLimit`
 * (app/domain/cards/favorites.server.ts): every DOES asserts on the
 * favorite row's `wip_limits` column and the emitted event as re-read
 * from the database; every REJECTS WHEN proves the column unchanged.
 * Also covers the re-save rule (a changed lane property drops the
 * limits), the grid route's loader and `wip` action, and the rendered
 * lane header (`n / limit`, `over-limit`).
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Card Management verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-wip-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "wip-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const gridRoute = await import("../app/routes/projects.cards.grid");
const { LaneHeader } = await import("../app/components/lane-header");
const { users } = await import("../app/db/schema/identity");
const { projects } = await import("../app/db/schema/projects");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardPropertyValues, propertyDefinitions } = await import("../app/db/schema/properties");
const { favorites } = await import("../app/db/schema/favorites");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { definePropertyDefinition, setCardPropertyValue } = await import("../app/domain/cards/properties.server");
const { saveFavorite, setLaneWipLimit, wipLimitsFor } = await import("../app/domain/cards/favorites.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let adminId: number;
let memberId: number;
let readerId: number;
let projectId: number;
let statusId: number;
let boardId: number; // the team grid favorite "Kanban Board", grouped by Status

const storedLimits = (favoriteId: number) =>
  JSON.parse(db.select({ wipLimits: favorites.wipLimits }).from(favorites).where(eq(favorites.id, favoriteId)).get()!.wipLimits);
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

function card(name: string, status: string | null) {
  const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
  const row = mustOk(createCard(db, { projectId, name, cardTypeId: typeId, actorUserId: memberId }), name);
  if (status) mustOk(setCardPropertyValue(db, { projectId, cardNumber: row.number, propertyDefinitionId: statusId, value: status, actorUserId: memberId }), `${name} status`);
  return row;
}

beforeEach(() => {
  for (const table of [domainEvents, favorites, cardPropertyValues, cardVersions, cards, propertyDefinitions, cardTypes, teamMemberships, projects, users])
    db.delete(table).run();
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "wip-1!" }), "admin").id;
  memberId = mustOk(registerUser(db, { login: "mem", name: "Member", password: "wip-1!" }), "mem").id;
  readerId = mustOk(registerUser(db, { login: "ro", name: "Reader", password: "wip-1!" }), "ro").id;
  projectId = mustOk(createProject(db, { name: "Kanban", identifier: "kb", actorUserId: adminId }), "project").id;
  mustOk(addTeamMember(db, { projectId, userId: memberId, role: "full_member", actorUserId: adminId }), "member");
  mustOk(addTeamMember(db, { projectId, userId: readerId, role: "readonly_member", actorUserId: adminId }), "reader");
  statusId = mustOk(
    definePropertyDefinition(db, { projectId, name: "Status", kind: "enumerated", values: ["Proposed", "In Progress", "Completed"], actorUserId: adminId }),
    "Status",
  ).id;
  mustOk(definePropertyDefinition(db, { projectId, name: "Owner", kind: "user", actorUserId: adminId }), "Owner");
  boardId = mustOk(
    saveFavorite(db, { projectId, name: "Kanban Board", style: "grid", filters: [], columns: [], groupBy: "Status", personal: false, actorUserId: memberId }),
    "board",
  ).id;
  db.delete(domainEvents).run();
});

describe("SetLaneWipLimit", () => {
  it("stores the lane's limit on the favorite row, keyed by the canonical lane value, and emits FavoriteWipLimitSet", () => {
    mustOk(setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "in progress", limit: 2, actorUserId: memberId }), "set");
    expect(storedLimits(boardId)).toEqual({ "In Progress": 2 });
    mustOk(setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "Proposed", limit: 5, actorUserId: adminId }), "set second");
    mustOk(setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "In Progress", limit: 3, actorUserId: memberId }), "raise");
    expect(storedLimits(boardId)).toEqual({ "In Progress": 3, Proposed: 5 });
    // Clearing removes the key; other lanes keep theirs.
    mustOk(setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "Proposed", limit: null, actorUserId: memberId }), "clear");
    expect(storedLimits(boardId)).toEqual({ "In Progress": 3 });
    expect(wipLimitsFor(db, projectId, boardId)).toEqual({ favoriteId: boardId, limits: { "In Progress": 3 } });
    expect(events("FavoriteWipLimitSet").map((event) => JSON.parse(String(event.payload)))).toEqual([
      { projectId, name: "Kanban Board", laneValue: "In Progress", limit: 2 },
      { projectId, name: "Kanban Board", laneValue: "Proposed", limit: 5 },
      { projectId, name: "Kanban Board", laneValue: "In Progress", limit: 3 },
      { projectId, name: "Kanban Board", laneValue: "Proposed", limit: null },
    ]);
  });

  it("rejects a readonly member, a personal or list favorite, the (not set) lane, an unknown lane value, and a bad limit — writing nothing", () => {
    const personalId = mustOk(
      saveFavorite(db, { projectId, name: "Mine", style: "grid", filters: [], columns: [], groupBy: "Status", personal: true, actorUserId: memberId }),
      "personal",
    ).id;
    const listId = mustOk(
      saveFavorite(db, { projectId, name: "List", style: "list", filters: [], columns: ["Status"], groupBy: "", personal: false, actorUserId: memberId }),
      "list",
    ).id;
    const ungroupedId = mustOk(
      saveFavorite(db, { projectId, name: "Ungrouped wall", style: "grid", filters: [], columns: [], groupBy: "", personal: false, actorUserId: memberId }),
      "ungrouped",
    ).id;
    const attempt = (over: Partial<Parameters<typeof setLaneWipLimit>[1]>) =>
      setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "In Progress", limit: 2, actorUserId: memberId, ...over });
    const cases: [Partial<Parameters<typeof setLaneWipLimit>[1]>, string, RegExp][] = [
      [{ actorUserId: readerId }, "authorization", /./],
      [{ favoriteId: personalId }, "favorite", /personal favorite/],
      [{ favoriteId: listId }, "favorite", /no lanes to limit/],
      [{ favoriteId: ungroupedId }, "favorite", /no lanes to limit/],
      [{ projectId: projectId + 999 }, "project", /does not exist/],
      [{ favoriteId: boardId + 999 }, "favorite", /does not exist/],
      [{ laneValue: "" }, "lane", /\(not set\) lane cannot carry a WIP limit/],
      [{ laneValue: "Done" }, "lane", /restricted to Proposed, In Progress, Completed/],
      [{ limit: 0 }, "limit", /positive whole number/],
      [{ limit: 2.5 }, "limit", /positive whole number/],
      [{ limit: Number.NaN }, "limit", /positive whole number/],
    ];
    for (const [over, field, message] of cases) {
      const result = attempt(over);
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(result.errors[field]?.join(" "), field).toMatch(message);
    }
    expect(storedLimits(boardId)).toEqual({});
    expect(storedLimits(personalId)).toEqual({});
    expect(storedLimits(listId)).toEqual({});
    expect(storedLimits(ungroupedId)).toEqual({});
    expect(wipLimitsFor(db, projectId, ungroupedId)).toBeNull();
    expect(events("FavoriteWipLimitSet")).toEqual([]);
    expect(wipLimitsFor(db, projectId, personalId)).toBeNull();
    expect(wipLimitsFor(db, projectId, listId)).toBeNull();
  });

  it("keeps the limits when the favorite is re-saved with the same lane property and drops them when the lane property changes", () => {
    mustOk(setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "In Progress", limit: 2, actorUserId: memberId }), "set");
    mustOk(
      saveFavorite(db, { projectId, name: "Kanban Board", style: "grid", filters: ["[Type][is][Card]"], columns: [], groupBy: "Status", personal: false, actorUserId: memberId }),
      "re-save same lanes",
    );
    expect(storedLimits(boardId)).toEqual({ "In Progress": 2 });
    mustOk(
      saveFavorite(db, { projectId, name: "Kanban Board", style: "grid", filters: [], columns: [], groupBy: "Owner", personal: false, actorUserId: memberId }),
      "re-save new lanes",
    );
    expect(storedLimits(boardId)).toEqual({});
  });
});

describe("the card wall", () => {
  it("shows a saved team grid favorite's limits, lets a full member set one through the wip action, and hides editing from a readonly member", async () => {
    card("A", "In Progress");
    card("B", "In Progress");
    card("C", "In Progress");
    card("D", "Proposed");
    mustOk(setLaneWipLimit(db, { projectId, favoriteId: boardId, laneValue: "In Progress", limit: 2, actorUserId: memberId }), "set");

    const cookieFor = async (userId: number) => (await createUserSession(userId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const url = `http://localhost/projects/kb/cards/grid?group_by=Status&favorite_id=${boardId}`;
    const load = async (userId: number, target = url) =>
      (await gridRoute.loader({ request: new Request(target, { headers: { Cookie: await cookieFor(userId) } }), params: { identifier: "kb" }, context: {} } as never)) as {
        wipFavoriteId: number | null;
        wipLimits: Record<string, number>;
        canEditWipLimits: boolean;
        lanes: { value: string; cards: unknown[] }[];
      };

    const asMember = await load(memberId);
    expect(asMember.wipFavoriteId).toBe(boardId);
    expect(asMember.wipLimits).toEqual({ "In Progress": 2 });
    expect(asMember.canEditWipLimits).toBe(true);
    expect(asMember.lanes.find((lane) => lane.value === "In Progress")?.cards).toHaveLength(3);
    const asReader = await load(readerId);
    expect(asReader.wipLimits).toEqual({ "In Progress": 2 });
    expect(asReader.canEditWipLimits).toBe(false);
    // No favorite in the URL: no limits, no editing.
    const bare = await load(memberId, "http://localhost/projects/kb/cards/grid?group_by=Status");
    expect(bare).toMatchObject({ wipFavoriteId: null, wipLimits: {}, canEditWipLimits: false });

    const post = async (userId: number, fields: Record<string, string>) => {
      const request = new Request(url, {
        method: "POST",
        headers: { Cookie: await cookieFor(userId), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "wip", favoriteId: String(boardId), ...fields }),
      });
      const result = (await gridRoute.action({ request, params: { identifier: "kb" }, context: {} } as never)) as
        | { ok: true }
        | { type: string; data: unknown; init: { status?: number } | null };
      // `data(body, { status })` returns a DataWithResponseInit, not a Response.
      return "type" in result ? { status: result.init?.status ?? 200, body: result.data } : { status: 200, body: result };
    };
    expect((await post(memberId, { laneValue: "Proposed", limit: "4" })).body).toEqual({ ok: true });
    expect(storedLimits(boardId)).toEqual({ "In Progress": 2, Proposed: 4 });
    const refused = await post(memberId, { laneValue: "Proposed", limit: "zero" });
    expect(refused.status).toBe(400);
    expect((refused.body as { errors: Record<string, string[]> }).errors.limit).toEqual(["must be a positive whole number"]);
    const denied = await post(readerId, { laneValue: "Proposed", limit: "1" });
    expect(denied.status).toBe(400);
    expect(Object.keys((denied.body as { errors: Record<string, string[]> }).errors)).toEqual(["authorization"]);
    expect(storedLimits(boardId)).toEqual({ "In Progress": 2, Proposed: 4 });
    expect((await post(memberId, { laneValue: "Proposed", limit: "" })).body).toEqual({ ok: true });
    expect(storedLimits(boardId)).toEqual({ "In Progress": 2 });
  });

  it("renders the lane header as n / limit with over-limit only when the lane exceeds it, and the set form only for editors", () => {
    // `Form` needs a data router, so the header renders inside a stub route.
    const render = (props: Parameters<typeof LaneHeader>[0]) => {
      const Stub = createRoutesStub([
        {
          path: "/projects/kb/cards/grid",
          Component: () => (
            <table>
              <thead>
                <tr>
                  <LaneHeader {...props} />
                </tr>
              </thead>
            </table>
          ),
        },
      ]);
      return renderToStaticMarkup(<Stub initialEntries={["/projects/kb/cards/grid"]} />);
    };
    const over = render({ title: "In Progress", laneValue: "In Progress", count: 3, limit: 2, favoriteId: boardId, editable: true });
    expect(over).toContain('class="lane_header over-limit"');
    expect(over).toContain('<span class="lane-card-number aggregate">3 / 2</span>');
    expect(over).toContain("WIP : 2");
    expect(over).toContain('name="intent" value="wip"');
    expect(over).toContain(`name="favoriteId" value="${boardId}"`);
    const under = render({ title: "In Progress", laneValue: "In Progress", count: 2, limit: 2, favoriteId: boardId, editable: false });
    expect(under).toContain('class="lane_header"');
    expect(under).not.toContain("over-limit");
    expect(under).toContain(">2 / 2</span>");
    expect(under).not.toContain('name="intent"'); // readonly: no form
    const none = render({ title: "Proposed", laneValue: "Proposed", count: 4, limit: null, favoriteId: boardId, editable: true });
    expect(none).toContain(">4</span>");
    expect(none).toContain("WIP : (not set)");
    const unset = render({ title: "(not set)", laneValue: "", count: 1, limit: null, favoriteId: boardId, editable: true });
    expect(unset).not.toContain("lane-wip"); // the (not set) lane never carries a limit
    const noFavorite = render({ title: "Proposed", laneValue: "Proposed", count: 4, limit: null, favoriteId: null, editable: false });
    expect(noFavorite).not.toContain("lane-wip");
  });
});
