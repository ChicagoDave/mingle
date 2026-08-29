/**
 * Behavioral tests for history subscriptions, the job queue, and
 * notification delivery (Phase 22).
 *
 * Derived from the phase's exit criterion: a triggering history event
 * causes a real job to run through the jobs table and an email to be
 * sent, verified against persisted rows and delivered messages — not
 * against whether a function was called. Every fixture is produced by
 * the real domain commands against a real file-backed SQLite database
 * created with the real generated migrations.
 *
 * The mailer here is a capturing one, so the suite can assert on
 * message content and simulate a refusing relay deterministically.
 * That makes this a SCAFFOLDING suite for the SMTP half (rule 13a);
 * the real SMTP path — the same handler registry and the same queue,
 * delivering into a Mailpit inbox — is `notifications.real.test.ts`.
 *
 * The route section drives the actual `projects.subscriptions.tsx`
 * loader and action with a Request carrying a real session cookie
 * (the Phase 21 recipe), asserting on the Response and the rows.
 *
 * Owner context: Collaboration verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Must be set BEFORE app/db/client.server is first imported: it resolves
// the database file at module load and applies migrations there.
const dir = mkdtempSync(join(tmpdir(), "mingle-subscriptions-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "subscriptions-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const subscriptionsRoute = await import("../app/routes/projects.subscriptions");

const { projects } = await import("../app/db/schema/projects");
const { users } = await import("../app/db/schema/identity");
const { teamMemberships } = await import("../app/db/schema/membership");
const { cards, cardTypes, cardVersions } = await import("../app/db/schema/cards");
const { pages, pageVersions } = await import("../app/db/schema/pages");
const { cardMurmurLinks, murmurMentions, murmurs } = await import(
  "../app/db/schema/murmurs"
);
const { domainEvents } = await import("../app/db/schema/events");
const { jobs } = await import("../app/db/schema/jobs");
const { historySubscriptions } = await import("../app/db/schema/subscriptions");
const { dependencies, dependencyResolvingCards, dependencyVersions } = await import(
  "../app/db/schema/dependencies"
);
const { linkResolvingCards, raiseDependency } = await import("../app/domain/dependencies/commands.server");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard, defineCardType, deleteCard, updateCard } = await import(
  "../app/domain/cards/commands.server"
);
const { createPage, deletePage, updatePage } = await import(
  "../app/domain/pages/commands.server"
);
const { addCardComment, postMurmur } = await import(
  "../app/domain/murmurs/commands.server"
);
const { subscribe, unsubscribe } = await import(
  "../app/domain/subscriptions/commands.server"
);
const { listSubscriptions } = await import("../app/domain/subscriptions/read.server");
const { deliverHistoryNotifications } = await import(
  "../app/domain/subscriptions/notify.server"
);
const { enqueueJob, recoverStaleJobs, runPendingJobs } = await import(
  "../app/jobs/queue.server"
);
const { HISTORY_NOTIFICATIONS_JOB, INTEGRATION_DELIVERIES_JOB } = await import("../app/domain/notifications.server");
const { historyCursor } = await import("../app/domain/history/read.server");

type MailMessage = import("../app/mail/mailer.server").MailMessage;
type Mailer = import("../app/mail/mailer.server").Mailer;
type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number;
let devId: number;
let readerId: number;
let noMailId: number;
let outsiderId: number;
let projectId: number;
let projectIdentifier: string;
let projectName: string;
let defaultTypeId: number;

function register(login: string, email: string | null): number {
  const result = registerUser(db, {
    login,
    name: login.toUpperCase(),
    email,
    password: "subscriptions-phase-22!",
  });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function mustReject<T>(result: CommandResult<T>, what: string): Record<string, string[]> {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return result.errors;
}

/** A Mailer that keeps what it sent and can be told to refuse a message. */
function capturingMailer(refuse?: (message: MailMessage, index: number) => boolean) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      if (refuse?.(message, sent.length)) throw new Error("relay refused the message");
      sent.push(message);
    },
  };
  return { sent, mailer };
}

function projectRef() {
  return { id: projectId, identifier: projectIdentifier, name: projectName };
}

function newCard(name: string, actor = adminId, cardTypeId = defaultTypeId) {
  return mustOk(createCard(db, { projectId, name, cardTypeId, actorUserId: actor }), name);
}

function subscription(id: number) {
  return db.select().from(historySubscriptions).where(eq(historySubscriptions.id, id)).get()!;
}

function pendingJobs() {
  return db.select().from(jobs).where(eq(jobs.status, "pending")).all();
}

function eventsOfType(type: string) {
  return db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(jobs).run();
  db.delete(historySubscriptions).run();
  db.delete(dependencyResolvingCards).run();
  db.delete(dependencyVersions).run();
  db.delete(dependencies).run();
  db.delete(cardMurmurLinks).run();
  db.delete(murmurMentions).run();
  db.delete(murmurs).run();
  db.delete(pageVersions).run();
  db.delete(pages).run();
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss", "boss@example.test");
  devId = register("dev", "dev@example.test");
  readerId = register("reader", "reader@example.test");
  noMailId = register("nomail", null);
  outsiderId = register("outsider", "outsider@example.test");
  const project = mustOk(
    createProject(db, { name: "History Land", identifier: "history_land", actorUserId: adminId }),
    "test project creation",
  );
  projectId = project.id;
  projectIdentifier = project.identifier;
  projectName = project.name;
  defaultTypeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  for (const [userId, role] of [
    [devId, "full_member"],
    [readerId, "readonly_member"],
    [noMailId, "full_member"],
  ] as const) {
    mustOk(addTeamMember(db, { projectId, userId, role, actorUserId: adminId }), "membership");
  }
  // Commands above scheduled delivery jobs; the queue tests want a clean table.
  db.delete(jobs).run();
});

// ----------------------------------------------------------- job queue

describe("job queue", () => {
  const NOW = new Date("2026-08-27T12:00:00Z");

  it("enqueueJob persists a pending job with its payload and schedule", () => {
    const row = enqueueJob(db, { type: "ping", payload: { n: 1 }, runAt: NOW });
    expect(row).not.toBeNull();
    const stored = db.select().from(jobs).where(eq(jobs.id, row!.id)).get()!;
    expect(stored.status).toBe("pending");
    expect(JSON.parse(stored.payload)).toEqual({ n: 1 });
    expect(stored.runAt.getTime()).toBe(NOW.getTime());
    expect(stored.attempts).toBe(0);
    expect(stored.maxAttempts).toBe(5);
    expect(stored.dedupeKey).toBeNull();
  });

  it("a second enqueue with the same dedupe key is absorbed while the first is pending, and accepted once it is done", async () => {
    const first = enqueueJob(db, { type: "ping", payload: {}, dedupeKey: "ping:1" });
    const second = enqueueJob(db, { type: "ping", payload: {}, dedupeKey: "ping:1" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(db.select().from(jobs).all()).toHaveLength(1);

    await runPendingJobs(db, { ping: () => {} });
    expect(db.select().from(jobs).where(eq(jobs.id, first!.id)).get()!.status).toBe("done");
    const third = enqueueJob(db, { type: "ping", payload: {}, dedupeKey: "ping:1" });
    expect(third).not.toBeNull();
    expect(db.select().from(jobs).all()).toHaveLength(2);
  });

  it("runPendingJobs runs the handler with the parsed payload and marks the job done", async () => {
    const job = enqueueJob(db, { type: "ping", payload: { hello: "world" }, runAt: NOW })!;
    const seen: unknown[] = [];
    const report = await runPendingJobs(db, { ping: (_db, payload) => void seen.push(payload) }, { now: NOW });
    expect(seen).toEqual([{ hello: "world" }]);
    expect(report).toEqual({ ran: 1, succeeded: 1, retried: 0, failed: 0 });
    const stored = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(stored.status).toBe("done");
    expect(stored.attempts).toBe(1);
    expect(stored.finishedAt).not.toBeNull();
    expect(stored.lastError).toBeNull();
  });

  it("a failing handler reschedules the job with backoff and records the error", async () => {
    const job = enqueueJob(db, { type: "ping", payload: {}, runAt: NOW })!;
    let calls = 0;
    const handlers = {
      ping: () => {
        calls++;
        throw new Error("boom");
      },
    };
    const report = await runPendingJobs(db, handlers, { now: NOW });
    expect(report).toEqual({ ran: 1, succeeded: 0, retried: 1, failed: 0 });
    const stored = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(stored.status).toBe("pending");
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toBe("boom");
    expect(stored.lockedAt).toBeNull();
    expect(stored.runAt.getTime()).toBe(NOW.getTime() + 30_000);

    // Not claimable until the backoff has passed.
    expect((await runPendingJobs(db, handlers, { now: NOW })).ran).toBe(0);
    expect(calls).toBe(1);
    const later = new Date(NOW.getTime() + 30_000);
    expect((await runPendingJobs(db, handlers, { now: later })).ran).toBe(1);
    expect(calls).toBe(2);
    // Second failure waits four times as long.
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.runAt.getTime()).toBe(
      later.getTime() + 120_000,
    );
  });

  it("a job exhausting max_attempts is failed for good", async () => {
    const job = enqueueJob(db, { type: "ping", payload: {}, runAt: NOW, maxAttempts: 1 })!;
    const report = await runPendingJobs(
      db,
      {
        ping: () => {
          throw new Error("still broken");
        },
      },
      { now: NOW },
    );
    expect(report.failed).toBe(1);
    const stored = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(stored.status).toBe("failed");
    expect(stored.lastError).toBe("still broken");
    expect(stored.finishedAt).not.toBeNull();
    expect((await runPendingJobs(db, { ping: () => {} }, { now: new Date(NOW.getTime() + 3_600_000) })).ran).toBe(0);
  });

  it("a job with no registered handler fails immediately rather than retrying", async () => {
    const job = enqueueJob(db, { type: "mystery", payload: {}, runAt: NOW })!;
    const report = await runPendingJobs(db, {}, { now: NOW });
    expect(report).toEqual({ ran: 1, succeeded: 0, retried: 0, failed: 1 });
    const stored = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(stored.status).toBe("failed");
    expect(stored.lastError).toContain('no handler registered for job type "mystery"');
  });

  it("a job scheduled for the future is not claimed, and older jobs run first", async () => {
    enqueueJob(db, { type: "ping", payload: { n: "future" }, runAt: new Date(NOW.getTime() + 60_000) });
    enqueueJob(db, { type: "ping", payload: { n: "second" }, runAt: new Date(NOW.getTime() - 1_000) });
    enqueueJob(db, { type: "ping", payload: { n: "first" }, runAt: new Date(NOW.getTime() - 2_000) });
    const order: string[] = [];
    await runPendingJobs(db, { ping: (_db, p) => void order.push(String(p.n)) }, { now: NOW });
    expect(order).toEqual(["first", "second"]);
    expect(pendingJobs().map((j) => JSON.parse(j.payload).n)).toEqual(["future"]);
  });

  it("recoverStaleJobs returns jobs a dead process left running to pending", () => {
    const job = enqueueJob(db, { type: "ping", payload: {} })!;
    db.update(jobs).set({ status: "running", lockedAt: new Date() }).where(eq(jobs.id, job.id)).run();
    expect(recoverStaleJobs(db)).toBe(1);
    const stored = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(stored.status).toBe("pending");
    expect(stored.lockedAt).toBeNull();
  });
});

// ------------------------------------------- scheduling from commands

describe("history-writing commands schedule delivery", () => {
  it("creating a card enqueues one history_notifications job for the project, and further changes collapse into it", () => {
    const card = newCard("Fix login");
    mustOk(
      updateCard(db, {
        projectId,
        cardNumber: card.number,
        name: "Fix login page",
        cardTypeId: defaultTypeId,
        actorUserId: adminId,
      }),
      "update",
    );
    // Since Phase 32 the outbox call schedules the email job and the
    // integration (Slack) job side by side, each collapsed per project.
    const pending = pendingJobs().sort((a, b) => a.type.localeCompare(b.type));
    expect(pending.map((j) => j.type)).toEqual([HISTORY_NOTIFICATIONS_JOB, INTEGRATION_DELIVERIES_JOB]);
    for (const job of pending) {
      expect(JSON.parse(job.payload)).toEqual({ projectId });
      expect(job.dedupeKey).toBe(`${job.type}:${projectId}`);
    }
  });

  it("every history-writing command schedules delivery", () => {
    const card = newCard("Card A");
    const page = mustOk(
      createPage(db, { projectId, name: "Release Notes", content: "<p>v1</p>", actorUserId: adminId }),
      "page",
    );
    const steps: [string, () => unknown][] = [
      ["addCardComment", () => addCardComment(db, { projectId, cardNumber: card.number, body: "note", actorUserId: adminId })],
      ["postMurmur", () => postMurmur(db, { projectId, body: "hello", actorUserId: adminId })],
      ["updatePage", () => updatePage(db, { projectId, identifier: "Release_Notes", content: "<p>v2</p>", actorUserId: adminId })],
      ["deletePage", () => deletePage(db, { projectId, identifier: "Release_Notes", actorUserId: adminId })],
      ["deleteCard", () => deleteCard(db, { projectId, cardNumber: card.number, actorUserId: adminId })],
    ];
    for (const [name, run] of steps) {
      db.delete(jobs).run();
      mustOk(run() as CommandResult<unknown>, name);
      expect(pendingJobs().map((j) => j.type).sort(), name).toEqual([HISTORY_NOTIFICATIONS_JOB, INTEGRATION_DELIVERIES_JOB]);
    }
  });

  it("a rejected command schedules nothing", () => {
    mustReject(createCard(db, { projectId, name: "   ", cardTypeId: defaultTypeId, actorUserId: adminId }), "blank card");
    expect(pendingJobs()).toHaveLength(0);
  });
});

// ------------------------------------------------------------ subscribe

describe("subscribe", () => {
  it("persists a project subscription starting at the current end of every trail, and records HistorySubscribed", () => {
    newCard("Before");
    mustOk(createPage(db, { projectId, name: "Before", content: "<p>x</p>", actorUserId: adminId }), "page");
    mustOk(postMurmur(db, { projectId, body: "before", actorUserId: adminId }), "murmur");
    const expected = historyCursor(db, projectId);
    expect(expected.cardVersionId).toBeGreaterThan(0);
    expect(expected.pageVersionId).toBeGreaterThan(0);
    expect(expected.murmurId).toBeGreaterThan(0);

    const row = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const stored = subscription(row.id);
    expect(stored.userId).toBe(devId);
    expect(stored.projectId).toBe(projectId);
    expect(stored.kind).toBe("project");
    expect(stored.filterKey).toBe("project");
    expect(stored.cardNumber).toBeNull();
    expect(stored.pageIdentifier).toBeNull();
    expect(stored.mql).toBeNull();
    expect(stored.lastCardVersionId).toBe(expected.cardVersionId);
    expect(stored.lastPageVersionId).toBe(expected.pageVersionId);
    expect(stored.lastMurmurId).toBe(expected.murmurId);
    expect(stored.lastError).toBeNull();

    const events = eventsOfType("HistorySubscribed");
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(row.id);
    expect(JSON.parse(events[0].payload)).toEqual({ projectId, userId: devId, filter: { kind: "project" } });
  });

  it("a card subscription stores the card number and rejects a card that does not exist", () => {
    const card = newCard("Watched");
    const row = mustOk(
      subscribe(db, { projectId, filter: { kind: "card", cardNumber: card.number }, actorUserId: devId }),
      "card subscription",
    );
    expect(subscription(row.id)).toMatchObject({ kind: "card", cardNumber: card.number, filterKey: `card:${card.number}` });
    expect(
      mustReject(subscribe(db, { projectId, filter: { kind: "card", cardNumber: 999 }, actorUserId: devId }), "missing card"),
    ).toEqual({ card: ["does not exist"] });
  });

  it("a page subscription stores the page identifier and rejects a page that does not exist", () => {
    mustOk(createPage(db, { projectId, name: "Release Notes", content: "<p>x</p>", actorUserId: adminId }), "page");
    const row = mustOk(
      subscribe(db, { projectId, filter: { kind: "page", pageIdentifier: "Release_Notes" }, actorUserId: devId }),
      "page subscription",
    );
    expect(subscription(row.id)).toMatchObject({ kind: "page", pageIdentifier: "Release_Notes", filterKey: "page:release_notes" });
    expect(
      mustReject(subscribe(db, { projectId, filter: { kind: "page", pageIdentifier: "Nope" }, actorUserId: devId }), "missing page"),
    ).toEqual({ page: ["does not exist"] });
  });

  it("an MQL subscription stores the trimmed condition and rejects blank, unparseable, or non-condition MQL", () => {
    mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story type");
    const row = mustOk(
      subscribe(db, { projectId, filter: { kind: "mql", mql: "  Type = Story  " }, actorUserId: devId }),
      "mql subscription",
    );
    expect(subscription(row.id)).toMatchObject({ kind: "mql", mql: "Type = Story", filterKey: "mql:type = story" });

    expect(mustReject(subscribe(db, { projectId, filter: { kind: "mql", mql: "   " }, actorUserId: devId }), "blank")).toEqual({
      mql: ["can't be blank"],
    });
    const unknown = mustReject(
      subscribe(db, { projectId, filter: { kind: "mql", mql: "Nonsense = 1" }, actorUserId: devId }),
      "unknown property",
    );
    expect(unknown.mql?.length).toBeGreaterThan(0);
    const select = mustReject(
      subscribe(db, { projectId, filter: { kind: "mql", mql: "SELECT name WHERE Type = Story" }, actorUserId: devId }),
      "select",
    );
    expect(select.mql?.[0]).toContain("condition only");
    expect(db.select().from(historySubscriptions).all()).toHaveLength(1);
  });

  it("rejects a subscriber without an email address, a non-member, and an unknown project", () => {
    expect(mustReject(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: noMailId }), "no email")).toEqual({
      email: ["must be set on your profile before subscribing"],
    });
    expect(
      mustReject(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: outsiderId }), "outsider").authorization,
    ).toBeDefined();
    expect(mustReject(subscribe(db, { projectId: 424242, filter: { kind: "project" }, actorUserId: devId }), "no project")).toEqual({
      project: ["does not exist"],
    });
    expect(db.select().from(historySubscriptions).all()).toHaveLength(0);
  });

  it("a read-only member may subscribe; the same filter twice is one subscription, however it is spelled", () => {
    mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story type");
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: readerId }), "reader subscribes");
    expect(mustReject(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: readerId }), "dup")).toEqual({
      subscription: ["already exists"],
    });
    mustOk(subscribe(db, { projectId, filter: { kind: "mql", mql: "Type = Story" }, actorUserId: readerId }), "mql");
    expect(
      mustReject(subscribe(db, { projectId, filter: { kind: "mql", mql: "  TYPE   =  story " }, actorUserId: readerId }), "dup mql"),
    ).toEqual({ subscription: ["already exists"] });
    expect(db.select().from(historySubscriptions).all()).toHaveLength(2);
  });
});

// ---------------------------------------------------------- unsubscribe

describe("unsubscribe", () => {
  it("the owner removes the row and HistoryUnsubscribed is recorded; a peer cannot; an admin can", () => {
    const mine = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "dev");
    const readers = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: readerId }), "reader");

    expect(
      mustReject(unsubscribe(db, { projectId, subscriptionId: readers.id, actorUserId: devId }), "peer").authorization,
    ).toBeDefined();
    expect(subscription(readers.id)).toBeDefined();

    mustOk(unsubscribe(db, { projectId, subscriptionId: mine.id, actorUserId: devId }), "owner");
    expect(db.select().from(historySubscriptions).where(eq(historySubscriptions.id, mine.id)).get()).toBeUndefined();
    const events = eventsOfType("HistoryUnsubscribed");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({ projectId, userId: devId });

    mustOk(unsubscribe(db, { projectId, subscriptionId: readers.id, actorUserId: adminId }), "admin");
    expect(db.select().from(historySubscriptions).all()).toHaveLength(0);
    expect(mustReject(unsubscribe(db, { projectId, subscriptionId: readers.id, actorUserId: adminId }), "gone")).toEqual({
      subscription: ["does not exist"],
    });
  });
});

// ------------------------------------------------------------- delivery

describe("delivery", () => {
  it("a project subscriber is emailed once per fresh entry, the cursor advances, and a re-run sends nothing", async () => {
    const sub = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const card = newCard("Fix login");
    const { sent, mailer } = capturingMailer();

    const report = await deliverHistoryNotifications(db, mailer, { projectId, siteUrl: "https://mingle.example/" });
    expect(report).toEqual({ subscriptions: 1, entries: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("dev@example.test");
    expect(sent[0].subject).toBe(`Card #${card.number} Fix login created by BOSS`);
    expect(sent[0].text).toContain(`https://mingle.example/projects/${projectIdentifier}/cards/${card.number}`);
    expect(sent[0].text).toContain("History Land history");
    expect(sent[0].text).toContain(`https://mingle.example/projects/${projectIdentifier}/subscriptions`);

    const versionId = db
      .select({ id: cardVersions.id })
      .from(cardVersions)
      .where(eq(cardVersions.cardId, card.id))
      .get()!.id;
    expect(subscription(sub.id).lastCardVersionId).toBe(versionId);
    const events = eventsOfType("HistoryNotificationSent");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      projectId,
      userId: devId,
      entryId: `card-${versionId}`,
      subscriptionIds: [sub.id],
      to: "dev@example.test",
    });

    expect((await deliverHistoryNotifications(db, mailer, { projectId })).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("a later subscription does not hear about an entry its earlier sibling still owes", async () => {
    // A: subscribed, then a card happens, not yet delivered. B: subscribed
    // AFTER the card, so its cursor sits exactly on that entry. The batch
    // is read from A's (older) cursor, so the entry is in it — and only A
    // may claim it.
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "A");
    const card = newCard("Owed to A only");
    mustOk(subscribe(db, { projectId, filter: { kind: "card", cardNumber: card.number }, actorUserId: devId }), "B");
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("  - History Land history");
    expect(sent[0].text).not.toContain(`  - Card #${card.number}`);
  });

  it("history from before the subscription is never delivered", async () => {
    newCard("Old news");
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const { sent, mailer } = capturingMailer();
    expect((await deliverHistoryNotifications(db, mailer, { projectId })).sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("a card subscription hears only about its card, and its cursor still moves past the rest", async () => {
    const watched = newCard("Watched");
    const other = newCard("Other");
    const sub = mustOk(
      subscribe(db, { projectId, filter: { kind: "card", cardNumber: watched.number }, actorUserId: devId }),
      "subscribe",
    );
    for (const card of [other, watched]) {
      mustOk(
        updateCard(db, { projectId, cardNumber: card.number, name: `${card.name} v2`, cardTypeId: defaultTypeId, actorUserId: adminId }),
        "update",
      );
    }
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent.map((m) => m.subject)).toEqual([`Card #${watched.number} Watched v2 changed by BOSS`]);
    expect(sent[0].text).toContain(`Card #${watched.number}`);
    expect(subscription(sub.id).lastCardVersionId).toBe(historyCursor(db, projectId).cardVersionId);
  });

  it("a page subscription hears about its page edits and nothing else", async () => {
    mustOk(createPage(db, { projectId, name: "Release Notes", content: "<p>v1</p>", actorUserId: adminId }), "page");
    mustOk(createPage(db, { projectId, name: "Other Page", content: "<p>v1</p>", actorUserId: adminId }), "other page");
    // Subscribed under a differently-cased identifier: page lookup is
    // case-insensitive, so matching must be too.
    mustOk(subscribe(db, { projectId, filter: { kind: "page", pageIdentifier: "RELEASE_Notes" }, actorUserId: devId }), "subscribe");
    mustOk(updatePage(db, { projectId, identifier: "Other_Page", content: "<p>v2</p>", actorUserId: adminId }), "other edit");
    mustOk(updatePage(db, { projectId, identifier: "Release_Notes", content: "<p>v2</p>", actorUserId: adminId }), "edit");
    newCard("Unrelated");
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent.map((m) => m.subject)).toEqual(["Page Release Notes changed by BOSS"]);
    expect(sent[0].text).toContain("Page Release Notes");
  });

  it("an MQL subscription is evaluated against the card as it stands, with CURRENT USER bound to the subscriber", async () => {
    const storyTypeId = mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story").id;
    mustOk(subscribe(db, { projectId, filter: { kind: "mql", mql: "Type = Story" }, actorUserId: devId }), "subscribe");
    newCard("A task", adminId, defaultTypeId);
    const story = newCard("A story", adminId, storyTypeId);
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent.map((m) => m.subject)).toEqual([`Card #${story.number} A story created by BOSS`]);
    expect(sent[0].text).toContain('Cards matching "Type = Story"');
  });

  it("a filter that no longer parses stops delivering and records why; it recovers when fixed", async () => {
    mustOk(defineCardType(db, { projectId, name: "Story", actorUserId: adminId }), "Story");
    const sub = mustOk(subscribe(db, { projectId, filter: { kind: "mql", mql: "Type = Story" }, actorUserId: devId }), "subscribe");
    // A property renamed underneath the subscription, simulated directly.
    db.update(historySubscriptions).set({ mql: "Vanished = 1" }).where(eq(historySubscriptions.id, sub.id)).run();
    newCard("Anything");
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent).toHaveLength(0);
    expect(subscription(sub.id).lastError).toBeTruthy();
    // Considered, not delivered: the cursor moved past the entry.
    expect(subscription(sub.id).lastCardVersionId).toBe(historyCursor(db, projectId).cardVersionId);

    db.update(historySubscriptions).set({ mql: "Type = Card" }).where(eq(historySubscriptions.id, sub.id)).run();
    newCard("After fix");
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent).toHaveLength(1);
    expect(subscription(sub.id).lastError).toBeNull();
  });

  it("a card comment is delivered once, as the card entry carrying the comment; a stream murmur is delivered as a murmur", async () => {
    const card = newCard("Discussed");
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    mustOk(addCardComment(db, { projectId, cardNumber: card.number, body: "looks good", actorUserId: adminId }), "comment");
    mustOk(postMurmur(db, { projectId, body: "shipping today", actorUserId: adminId }), "murmur");
    const { sent, mailer } = capturingMailer();
    const report = await deliverHistoryNotifications(db, mailer, { projectId });
    expect(report.sent).toBe(2);
    // Written in the same millisecond, so their relative order is the
    // feed's tie-break — assert the set, not the order.
    expect(sent.map((m) => m.subject).sort()).toEqual(
      [`Card #${card.number} Discussed commented by BOSS`, "Murmur in History Land murmured by BOSS"].sort(),
    );
    const comment = sent.find((m) => m.subject.startsWith("Card"))!;
    const murmur = sent.find((m) => m.subject.startsWith("Murmur"))!;
    expect(comment.text).toContain("Comment:\nlooks good");
    expect(murmur.text).toContain("Murmur:\nshipping today");
  });

  it("two subscriptions that agree on an entry produce one email naming both", async () => {
    const card = newCard("Doubly watched");
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "project");
    mustOk(subscribe(db, { projectId, filter: { kind: "card", cardNumber: card.number }, actorUserId: devId }), "card");
    mustOk(
      updateCard(db, { projectId, cardNumber: card.number, name: "Doubly watched v2", cardTypeId: defaultTypeId, actorUserId: adminId }),
      "update",
    );
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("  - History Land history");
    expect(sent[0].text).toContain(`  - Card #${card.number}`);
    const events = eventsOfType("HistoryNotificationSent");
    expect(JSON.parse(events[0].payload).subscriptionIds).toHaveLength(2);
  });

  it("each subscriber gets their own email; a subscriber who lost their address is skipped and told why", async () => {
    const devSub = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "dev");
    const readerSub = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: readerId }), "reader");
    db.update(users).set({ email: null }).where(eq(users.id, readerId)).run();
    newCard("For everyone");
    const { sent, mailer } = capturingMailer();
    await deliverHistoryNotifications(db, mailer, { projectId });
    expect(sent.map((m) => m.to)).toEqual(["dev@example.test"]);
    expect(subscription(readerSub.id).lastError).toBe("subscriber has no email address");
    expect(subscription(readerSub.id).lastCardVersionId).toBe(subscription(devSub.id).lastCardVersionId);
  });

  it("when the relay refuses mid-batch, accepted emails are not resent and the rest are retried", async () => {
    const sub = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const first = newCard("First");
    const second = newCard("Second");
    const refusing = capturingMailer((_message, index) => index === 1);
    await expect(deliverHistoryNotifications(db, refusing.mailer, { projectId })).rejects.toThrow("relay refused");
    expect(refusing.sent.map((m) => m.subject)).toEqual([`Card #${first.number} First created by BOSS`]);
    const firstVersionId = db.select({ id: cardVersions.id }).from(cardVersions).where(eq(cardVersions.cardId, first.id)).get()!.id;
    expect(subscription(sub.id).lastCardVersionId).toBe(firstVersionId);

    const working = capturingMailer();
    await deliverHistoryNotifications(db, working.mailer, { projectId });
    expect(working.sent.map((m) => m.subject)).toEqual([`Card #${second.number} Second created by BOSS`]);
  });

  it("a dependency's versions are delivered on the dependency trail, and a mid-batch refusal keeps the accepted one from being resent", async () => {
    const sub = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const raising = newCard("Needs help");
    const resolving = newCard("Helper");
    // Both projects are this one (legacy allowed it), so the whole trail is in scope.
    const raised = mustOk(
      raiseDependency(db, { raisingProjectId: projectId, raisingCardNumber: raising.number, name: "Need help", desiredEndDate: "2026-12-01", resolvingProjectId: projectId, actorUserId: adminId }),
      "raise",
    );
    mustOk(linkResolvingCards(db, { projectId, dependencyNumber: raised.number, cardNumbers: [resolving.number], actorUserId: adminId }), "link");
    const versionIds = db
      .select({ id: dependencyVersions.id })
      .from(dependencyVersions)
      .where(eq(dependencyVersions.dependencyId, raised.id))
      .all()
      .map((v) => v.id)
      .sort((a, b) => a - b);
    expect(versionIds).toHaveLength(2);

    // The two card creations are accepted; the dependency's first version is accepted; its second is refused.
    const refusing = capturingMailer((message) => message.subject.startsWith("Dependency D1") && message.subject.includes("changed"));
    await expect(deliverHistoryNotifications(db, refusing.mailer, { projectId })).rejects.toThrow("relay refused");
    // Entries written in the same millisecond order by kind, so only the set is stable.
    expect(refusing.sent.map((m) => m.subject).sort()).toEqual([
      `Card #${raising.number} Needs help created by BOSS`,
      `Card #${resolving.number} Helper created by BOSS`,
      "Dependency D1 Need help created by BOSS",
    ]);
    expect(subscription(sub.id).lastDependencyVersionId).toBe(versionIds[0]);

    const working = capturingMailer();
    await deliverHistoryNotifications(db, working.mailer, { projectId });
    expect(working.sent.map((m) => m.subject)).toEqual(["Dependency D1 Need help changed by BOSS"]);
    expect(subscription(sub.id).lastDependencyVersionId).toBe(versionIds[1]);
  });

  it("a sweep with no project visits every project that has subscriptions", async () => {
    const otherProject = mustOk(
      createProject(db, { name: "Other Land", identifier: "other_land", actorUserId: adminId }),
      "other project",
    );
    const otherTypeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, otherProject.id)).get()!.id;
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "here");
    mustOk(subscribe(db, { projectId: otherProject.id, filter: { kind: "project" }, actorUserId: adminId }), "there");
    newCard("Here");
    mustOk(createCard(db, { projectId: otherProject.id, name: "There", cardTypeId: otherTypeId, actorUserId: adminId }), "there card");
    const { sent, mailer } = capturingMailer();
    const report = await deliverHistoryNotifications(db, mailer);
    expect(report.subscriptions).toBe(2);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ["dev@example.test", "Card #1 Here created by BOSS"],
      ["boss@example.test", "Card #1 There created by BOSS"],
    ]);
  });

  it("end to end through the queue: a card change runs a real job that delivers the email", async () => {
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const card = newCard("Queued");
    const job = pendingJobs().find((j) => j.type === HISTORY_NOTIFICATIONS_JOB)!;
    expect(job).toBeDefined();

    const { sent, mailer } = capturingMailer();
    const report = await runPendingJobs(db, {
      [HISTORY_NOTIFICATIONS_JOB]: (handle, payload) =>
        deliverHistoryNotifications(handle, mailer, { projectId: Number(payload.projectId) }).then(() => undefined),
      // The integration job scheduled beside it is Phase 32's concern (test/integrations.behavior.test.ts).
      [INTEGRATION_DELIVERIES_JOB]: async () => undefined,
    });
    expect(report).toEqual({ ran: 2, succeeded: 2, retried: 0, failed: 0 });
    expect(db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe("done");
    expect(sent.map((m) => m.subject)).toEqual([`Card #${card.number} Queued created by BOSS`]);
  });
});

// --------------------------------------------------------------- routes

describe("/projects/:identifier/subscriptions (real route module)", () => {
  async function cookieFor(userId: number): Promise<string> {
    const session = await createUserSession(userId, "/");
    return session.headers.get("Set-Cookie")!;
  }

  /** What an action produced: a thrown redirect/error Response, or data() with its status. */
  interface ActionOutcome {
    status: number;
    location: string | null;
    data: unknown;
  }

  async function post(
    userId: number | null,
    identifier: string,
    fields: Record<string, string>,
  ): Promise<ActionOutcome> {
    const body = new URLSearchParams(fields);
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (userId !== null) headers.Cookie = await cookieFor(userId);
    const request = new Request(`http://localhost/projects/${identifier}/subscriptions`, { method: "POST", headers, body });
    try {
      const result = (await subscriptionsRoute.action({ request, params: { identifier }, context: {} } as never)) as unknown as {
        data: unknown;
        init: { status?: number } | null;
      };
      return { status: result.init?.status ?? 200, location: null, data: result.data };
    } catch (thrown) {
      if (thrown instanceof Response)
        return { status: thrown.status, location: thrown.headers.get("Location"), data: null };
      throw thrown;
    }
  }

  it("subscribing from a card page persists the row and redirects back to the card", async () => {
    const card = newCard("Routed");
    const response = await post(devId, projectIdentifier, {
      intent: "subscribe",
      kind: "card",
      card_number: String(card.number),
      returnTo: `/projects/${projectIdentifier}/cards/${card.number}`,
    });
    expect(response.status).toBe(302);
    expect(response.location).toBe(`/projects/${projectIdentifier}/cards/${card.number}`);
    const rows = db.select().from(historySubscriptions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: devId, kind: "card", cardNumber: card.number });
  });

  it("a rejected subscription answers 400 with the field errors and persists nothing", async () => {
    const response = await post(devId, projectIdentifier, { intent: "subscribe", kind: "card", card_number: "999" });
    expect(response.status).toBe(400);
    const payload = response.data as { ok: boolean; errors: Record<string, string[]> };
    expect(payload.ok).toBe(false);
    expect(payload.errors).toEqual({ card: ["does not exist"] });
    expect(db.select().from(historySubscriptions).all()).toHaveLength(0);
  });

  it("unsubscribing removes the row; an off-site returnTo falls back to the subscriptions page", async () => {
    const sub = mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    const response = await post(devId, projectIdentifier, {
      intent: "unsubscribe",
      id: String(sub.id),
      returnTo: "//evil.example/phish",
    });
    expect(response.status).toBe(302);
    expect(response.location).toBe(`/projects/${projectIdentifier}/subscriptions`);
    expect(db.select().from(historySubscriptions).all()).toHaveLength(0);
  });

  it("the loader lists the viewer's subscriptions with descriptions", async () => {
    const card = newCard("Listed");
    mustOk(subscribe(db, { projectId, filter: { kind: "card", cardNumber: card.number }, actorUserId: devId }), "dev");
    mustOk(subscribe(db, { projectId, filter: { kind: "project" }, actorUserId: readerId }), "reader");
    const request = new Request(`http://localhost/projects/${projectIdentifier}/subscriptions`, {
      headers: { Cookie: await cookieFor(devId) },
    });
    const loaded = (await subscriptionsRoute.loader({ request, params: { identifier: projectIdentifier }, context: {} } as never)) as {
      subscriptions: { description: string }[];
      hasEmail: boolean;
    };
    expect(loaded.subscriptions.map((s) => s.description)).toEqual([`Card #${card.number}`]);
    expect(loaded.hasEmail).toBe(true);
    expect(listSubscriptions(db, projectRef(), readerId).map((s) => s.description)).toEqual(["History Land history"]);
  });

  it("an unauthenticated poster is sent to login; an unknown project is 404; an unknown kind is 400", async () => {
    expect((await post(null, projectIdentifier, { intent: "subscribe", kind: "project" })).status).toBe(302);
    expect((await post(devId, "no_such_project", { intent: "subscribe", kind: "project" })).status).toBe(404);
    expect((await post(devId, projectIdentifier, { intent: "subscribe", kind: "everything" })).status).toBe(400);
    expect(db.select().from(historySubscriptions).all()).toHaveLength(0);
  });
});

