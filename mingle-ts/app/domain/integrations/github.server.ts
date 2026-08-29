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
 *   ReceiveGithubPullRequest   → GithubPullRequestReceived, PullRequestLinked (per link)
 *   ReceiveGithubStatus        → GithubStatusReceived, CommitStatusRecorded (per link)
 *
 * Since P-12 a registration names its SCM `provider` (github, gitlab,
 * bitbucket); the GitLab and Bitbucket receivers verify and normalize
 * their payloads (scm-receivers.server.ts) and share `receiveGithubPush`,
 * each provider's murmurs authored by its own system user.
 *
 * Public interface: `GITHUB_SYSTEM_LOGIN`, `configureGithubIntegration`,
 * `parsePullRequestPayload`, `receiveGithubPullRequest`,
 * `parseStatusPayload`, `receiveGithubStatus`,
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
import { commitLinks, githubCommits, githubIntegrations, type GithubIntegrationRow, pullRequestLinks } from "~/db/schema/integrations";
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
import { SCM_SYSTEM_USERS } from "~/domain/integrations/scm-receivers.server";
import { SCM_PROVIDERS, type ScmProvider } from "~/shared/wire-types";

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
  /** The SCM host; defaults to GitHub. */
  provider?: ScmProvider;
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
  const provider: ScmProvider = input.provider ?? "github";
  if (!(SCM_PROVIDERS as readonly string[]).includes(provider)) return reject("provider", "is not a supported SCM host");
  const taken = db
    .select({ id: githubIntegrations.id })
    .from(githubIntegrations)
    .where(and(eq(githubIntegrations.projectId, input.projectId), eq(githubIntegrations.repository, repository)))
    .get();
  if (taken) return reject("repository", "has already been registered");

  const secret = randomBytes(32).toString("base64url");
  try {
    return db.transaction((tx) => {
    const github = ensureSystemUser(tx, { ...SCM_SYSTEM_USERS[provider], actorUserId: input.actorUserId });
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
      .values({ projectId: input.projectId, provider, repository, secretSealed: sealer.seal(secret), createdByUserId: input.actorUserId })
      .returning()
      .get();
    emitEvent(tx, {
      type: "GithubIntegrationConfigured",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { repository, provider },
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
    const github = ensureSystemUser(tx, { ...SCM_SYSTEM_USERS[integration.provider as ScmProvider], actorUserId: integration.createdByUserId });
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
      payload: { provider: integration.provider, repository: input.payload.repository, commits: input.payload.commits.length, skipped, linked, murmurs: murmurCount },
      actorUserId: github.id,
    });
    return { ok: true, value: { commits: input.payload.commits.length, skipped, linked, murmurs: murmurCount } } as CommandResult<GithubPushOutcome>;
  });
}

// ---------------------------------------------------------- pull requests

/** A pull_request event, reduced to what is used (P-11). */
export interface PullRequestPayload {
  /** "owner/name", lowercase. */
  repository: string;
  /** GitHub's `action`: opened, closed, reopened, edited, synchronize, ready_for_review, ... */
  action: string;
  number: number;
  title: string;
  body: string;
  url: string;
  /** "open", "closed", or "merged". */
  state: string;
  authorLogin: string | null;
}

/**
 * Reduces a GitHub pull_request-event body to `PullRequestPayload`.
 *
 * @returns the payload, or null when the body is not a pull_request
 *   event (no `pull_request.number`, `action`, or repository)
 */
export function parsePullRequestPayload(body: unknown): PullRequestPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as { action?: unknown; repository?: { full_name?: unknown }; pull_request?: Record<string, unknown> };
  const fullName = raw.repository?.full_name;
  const pr = raw.pull_request;
  if (typeof fullName !== "string" || typeof raw.action !== "string" || !pr || typeof pr.number !== "number") return null;
  const user = (pr.user ?? {}) as Record<string, unknown>;
  const merged = pr.merged === true || (typeof pr.merged_at === "string" && pr.merged_at !== "");
  return {
    repository: fullName.toLowerCase(),
    action: raw.action,
    number: pr.number,
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    url: typeof pr.html_url === "string" ? pr.html_url : "",
    state: merged ? "merged" : pr.state === "closed" ? "closed" : "open",
    authorLogin: typeof user.login === "string" ? user.login : null,
  };
}

export interface ReceiveGithubPullRequestInput {
  integrationId: number;
  payload: PullRequestPayload;
}

export interface GithubPullRequestOutcome {
  /** pull request→card links written or updated. */
  linked: number;
  murmurs: number;
}

/** The actions worth a murmur; edits and pushes to the branch only refresh the links. */
const MURMURED_PR_ACTIONS: Record<string, string> = {
  opened: "opened",
  reopened: "reopened",
  ready_for_review: "marked ready for review",
  closed: "closed",
};

/**
 * ReceiveGithubPullRequest — records a verified pull_request event.
 *
 * DOES: finds the project's live cards whose numbers the title or body
 * reference (`#123`) and upserts one `pull_request_links` row per card
 * (title, url, state and author refreshed on every event; appending
 * PullRequestLinked when a link is new); for an opened, reopened,
 * ready-for-review, closed, or merged event posts one murmur as the
 * provider's system user naming the pull request and its cards; stamps
 * `last_received_at`; appends GithubPullRequestReceived; all in one
 * transaction. An event referencing no card writes no link and no
 * murmur.
 * REJECTS: unknown or disabled integration.
 */
export function receiveGithubPullRequest(db: BetterSQLite3Database, input: ReceiveGithubPullRequestInput): CommandResult<GithubPullRequestOutcome> {
  const integration = db.select().from(githubIntegrations).where(eq(githubIntegrations.id, input.integrationId)).get();
  if (!integration || !integration.enabled) return reject("repository", "is not registered for this project");
  const { payload } = input;
  return db.transaction((tx) => {
    const github = ensureSystemUser(tx, { ...SCM_SYSTEM_USERS[integration.provider as ScmProvider], actorUserId: integration.createdByUserId });
    const numbers = cardNumbersInText(`${payload.title}\n${payload.body}`);
    const targets =
      numbers.length === 0
        ? []
        : tx
            .select({ id: cards.id, number: cards.number })
            .from(cards)
            .where(and(eq(cards.projectId, integration.projectId), inArray(cards.number, numbers)))
            .all();
    let linked = 0;
    for (const card of targets) {
      const existing = tx
        .select({ id: pullRequestLinks.id })
        .from(pullRequestLinks)
        .where(and(eq(pullRequestLinks.githubIntegrationId, integration.id), eq(pullRequestLinks.number, payload.number), eq(pullRequestLinks.cardId, card.id)))
        .get();
      const values = { title: payload.title, url: payload.url, state: payload.state, authorLogin: payload.authorLogin, updatedAt: new Date() };
      if (existing) {
        tx.update(pullRequestLinks).set(values).where(eq(pullRequestLinks.id, existing.id)).run();
      } else {
        tx.insert(pullRequestLinks)
          .values({ projectId: integration.projectId, cardId: card.id, githubIntegrationId: integration.id, repository: payload.repository, number: payload.number, ...values })
          .run();
        emitEvent(tx, {
          type: "PullRequestLinked",
          aggregateType: "Card",
          aggregateId: card.id,
          payload: { cardNumber: card.number, repository: payload.repository, number: payload.number },
          actorUserId: github.id,
        });
      }
      linked += 1;
    }
    let murmurs = 0;
    const verb = payload.action === "closed" && payload.state === "merged" ? "merged" : MURMURED_PR_ACTIONS[payload.action];
    if (verb && targets.length > 0) {
      const by = payload.authorLogin ? ` by ${payload.authorLogin}` : "";
      const body = [
        `Pull request [#${payload.number} ${payload.title}](${payload.url}) ${verb}${by} (${payload.repository})`,
        `Cards: ${targets.map((card) => `#${card.number}`).join(", ")}`,
      ].join("\n");
      if (postMurmur(tx, { projectId: integration.projectId, body, actorUserId: github.id }).ok) murmurs += 1;
    }
    tx.update(githubIntegrations).set({ lastReceivedAt: new Date() }).where(eq(githubIntegrations.id, integration.id)).run();
    emitEvent(tx, {
      type: "GithubPullRequestReceived",
      aggregateType: "Project",
      aggregateId: integration.projectId,
      payload: { repository: payload.repository, number: payload.number, action: payload.action, state: payload.state, linked, murmurs },
      actorUserId: github.id,
    });
    return { ok: true, value: { linked, murmurs } } as CommandResult<GithubPullRequestOutcome>;
  });
}

// ---------------------------------------------------------------- statuses

/** A status event, reduced to what is used (P-11). */
export interface StatusPayload {
  /** "owner/name", lowercase. */
  repository: string;
  sha: string;
  /** "success", "failure", "error", or "pending". */
  state: string;
  context: string;
  description: string;
  targetUrl: string | null;
}

/**
 * Reduces a GitHub status-event body to `StatusPayload`.
 *
 * @returns the payload, or null when the body is not a status event
 *   (no `sha`, `state`, or repository)
 */
export function parseStatusPayload(body: unknown): StatusPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown> & { repository?: { full_name?: unknown } };
  const fullName = raw.repository?.full_name;
  if (typeof fullName !== "string" || typeof raw.sha !== "string" || typeof raw.state !== "string") return null;
  return {
    repository: fullName.toLowerCase(),
    sha: raw.sha,
    state: raw.state,
    context: typeof raw.context === "string" ? raw.context : "default",
    description: typeof raw.description === "string" ? raw.description : "",
    targetUrl: typeof raw.target_url === "string" && raw.target_url ? raw.target_url : null,
  };
}

export interface ReceiveGithubStatusInput {
  integrationId: number;
  payload: StatusPayload;
}

export interface GithubStatusOutcome {
  /** commit→card links the status was recorded on. */
  updated: number;
  murmurs: number;
}

/**
 * ReceiveGithubStatus — records a verified commit status.
 *
 * DOES: for every `commit_links` row of this integration with the
 * payload's SHA, sets the status columns (state, context, description,
 * URL, now) and appends CommitStatusRecorded; for a non-pending state
 * with at least one link posts one murmur as the provider's system
 * user naming the commit, the state, and the cards; stamps
 * `last_received_at`; appends GithubStatusReceived; all in one
 * transaction. A status for an unlinked commit records nothing but the
 * receipt.
 * REJECTS: unknown or disabled integration.
 */
export function receiveGithubStatus(db: BetterSQLite3Database, input: ReceiveGithubStatusInput): CommandResult<GithubStatusOutcome> {
  const integration = db.select().from(githubIntegrations).where(eq(githubIntegrations.id, input.integrationId)).get();
  if (!integration || !integration.enabled) return reject("repository", "is not registered for this project");
  const { payload } = input;
  return db.transaction((tx) => {
    const github = ensureSystemUser(tx, { ...SCM_SYSTEM_USERS[integration.provider as ScmProvider], actorUserId: integration.createdByUserId });
    const links = tx
      .select({ id: commitLinks.id, cardId: commitLinks.cardId, cardNumber: cards.number })
      .from(commitLinks)
      .innerJoin(cards, eq(cards.id, commitLinks.cardId))
      .where(and(eq(commitLinks.githubIntegrationId, integration.id), eq(commitLinks.sha, payload.sha)))
      .all();
    const now = new Date();
    for (const link of links) {
      tx.update(commitLinks)
        .set({ statusState: payload.state, statusContext: payload.context, statusDescription: payload.description, statusUrl: payload.targetUrl, statusAt: now })
        .where(eq(commitLinks.id, link.id))
        .run();
      emitEvent(tx, {
        type: "CommitStatusRecorded",
        aggregateType: "Card",
        aggregateId: link.cardId,
        payload: { cardNumber: link.cardNumber, sha: payload.sha, state: payload.state, context: payload.context },
        actorUserId: github.id,
      });
    }
    let murmurs = 0;
    if (links.length > 0 && payload.state !== "pending") {
      const target = payload.targetUrl ? ` ([details](${payload.targetUrl}))` : "";
      const body = [
        `Status *${payload.state}* for commit #rev-${payload.sha.slice(0, 11)} — ${payload.context}${payload.description ? `: ${payload.description}` : ""}${target} (${payload.repository})`,
        `Cards: ${links.map((link) => `#${link.cardNumber}`).join(", ")}`,
      ].join("\n");
      if (postMurmur(tx, { projectId: integration.projectId, body, actorUserId: github.id }).ok) murmurs += 1;
    }
    tx.update(githubIntegrations).set({ lastReceivedAt: new Date() }).where(eq(githubIntegrations.id, integration.id)).run();
    emitEvent(tx, {
      type: "GithubStatusReceived",
      aggregateType: "Project",
      aggregateId: integration.projectId,
      payload: { repository: payload.repository, sha: payload.sha, state: payload.state, context: payload.context, updated: links.length, murmurs },
      actorUserId: github.id,
    });
    return { ok: true, value: { updated: links.length, murmurs } } as CommandResult<GithubStatusOutcome>;
  });
}
