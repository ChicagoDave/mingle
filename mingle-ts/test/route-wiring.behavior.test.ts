/**
 * HTTP-path tests for the route modules that shipped without one:
 * the wiki page (Phase 16/17), the murmur stream (Phase 20), and the
 * card page's `comment` intent (Phase 20).
 *
 * Each test drives the actual route module — its exported `loader` or
 * `action` — with a `Request` carrying a real signed session cookie
 * (the Phase 21 recipe used by the tree routes), then asserts on rows
 * reloaded from the database or on the exact loader payload the
 * component renders. The domain commands behind these routes have
 * their own suites; this one pins the adapter: form-field names,
 * intent dispatch, query parameters, status codes, redirects, and the
 * authorization outcome as it surfaces over HTTP.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: HTTP adapter verification (Wiki & Content,
 * Collaboration).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-route-wiring-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "route-wiring-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const wikiPageRoute = await import("../app/routes/projects.wiki.page");
const murmursRoute = await import("../app/routes/projects.murmurs");
const cardRoute = await import("../app/routes/projects.cards.card");

const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { pages, pageVersions } = await import("../app/db/schema/pages");
const { cardMurmurLinks, murmurMentions, murmurs } = await import("../app/db/schema/murmurs");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { createPage, updatePage } = await import("../app/domain/pages/commands.server");
const { postMurmur } = await import("../app/domain/murmurs/commands.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number; //    site admin, project creator
let devId: number; //      full_member
let readonlyId: number; // readonly_member
let projectId: number;
const identifier = "wiring";
let cardTypeId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function register(login: string): number {
  return mustOk(
    registerUser(db, { login, name: login.toUpperCase(), email: `${login}@example.test`, password: "route-wiring-1!" }),
    login,
  ).id;
}

beforeEach(() => {
  for (const table of [
    jobs, domainEvents, cardMurmurLinks, murmurMentions, murmurs, pageVersions, pages,
    cardVersions, cards, cardTypes, teamMemberships, projects, users,
  ]) db.delete(table).run();
  adminId = register("admin");
  devId = register("dev");
  readonlyId = register("viewer");
  projectId = mustOk(createProject(db, { name: "Wiring", identifier, actorUserId: adminId }), "project").id;
  cardTypeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
  mustOk(addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }), "dev membership");
  mustOk(addTeamMember(db, { projectId, userId: readonlyId, role: "readonly_member", actorUserId: adminId }), "viewer membership");
});

// ------------------------------------------------------------ harness

interface Outcome {
  status: number;
  location: string | null;
  data: unknown;
}

async function cookieFor(userId: number): Promise<string> {
  return (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
}

/**
 * Invokes a route loader/action the way the framework would: a GET for
 * a bare path, a form-encoded POST when fields are given. `userId`
 * null sends no cookie at all.
 */
async function run(
  fn: (args: never) => Promise<unknown>,
  userId: number | null,
  path: string,
  params: Record<string, string>,
  fields?: Record<string, string>,
): Promise<Outcome> {
  const headers: Record<string, string> = {};
  if (userId !== null) headers.Cookie = await cookieFor(userId);
  let body: URLSearchParams | undefined;
  if (fields) {
    body = new URLSearchParams(fields);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const request = new Request(`http://localhost${path}`, { method: fields ? "POST" : "GET", headers, body });
  try {
    const result = (await fn({ request, params, context: {} } as never)) as { data?: unknown; init?: { status?: number } | null };
    return { status: result?.init?.status ?? 200, location: null, data: result?.init === undefined ? result : result.data };
  } catch (thrown) {
    if (thrown instanceof Response) return { status: thrown.status, location: thrown.headers.get("Location"), data: null };
    throw thrown;
  }
}

// ---------------------------------------------------------- wiki page

describe("/projects/:identifier/wiki/:pagename (real route module)", () => {
  const path = (pagename: string) => `/projects/${identifier}/wiki/${pagename}`;
  const params = (pagename: string) => ({ identifier, pagename });

  interface Shown {
    exists: boolean;
    name: string;
    content?: string;
    version?: number;
    currentVersion?: number;
    history?: { version: number }[];
    linkedFrom?: { name: string }[];
    canEdit: boolean;
    canDelete: boolean;
  }

  it("renders the current version with wiki and card links resolved, plus history and backlinks", async () => {
    const card = mustOk(createCard(db, { projectId, name: "Login", cardTypeId, actorUserId: adminId }), "card");
    mustOk(createPage(db, { projectId, name: "Overview", content: "<p>See [[Roadmap]] and #" + card.number + "</p>", actorUserId: devId }), "overview");
    const roadmap = mustOk(createPage(db, { projectId, name: "Roadmap", content: "<p>v1</p>", actorUserId: devId }), "roadmap");
    mustOk(updatePage(db, { projectId, identifier: "Roadmap", content: "<p>v2</p>", actorUserId: devId }), "roadmap v2");
    expect(roadmap.version).toBe(1);

    const outcome = await run(wikiPageRoute.loader, devId, path("Overview"), params("Overview"));
    expect(outcome.status).toBe(200);
    const shown = outcome.data as Shown;
    expect(shown.exists).toBe(true);
    expect(shown.name).toBe("Overview");
    expect(shown.content).toContain(`href="/projects/${identifier}/wiki/Roadmap"`);
    expect(shown.content).toContain(`href="/projects/${identifier}/cards/${card.number}"`);
    expect(shown.version).toBe(1);
    expect(shown.currentVersion).toBe(1);
    expect(shown.canEdit).toBe(true);
    expect(shown.canDelete).toBe(false);

    const linked = await run(wikiPageRoute.loader, devId, path("Roadmap"), params("Roadmap"));
    const roadmapShown = linked.data as Shown;
    expect(roadmapShown.version).toBe(2);
    expect(roadmapShown.currentVersion).toBe(2);
    expect(roadmapShown.history!.map((h) => h.version)).toEqual([2, 1]);
    expect(roadmapShown.linkedFrom!.map((p) => p.name)).toEqual(["Overview"]);
  });

  it("?version=n shows that earlier version read-only and 404s for a version that never existed", async () => {
    mustOk(createPage(db, { projectId, name: "Roadmap", content: "<p>first</p>", actorUserId: devId }), "roadmap");
    mustOk(updatePage(db, { projectId, identifier: "Roadmap", content: "<p>second</p>", actorUserId: devId }), "roadmap v2");

    const earlier = await run(wikiPageRoute.loader, devId, `${path("Roadmap")}?version=1`, params("Roadmap"));
    const shown = earlier.data as Shown;
    expect(shown.content).toContain("first");
    expect(shown.content).not.toContain("second");
    expect(shown.version).toBe(1);
    expect(shown.currentVersion).toBe(2);

    expect((await run(wikiPageRoute.loader, devId, `${path("Roadmap")}?version=9`, params("Roadmap"))).status).toBe(404);
  });

  it("a page nobody has written yet renders the create prompt, not a 404, and only editors may create it", async () => {
    const asDev = (await run(wikiPageRoute.loader, devId, path("Nowhere"), params("Nowhere"))).data as Shown;
    expect(asDev.exists).toBe(false);
    expect(asDev.name).toBe("Nowhere");
    expect(asDev.canEdit).toBe(true);

    const asViewer = (await run(wikiPageRoute.loader, readonlyId, path("Nowhere"), params("Nowhere"))).data as Shown;
    expect(asViewer.exists).toBe(false);
    expect(asViewer.canEdit).toBe(false);
  });

  it("redirects a logged-out browser to /login and 404s an unknown project", async () => {
    const anonymous = await run(wikiPageRoute.loader, null, path("Overview"), params("Overview"));
    expect(anonymous.status).toBe(302);
    expect(anonymous.location).toBe("/login");

    expect((await run(wikiPageRoute.loader, devId, "/projects/nope/wiki/Overview", { identifier: "nope", pagename: "Overview" })).status).toBe(404);
  });

  it("the delete form removes the page for a project admin and redirects to the page list", async () => {
    mustOk(createPage(db, { projectId, name: "Scratch", content: "<p>x</p>", actorUserId: devId }), "scratch");
    const outcome = await run(wikiPageRoute.action, adminId, path("Scratch"), params("Scratch"), { intent: "delete" });
    expect(outcome.status).toBe(302);
    expect(outcome.location).toBe(`/projects/${identifier}/wiki`);
    expect(db.select().from(pages).where(eq(pages.projectId, projectId)).all()).toHaveLength(0);
  });

  it("the delete form is refused for a full member and the page stays", async () => {
    mustOk(createPage(db, { projectId, name: "Scratch", content: "<p>x</p>", actorUserId: devId }), "scratch");
    const outcome = await run(wikiPageRoute.action, devId, path("Scratch"), params("Scratch"), { intent: "delete" });
    expect(outcome.status).toBe(400);
    expect((outcome.data as { ok: boolean }).ok).toBe(false);
    expect(db.select().from(pages).where(eq(pages.projectId, projectId)).all()).toHaveLength(1);
  });

  it("rejects an intent the page does not offer", async () => {
    mustOk(createPage(db, { projectId, name: "Scratch", content: "<p>x</p>", actorUserId: devId }), "scratch");
    expect((await run(wikiPageRoute.action, adminId, path("Scratch"), params("Scratch"), { intent: "rename" })).status).toBe(400);
    expect(db.select().from(pages).all()).toHaveLength(1);
  });
});

// ------------------------------------------------------------ murmurs

describe("/projects/:identifier/murmurs (real route module)", () => {
  const path = `/projects/${identifier}/murmurs`;
  const params = { identifier };

  interface Stream {
    murmurs: { id: number; authorName: string }[];
    mentionsOnly: boolean;
    canPost: boolean;
  }

  it("lists the project's murmurs newest first and pages with ?before=", async () => {
    const first = mustOk(postMurmur(db, { projectId, body: "first", actorUserId: devId }), "first");
    const second = mustOk(postMurmur(db, { projectId, body: "second", actorUserId: adminId }), "second");

    const stream = (await run(murmursRoute.loader, devId, path, params)).data as Stream;
    expect(stream.murmurs.map((m) => m.id)).toEqual([second.id, first.id]);
    expect(stream.murmurs.map((m) => m.authorName)).toEqual(["ADMIN", "DEV"]);
    expect(stream.mentionsOnly).toBe(false);
    expect(stream.canPost).toBe(true);

    const older = (await run(murmursRoute.loader, devId, `${path}?before=${second.id}`, params)).data as Stream;
    expect(older.murmurs.map((m) => m.id)).toEqual([first.id]);
  });

  it("?filter=mentions narrows to murmurs that mention the viewer", async () => {
    mustOk(postMurmur(db, { projectId, body: "nothing for anyone", actorUserId: adminId }), "plain");
    const hey = mustOk(postMurmur(db, { projectId, body: "@dev look at this", actorUserId: adminId }), "mention");

    const stream = (await run(murmursRoute.loader, devId, `${path}?filter=mentions`, params)).data as Stream;
    expect(stream.mentionsOnly).toBe(true);
    expect(stream.murmurs.map((m) => m.id)).toEqual([hey.id]);
  });

  it("a readonly member sees the stream but may not post", async () => {
    const stream = (await run(murmursRoute.loader, readonlyId, path, params)).data as Stream;
    expect(stream.canPost).toBe(false);
  });

  it("posting the form persists the murmur with its mention row", async () => {
    const outcome = await run(murmursRoute.action, adminId, path, params, { body: "shipped it, thanks @dev" });
    expect(outcome.status).toBe(200);
    expect((outcome.data as { errors: unknown }).errors).toBeNull();

    const rows = db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].authorUserId).toBe(adminId);
    expect(rows[0].originType).toBe("project");
    expect(rows[0].body).toBe("shipped it, thanks @dev");
    const mentions = db.select().from(murmurMentions).where(eq(murmurMentions.murmurId, rows[0].id)).all();
    expect(mentions.map((m) => m.userId)).toEqual([devId]);
  });

  it("a blank body is refused with 400 and nothing is written", async () => {
    const outcome = await run(murmursRoute.action, devId, path, params, { body: "   " });
    expect(outcome.status).toBe(400);
    expect((outcome.data as { errors: Record<string, string[]> }).errors.body).toContain("can't be blank");
    expect(db.select().from(murmurs).all()).toHaveLength(0);
  });

  it("a readonly member's post is refused with 400 and nothing is written", async () => {
    const outcome = await run(murmursRoute.action, readonlyId, path, params, { body: "let me in" });
    expect(outcome.status).toBe(400);
    expect(db.select().from(murmurs).all()).toHaveLength(0);
  });

  it("redirects a logged-out browser to /login and 404s an unknown project", async () => {
    const anonymous = await run(murmursRoute.action, null, path, params, { body: "hi" });
    expect(anonymous.status).toBe(302);
    expect(anonymous.location).toBe("/login");
    expect(db.select().from(murmurs).all()).toHaveLength(0);

    expect((await run(murmursRoute.loader, devId, "/projects/nope/murmurs", { identifier: "nope" })).status).toBe(404);
  });
});

// ------------------------------------------------- card comment intent

describe("/projects/:identifier/cards/:number comment intent (real route module)", () => {
  function cardPath(number: number) {
    return { path: `/projects/${identifier}/cards/${number}`, params: { identifier, number: String(number) } };
  }

  it("the comment form persists a murmur linked to the card and a card version carrying the comment", async () => {
    const card = mustOk(createCard(db, { projectId, name: "Login", cardTypeId, actorUserId: adminId }), "card");
    const { path, params } = cardPath(card.number);

    const outcome = await run(cardRoute.action, devId, path, params, { intent: "comment", body: "looks wrong to me" });
    expect(outcome.status).toBe(200);
    expect(outcome.data).toEqual({ saved: true });

    const murmur = db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).get()!;
    expect(murmur.body).toBe("looks wrong to me");
    expect(murmur.authorUserId).toBe(devId);
    expect(murmur.originType).toBe("card");
    expect(murmur.originCardId).toBe(card.id);
    expect(murmur.originCardVersion).toBe(2);

    const versions = db
      .select({ version: cardVersions.version, comment: cardVersions.comment })
      .from(cardVersions)
      .where(eq(cardVersions.cardId, card.id))
      .orderBy(asc(cardVersions.version))
      .all();
    expect(versions).toEqual([
      { version: 1, comment: null },
      { version: 2, comment: "looks wrong to me" },
    ]);
  });

  it("a blank comment is refused with field errors and writes nothing", async () => {
    const card = mustOk(createCard(db, { projectId, name: "Login", cardTypeId, actorUserId: adminId }), "card");
    const { path, params } = cardPath(card.number);

    const outcome = await run(cardRoute.action, devId, path, params, { intent: "comment", body: "" });
    expect(outcome.status).toBe(200);
    expect((outcome.data as { errors: Record<string, string[]> }).errors.body).toContain("can't be blank");
    expect(db.select().from(murmurs).all()).toHaveLength(0);
    expect(db.select().from(cardVersions).where(eq(cardVersions.cardId, card.id)).all()).toHaveLength(1);
  });

  it("a readonly member's comment is refused and writes nothing", async () => {
    const card = mustOk(createCard(db, { projectId, name: "Login", cardTypeId, actorUserId: adminId }), "card");
    const { path, params } = cardPath(card.number);

    const outcome = await run(cardRoute.action, readonlyId, path, params, { intent: "comment", body: "hi" });
    expect((outcome.data as { errors?: unknown }).errors).toBeDefined();
    expect(db.select().from(murmurs).all()).toHaveLength(0);
    expect(db.select().from(cardVersions).where(eq(cardVersions.cardId, card.id)).all()).toHaveLength(1);
  });
});
