/**
 * GitHub integration — repositories that push to a project, and the
 * commit→card links their pushes create (Phase 32), ported from
 * legacy `github_controller.rb` / `github.rb`.
 *
 * Purpose: the inbound half of the External Integrations context. A
 * project admin registers a repository; GitHub is configured (by the
 * admin, on GitHub) to POST push events to this site with a secret
 * this module minted. Each commit whose message references a card
 * (`#123`) is linked to that card, and — legacy `receive` parity — is
 * murmured into the project by the "github" system user.
 *
 * Legacy created the GitHub webhook through GitHub's API using the
 * github user's API key as the signing secret; that call is EXTERNAL
 * and is not made here — the admin pastes the payload URL and secret
 * into GitHub instead, and the secret is per repository and sealed
 * (ADR-0020).
 *
 * Commands → events:
 *   ConfigureGithubIntegration → GithubIntegrationConfigured
 *   RemoveGithubIntegration    → GithubIntegrationRemoved
 *   ReceiveGithubPush          → GithubPushReceived, CommitLinked (per link)
 *
 * Public interface: `GITHUB_SYSTEM_LOGIN`, `configureGithubIntegration`,
 * `removeGithubIntegration`, `verifyGithubSignature`, `parsePushPayload`,
 * `receiveGithubPush`.
 *
 * Owner context: External Integrations. Takes the Drizzle handle and
 * the sealer as parameters; the route verifies the signature and
 * hands the parsed payload in.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { commitLinks, githubCommits, githubIntegrations, type GithubIntegrationRow } from "~/db/schema/integrations";
import { teamMemberships } from "~/db/schema/membership";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { addTeamMember } from "~/domain/identity/membership.server";
import type { Sealer } from "~/domain/identity/sealer.server";
import { ensureSystemUser } from "~/domain/identity/system-users.server";
import { postMurmur } from "~/domain/murmurs/commands.server";
import { cardNumbersInText } from "~/domain/text-references.server";

/** The system account that authors commit murmurs (legacy: "github"). */
export const GITHUB_SYSTEM_LOGIN = "github";

const REPOSITORY_FORMAT = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Carries a nested command's rejection out of a transaction so it rolls back. */
class IntegrationRejected extends Error {
  constructor(readonly errors: Record<string, string[]>) {
    super("integration command rejected");
  }
}

// --------------------------------------------------------------- commands

export interface ConfigureGithubIntegrationInput {
  projectId: number;
  /** "owner/name". */
  repository: string;
  actorUserId: number;
}

/** What ConfigureGithubIntegration hands back — the only place the secret exists. */
export interface ConfiguredGithubIntegration {
  /** The webhook secret to paste into GitHub; shown once. */
  secret: string;
  row: GithubIntegrationRow;
}

/**
 * ConfigureGithubIntegration — registers a repository for a project.
 *
 * DOES: ensures the "github" system user exists and is a full team
 * member of the project (so its commit murmurs are accepted with no
 * wider privilege — a departure from legacy, which made it a site
 * admin); inserts a `github_integrations` row with a fresh 256-bit
 * secret sealed; appends GithubIntegrationConfigured naming the
 * repository — never the secret; in one transaction.
 * REJECTS: unknown project; actor below project administrator; a
 * repository not of the form owner/name; a repository already
 * registered for the project.
 *
 * @returns the secret (once) and the row, or field errors
 */
export function configureGithubIntegration(
  db: BetterSQLite3Database,
  sealer: Sealer,
  input: ConfigureGithubIntegrationInput,
): CommandResult<ConfiguredGithubIntegration> {
  if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get())
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const repository = input.repository.trim().toLowerCase();
  if (!REPOSITORY_FORMAT.test(repository)) return reject("repository", "must be owner/name");
  const taken = db
    .select({ id: githubIntegrations.id })
    .from(githubIntegrations)
    .where(and(eq(githubIntegrations.projectId, input.projectId), eq(githubIntegrations.repository, repository)))
    .get();
  if (taken) return reject("repository", "has already been registered");

  const secret = randomBytes(32).toString("base64url");
  try {
    return db.transaction((tx) => {
    const github = ensureSystemUser(tx, { login: GITHUB_SYSTEM_LOGIN, name: "GitHub", actorUserId: input.actorUserId });
    const member = tx
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.projectId, input.projectId), eq(teamMemberships.userId, github.id)))
      .get();
    if (!member) {
      const added = addTeamMember(tx, { projectId: input.projectId, userId: github.id, role: "full_member", actorUserId: input.actorUserId });
      // Thrown, not returned: a rejection returned from inside the
      // transaction would commit the system user written above.
      if (!added.ok) throw new IntegrationRejected(added.errors);
    }
    const row = tx
      .insert(githubIntegrations)
      .values({ projectId: input.projectId, repository, secretSealed: sealer.seal(secret), createdByUserId: input.actorUserId })
      .returning()
      .get();
    emitEvent(tx, {
      type: "GithubIntegrationConfigured",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { repository },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { secret, row } } as CommandResult<ConfiguredGithubIntegration>;
    });
  } catch (error) {
    if (error instanceof IntegrationRejected) return { ok: false, errors: error.errors };
    throw error;
  }
}

export interface RemoveGithubIntegrationInput {
  projectId: number;
  integrationId: number;
  actorUserId: number;
}

/**
 * RemoveGithubIntegration — unregisters a repository.
 *
 * DOES: deletes the `github_integrations` row (commit links it created
 * are kept — they are history) and appends GithubIntegrationRemoved,
 * in one transaction.
 * REJECTS: actor below project administrator; an integration not of
 * this project.
 */
export function removeGithubIntegration(
  db: BetterSQLite3Database,
  input: RemoveGithubIntegrationInput,
): CommandResult<GithubIntegrationRow> {
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;
  const existing = db
    .select()
    .from(githubIntegrations)
    .where(and(eq(githubIntegrations.id, input.integrationId), eq(githubIntegrations.projectId, input.projectId)))
    .get();
  if (!existing) return reject("repository", "is not registered for this project");
  return db.transaction((tx) => {
    tx.delete(githubIntegrations).where(eq(githubIntegrations.id, existing.id)).run();
    emitEvent(tx, {
      type: "GithubIntegrationRemoved",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { repository: existing.repository },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: existing } as CommandResult<GithubIntegrationRow>;
  });
}

// -------------------------------------------------------------- signature

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (`sha256=<hex>`) over
 * the raw request body, timing-safely.
 *
 * @param secret - the webhook secret in the clear
 * @param rawBody - the exact bytes GitHub sent
 * @param header - the header value, or null when absent
 */
export function verifyGithubSignature(secret: string, rawBody: string | Uint8Array, header: string | null): boolean {
  const match = header ? /^sha256=([0-9a-f]{64})$/i.exec(header.trim()) : null;
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const presented = Buffer.from(match[1], "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

// ---------------------------------------------------------------- payload

/** One commit of a push, as this module needs it. */
export interface PushCommit {
  sha: string;
  message: string;
  url: string;
  authorName: string;
  authorLogin: string | null;
  authorEmail: string | null;
  committedAt: Date;
}

/** A push event, reduced to what is used. */
export interface PushPayload {
  /** "owner/name", lowercase. */
  repository: string;
  commits: PushCommit[];
}

/**
 * Reduces a GitHub push-event body to `PushPayload`.
 *
 * @returns the payload, or null when the body is not a push (no
 *   `repository.full_name` or no `commits` array)
 */
export function parsePushPayload(body: unknown): PushPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as { repository?: { full_name?: unknown }; commits?: unknown };
  const fullName = raw.repository?.full_name;
  if (typeof fullName !== "string" || !Array.isArray(raw.commits)) return null;
  const commits: PushCommit[] = [];
  for (const item of raw.commits as Record<string, unknown>[]) {
    if (typeof item?.id !== "string" || typeof item.message !== "string") continue;
    const author = (item.author ?? {}) as Record<string, unknown>;
    const committedAt = typeof item.timestamp === "string" ? new Date(item.timestamp) : new Date();
    commits.push({
      sha: item.id,
      message: item.message,
      url: typeof item.url === "string" ? item.url : "",
      authorName: typeof author.name === "string" && author.name ? author.name : "unknown",
      authorLogin: typeof author.username === "string" ? author.username : null,
      authorEmail: typeof author.email === "string" ? author.email : null,
      committedAt: Number.isNaN(committedAt.getTime()) ? new Date() : committedAt,
    });
  }
  return { repository: fullName.toLowerCase(), commits };
}

// ---------------------------------------------------------------- receive

export interface ReceiveGithubPushInput {
  integrationId: number;
  payload: PushPayload;
}

export interface GithubPushOutcome {
  commits: number;
  /** Commits already received from this repository (a redelivery), skipped whole. */
  skipped: number;
  /** commit→card links written. */
  linked: number;
  murmurs: number;
}

/** Legacy `receive`'s murmur body for one commit. */
function commitMurmurBody(commit: PushCommit, repository: string): string {
  const author = commit.authorEmail
    ? `Author: [${commit.authorLogin ?? commit.authorName}](mailto:${commit.authorEmail})`
    : `Author: ${commit.authorLogin ?? commit.authorName}`;
  return [
    author,
    commit.message,
    `commit [#rev-${commit.sha.slice(0, 11)}](${commit.url}) (${repository})`,
    `Date: ${commit.committedAt.toISOString()}`,
  ].join("\n");
}

/**
 * ReceiveGithubPush — records a verified push.
 *
 * DOES: for each commit not yet received from this repository (a
 * `github_commits` row per SHA — a redelivered commit is skipped whole,
 * so nothing is linked or murmured twice), finds the project's live
 * cards whose numbers the message references (`#123`, the murmur
 * convention) and inserts one `commit_links` row per card, appending
 * CommitLinked for each; posts one murmur per commit as the "github"
 * user in legacy's format (author, message, `#rev-<sha>` link, date)
 * — a murmur the system user may not post (it was removed from the
 * team) is skipped, the links are the record; stamps the integration's
 * `last_received_at`; appends GithubPushReceived with the counts; all
 * in one transaction.
 * REJECTS: unknown or disabled integration.
 *
 * @returns the counts, or field errors
 */
export function receiveGithubPush(db: BetterSQLite3Database, input: ReceiveGithubPushInput): CommandResult<GithubPushOutcome> {
  const integration = db.select().from(githubIntegrations).where(eq(githubIntegrations.id, input.integrationId)).get();
  if (!integration || !integration.enabled) return reject("repository", "is not registered for this project");
  return db.transaction((tx) => {
    const github = ensureSystemUser(tx, { login: GITHUB_SYSTEM_LOGIN, name: "GitHub", actorUserId: integration.createdByUserId });
    let linked = 0;
    let murmurCount = 0;
    let skipped = 0;
    for (const commit of input.payload.commits) {
      const fresh = tx
        .insert(githubCommits)
        .values({ githubIntegrationId: integration.id, sha: commit.sha })
        .onConflictDoNothing()
        .returning({ id: githubCommits.id })
        .get();
      if (!fresh) {
        skipped += 1;
        continue;
      }
      const numbers = cardNumbersInText(commit.message);
      const targets =
        numbers.length === 0
          ? []
          : tx
              .select({ id: cards.id, number: cards.number })
              .from(cards)
              .where(and(eq(cards.projectId, integration.projectId), inArray(cards.number, numbers)))
              .all();
      for (const card of targets) {
        const inserted = tx
          .insert(commitLinks)
          .values({
            projectId: integration.projectId,
            cardId: card.id,
            githubIntegrationId: integration.id,
            repository: input.payload.repository,
            sha: commit.sha,
            url: commit.url,
            authorName: commit.authorName,
            authorLogin: commit.authorLogin,
            message: commit.message,
            committedAt: commit.committedAt,
          })
          .onConflictDoNothing()
          .returning({ id: commitLinks.id })
          .get();
        if (!inserted) continue;
        linked += 1;
        emitEvent(tx, {
          type: "CommitLinked",
          aggregateType: "Card",
          aggregateId: card.id,
          payload: { cardNumber: card.number, repository: input.payload.repository, sha: commit.sha },
          actorUserId: github.id,
        });
      }
      const murmured = postMurmur(tx, {
        projectId: integration.projectId,
        body: commitMurmurBody(commit, input.payload.repository),
        actorUserId: github.id,
      });
      if (murmured.ok) murmurCount += 1;
    }
    tx.update(githubIntegrations).set({ lastReceivedAt: new Date() }).where(eq(githubIntegrations.id, integration.id)).run();
    emitEvent(tx, {
      type: "GithubPushReceived",
      aggregateType: "Project",
      aggregateId: integration.projectId,
      payload: { repository: input.payload.repository, commits: input.payload.commits.length, skipped, linked, murmurs: murmurCount },
      actorUserId: github.id,
    });
    return { ok: true, value: { commits: input.payload.commits.length, skipped, linked, murmurs: murmurCount } } as CommandResult<GithubPushOutcome>;
  });
}
