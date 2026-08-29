/**
 * Behavioral tests for External Integrations (Phase 32): the Slack
 * notifier and the GitHub push receiver.
 *
 * The phase's exit criteria are met the way the plan prescribes: Slack
 * and GitHub are EXTERNAL (rule 13a), so a local HTTP receiver stands
 * in for Slack's webhook endpoint — the app's real poster
 * (`postToSlackWebhook`) is what calls it, driven by the real job
 * handler — and a real GitHub push payload, signed with the registered
 * secret exactly as GitHub signs it, is POSTed to the real webhook
 * route. Every outcome is asserted on persisted rows and events.
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations — no stubs.
 *
 * Owner context: External Integrations verification.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-integrations-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "integrations-suite-secret";
process.env.SITE_URL = "https://mingle.example.test";

const { db, sqlite } = await import("../app/db/client.server");
const { sealer } = await import("../app/auth/sealer.server");
const { createUserSession } = await import("../app/auth/session.server");
const integrationsRoute = await import("../app/routes/projects.integrations");
const webhookRoute = await import("../app/routes/projects.github.webhook");
const cardRoute = await import("../app/routes/projects.cards.card");
const { jobHandlers } = await import("../app/jobs/handlers.server");
const { runPendingJobs } = await import("../app/jobs/queue.server");
const { HISTORY_NOTIFICATIONS_JOB, INTEGRATION_DELIVERIES_JOB } = await import("../app/domain/notifications.server");
const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardMurmurLinks, murmurMentions, murmurs } = await import("../app/db/schema/murmurs");
const { commitLinks, githubCommits, githubIntegrations, slackIntegrations } = await import("../app/db/schema/integrations");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { verifyPassword } = await import("../app/domain/identity/password.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { addCardComment, postMurmur } = await import("../app/domain/murmurs/commands.server");
const { historyCursor } = await import("../app/domain/history/read.server");
const { configureSlackIntegration, deliverSlackNotifications, removeSlackIntegration, slackMessageFor } = await import(
  "../app/domain/integrations/slack.server"
);
const { configureGithubIntegration, parsePushPayload, receiveGithubPush, removeGithubIntegration, verifyGithubSignature, GITHUB_SYSTEM_LOGIN } =
  await import("../app/domain/integrations/github.server");
const { postToSlackWebhook } = await import("../app/integrations/slack-poster.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

// ------------------------------------------------ the stand-in for Slack

interface Received {
  path: string;
  contentType: string | undefined;
  body: unknown;
}
const received: Received[] = [];
let respondWith = 200;
let receiver: Server | undefined;
let receiverUrl = "";

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += String(chunk)));
    req.on("end", () => {
      received.push({ path: req.url ?? "", contentType: req.headers["content-type"], body: text ? JSON.parse(text) : null });
      res.statusCode = respondWith;
      res.end(respondWith === 200 ? "ok" : "no_service");
    });
  });
  await new Promise<void>((resolve) => receiver!.listen(0, "127.0.0.1", () => resolve()));
  const address = receiver.address();
  receiverUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/services/T000/B000/hook`;
});

afterAll(async () => {
  if (receiver) await new Promise<void>((resolve) => receiver!.close(() => resolve()));
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ fixtures

let adminId: number;
let devId: number;
let projectId: number;
const identifier = "integ";
let cardNumber: number;
let cardId: number;

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  for (const table of [
    jobs, domainEvents, commitLinks, githubCommits, githubIntegrations, slackIntegrations, cardMurmurLinks, murmurMentions, murmurs,
    cardVersions, cards, cardTypes, teamMemberships, projects, users,
  ]) db.delete(table).run();
  received.length = 0;
  respondWith = 200;
  adminId = mustOk(registerUser(db, { login: "admin", name: "Admin", password: "integ-1!" }), "admin").id;
  devId = mustOk(registerUser(db, { login: "dev", name: "Dev", password: "integ-1!" }), "dev").id;
  projectId = mustOk(createProject(db, { name: "Integrations", identifier, actorUserId: adminId }), "project").id;
  mustOk(addTeamMember(db, { projectId, userId: devId, role: "full_member", actorUserId: adminId }), "dev");
  const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
  const card = mustOk(createCard(db, { projectId, name: "Login page", cardTypeId: typeId, actorUserId: devId }), "card");
  cardNumber = card.number;
  cardId = card.id;
  db.delete(jobs).run();
  db.delete(domainEvents).run();
});

const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
const slackRow = () => db.select().from(slackIntegrations).where(eq(slackIntegrations.projectId, projectId)).get();
/** Drains only the integration job (the email job scheduled beside it is this suite's noise). */
const drainIntegrations = (now?: Date) => {
  db.delete(jobs).where(eq(jobs.type, HISTORY_NOTIFICATIONS_JOB)).run();
  return runPendingJobs(db, { [INTEGRATION_DELIVERIES_JOB]: jobHandlers[INTEGRATION_DELIVERIES_JOB] }, now ? { now } : {});
};

// ------------------------------------------------------------------ Slack

describe("ConfigureSlackIntegration", () => {
  it("persists the notifier with the URL sealed and the cursor at the current end of history; a blank URL keeps it", () => {
    const before = historyCursor(db, projectId);
    const row = mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, channelLabel: "#dev", enabled: true, actorUserId: adminId }), "configure");
    const stored = slackRow()!;
    expect(stored.id).toBe(row.id);
    expect(stored.webhookUrlSealed).not.toContain("127.0.0.1");
    expect(sealer.open(stored.webhookUrlSealed)).toBe(receiverUrl);
    expect(JSON.parse(stored.cursor)).toEqual(before);
    expect(stored).toMatchObject({ channelLabel: "#dev", enabled: true, createdByUserId: adminId });
    const [event] = events("SlackIntegrationConfigured");
    expect(JSON.parse(event.payload)).toEqual({ enabled: true, channelLabel: "#dev" });
    expect(JSON.stringify(events("SlackIntegrationConfigured"))).not.toContain("127.0.0.1");

    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: "", channelLabel: "#ops", enabled: false, actorUserId: adminId }), "update");
    const updated = slackRow()!;
    expect(sealer.open(updated.webhookUrlSealed)).toBe(receiverUrl);
    expect(updated).toMatchObject({ channelLabel: "#ops", enabled: false });
    expect(db.select().from(slackIntegrations).all()).toHaveLength(1);
  });

  it("rejects a missing or non-http URL and a non-admin — nothing written; remove deletes the row", () => {
    const blank = configureSlackIntegration(db, sealer, { projectId, webhookUrl: "", enabled: true, actorUserId: adminId });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.webhookUrl).toEqual(["can't be blank"]);
    const bad = configureSlackIntegration(db, sealer, { projectId, webhookUrl: "ftp://x", enabled: true, actorUserId: adminId });
    expect(bad.ok).toBe(false);
    const denied = configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: true, actorUserId: devId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.errors.authorization).toBeDefined();
    expect(slackRow()).toBeUndefined();

    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: true, actorUserId: adminId }), "configure");
    expect(removeSlackIntegration(db, { projectId, actorUserId: devId }).ok).toBe(false);
    mustOk(removeSlackIntegration(db, { projectId, actorUserId: adminId }), "remove");
    expect(slackRow()).toBeUndefined();
    expect(events("SlackIntegrationRemoved")).toHaveLength(1);
  });
});

describe("Slack delivery through the real poster to a local receiver", () => {
  it("a card change schedules the job, which posts the entry with a site link and advances the cursor", async () => {
    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, channelLabel: "#dev", enabled: true, actorUserId: adminId }), "configure");
    const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
    const created = mustOk(createCard(db, { projectId, name: "Search <box> & filters", cardTypeId: typeId, actorUserId: devId }), "card");
    const scheduled = db.select().from(jobs).where(eq(jobs.type, INTEGRATION_DELIVERIES_JOB)).all();
    expect(scheduled).toHaveLength(1);
    expect(JSON.parse(scheduled[0].payload)).toEqual({ projectId });

    const report = await drainIntegrations();
    expect(report).toMatchObject({ ran: 1, succeeded: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe("/services/T000/B000/hook");
    expect(received[0].contentType).toContain("application/json");
    const text = (received[0].body as { text: string }).text;
    expect(text).toContain("*Integrations*: Dev created");
    expect(text).toContain(`<https://mingle.example.test/projects/${identifier}/cards/${created.number}|`);
    expect(text).toContain("Search &lt;box&gt; &amp; filters");

    const row = slackRow()!;
    expect(JSON.parse(row.cursor)).toEqual(historyCursor(db, projectId));
    expect(row.lastDeliveredAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(events("SlackNotificationsDelivered").map((e) => JSON.parse(e.payload))).toEqual([{ posted: 1 }]);
    expect(db.select().from(jobs).where(eq(jobs.type, INTEGRATION_DELIVERIES_JOB)).get()!.status).toBe("done");

    // Nothing new: the next run posts nothing and moves nothing.
    expect(await deliverSlackNotifications(db, sealer, postToSlackWebhook, { projectId, siteUrl: "https://mingle.example.test" })).toEqual({ posted: 0, remaining: 0 });
    expect(received).toHaveLength(1);
  });

  it("posts a murmur once and a card comment once (not its murmur half), quoting the text", async () => {
    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: true, actorUserId: adminId }), "configure");
    mustOk(postMurmur(db, { projectId, body: "Standup at 10\nbring coffee", actorUserId: devId }), "murmur");
    mustOk(addCardComment(db, { projectId, cardNumber, body: "Looks done to me", actorUserId: devId }), "comment");
    await drainIntegrations();
    const texts = received.map((r) => (r.body as { text: string }).text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Dev murmured in Integrations");
    expect(texts[0]).toContain("> Standup at 10\n> bring coffee");
    expect(texts[1]).toContain("Dev commented on");
    expect(texts[1]).toContain("> Looks done to me");
    expect(JSON.parse(slackRow()!.cursor)).toEqual(historyCursor(db, projectId));
  });

  it("a refused post records the error, keeps the cursor, and the job retries; a later success delivers", async () => {
    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: true, actorUserId: adminId }), "configure");
    const cursorBefore = slackRow()!.cursor;
    mustOk(postMurmur(db, { projectId, body: "first", actorUserId: devId }), "murmur");
    respondWith = 500;
    const failed = await drainIntegrations();
    expect(failed).toMatchObject({ ran: 1, succeeded: 0, retried: 1 });
    const row = slackRow()!;
    expect(row.lastError).toContain("500");
    expect(row.cursor).toBe(cursorBefore);
    expect(row.lastDeliveredAt).toBeNull();
    const job = db.select().from(jobs).where(eq(jobs.type, INTEGRATION_DELIVERIES_JOB)).get()!;
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain("Slack webhook answered 500");

    respondWith = 200;
    const later = await drainIntegrations(new Date(Date.now() + 60 * 60 * 1000));
    expect(later.succeeded).toBe(1);
    expect(received.filter((r) => (r.body as { text: string }).text.includes("> first"))).toHaveLength(2);
    expect(slackRow()!.lastError).toBeNull();
    expect(JSON.parse(slackRow()!.cursor)).toEqual(historyCursor(db, projectId));
  });

  it("a disabled or absent notifier posts nothing", async () => {
    mustOk(postMurmur(db, { projectId, body: "quiet", actorUserId: devId }), "murmur");
    expect((await drainIntegrations()).succeeded).toBe(1);
    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: false, actorUserId: adminId }), "configure");
    mustOk(postMurmur(db, { projectId, body: "still quiet", actorUserId: devId }), "murmur");
    await drainIntegrations();
    expect(received).toHaveLength(0);
  });

  it("slackMessageFor escapes mrkdwn characters and links entries into the site", () => {
    const message = slackMessageFor(
      { id: "card:1", kind: "card", sourceId: 1, action: "changed", occurredAt: new Date(), authorUserId: 1, authorName: "A <b>", title: "Card #1 x & y", categories: [], href: "/projects/p/cards/1", cardNumber: 1, dependencyNumber: null, pageIdentifier: null, version: 2, text: null },
      { name: "P&Q" },
      "https://site.test/",
    );
    expect(message.text).toBe("*P&amp;Q*: A &lt;b&gt; changed <https://site.test/projects/p/cards/1|Card #1 x &amp; y>");
  });
});

// ----------------------------------------------------------------- GitHub

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function pushPayload(commits: { id: string; message: string }[]) {
  return {
    ref: "refs/heads/main",
    repository: { full_name: "Acme/Widgets", html_url: "https://github.com/acme/widgets" },
    commits: commits.map((c) => ({
      id: c.id,
      message: c.message,
      timestamp: "2026-08-28T12:34:56Z",
      url: `https://github.com/acme/widgets/commit/${c.id}`,
      author: { name: "Alice Example", email: "alice@example.test", username: "alice" },
    })),
  };
}

async function postWebhook(body: string, headers: Record<string, string>) {
  const request = new Request(`http://localhost/projects/${identifier}/github/webhook`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  const response = (await webhookRoute.action({ request, params: { identifier }, context: {} } as never)) as Response;
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

describe("ConfigureGithubIntegration", () => {
  it("registers the repository with the secret sealed, creates the github system user as a full member, and records the event", () => {
    const { secret, row } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "Acme/Widgets", actorUserId: adminId }), "configure");
    expect(secret.length).toBeGreaterThan(30);
    const stored = db.select().from(githubIntegrations).where(eq(githubIntegrations.id, row.id)).get()!;
    expect(stored.repository).toBe("acme/widgets");
    expect(stored.secretSealed).not.toContain(secret);
    expect(sealer.open(stored.secretSealed)).toBe(secret);
    const github = db.select().from(users).where(eq(users.login, GITHUB_SYSTEM_LOGIN)).get()!;
    expect(github).toMatchObject({ name: "GitHub", admin: false, email: null });
    expect(verifyPassword("anything-1!", github.passwordHash)).toBe(false);
    expect(db.select().from(teamMemberships).where(and(eq(teamMemberships.projectId, projectId), eq(teamMemberships.userId, github.id))).get()!.role).toBe("full_member");
    expect(events("SystemUserCreated")).toHaveLength(1);
    expect(JSON.parse(events("GithubIntegrationConfigured")[0].payload)).toEqual({ repository: "acme/widgets" });
    expect(JSON.stringify(db.select().from(domainEvents).all())).not.toContain(secret);

    const again = configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors.repository).toEqual(["has already been registered"]);
    expect(configureGithubIntegration(db, sealer, { projectId, repository: "not a repo", actorUserId: adminId }).ok).toBe(false);
    expect(configureGithubIntegration(db, sealer, { projectId, repository: "acme/other", actorUserId: devId }).ok).toBe(false);
    expect(db.select().from(githubIntegrations).all()).toHaveLength(1);

    mustOk(removeGithubIntegration(db, { projectId, integrationId: row.id, actorUserId: adminId }), "remove");
    expect(db.select().from(githubIntegrations).all()).toHaveLength(0);
  });

  it("verifies GitHub's sha256 signature and rejects a wrong, malformed, or missing one", () => {
    expect(verifyGithubSignature("s", "body", sign("s", "body"))).toBe(true);
    expect(verifyGithubSignature("s", "body", sign("s", "other"))).toBe(false);
    expect(verifyGithubSignature("s", "body", sign("t", "body"))).toBe(false);
    expect(verifyGithubSignature("s", "body", "sha1=abc")).toBe(false);
    expect(verifyGithubSignature("s", "body", null)).toBe(false);
    expect(parsePushPayload({ zen: "keep it logically awesome" })).toBeNull();
  });
});

describe("POST /projects/:identifier/github/webhook (real route module)", () => {
  it("a signed push links the referenced commit to the card, murmurs each commit as github, and is idempotent on redelivery", async () => {
    const { secret, row } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    db.delete(domainEvents).run();
    const body = JSON.stringify(pushPayload([
      { id: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", message: `Fix #${cardNumber} login redirect\n\nAlso touches #999 which does not exist` },
      { id: "0123456789abcdef0123456789abcdef01234567", message: "Bump deps" },
    ]));
    const outcome = await postWebhook(body, { "X-Hub-Signature-256": sign(secret, body), "X-GitHub-Event": "push" });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ ok: true, commits: 2, skipped: 0, linked: 1, murmurs: 2 });

    const links = db.select().from(commitLinks).where(eq(commitLinks.projectId, projectId)).all();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      cardId,
      githubIntegrationId: row.id,
      repository: "acme/widgets",
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      url: "https://github.com/acme/widgets/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      authorName: "Alice Example",
      authorLogin: "alice",
    });
    expect(links[0].committedAt.toISOString()).toBe("2026-08-28T12:34:56.000Z");
    expect(JSON.parse(events("CommitLinked")[0].payload)).toEqual({ cardNumber, repository: "acme/widgets", sha: links[0].sha });

    const github = db.select().from(users).where(eq(users.login, GITHUB_SYSTEM_LOGIN)).get()!;
    const posted = db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).orderBy(asc(murmurs.id)).all();
    expect(posted).toHaveLength(2);
    expect(posted.every((m) => m.authorUserId === github.id)).toBe(true);
    expect(posted[0].body).toContain("Author: [alice](mailto:alice@example.test)");
    expect(posted[0].body).toContain(`Fix #${cardNumber} login redirect`);
    expect(posted[0].body).toContain("commit [#rev-a1b2c3d4e5f](https://github.com/acme/widgets/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678) (acme/widgets)");
    expect(db.select().from(cardMurmurLinks).where(eq(cardMurmurLinks.murmurId, posted[0].id)).all()).toHaveLength(1);
    expect(JSON.parse(events("GithubPushReceived")[0].payload)).toEqual({ repository: "acme/widgets", commits: 2, skipped: 0, linked: 1, murmurs: 2 });
    expect(db.select().from(githubCommits).where(eq(githubCommits.githubIntegrationId, row.id)).all().map((c) => c.sha).sort()).toEqual([
      "0123456789abcdef0123456789abcdef01234567",
      "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    ]);
    expect(db.select().from(githubIntegrations).where(eq(githubIntegrations.id, row.id)).get()!.lastReceivedAt).not.toBeNull();

    // GitHub redelivers the same payload: no second link, no second murmur, no new events.
    const again = await postWebhook(body, { "X-Hub-Signature-256": sign(secret, body), "X-GitHub-Event": "push" });
    expect(again.body).toMatchObject({ commits: 2, skipped: 2, linked: 0, murmurs: 0 });
    expect(db.select().from(commitLinks).all()).toHaveLength(1);
    expect(db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).all()).toHaveLength(2);
    expect(events("CommitLinked")).toHaveLength(1);
    expect(db.select().from(githubCommits).all()).toHaveLength(2);

    // The card page and the integrations page show the link.
    const cookie = (await createUserSession(adminId, "/")).headers.get("Set-Cookie")!;
    const shown = (await cardRoute.loader({ request: new Request(`http://localhost/projects/${identifier}/cards/${cardNumber}`, { headers: { Cookie: cookie } }), params: { identifier, number: String(cardNumber) }, context: {} } as never)) as { commits: { shortSha: string; repository: string }[] };
    expect(shown.commits).toEqual([expect.objectContaining({ shortSha: "a1b2c3d", repository: "acme/widgets" })]);
    const page = (await integrationsRoute.loader({ request: new Request(`http://localhost/projects/${identifier}/integrations`, { headers: { Cookie: cookie } }), params: { identifier }, context: {} } as never)) as { commits: { cardNumber: number }[]; github: { repository: string }[]; payloadUrl: string };
    expect(page.commits.map((c) => c.cardNumber)).toEqual([cardNumber]);
    expect(page.github.map((g) => g.repository)).toEqual(["acme/widgets"]);
    expect(page.payloadUrl).toBe(`http://localhost/projects/${identifier}/github/webhook`);
  });

  it("refuses a wrong or missing signature (401), an unregistered repository (404), a malformed body (400) — nothing written; ping answers 200 without writes", async () => {
    const { secret } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    db.delete(domainEvents).run();
    const body = JSON.stringify(pushPayload([{ id: "feedfacefeedfacefeedfacefeedfacefeedface", message: `Touch #${cardNumber}` }]));

    expect((await postWebhook(body, { "X-Hub-Signature-256": sign("wrong", body) })).status).toBe(401);
    expect((await postWebhook(body, {})).status).toBe(401);
    const other = JSON.stringify(pushPayload([{ id: "feedfacefeedfacefeedfacefeedfacefeedface", message: `Touch #${cardNumber}` }])).replace("Acme/Widgets", "acme/elsewhere");
    expect((await postWebhook(other, { "X-Hub-Signature-256": sign(secret, other) })).status).toBe(404);
    expect((await postWebhook("{not json", { "X-Hub-Signature-256": sign(secret, "{not json") })).status).toBe(400);
    const ping = await postWebhook(body, { "X-Hub-Signature-256": sign(secret, body), "X-GitHub-Event": "ping" });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ ok: true, event: "ping" });

    expect(db.select().from(commitLinks).all()).toHaveLength(0);
    expect(db.select().from(murmurs).all()).toHaveLength(0);
    expect(events("GithubPushReceived")).toHaveLength(0);
    expect(db.select().from(githubIntegrations).all()[0].lastReceivedAt).toBeNull();
  });

  it("receiveGithubPush rejects a disabled registration", () => {
    const { row } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    db.update(githubIntegrations).set({ enabled: false }).where(eq(githubIntegrations.id, row.id)).run();
    const result = receiveGithubPush(db, { integrationId: row.id, payload: { repository: "acme/widgets", commits: [] } });
    expect(result.ok).toBe(false);
  });
});

// ------------------------------------------------- integrations route

describe("/projects/:identifier/integrations (real route module)", () => {
  async function post(userId: number, fields: Record<string, string>) {
    const cookie = (await createUserSession(userId, "/")).headers.get("Set-Cookie")!;
    const request = new Request(`http://localhost/projects/${identifier}/integrations`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    try {
      return { status: 200, data: (await integrationsRoute.action({ request, params: { identifier }, context: {} } as never)) as Record<string, unknown> };
    } catch (thrown) {
      if (thrown instanceof Response) return { status: thrown.status, data: null };
      throw thrown;
    }
  }

  it("saves the Slack notifier and registers a repository for a project admin; a full member gets 403", async () => {
    const slack = await post(adminId, { intent: "slack", webhookUrl: receiverUrl, channelLabel: "#dev", enabled: "on" });
    expect(slack.data?.saved).toBe("slack");
    expect(slackRow()).toMatchObject({ channelLabel: "#dev", enabled: true });

    const github = await post(adminId, { intent: "github-add", repository: "acme/widgets" });
    expect(github.data?.saved).toBe("github-add");
    expect(String(github.data?.secret).length).toBeGreaterThan(30);
    expect(github.data?.repository).toBe("acme/widgets");
    expect(sealer.open(db.select().from(githubIntegrations).all()[0].secretSealed)).toBe(github.data?.secret);

    expect((await post(devId, { intent: "slack", webhookUrl: receiverUrl, enabled: "on" })).status).toBe(403);
    const invalid = await post(adminId, { intent: "github-add", repository: "nope" });
    expect((invalid.data?.errors as Record<string, string[]>).repository).toEqual(["must be owner/name"]);
  });
});
