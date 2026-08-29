/**
 * SCM push receivers for GitLab and Bitbucket (P-12) — verification and
 * payload normalization, so both hosts feed the one ReceivePush path
 * the GitHub receiver established.
 *
 * Purpose: each host authenticates a webhook differently and shapes
 * its push payload differently; this module reduces both to what the
 * domain already knows: a verified request and a `PushPayload`.
 * Verification is per integration, against the sealed secret the
 * registration minted (ADR-0020) — GitLab sends the secret back
 * verbatim in `X-Gitlab-Token`; Bitbucket signs the raw body with it
 * as `X-Hub-Signature: sha256=<hex>`. Both comparisons are timing-safe.
 *
 * Public interface: `SCM_SYSTEM_USERS`, `verifyGitlabToken`,
 * `parseGitlabPushPayload`, `verifyBitbucketSignature`,
 * `parseBitbucketPushPayload`.
 *
 * Owner context: External Integrations (pure functions; no I/O).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PushCommit, PushPayload } from "~/domain/integrations/github.server";
import type { ScmProvider } from "~/shared/wire-types";

/** The system account that authors each host's commit murmurs (legacy: "github"). */
export const SCM_SYSTEM_USERS: Record<ScmProvider, { login: string; name: string }> = {
  github: { login: "github", name: "GitHub" },
  gitlab: { login: "gitlab", name: "GitLab" },
  bitbucket: { login: "bitbucket", name: "Bitbucket" },
};

/** Timing-safe equality of two strings. */
function sameSecret(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Verifies GitLab's `X-Gitlab-Token` header — the registration's secret
 * sent back verbatim.
 *
 * @param secret - the webhook secret in the clear
 * @param header - the header value, or null when absent
 */
export function verifyGitlabToken(secret: string, header: string | null): boolean {
  return header !== null && sameSecret(secret, header.trim());
}

/**
 * Reduces a GitLab push-hook body to `PushPayload`.
 *
 * @returns the payload, or null when the body is not a push (no
 *   `project.path_with_namespace` or no `commits` array)
 */
export function parseGitlabPushPayload(body: unknown): PushPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as { object_kind?: unknown; project?: { path_with_namespace?: unknown }; commits?: unknown };
  const path = raw.project?.path_with_namespace;
  if (typeof path !== "string" || !Array.isArray(raw.commits)) return null;
  if (raw.object_kind !== undefined && raw.object_kind !== "push") return null;
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
      authorLogin: null,
      authorEmail: typeof author.email === "string" ? author.email : null,
      committedAt: Number.isNaN(committedAt.getTime()) ? new Date() : committedAt,
    });
  }
  return { repository: path.toLowerCase(), commits };
}

/**
 * Verifies Bitbucket's `X-Hub-Signature` header (`sha256=<hex>`) over
 * the raw request body, timing-safely.
 *
 * @param secret - the webhook secret in the clear
 * @param rawBody - the exact bytes Bitbucket sent
 * @param header - the header value, or null when absent
 */
export function verifyBitbucketSignature(secret: string, rawBody: string | Uint8Array, header: string | null): boolean {
  const match = header ? /^sha256=([0-9a-f]{64})$/i.exec(header.trim()) : null;
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const presented = Buffer.from(match[1], "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

/**
 * Reduces a Bitbucket Cloud `repo:push` body to `PushPayload` — every
 * commit of every change in the push.
 *
 * @returns the payload, or null when the body is not a push (no
 *   `repository.full_name` or no `push.changes` array)
 */
export function parseBitbucketPushPayload(body: unknown): PushPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as { repository?: { full_name?: unknown }; push?: { changes?: unknown } };
  const fullName = raw.repository?.full_name;
  if (typeof fullName !== "string" || !Array.isArray(raw.push?.changes)) return null;
  const commits: PushCommit[] = [];
  const seen = new Set<string>();
  for (const change of raw.push.changes as Record<string, unknown>[]) {
    if (!Array.isArray(change?.commits)) continue;
    for (const item of change.commits as Record<string, unknown>[]) {
      if (typeof item?.hash !== "string" || typeof item.message !== "string" || seen.has(item.hash)) continue;
      seen.add(item.hash);
      const author = (item.author ?? {}) as { raw?: unknown; user?: { display_name?: unknown; nickname?: unknown } };
      const links = (item.links ?? {}) as { html?: { href?: unknown } };
      const rawAuthor = typeof author.raw === "string" ? author.raw : "";
      const email = /<([^>]+)>/.exec(rawAuthor)?.[1] ?? null;
      const displayName = typeof author.user?.display_name === "string" ? author.user.display_name : rawAuthor.replace(/\s*<[^>]*>/, "").trim();
      const committedAt = typeof item.date === "string" ? new Date(item.date) : new Date();
      commits.push({
        sha: item.hash,
        message: item.message,
        url: typeof links.html?.href === "string" ? links.html.href : "",
        authorName: displayName || "unknown",
        authorLogin: typeof author.user?.nickname === "string" ? author.user.nickname : null,
        authorEmail: email,
        committedAt: Number.isNaN(committedAt.getTime()) ? new Date() : committedAt,
      });
    }
  }
  return { repository: fullName.toLowerCase(), commits };
}
