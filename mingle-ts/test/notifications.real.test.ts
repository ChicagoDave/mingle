/**
 * Real-path test for history notifications (rule 13a — Phase 22
 * acceptance gate).
 *
 * Purpose: proves the production path end to end with nothing swapped
 * out: a real card change writes a real `jobs` row through the real
 * outbox call; the real worker loop (`ensureJobWorker`) and the real
 * handler registry (`jobHandlers`) drain it; the real SMTP mailer
 * delivers over TCP to a Mailpit server; and the assertion reads the
 * message back out of Mailpit's inbox over its HTTP API. No stubs, no
 * injection — the mailer is built from the same environment variables
 * the container reads.
 *
 * Precondition: Mailpit is reachable — `docker compose -f compose.yaml -f compose.dev.yaml up -d mailpit`
 * in mingle-ts/ (SMTP on 1025, API on 8025). MAILPIT_SMTP_HOST,
 * MAILPIT_SMTP_PORT and MAILPIT_API_URL override the defaults. Run via
 * `npm run test:realpath`.
 *
 * Owner context: Collaboration verification (integration reality).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const SMTP_HOST = process.env.MAILPIT_SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = process.env.MAILPIT_SMTP_PORT ?? "1025";
const MAILPIT_API = (process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025").replace(/\/+$/, "");

// The production modules read these at import/first use, exactly as
// the container does — set them before anything below is imported.
const dir = mkdtempSync(join(tmpdir(), "mingle-notifications-real-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "notifications-real-secret";
process.env.SMTP_HOST = SMTP_HOST;
process.env.SMTP_PORT = SMTP_PORT;
process.env.SMTP_FROM = "mingle@realpath.test";
process.env.SITE_URL = "http://mingle.realpath.test";

const { db, sqlite } = await import("../app/db/client.server");
const { jobs } = await import("../app/db/schema/jobs");
const { cardTypes } = await import("../app/db/schema/cards");
const { registerUser } = await import("../app/domain/identity/commands.server");
const { addTeamMember } = await import("../app/domain/identity/membership.server");
const { createProject } = await import("../app/domain/projects/commands.server");
const { createCard } = await import("../app/domain/cards/commands.server");
const { subscribe } = await import("../app/domain/subscriptions/commands.server");
const { HISTORY_NOTIFICATIONS_JOB } = await import("../app/domain/notifications.server");
const { jobHandlers } = await import("../app/jobs/handlers.server");
const { ensureJobWorker } = await import("../app/jobs/worker.server");

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: unknown };

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Mailpit's search endpoint, filtered to one recipient. */
async function inboxFor(address: string): Promise<MailpitSummary[]> {
  const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages: MailpitSummary[] };
  return body.messages;
}

/** One message's full content from Mailpit. */
async function messageText(id: string): Promise<{ Subject: string; Text: string; From: { Address: string } }> {
  const res = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit message fetch failed: ${res.status}`);
  return (await res.json()) as { Subject: string; Text: string; From: { Address: string } };
}

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the job worker");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("history notification through the real queue, worker, SMTP and Mailpit inbox", () => {
  it("a card change runs a real job that lands a real email in Mailpit", async () => {
    // A unique recipient per run, so an inbox left over from an earlier
    // run cannot satisfy the assertion.
    const stamp = Date.now().toString(36);
    const recipient = `dev-${stamp}@realpath.test`;
    const bossId = mustOk(
      registerUser(db, { login: `boss${stamp}`, name: "Boss", email: `boss-${stamp}@realpath.test`, password: "real-path-22!" }),
      "boss",
    ).id;
    const devId = mustOk(
      registerUser(db, { login: `dev${stamp}`, name: "Dev", email: recipient, password: "real-path-22!" }),
      "dev",
    ).id;
    const project = mustOk(
      createProject(db, { name: "Real Path", identifier: `real_path_${stamp}`, actorUserId: bossId }),
      "project",
    );
    mustOk(addTeamMember(db, { projectId: project.id, userId: devId, role: "full_member", actorUserId: bossId }), "member");
    mustOk(subscribe(db, { projectId: project.id, filter: { kind: "project" }, actorUserId: devId }), "subscribe");
    db.delete(jobs).run();

    const typeId = db.select({ id: cardTypes.id }).from(cardTypes).where(eq(cardTypes.projectId, project.id)).get()!.id;
    const cardName = `Real path card ${stamp}`;
    const card = mustOk(
      createCard(db, { projectId: project.id, name: cardName, cardTypeId: typeId, actorUserId: bossId }),
      "card",
    );

    // The trigger wrote a real job row.
    const queued = db.select().from(jobs).all();
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe(HISTORY_NOTIFICATIONS_JOB);
    expect(queued[0].status).toBe("pending");

    // The real worker loop drains it through the real handler registry.
    const stop = ensureJobWorker(db, jobHandlers, 100);
    try {
      await until(() => db.select().from(jobs).where(eq(jobs.id, queued[0].id)).get()!.status !== "pending", 10_000);
      await until(() => db.select().from(jobs).where(eq(jobs.id, queued[0].id)).get()!.status !== "running", 10_000);
    } finally {
      stop();
    }
    const finished = db.select().from(jobs).where(eq(jobs.id, queued[0].id)).get()!;
    expect(finished.lastError).toBeNull();
    expect(finished.status).toBe("done");

    // And the email is in the mail server's inbox.
    const inbox = await inboxFor(recipient);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].To.map((t) => t.Address)).toEqual([recipient]);
    const expectedSubject = `Card #${card.number} ${cardName} created by Boss`;
    expect(inbox[0].Subject).toBe(expectedSubject);
    const message = await messageText(inbox[0].ID);
    expect(message.From.Address).toBe("mingle@realpath.test");
    expect(message.Text).toContain(`http://mingle.realpath.test/projects/${project.identifier}/cards/${card.number}`);
    expect(message.Text).toContain("Real Path history");
  });
});
