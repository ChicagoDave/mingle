/**
 * Collaboration — `@mention` parsing and resolution.
 *
 * Purpose: turns the `@…` tokens in a murmur body into the team
 * members they name, reproducing legacy `MurmurUserMentions`: the
 * literal `@team` reaches everyone on the project, a group name
 * reaches that group's members, and anything else is matched against
 * user logins case-insensitively. Deactivated users are dropped, and
 * a user named twice — say by `@team` and by login — is resolved once.
 *
 * The one divergence from legacy is WHEN this runs. Legacy resolved on
 * every read, so the answer drifted as team membership changed and
 * could not be queried without loading every body. Here the resolution
 * is computed once, at post time, and stored (see
 * app/db/schema/murmurs.ts) — which is what makes "who was mentioned"
 * a persisted fact rather than a render-time coincidence.
 *
 * Public interface: `MENTION_TOKEN`, `mentionTokensIn`,
 * `resolveMentions`, `ResolvedMention`. Rendering does NOT call back
 * into this module: a stored murmur already carries the tokens that
 * resolved, so the display path links exactly what was persisted.
 *
 * Owner context: Collaboration.
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { users } from "~/db/schema/identity";
import {
  groupMemberships,
  groups,
  teamMemberships,
} from "~/db/schema/membership";
import type { MentionKind } from "~/db/schema/murmurs";

/**
 * Matches an `@token` that is not glued to a preceding word character
 * (legacy `SEARCH_USER_REGEX`). Group 1 is the consumed separator,
 * group 2 the token without its "@". The character class matches what
 * a login may contain — letters, digits, underscore, dot, plus, at,
 * and hyphen — so an email-shaped login mentions correctly.
 *
 * Global, so every use must either be `matchAll` or reset `lastIndex`.
 */
export const MENTION_TOKEN = /(^|\W)@([.+@_\w-]+)/g;

/** The literal token that reaches the whole team (legacy TEAM_ID). */
const TEAM_TOKEN = "team";

/**
 * The `@…` tokens a body carries, lowercased, in the order written.
 *
 * A token ending in a period yields BOTH the bare and the trailing-dot
 * form — legacy did this so "ask @bob." reaches the user `bob` while
 * a login that genuinely ends in a dot still matches. Both forms are
 * offered to resolution; whichever names something wins.
 *
 * @param text - the murmur body as typed
 * @returns candidate tokens without their leading "@", lowercased,
 *   duplicates preserved (resolution dedupes by resolved user)
 */
export function mentionTokensIn(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const token = match[2].toLowerCase();
    if (token.endsWith(".") && token.length > 1) {
      tokens.push(token.slice(0, -1), token);
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

/** One resolved mention: a team member, and how they were named. */
export interface ResolvedMention {
  kind: MentionKind;
  userId: number;
  /** The group a `group` mention expanded through; null otherwise. */
  groupId: number | null;
  /** The token as written, without "@", lowercased. */
  mentionText: string;
}

/** The activated team members of a project, keyed by lowercased login. */
function projectMembers(
  db: BetterSQLite3Database,
  projectId: number,
): { id: number; login: string }[] {
  return db
    .select({ id: users.id, login: users.login })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(
      and(
        eq(teamMemberships.projectId, projectId),
        eq(users.activated, true),
      ),
    )
    .all();
}

/**
 * Resolves a body's `@` tokens against a project's team.
 *
 * Resolution order per token matches legacy `MurmurUserMentions.detect`
 * — `team`, then a group name, then a user login — so a group named
 * "team" cannot shadow the whole-team mention. A token naming nothing
 * resolves to nobody and leaves no trace; that is not an error, since
 * "@" appears in ordinary prose.
 *
 * @param db - the Drizzle handle the surrounding command is using
 * @param projectId - the project whose team the tokens resolve against
 * @param body - the murmur body as typed
 * @returns one entry per distinct mentioned user, first mention
 *   winning, in the order the tokens were written
 */
export function resolveMentions(
  db: BetterSQLite3Database,
  projectId: number,
  body: string,
): ResolvedMention[] {
  const tokens = mentionTokensIn(body);
  if (tokens.length === 0) return [];

  const members = projectMembers(db, projectId);
  if (members.length === 0) return [];
  const memberIds = new Set(members.map((m) => m.id));
  const byLogin = new Map(members.map((m) => [m.login.toLowerCase(), m.id]));

  const projectGroups = db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(eq(groups.projectId, projectId))
    .all();
  const groupByName = new Map(
    projectGroups.map((g) => [g.name.toLowerCase(), g.id]),
  );

  const resolved: ResolvedMention[] = [];
  const seen = new Set<number>();
  const add = (mention: ResolvedMention) => {
    if (seen.has(mention.userId)) return;
    seen.add(mention.userId);
    resolved.push(mention);
  };

  for (const token of tokens) {
    if (token === TEAM_TOKEN) {
      for (const member of members)
        add({ kind: "team", userId: member.id, groupId: null, mentionText: token });
      continue;
    }
    const groupId = groupByName.get(token);
    if (groupId !== undefined) {
      const groupUserIds = db
        .select({ userId: groupMemberships.userId })
        .from(groupMemberships)
        .where(eq(groupMemberships.groupId, groupId))
        .all()
        .map((row) => row.userId)
        // A group may still list someone who has left the team or been
        // deactivated; only current, activated members are mentioned.
        .filter((userId) => memberIds.has(userId));
      for (const userId of groupUserIds)
        add({ kind: "group", userId, groupId, mentionText: token });
      continue;
    }
    const userId = byLogin.get(token);
    if (userId !== undefined)
      add({ kind: "user", userId, groupId: null, mentionText: token });
  }
  return resolved;
}
