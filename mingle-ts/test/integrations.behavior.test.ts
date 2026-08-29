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
const gitlabRoute = await import("../app/routes/projects.gitlab.webhook");
const { commitLinksForCard, pullRequestLinksForCard } = await import("../app/domain/integrations/read.server");
const bitbucketRoute = await import("../app/routes/projects.bitbucket.webhook");
const cardRoute = await import("../app/routes/projects.cards.card");
const { jobHandlers } = await import("../app/jobs/handlers.server");
const { runPendingJobs } = await import("../app/jobs/queue.server");
const { HISTORY_NOTIFICATIONS_JOB, INTEGRATION_DELIVERIES_JOB } = await import("../app/domain/notifications.server");
const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { cardMurmurLinks, murmurMentions, murmurs } = await import("../app/db/schema/murmurs");
const { commitLinks, githubCommits, githubIntegrations, slackIntegrations, slackEventRoutes, pullRequestLinks } = await import("../app/db/schema/integrations");
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { verifyPassword } = await import("../app/domain/identity/password.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { addCardComment, postMurmur } = await import("../app/domain/murmurs/commands.server");
const { historyCursor } = await import("../app/domain/history/read.server");
const { addSlackWebhook, configureSlackIntegration, deliverSlackNotifications, removeSlackIntegration, routeSlackEvents, setDefaultSlackWebhook, slackMessageFor } = await import(
  "../app/domain/integrations/slack.server"
);
const { configureGithubIntegration, parsePushPayload, receiveGithubPush, removeGithubIntegration, verifyGithubSignature, GITHUB_SYSTEM_LOGIN } =
  await import("../app/domain/integrations/github.server");
const { receiveGithubPullRequest, receiveGithubStatus } = await import("../app/domain/integrations/github.server");
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
/** When set, requests to this path answer 500 whatever `respondWith` says. */
let failPath: string | null = null;
let receiver: Server | undefined;
let receiverUrl = "";

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += String(chunk)));
    req.on("end", () => {
      received.push({ path: req.url ?? "", contentType: req.headers["content-type"], body: text ? JSON.parse(text) : null });
      const status = failPath !== null && req.url === failPath ? 500 : respondWith;
      res.statusCode = status;
      res.end(status === 200 ? "ok" : "no_service");
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
    jobs, domainEvents, pullRequestLinks, commitLinks, githubCommits, githubIntegrations, slackEventRoutes, slackIntegrations, cardMurmurLinks, murmurMentions, murmurs,
    cardVersions, cards, cardTypes, teamMemberships, projects, users,
  ]) db.delete(table).run();
  received.length = 0;
  respondWith = 200;
  failPath = null;
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
    expect(JSON.parse(event.payload)).toEqual({ integrationId: row.id, enabled: true, channelLabel: "#dev", isDefault: true });
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

describe("Slack routing across several webhooks (P-10)", () => {
  const hookPath = (n: number) => `/services/T000/B00${n}/hook`;
  const secondUrl = () => receiverUrl.replace("/services/T000/B000/hook", hookPath(1));
  const textsAt = (path: string) => received.filter((r) => r.path === path).map((r) => (r.body as { text: string }).text);
  const webhookRows = () => db.select().from(slackIntegrations).where(eq(slackIntegrations.projectId, projectId)).orderBy(slackIntegrations.id).all();

  it("a second webhook is registered non-default with its own cursor; the default can be moved; removing the default promotes the oldest", () => {
    const first = mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, channelLabel: "#dev", enabled: true, actorUserId: adminId }), "first");
    expect(first.isDefault).toBe(true);
    const second = mustOk(addSlackWebhook(db, sealer, { projectId, webhookUrl: secondUrl(), channelLabel: "#cards", enabled: true, actorUserId: adminId }), "second");
    expect(second.isDefault).toBe(false);
    expect(JSON.parse(second.cursor)).toEqual(historyCursor(db, projectId));
    expect(sealer.open(second.webhookUrlSealed)).toBe(secondUrl());
    expect(webhookRows().map((r) => [r.id, r.isDefault])).toEqual([[first.id, true], [second.id, false]]);

    mustOk(setDefaultSlackWebhook(db, { projectId, integrationId: second.id, actorUserId: adminId }), "move default");
    expect(webhookRows().map((r) => [r.id, r.isDefault])).toEqual([[first.id, false], [second.id, true]]);
    expect(events("SlackDefaultWebhookChanged")).toHaveLength(1);
    expect(setDefaultSlackWebhook(db, { projectId, integrationId: 999, actorUserId: adminId }).ok).toBe(false);
    expect(setDefaultSlackWebhook(db, { projectId, integrationId: first.id, actorUserId: devId }).ok).toBe(false);

    mustOk(removeSlackIntegration(db, { projectId, integrationId: second.id, actorUserId: adminId }), "remove default");
    expect(webhookRows().map((r) => [r.id, r.isDefault])).toEqual([[first.id, true]]);
    expect(addSlackWebhook(db, sealer, { projectId, webhookUrl: "nope", enabled: true, actorUserId: adminId }).ok).toBe(false);
    expect(addSlackWebhook(db, sealer, { projectId, webhookUrl: secondUrl(), enabled: true, actorUserId: devId }).ok).toBe(false);
  });

  it("routes an event type to the second webhook, suppresses another, and falls through the rest to the default — each webhook on its own cursor", async () => {
    const first = mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, channelLabel: "#dev", enabled: true, actorUserId: adminId }), "first");
    const second = mustOk(addSlackWebhook(db, sealer, { projectId, webhookUrl: secondUrl(), channelLabel: "#cards", enabled: true, actorUserId: adminId }), "second");
    const routed = mustOk(routeSlackEvents(db, { projectId, routes: { "card.created": second.id, "murmur.murmured": "suppressed" }, actorUserId: adminId }), "route");
    expect(routed["card.created"]).toBe(second.id);
    expect(routed["murmur.murmured"]).toBe("suppressed");
    expect(routed["card.commented"]).toBe("default");
    expect(db.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, projectId)).all().map((r) => [r.eventType, r.slackIntegrationId])).toEqual([
      ["card.created", second.id], ["murmur.murmured", null],
    ]);
    expect(events("SlackEventsRouted")).toHaveLength(1);

    const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, projectId)).get()!.id;
    mustOk(createCard(db, { projectId, name: "Routed card", cardTypeId: typeId, actorUserId: devId }), "card");
    mustOk(postMurmur(db, { projectId, body: "suppressed murmur", actorUserId: devId }), "murmur");
    mustOk(addCardComment(db, { projectId, cardNumber, body: "default comment", actorUserId: devId }), "comment");
    const report = await drainIntegrations();
    expect(report).toMatchObject({ succeeded: 1, failed: 0 });

    // The routed event reached only the second webhook; the suppressed one reached nobody; the rest fell through to the default.
    expect(textsAt(hookPath(1))).toEqual([expect.stringContaining("Dev created")]);
    expect(textsAt(hookPath(1))[0]).toContain("Routed card");
    expect(textsAt("/services/T000/B000/hook")).toEqual([expect.stringContaining("Dev commented on")]);
    expect(received.map((r) => (r.body as { text: string }).text).join("\n")).not.toContain("suppressed murmur");
    // Both cursors are at the end of history: skipped entries advance a cursor too.
    const end = historyCursor(db, projectId);
    for (const row of webhookRows()) expect(JSON.parse(row.cursor)).toEqual(end);
    expect(webhookRows().map((r) => r.lastDeliveredAt !== null)).toEqual([true, true]);
    expect(events("SlackNotificationsDelivered").map((e) => JSON.parse(e.payload))).toEqual([{ posted: 2 }]);

    // Routing back to the default and suppressing nothing: the next card goes to the default webhook only.
    mustOk(routeSlackEvents(db, { projectId, routes: { "card.created": "default", "murmur.murmured": "default" }, actorUserId: adminId }), "reset");
    expect(db.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, projectId)).all()).toEqual([]);
    received.length = 0;
    mustOk(createCard(db, { projectId, name: "Default card", cardTypeId: typeId, actorUserId: devId }), "card 2");
    await drainIntegrations();
    expect(textsAt("/services/T000/B000/hook")).toEqual([expect.stringContaining("Default card")]);
    expect(textsAt(hookPath(1))).toEqual([]);
    expect(first.id).toBeLessThan(second.id);
  });

  it("rejects an unknown event type, a foreign webhook id, and a non-admin; removing a webhook drops the routes that named it", () => {
    const first = mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: true, actorUserId: adminId }), "first");
    const second = mustOk(addSlackWebhook(db, sealer, { projectId, webhookUrl: secondUrl(), enabled: true, actorUserId: adminId }), "second");
    const unknownType = routeSlackEvents(db, { projectId, routes: { ["card.exploded" as "card.created"]: second.id }, actorUserId: adminId });
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) expect(unknownType.errors.routes).toEqual(["'card.exploded' is not a history event type"]);
    const foreign = routeSlackEvents(db, { projectId, routes: { "card.created": 999 }, actorUserId: adminId });
    expect(foreign.ok).toBe(false);
    expect(routeSlackEvents(db, { projectId, routes: { "card.created": second.id }, actorUserId: devId }).ok).toBe(false);
    expect(db.select().from(slackEventRoutes).all()).toEqual([]);

    mustOk(routeSlackEvents(db, { projectId, routes: { "card.created": second.id, "page.created": "suppressed" }, actorUserId: adminId }), "route");
    mustOk(removeSlackIntegration(db, { projectId, integrationId: second.id, actorUserId: adminId }), "remove second");
    expect(db.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, projectId)).all().map((r) => r.eventType)).toEqual(["page.created"]);
    expect(webhookRows().map((r) => r.id)).toEqual([first.id]);
  });

  it("a failing webhook records its error and keeps its cursor while the other webhook still delivers; the job retries", async () => {
    mustOk(configureSlackIntegration(db, sealer, { projectId, webhookUrl: receiverUrl, enabled: true, actorUserId: adminId }), "first");
    // The second webhook points at a path the receiver answers with the failure status for.
    const second = mustOk(addSlackWebhook(db, sealer, { projectId, webhookUrl: receiverUrl.replace("/services/T000/B000/hook", "/fail"), enabled: true, actorUserId: adminId }), "second");
    mustOk(routeSlackEvents(db, { projectId, routes: { "murmur.murmured": second.id }, actorUserId: adminId }), "route");
    failPath = "/fail";
    const before = webhookRows().find((r) => r.id === second.id)!.cursor;
    mustOk(postMurmur(db, { projectId, body: "to the failing hook", actorUserId: devId }), "murmur");
    mustOk(addCardComment(db, { projectId, cardNumber, body: "to the default hook", actorUserId: devId }), "comment");
    const outcome = await drainIntegrations();
    expect(outcome).toMatchObject({ retried: 1 });
    expect(textsAt("/services/T000/B000/hook")).toEqual([expect.stringContaining("to the default hook")]);
    const failing = webhookRows().find((r) => r.id === second.id)!;
    expect(failing.lastError).toContain("500");
    expect(failing.cursor).toBe(before);
    expect(webhookRows().find((r) => r.id !== second.id)!.lastError).toBeNull();
    failPath = null;
    const later = await drainIntegrations(new Date(Date.now() + 60 * 60 * 1000));
    expect(later.succeeded).toBe(1);
    expect(textsAt("/fail")).toEqual([expect.stringContaining("to the failing hook"), expect.stringContaining("to the failing hook")]);
    expect(JSON.parse(webhookRows().find((r) => r.id === second.id)!.cursor)).toEqual(historyCursor(db, projectId));
  });
});

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
    expect(JSON.parse(events("GithubIntegrationConfigured")[0].payload)).toEqual({ repository: "acme/widgets", provider: "github" });
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
    expect(JSON.parse(events("GithubPushReceived")[0].payload)).toEqual({ provider: "github", repository: "acme/widgets", commits: 2, skipped: 0, linked: 1, murmurs: 2 });
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

// ---------------------------------------- GitHub pull requests and statuses (P-11)

describe("GitHub pull_request and status events (real route module)", () => {
  async function postEvent(route: typeof webhookRoute, event: string, body: string, headers: Record<string, string>) {
    const request = new Request(`http://localhost/projects/${identifier}/github/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": event, ...headers },
      body,
    });
    const response = (await route.action({ request, params: { identifier }, context: {} } as never)) as Response;
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
  }
  const prBody = (action: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      action,
      repository: { full_name: "Acme/Widgets" },
      pull_request: { number: 7, title: `Fix login for #${cardNumber}`, body: "see also #999", html_url: "https://github.com/acme/widgets/pull/7", state: "open", merged: false, user: { login: "dave" }, ...extra },
    });
  const links = () => db.select().from(pullRequestLinks).where(eq(pullRequestLinks.projectId, projectId)).all();
  const murmurBodies = () => db.select({ body: murmurs.body }).from(murmurs).where(eq(murmurs.projectId, projectId)).all().map((m) => m.body);

  it("links an opened pull request to the cards its title and body mention, murmurs it as github, then follows it to merged", async () => {
    const { secret } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    const opened = await postEvent(webhookRoute, "pull_request", prBody("opened"), { "X-Hub-Signature-256": sign(secret, prBody("opened")) });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ ok: true, event: "pull_request", linked: 1, murmurs: 1 });
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ cardId, repository: "acme/widgets", number: 7, title: `Fix login for #${cardNumber}`, state: "open", authorLogin: "dave" });
    expect(murmurBodies()).toEqual([expect.stringContaining("Pull request [#7 Fix login for")]);
    expect(murmurBodies()[0]).toContain("opened by dave");
    expect(murmurBodies()[0]).toContain(`Cards: #${cardNumber}`);
    expect(events("PullRequestLinked")).toHaveLength(1);
    expect(events("GithubPullRequestReceived")).toHaveLength(1);

    // An edit refreshes the link without a murmur; a merge updates the state and murmurs once more.
    const edited = prBody("edited", { title: `Fix login for #${cardNumber} (retitled)` });
    expect((await postEvent(webhookRoute, "pull_request", edited, { "X-Hub-Signature-256": sign(secret, edited) })).body).toMatchObject({ linked: 1, murmurs: 0 });
    expect(links()[0].title).toBe(`Fix login for #${cardNumber} (retitled)`);
    const merged = prBody("closed", { state: "closed", merged: true, merged_at: "2026-08-29T10:00:00Z" });
    expect((await postEvent(webhookRoute, "pull_request", merged, { "X-Hub-Signature-256": sign(secret, merged) })).body).toMatchObject({ linked: 1, murmurs: 1 });
    expect(links()).toHaveLength(1);
    expect(links()[0].state).toBe("merged");
    expect(murmurBodies()[1]).toContain("merged by dave");
    expect(events("PullRequestLinked")).toHaveLength(1);
    // The card page lists it.
    expect(pullRequestLinksForCard(db, cardId, cardNumber)).toEqual([expect.objectContaining({ number: 7, state: "merged", cardNumber })]);
  });

  it("refuses an unsigned pull_request, links nothing for one mentioning no card, and answers 400 for a malformed one", async () => {
    const { secret } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    expect((await postEvent(webhookRoute, "pull_request", prBody("opened"), { "X-Hub-Signature-256": sign("wrong", prBody("opened")) })).status).toBe(401);
    expect(links()).toEqual([]);
    const unrelated = JSON.stringify({ action: "opened", repository: { full_name: "acme/widgets" }, pull_request: { number: 8, title: "Docs", body: "", html_url: "u", state: "open", user: { login: "x" } } });
    expect((await postEvent(webhookRoute, "pull_request", unrelated, { "X-Hub-Signature-256": sign(secret, unrelated) })).body).toMatchObject({ linked: 0, murmurs: 0 });
    expect(links()).toEqual([]);
    expect(murmurBodies()).toEqual([]);
    const malformed = JSON.stringify({ action: "opened", repository: { full_name: "acme/widgets" }, pull_request: { title: "no number" } });
    expect((await postEvent(webhookRoute, "pull_request", malformed, { "X-Hub-Signature-256": sign(secret, malformed) })).status).toBe(400);
  });

  it("records a status on the linked commit, murmurs a non-pending state, and ignores statuses for unlinked commits", async () => {
    const { secret } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    const push = JSON.stringify({
      repository: { full_name: "acme/widgets" },
      commits: [{ id: "abc123def456", message: `Fix #${cardNumber}`, url: "https://github.com/acme/widgets/commit/abc123def456", timestamp: "2026-08-29T09:00:00Z", author: { name: "Dave", username: "dave" } }],
    });
    expect((await postEvent(webhookRoute, "push", push, { "X-Hub-Signature-256": sign(secret, push) })).status).toBe(200);
    db.delete(murmurs).run();
    const statusBody = (state: string, description: string) =>
      JSON.stringify({ repository: { full_name: "acme/widgets" }, sha: "abc123def456", state, context: "ci/build", description, target_url: "https://ci.example.test/1" });
    const pending = statusBody("pending", "Building");
    expect((await postEvent(webhookRoute, "status", pending, { "X-Hub-Signature-256": sign(secret, pending) })).body).toMatchObject({ event: "status", updated: 1, murmurs: 0 });
    expect(db.select().from(commitLinks).where(eq(commitLinks.projectId, projectId)).get()).toMatchObject({ statusState: "pending", statusContext: "ci/build", statusDescription: "Building", statusUrl: "https://ci.example.test/1" });
    const success = statusBody("success", "All green");
    expect((await postEvent(webhookRoute, "status", success, { "X-Hub-Signature-256": sign(secret, success) })).body).toMatchObject({ updated: 1, murmurs: 1 });
    const link = db.select().from(commitLinks).where(eq(commitLinks.projectId, projectId)).get()!;
    expect(link.statusState).toBe("success");
    expect(link.statusAt).not.toBeNull();
    expect(murmurBodies()).toEqual([expect.stringContaining("Status *success* for commit #rev-abc123def45")]);
    expect(murmurBodies()[0]).toContain(`Cards: #${cardNumber}`);
    expect(events("CommitStatusRecorded")).toHaveLength(2);
    expect(commitLinksForCard(db, cardId, cardNumber)[0].status).toEqual({ state: "success", context: "ci/build", description: "All green", url: "https://ci.example.test/1", reportedAt: link.statusAt!.toISOString() });

    const unlinked = JSON.stringify({ repository: { full_name: "acme/widgets" }, sha: "ffffffffffff", state: "failure", context: "ci/build", description: "boom" });
    expect((await postEvent(webhookRoute, "status", unlinked, { "X-Hub-Signature-256": sign(secret, unlinked) })).body).toMatchObject({ updated: 0, murmurs: 0 });
    expect(murmurBodies()).toHaveLength(1);
    expect((await postEvent(webhookRoute, "status", success, { "X-Hub-Signature-256": sign("wrong", success) })).status).toBe(401);
  });
});

// ---------------------------------------- GitLab and Bitbucket receivers (P-12)

describe("receiveGithubPullRequest / receiveGithubStatus reject a disabled registration", () => {
  it("writes nothing for a disabled or unknown integration", () => {
    const { row } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "configure");
    db.update(githubIntegrations).set({ enabled: false }).where(eq(githubIntegrations.id, row.id)).run();
    const pr = receiveGithubPullRequest(db, { integrationId: row.id, payload: { repository: "acme/widgets", action: "opened", number: 1, title: `#${cardNumber}`, body: "", url: "u", state: "open", authorLogin: null } });
    expect(pr.ok).toBe(false);
    const status = receiveGithubStatus(db, { integrationId: row.id, payload: { repository: "acme/widgets", sha: "abc", state: "success", context: "ci", description: "", targetUrl: null } });
    expect(status.ok).toBe(false);
    expect(receiveGithubPullRequest(db, { integrationId: 999, payload: { repository: "x/y", action: "opened", number: 1, title: "", body: "", url: "", state: "open", authorLogin: null } }).ok).toBe(false);
    expect(db.select().from(pullRequestLinks).all()).toEqual([]);
    expect(db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).all()).toEqual([]);
    expect(events("GithubPullRequestReceived")).toEqual([]);
    expect(events("GithubStatusReceived")).toEqual([]);
  });
});

describe("GitLab and Bitbucket push receivers (real route modules)", () => {
  async function postTo(route: { action: (args: never) => Promise<unknown> }, provider: string, body: string, headers: Record<string, string>) {
    const request = new Request(`http://localhost/projects/${identifier}/${provider}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    const response = (await route.action({ request, params: { identifier }, context: {} } as never)) as Response;
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
  }
  const linkedShas = () => db.select({ sha: commitLinks.sha, cardId: commitLinks.cardId }).from(commitLinks).where(eq(commitLinks.projectId, projectId)).all();
  const murmurAuthors = () =>
    db.select({ login: users.login }).from(murmurs).innerJoin(users, eq(users.id, murmurs.authorUserId)).where(eq(murmurs.projectId, projectId)).all().map((m) => m.login);

  it("GitLab: a push with the registration's token links commits to cards and murmurs as gitlab; a wrong or missing token is 401", async () => {
    const { secret, row } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "group/app", provider: "gitlab", actorUserId: adminId }), "register");
    expect(row.provider).toBe("gitlab");
    expect(db.select().from(users).where(eq(users.login, "gitlab")).get()?.name).toBe("GitLab");
    const body = JSON.stringify({
      object_kind: "push",
      project: { path_with_namespace: "Group/App" },
      commits: [
        { id: "1111aaaa2222bbbb", message: `Implement #${cardNumber}\n\nDetails`, url: "https://gitlab.example.test/group/app/-/commit/1111aaaa", timestamp: "2026-08-29T08:00:00+00:00", author: { name: "Gia", email: "gia@example.test" } },
        { id: "3333cccc", message: "unrelated", url: "https://gitlab.example.test/group/app/-/commit/3333cccc", timestamp: "2026-08-29T08:01:00+00:00", author: { name: "Gia", email: "gia@example.test" } },
      ],
    });
    expect((await postTo(gitlabRoute, "gitlab", body, { "X-Gitlab-Token": "nope", "X-Gitlab-Event": "Push Hook" })).status).toBe(401);
    expect((await postTo(gitlabRoute, "gitlab", body, { "X-Gitlab-Event": "Push Hook" })).status).toBe(401);
    expect(linkedShas()).toEqual([]);

    const ok = await postTo(gitlabRoute, "gitlab", body, { "X-Gitlab-Token": secret, "X-Gitlab-Event": "Push Hook" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, commits: 2, linked: 1, murmurs: 2 });
    expect(linkedShas()).toEqual([{ sha: "1111aaaa2222bbbb", cardId }]);
    const link = db.select().from(commitLinks).where(eq(commitLinks.projectId, projectId)).get()!;
    expect(link).toMatchObject({ repository: "group/app", authorName: "Gia", url: "https://gitlab.example.test/group/app/-/commit/1111aaaa" });
    expect(murmurAuthors()).toEqual(["gitlab", "gitlab"]);
    expect(db.select().from(githubIntegrations).where(eq(githubIntegrations.id, row.id)).get()!.lastReceivedAt).not.toBeNull();
    // Redelivery is skipped whole; another hook kind is ignored; a repository registered on GitHub does not answer GitLab.
    expect((await postTo(gitlabRoute, "gitlab", body, { "X-Gitlab-Token": secret, "X-Gitlab-Event": "Push Hook" })).body).toMatchObject({ skipped: 2, linked: 0 });
    expect((await postTo(gitlabRoute, "gitlab", body, { "X-Gitlab-Token": secret, "X-Gitlab-Event": "Tag Push Hook" })).body).toMatchObject({ ignored: true });
    mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "acme/widgets", actorUserId: adminId }), "github registration");
    const other = JSON.stringify({ object_kind: "push", project: { path_with_namespace: "acme/widgets" }, commits: [] });
    expect((await postTo(gitlabRoute, "gitlab", other, { "X-Gitlab-Token": secret })).status).toBe(404);
  });

  it("Bitbucket: a push signed with the registration's secret links commits and murmurs as bitbucket; a wrong or missing signature is 401", async () => {
    const { secret } = mustOk(configureGithubIntegration(db, sealer, { projectId, repository: "team/repo", provider: "bitbucket", actorUserId: adminId }), "register");
    const body = JSON.stringify({
      repository: { full_name: "Team/Repo" },
      push: {
        changes: [
          {
            commits: [
              { hash: "deadbeef0001", message: `Closes #${cardNumber}`, date: "2026-08-29T07:00:00+00:00", author: { raw: "Bea Bit <bea@example.test>", user: { display_name: "Bea Bit", nickname: "bea" } }, links: { html: { href: "https://bitbucket.org/team/repo/commits/deadbeef0001" } } },
            ],
          },
          { commits: [{ hash: "deadbeef0001", message: "duplicate in a second change", date: "2026-08-29T07:00:00+00:00", author: { raw: "x <x@y>" }, links: {} }] },
        ],
      },
    });
    expect((await postTo(bitbucketRoute, "bitbucket", body, { "X-Hub-Signature": sign("wrong", body), "X-Event-Key": "repo:push" })).status).toBe(401);
    expect((await postTo(bitbucketRoute, "bitbucket", body, { "X-Event-Key": "repo:push" })).status).toBe(401);
    expect(linkedShas()).toEqual([]);

    const ok = await postTo(bitbucketRoute, "bitbucket", body, { "X-Hub-Signature": sign(secret, body), "X-Event-Key": "repo:push" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, commits: 1, linked: 1, murmurs: 1 });
    expect(linkedShas()).toEqual([{ sha: "deadbeef0001", cardId }]);
    const link = db.select().from(commitLinks).where(eq(commitLinks.projectId, projectId)).get()!;
    expect(link).toMatchObject({ repository: "team/repo", authorName: "Bea Bit", authorLogin: "bea", url: "https://bitbucket.org/team/repo/commits/deadbeef0001" });
    expect(murmurAuthors()).toEqual(["bitbucket"]);
    expect(db.select().from(murmurs).where(eq(murmurs.projectId, projectId)).get()!.body).toContain("[bea](mailto:bea@example.test)");
    expect((await postTo(bitbucketRoute, "bitbucket", body, { "X-Hub-Signature": sign(secret, body), "X-Event-Key": "pullrequest:created" })).body).toMatchObject({ ignored: true });
    expect((await postTo(bitbucketRoute, "bitbucket", "{nope", { "X-Hub-Signature": sign(secret, "{nope") })).status).toBe(400);
  });
});

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
    expect(slackRow()).toMatchObject({ channelLabel: "#dev", enabled: true, isDefault: true });
    const added = await post(adminId, { intent: "slack-add", webhookUrl: receiverUrl.replace("B000", "B001"), channelLabel: "#cards", enabled: "on" });
    expect(added.data?.saved).toBe("slack-add");
    const secondId = db.select().from(slackIntegrations).where(eq(slackIntegrations.channelLabel, "#cards")).get()!.id;
    const routed = await post(adminId, { intent: "slack-routes", "route[card.created]": String(secondId), "route[murmur.murmured]": "suppressed", "route[page.created]": "default" });
    expect(routed.data?.saved).toBe("slack-routes");
    expect(db.select().from(slackEventRoutes).where(eq(slackEventRoutes.projectId, projectId)).all().map((r) => [r.eventType, r.slackIntegrationId])).toEqual([
      ["card.created", secondId], ["murmur.murmured", null],
    ]);
    const promoted = await post(adminId, { intent: "slack-default", integrationId: String(secondId) });
    expect(promoted.data?.saved).toBe("slack-default");
    expect(db.select().from(slackIntegrations).where(eq(slackIntegrations.id, secondId)).get()!.isDefault).toBe(true);

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
