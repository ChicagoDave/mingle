/**
 * Project access constraint — the predicate behind ADR-0021.
 *
 * Purpose: a project may permit only sessions opened through certain
 * strategy kinds (`projects.permitted_strategy_kinds`, empty = no
 * constraint). This module answers, in one place, whether a user under
 * a given request principal passes that constraint:
 *
 *   - a browser session passes when its recorded strategy kind is
 *     permitted; a session with no recorded kind passes no constraint;
 *   - an API principal passes when the user holds a linked identity of
 *     a permitted kind, or when `password` is permitted (Decision 5);
 *   - no principal at all (in-process work outside a request) is not
 *     subject to the constraint;
 *   - site admins bypass it (Decision 7) — callers check the trump
 *     first; this module also does, so the team list can ask directly.
 *
 * The same predicate serves the checkpoint (authorization.server.ts),
 * the API authenticator, root middleware, and the team list's badge
 * (Decision 6: the list reports, it never changes membership).
 *
 * Public interface: `permittedStrategyKindsFor`,
 * `identitySatisfiesConstraint`, `accessRefusal`, `constraintMessage`.
 *
 * Owner context: Identity & Access.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { externalIdentities, users } from "~/db/schema/identity";
import { projects } from "~/db/schema/projects";
import type { RequestPrincipal } from "~/domain/identity/principal.server";
import { STRATEGY_KIND_LABELS, STRATEGY_KINDS, type StrategyKind } from "~/shared/wire-types";

/** Parses a stored constraint column; unknown or malformed content reads as no constraint. */
export function parsePermittedStrategyKinds(stored: string | null | undefined): StrategyKind[] {
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((kind): kind is StrategyKind => (STRATEGY_KINDS as readonly string[]).includes(String(kind)));
  } catch {
    return [];
  }
}

/**
 * The strategy kinds a project permits; empty means no constraint.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project
 */
export function permittedStrategyKindsFor(db: BetterSQLite3Database, projectId: number): StrategyKind[] {
  const row = db
    .select({ permitted: projects.permittedStrategyKinds })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return parsePermittedStrategyKinds(row?.permitted);
}

/** The refusal message for a constraint, naming the permitted kinds. */
export function constraintMessage(permitted: StrategyKind[]): string {
  return `this project only admits sessions signed in through ${permitted.map((kind) => STRATEGY_KIND_LABELS[kind]).join(" or ")}`;
}

/**
 * Whether a user qualifies by linked identity (Decision 5, and the
 * team list's badge): `password` permitted admits everyone; otherwise
 * the user needs an `external_identities` row of a permitted kind.
 *
 * @param db - the Drizzle handle
 * @param userId - the user judged
 * @param permitted - the project's permitted kinds (non-empty)
 */
export function identitySatisfiesConstraint(db: BetterSQLite3Database, userId: number, permitted: StrategyKind[]): boolean {
  if (permitted.length === 0 || permitted.includes("password")) return true;
  const linked = db
    .select({ id: externalIdentities.id })
    .from(externalIdentities)
    .where(and(eq(externalIdentities.userId, userId), inArray(externalIdentities.kind, permitted)))
    .get();
  return Boolean(linked);
}

/**
 * Why the user is refused by the project's constraint under this
 * principal, or null when they pass.
 *
 * @param db - the Drizzle handle
 * @param userId - the acting user
 * @param projectId - the project being reached
 * @param principal - the request principal; undefined outside a request
 */
export function accessRefusal(
  db: BetterSQLite3Database,
  userId: number,
  projectId: number,
  principal: RequestPrincipal | undefined,
): string | null {
  if (!principal || principal.via === "anonymous") return null;
  const permitted = permittedStrategyKindsFor(db, projectId);
  if (permitted.length === 0) return null;
  const user = db.select({ admin: users.admin }).from(users).where(eq(users.id, userId)).get();
  if (user?.admin) return null;
  const passes =
    principal.via === "session"
      ? principal.strategyKind !== null && permitted.includes(principal.strategyKind)
      : identitySatisfiesConstraint(db, userId, permitted);
  return passes ? null : constraintMessage(permitted);
}
