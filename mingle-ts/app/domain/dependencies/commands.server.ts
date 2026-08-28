/**
 * Cross-Project Dependencies command handlers (Phase 25).
 *
 * Purpose: the write path for dependencies (legacy `Dependency` and
 * `DependenciesController`). A card in the RAISING project raises a
 * dependency on the RESOLVING project; the resolving project accepts
 * it by linking its own cards as resolving cards; either side marks it
 * resolved. Status is derived, never set directly: NEW while no
 * resolving card is linked, ACCEPTED while one is, RESOLVED once
 * toggled done (legacy `recalculate_status` / `toggle_resolved_status`).
 *
 * Every change appends a `dependency_versions` row in the same
 * transaction, snapshotting the resolving card numbers at that moment
 * — the same trail-per-change rule cards follow (ADR-0004) — and that
 * trail is what both projects' history feeds read. A change that
 * alters nothing (linking a card already linked, toggling a NEW
 * dependency with no cards) appends no version: the trail records
 * what changed, not what was attempted (legacy `altered?`).
 *
 * Which project the actor acts FROM matters, as it did in legacy where
 * every action ran under a project scope: cards are linked from the
 * resolving project, a dependency is deleted from the raising project,
 * and it is toggled or edited from either side it belongs to.
 *
 * Commands → events:
 *   RaiseDependency        → DependencyRaised
 *   LinkResolvingCards     → ResolvingCardsLinked
 *   UnlinkResolvingCard    → ResolvingCardUnlinked
 *   ToggleDependencyResolved → DependencyStatusChanged
 *   UpdateDependency       → DependencyUpdated
 *   DeleteDependency       → DependencyDeleted
 *
 * Public interface: `raiseDependency`, `linkResolvingCards`,
 * `unlinkResolvingCard`, `toggleDependencyResolved`,
 * `updateDependency`, `deleteDependency`, `recalculatedStatus`.
 *
 * Owner context: Cross-Project Dependencies. Handlers take the Drizzle
 * handle as a parameter — no module-level infrastructure imports.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import {
  dependencies,
  dependencyResolvingCards,
  dependencyVersions,
  type DependencyRow,
} from "~/db/schema/dependencies";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProjectAction, PrivilegeLevel } from "~/domain/identity/authorization.server";
import type { DependencyStatus } from "~/shared/wire-types";

/** Legacy validates_length_of :name (shared with cards). */
const NAME_MAX_LENGTH = 255;
const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get());
}

function cardExists(db: BetterSQLite3Database, projectId: number, number: number): boolean {
  return Boolean(
    db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
      .get(),
  );
}

function findDependency(db: BetterSQLite3Database, number: number): DependencyRow | undefined {
  return db.select().from(dependencies).where(eq(dependencies.number, number)).get();
}

/**
 * The next dependency number: one past the highest ever used, across
 * live dependencies and the trails of deleted ones — global, never
 * reused (legacy `dependency_numbers` sequence).
 */
function nextDependencyNumber(db: BetterSQLite3Database): number {
  const row = db.get<{ highest: number }>(sql`
    SELECT COALESCE(MAX(number), 0) AS highest FROM (
      SELECT number FROM ${dependencies}
      UNION ALL
      SELECT number FROM ${dependencyVersions}
    )`);
  return (row?.highest ?? 0) + 1;
}

/** The numbers of the cards currently linked as resolving, ascending. */
function resolvingCardNumbers(db: BetterSQLite3Database, dependencyId: number): number[] {
  return db
    .select({ cardNumber: dependencyResolvingCards.cardNumber })
    .from(dependencyResolvingCards)
    .where(eq(dependencyResolvingCards.dependencyId, dependencyId))
    .orderBy(asc(dependencyResolvingCards.cardNumber))
    .all()
    .map((row) => row.cardNumber);
}

/**
 * The status a dependency should carry given its current status and
 * whether any resolving card is linked (legacy `recalculate_status`):
 * RESOLVED is sticky; otherwise ACCEPTED with cards, NEW without.
 *
 * @param current - the status as stored
 * @param hasResolvingCards - whether at least one resolving card is linked
 */
export function recalculatedStatus(current: DependencyStatus, hasResolvingCards: boolean): DependencyStatus {
  if (current === "RESOLVED") return "RESOLVED";
  return hasResolvingCards ? "ACCEPTED" : "NEW";
}

/**
 * Appends the next version of a dependency from its CURRENT row and
 * link rows, bumping the row's version unless this is the deletion
 * version (whose row is about to go).
 */
function appendVersion(
  tx: BetterSQLite3Database,
  dependency: DependencyRow,
  actorUserId: number,
  options: { isDeletion?: boolean } = {},
): DependencyRow {
  const nextVersion = dependency.version + 1;
  const current = options.isDeletion
    ? dependency
    : tx
        .update(dependencies)
        .set({ version: nextVersion, updatedAt: new Date() })
        .where(eq(dependencies.id, dependency.id))
        .returning()
        .get();
  tx.insert(dependencyVersions)
    .values({
      dependencyId: current.id,
      number: current.number,
      version: nextVersion,
      name: current.name,
      description: current.description,
      desiredEndDate: current.desiredEndDate,
      raisingProjectId: current.raisingProjectId,
      raisingCardNumber: current.raisingCardNumber,
      raisingUserId: current.raisingUserId,
      resolvingProjectId: current.resolvingProjectId,
      status: current.status,
      resolvingCardNumbers: JSON.stringify(resolvingCardNumbers(tx, current.id)),
      isDeletion: options.isDeletion ?? false,
      modifiedByUserId: actorUserId,
    })
    .run();
  return current;
}

function nameError(name: string): string | null {
  if (!name) return "can't be blank";
  if (name.length > NAME_MAX_LENGTH) return `is too long (maximum is ${NAME_MAX_LENGTH} characters)`;
  return null;
}

function desiredEndDateError(value: string): string | null {
  if (!value) return "can't be blank";
  if (!ISO_DATE_FORMAT.test(value) || Number.isNaN(Date.parse(value))) return "is not a valid date";
  return null;
}

export interface RaiseDependencyInput {
  /** The project the raising card lives in — the project the actor acts from. */
  raisingProjectId: number;
  raisingCardNumber: number;
  name: string;
  description?: string | null;
  /** ISO `YYYY-MM-DD`. */
  desiredEndDate: string;
  resolvingProjectId: number;
  actorUserId: number;
}

/**
 * RaiseDependency — a card asks another project for something.
 *
 * DOES: inserts a `dependencies` row with the next global number,
 * status NEW and version 1, stamped with the actor as raising user;
 * inserts its version-1 `dependency_versions` row; appends a
 * DependencyRaised event — all in one transaction.
 * WHEN: the raising project exists, the actor is at least a full team
 * member of it, the raising card exists in it, the name is non-blank,
 * the desired end date is a valid ISO date, and the resolving project
 * exists (it may be the raising project itself, as legacy allowed).
 * BECAUSE: a dependency is the raising card's request, so it is raised
 * from that card's project by someone who may edit there; the number
 * is global because the same dependency appears in two projects.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function raiseDependency(
  db: BetterSQLite3Database,
  input: RaiseDependencyInput,
): CommandResult<DependencyRow> {
  if (!projectExists(db, input.raisingProjectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.raisingProjectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  if (!cardExists(db, input.raisingProjectId, input.raisingCardNumber))
    return reject("raising_card", "does not exist");

  const name = input.name.trim();
  const invalidName = nameError(name);
  if (invalidName) return reject("name", invalidName);
  const desiredEndDate = input.desiredEndDate.trim();
  const invalidDate = desiredEndDateError(desiredEndDate);
  if (invalidDate) return reject("desired_end_date", invalidDate);
  if (!projectExists(db, input.resolvingProjectId)) return reject("resolving_project", "does not exist");

  return db.transaction((tx) => {
    const row = tx
      .insert(dependencies)
      .values({
        number: nextDependencyNumber(tx),
        name,
        description: input.description?.trim() || null,
        desiredEndDate,
        raisingProjectId: input.raisingProjectId,
        raisingCardNumber: input.raisingCardNumber,
        raisingUserId: input.actorUserId,
        resolvingProjectId: input.resolvingProjectId,
        status: "NEW",
        version: 1,
      })
      .returning()
      .get();
    tx.insert(dependencyVersions)
      .values({
        dependencyId: row.id,
        number: row.number,
        version: 1,
        name: row.name,
        description: row.description,
        desiredEndDate: row.desiredEndDate,
        raisingProjectId: row.raisingProjectId,
        raisingCardNumber: row.raisingCardNumber,
        raisingUserId: row.raisingUserId,
        resolvingProjectId: row.resolvingProjectId,
        status: row.status,
        resolvingCardNumbers: "[]",
        modifiedByUserId: input.actorUserId,
      })
      .run();
    emitEvent(tx, {
      type: "DependencyRaised",
      aggregateType: "Dependency",
      aggregateId: row.id,
      payload: {
        number: row.number,
        raisingProjectId: row.raisingProjectId,
        raisingCardNumber: row.raisingCardNumber,
        resolvingProjectId: row.resolvingProjectId,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface LinkResolvingCardsInput {
  /** The project the actor acts from — must be the resolving project. */
  projectId: number;
  dependencyNumber: number;
  /** Numbers of cards in the resolving project. */
  cardNumbers: number[];
  actorUserId: number;
}

/**
 * LinkResolvingCards — the resolving project accepts a dependency by
 * naming the cards that will resolve it.
 *
 * DOES: inserts one `dependency_resolving_cards` row per card not
 * already linked, sets the status to ACCEPTED unless it is RESOLVED,
 * bumps the version and appends a version row snapshotting the new
 * link set, and appends a ResolvingCardsLinked event — in one
 * transaction. Linking only cards already linked changes nothing and
 * appends no version.
 * WHEN: the dependency exists, the acting project is its resolving
 * project, the actor is at least a full team member there, at least
 * one card number is given, every card exists in the resolving
 * project, and — when the raising and resolving projects are the same
 * — the raising card is not among them.
 * BECAUSE: only the project asked to resolve a dependency can say
 * which of its cards will; a card cannot resolve its own request.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function linkResolvingCards(
  db: BetterSQLite3Database,
  input: LinkResolvingCardsInput,
): CommandResult<DependencyRow> {
  const dependency = findDependency(db, input.dependencyNumber);
  if (!dependency) return reject("dependency", "does not exist");
  if (dependency.resolvingProjectId !== input.projectId)
    return reject("dependency", "can only be resolved from its resolving project");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;

  const wanted = [...new Set(input.cardNumbers)];
  if (wanted.length === 0) return reject("cards", "can't be blank");
  for (const number of wanted) {
    if (!cardExists(db, input.projectId, number)) return reject("cards", `#${number} does not exist`);
  }
  if (dependency.raisingProjectId === dependency.resolvingProjectId && wanted.includes(dependency.raisingCardNumber))
    return reject("cards", "Cannot link raising card as resolving card.");

  return db.transaction((tx) => {
    const already = new Set(resolvingCardNumbers(tx, dependency.id));
    const fresh = wanted.filter((number) => !already.has(number)).sort((a, b) => a - b);
    if (fresh.length === 0) return { ok: true, value: dependency };
    for (const cardNumber of fresh) {
      tx.insert(dependencyResolvingCards)
        .values({ dependencyId: dependency.id, projectId: input.projectId, cardNumber })
        .run();
    }
    const status = recalculatedStatus(dependency.status as DependencyStatus, true);
    tx.update(dependencies).set({ status }).where(eq(dependencies.id, dependency.id)).run();
    const row = appendVersion(tx, { ...dependency, status }, input.actorUserId);
    emitEvent(tx, {
      type: "ResolvingCardsLinked",
      aggregateType: "Dependency",
      aggregateId: dependency.id,
      payload: { number: dependency.number, resolvingProjectId: input.projectId, cardNumbers: fresh, status },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface UnlinkResolvingCardInput {
  /** The project the actor acts from — must be the resolving project. */
  projectId: number;
  dependencyNumber: number;
  cardNumber: number;
  actorUserId: number;
}

/**
 * UnlinkResolvingCard — the resolving project withdraws one of its
 * resolving cards.
 *
 * DOES: deletes the card's `dependency_resolving_cards` row, drops the
 * status back to NEW when no resolving card remains (RESOLVED stays),
 * bumps the version and appends a version row, and appends a
 * ResolvingCardUnlinked event — in one transaction.
 * WHEN: the dependency exists, the acting project is its resolving
 * project, the actor is at least a full team member there, and the
 * card is currently linked.
 * BECAUSE: an accepted dependency whose last resolving card is
 * withdrawn is no longer accepted — its status must say so.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function unlinkResolvingCard(
  db: BetterSQLite3Database,
  input: UnlinkResolvingCardInput,
): CommandResult<DependencyRow> {
  const dependency = findDependency(db, input.dependencyNumber);
  if (!dependency) return reject("dependency", "does not exist");
  if (dependency.resolvingProjectId !== input.projectId)
    return reject("dependency", "can only be resolved from its resolving project");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const link = db
    .select({ id: dependencyResolvingCards.id })
    .from(dependencyResolvingCards)
    .where(
      and(
        eq(dependencyResolvingCards.dependencyId, dependency.id),
        eq(dependencyResolvingCards.cardNumber, input.cardNumber),
      ),
    )
    .get();
  if (!link) return reject("card", "is not a resolving card of this dependency");

  return db.transaction((tx) => {
    tx.delete(dependencyResolvingCards).where(eq(dependencyResolvingCards.id, link.id)).run();
    const remaining = resolvingCardNumbers(tx, dependency.id);
    const status = recalculatedStatus(dependency.status as DependencyStatus, remaining.length > 0);
    tx.update(dependencies).set({ status }).where(eq(dependencies.id, dependency.id)).run();
    const row = appendVersion(tx, { ...dependency, status }, input.actorUserId);
    emitEvent(tx, {
      type: "ResolvingCardUnlinked",
      aggregateType: "Dependency",
      aggregateId: dependency.id,
      payload: { number: dependency.number, resolvingProjectId: input.projectId, cardNumber: input.cardNumber, status },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface ToggleDependencyResolvedInput {
  /** The project the actor acts from — either side of the dependency. */
  projectId: number;
  dependencyNumber: number;
  actorUserId: number;
}

/**
 * ToggleDependencyResolved — marks a dependency done, or reopens it.
 *
 * DOES: sets status ACCEPTED → RESOLVED; RESOLVED → ACCEPTED when
 * resolving cards are linked, else NEW (legacy `toggle_resolved_status`);
 * bumps the version, appends a version row and a
 * DependencyStatusChanged event — in one transaction. A NEW dependency
 * with no resolving cards stays NEW and appends nothing: there is
 * nothing to resolve yet.
 * WHEN: the dependency exists, the acting project is its raising or
 * resolving project, and the actor is at least a full team member of
 * that project.
 * BECAUSE: resolution is the one status move a person makes; the
 * others follow from the resolving cards.
 * REJECTS WHEN: the dependency is unknown, the acting project is
 * neither side, or the actor may not edit there — nothing written.
 */
export function toggleDependencyResolved(
  db: BetterSQLite3Database,
  input: ToggleDependencyResolvedInput,
): CommandResult<DependencyRow> {
  const dependency = findDependency(db, input.dependencyNumber);
  if (!dependency) return reject("dependency", "does not exist");
  if (dependency.raisingProjectId !== input.projectId && dependency.resolvingProjectId !== input.projectId)
    return reject("dependency", "does not belong to this project");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;

  return db.transaction((tx) => {
    const hasCards = resolvingCardNumbers(tx, dependency.id).length > 0;
    const status: DependencyStatus =
      dependency.status === "ACCEPTED" ? "RESOLVED" : hasCards ? "ACCEPTED" : "NEW";
    if (status === dependency.status) return { ok: true, value: dependency };
    tx.update(dependencies).set({ status }).where(eq(dependencies.id, dependency.id)).run();
    const row = appendVersion(tx, { ...dependency, status }, input.actorUserId);
    emitEvent(tx, {
      type: "DependencyStatusChanged",
      aggregateType: "Dependency",
      aggregateId: dependency.id,
      payload: { number: dependency.number, projectId: input.projectId, from: dependency.status, to: status },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface UpdateDependencyInput {
  /** The project the actor acts from — must be the raising project. */
  projectId: number;
  dependencyNumber: number;
  name: string;
  description?: string | null;
  desiredEndDate: string;
  actorUserId: number;
}

/**
 * UpdateDependency — edits what the raising project asked for.
 *
 * DOES: updates name, description and desired end date on the
 * `dependencies` row, bumps the version, appends a version row and a
 * DependencyUpdated event — in one transaction. Submitting the values
 * already stored changes nothing and appends no version.
 * WHEN: the dependency exists, the acting project is its raising
 * project, the actor is at least a full team member there, the name is
 * non-blank and the date valid.
 * BECAUSE: the request belongs to the project that made it (legacy
 * `allowed_to_edit(raising_project)`).
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function updateDependency(
  db: BetterSQLite3Database,
  input: UpdateDependencyInput,
): CommandResult<DependencyRow> {
  const dependency = findDependency(db, input.dependencyNumber);
  if (!dependency) return reject("dependency", "does not exist");
  if (dependency.raisingProjectId !== input.projectId)
    return reject("dependency", "can only be edited from the project that raised it");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const name = input.name.trim();
  const invalidName = nameError(name);
  if (invalidName) return reject("name", invalidName);
  const desiredEndDate = input.desiredEndDate.trim();
  const invalidDate = desiredEndDateError(desiredEndDate);
  if (invalidDate) return reject("desired_end_date", invalidDate);
  const description = input.description?.trim() || null;

  if (
    name === dependency.name &&
    description === dependency.description &&
    desiredEndDate === dependency.desiredEndDate
  )
    return { ok: true, value: dependency };

  return db.transaction((tx) => {
    tx.update(dependencies)
      .set({ name, description, desiredEndDate })
      .where(eq(dependencies.id, dependency.id))
      .run();
    const row = appendVersion(tx, { ...dependency, name, description, desiredEndDate }, input.actorUserId);
    emitEvent(tx, {
      type: "DependencyUpdated",
      aggregateType: "Dependency",
      aggregateId: dependency.id,
      payload: { number: dependency.number, projectId: input.projectId },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

export interface DeleteDependencyInput {
  /** The project the actor acts from — must be the raising project. */
  projectId: number;
  dependencyNumber: number;
  actorUserId: number;
}

/**
 * DeleteDependency — withdraws a dependency entirely.
 *
 * DOES: appends a final `dependency_versions` row flagged as the
 * deletion (so both histories keep the record and the number stays
 * reserved), deletes every `dependency_resolving_cards` row and the
 * `dependencies` row, and appends a DependencyDeleted event — in one
 * transaction.
 * WHEN: the dependency exists, the acting project is its raising
 * project, and the actor is a project admin there.
 * BECAUSE: only the project that asked may withdraw the request
 * (legacy: "can only be deleted from the project that raised it"),
 * and deletion is history, not erasure.
 * REJECTS WHEN: any condition above fails — field errors, nothing written.
 */
export function deleteDependency(
  db: BetterSQLite3Database,
  input: DeleteDependencyInput,
): CommandResult<{ number: number }> {
  const dependency = findDependency(db, input.dependencyNumber);
  if (!dependency) return reject("dependency", "does not exist");
  if (dependency.raisingProjectId !== input.projectId)
    return reject("dependency", "can only be deleted from the project that raised it");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.PROJECT_ADMIN);
  if (denied) return denied;

  return db.transaction((tx) => {
    appendVersion(tx, dependency, input.actorUserId, { isDeletion: true });
    tx.delete(dependencyResolvingCards).where(eq(dependencyResolvingCards.dependencyId, dependency.id)).run();
    tx.delete(dependencies).where(eq(dependencies.id, dependency.id)).run();
    emitEvent(tx, {
      type: "DependencyDeleted",
      aggregateType: "Dependency",
      aggregateId: dependency.id,
      payload: {
        number: dependency.number,
        raisingProjectId: dependency.raisingProjectId,
        resolvingProjectId: dependency.resolvingProjectId,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { number: dependency.number } };
  });
}
