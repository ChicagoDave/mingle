/**
 * Import/Export — dependencies import (Phase 29; legacy
 * DependenciesImporter with its preview and raising-card remapping).
 *
 * Purpose: recreates the dependencies of a bundle in this
 * installation through the Dependencies commands — RaiseDependency,
 * LinkResolvingCards, ToggleDependencyResolved — on one transaction.
 * Projects are matched by identifier and cards by number; a raising
 * card that does not exist can be remapped from the preview (legacy
 * `preview` → `add_raising_cards_to_errors`). Imported dependencies
 * take fresh numbers (numbers are global and never reused here; the
 * source number is recorded in the event). Resolving cards that do
 * not exist are dropped with a warning; a RESOLVED dependency with no
 * surviving resolving cards imports as NEW, since nothing resolves it.
 *
 * Commands → events:
 *   ImportDependencies → DependenciesImported (after the events of the
 *   commands it ran)
 *
 * Public interface: `previewDependencyImport`, `importDependencies`.
 *
 * Owner context: Import/Export (depends inward on Dependencies).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards } from "~/db/schema/cards";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { linkResolvingCards, raiseDependency, toggleDependencyResolved } from "~/domain/dependencies/commands.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeSiteAdminAction } from "~/domain/identity/authorization.server";
import type { BundleDependency, DependenciesBundle } from "~/domain/import-export/dependencies-bundle.server";
import type { FieldErrors } from "~/shared/wire-types";

/** Per source number, the raising card number to use instead of the bundle's. */
export type RaisingCardOverrides = Record<number, number>;

export interface DependencyImportEntry {
  sourceNumber: number;
  name: string;
  status: BundleDependency["status"];
  raisingProject: { identifier: string; found: boolean };
  raisingCard: { number: number; name: string | null; found: boolean };
  resolvingProject: { identifier: string; found: boolean };
  resolvingCards: { number: number; name: string | null; found: boolean }[];
  errors: string[];
  warnings: string[];
}

export interface DependencyImportPreview {
  entries: DependencyImportEntry[];
  importable: number;
  errorCount: number;
}

export interface PreviewDependencyImportInput {
  bundle: DependenciesBundle;
  raisingCardOverrides?: RaisingCardOverrides | null;
  actorUserId: number;
}

interface Resolved {
  entry: DependencyImportEntry;
  raisingProjectId: number | null;
  resolvingProjectId: number | null;
  resolvingCardNumbers: number[];
}

function resolveAll(db: BetterSQLite3Database, input: PreviewDependencyImportInput): Resolved[] {
  const identifiers = [...new Set(input.bundle.dependencies.flatMap((d) => [d.raisingProject, d.resolvingProject]))];
  const projectRows = identifiers.length
    ? db.select({ id: projects.id, identifier: projects.identifier }).from(projects).where(inArray(projects.identifier, identifiers)).all()
    : [];
  const projectId = (identifier: string) => projectRows.find((p) => p.identifier === identifier)?.id ?? null;
  const cardExists = (pid: number, number: number) =>
    Boolean(db.select({ id: cards.id }).from(cards).where(and(eq(cards.projectId, pid), eq(cards.number, number))).get());

  return input.bundle.dependencies.map((d) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const raisingProjectId = projectId(d.raisingProject);
    const resolvingProjectId = projectId(d.resolvingProject);
    if (raisingProjectId === null) errors.push(`raising project "${d.raisingProject}" does not exist`);
    if (resolvingProjectId === null) errors.push(`resolving project "${d.resolvingProject}" does not exist`);
    const raisingNumber = input.raisingCardOverrides?.[d.number] ?? d.raisingCard.number;
    const raisingFound = raisingProjectId !== null && cardExists(raisingProjectId, raisingNumber);
    if (raisingProjectId !== null && !raisingFound) errors.push(`raising card #${raisingNumber} does not exist in "${d.raisingProject}"`);
    const resolvingCards = d.resolvingCards.map((c) => ({
      number: c.number,
      name: c.name,
      found: resolvingProjectId !== null && cardExists(resolvingProjectId, c.number),
    }));
    for (const c of resolvingCards) if (!c.found && resolvingProjectId !== null) warnings.push(`resolving card #${c.number} does not exist in "${d.resolvingProject}" and will be dropped`);
    const survivors = resolvingCards.filter((c) => c.found).map((c) => c.number);
    if (d.status === "RESOLVED" && survivors.length === 0 && errors.length === 0) warnings.push("no resolving card survives, so the dependency imports as NEW");
    return {
      entry: {
        sourceNumber: d.number,
        name: d.name,
        status: d.status,
        raisingProject: { identifier: d.raisingProject, found: raisingProjectId !== null },
        raisingCard: { number: raisingNumber, name: d.raisingCard.name, found: raisingFound },
        resolvingProject: { identifier: d.resolvingProject, found: resolvingProjectId !== null },
        resolvingCards,
        errors,
        warnings,
      },
      raisingProjectId,
      resolvingProjectId,
      resolvingCardNumbers: survivors,
    };
  });
}

/**
 * Resolves the bundle against this installation without writing: per
 * dependency, whether its projects and cards exist (honoring
 * raising-card overrides), its errors and warnings. Rejects only when
 * the actor is not a site administrator.
 */
export function previewDependencyImport(db: BetterSQLite3Database, input: PreviewDependencyImportInput): CommandResult<DependencyImportPreview> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;
  const entries = resolveAll(db, input).map((r) => r.entry);
  return {
    ok: true,
    value: { entries, importable: entries.filter((e) => e.errors.length === 0).length, errorCount: entries.filter((e) => e.errors.length > 0).length },
  };
}

export interface ImportDependenciesInput extends PreviewDependencyImportInput {}

export interface DependencyImportOutcome {
  /** Source number → number assigned here. */
  imported: { source: number; number: number }[];
}

class ImportRejected extends Error {
  constructor(readonly errors: FieldErrors) {
    super("import rejected");
  }
}

/**
 * ImportDependencies — recreates the bundle's dependencies.
 *
 * DOES: on one transaction, for each dependency: raises it from its
 * raising card (the actor as raising user, fresh number, name,
 * description and desired end date from the bundle), links the
 * resolving cards that exist, and marks it resolved when the bundle
 * says RESOLVED and a resolving card survived; appends a
 * DependenciesImported event mapping source numbers to the new ones.
 * WHEN: the actor is a site administrator, the bundle has at least
 * one dependency, and every dependency's projects and (possibly
 * remapped) raising card exist.
 * BECAUSE: an imported dependency is a real request between two
 * projects here; one that names nothing here has nothing to attach to.
 * REJECTS WHEN: any dependency has a preview error — errors keyed
 * `dependencies[i]`, nothing written — or the bundle is empty.
 */
export function importDependencies(db: BetterSQLite3Database, input: ImportDependenciesInput): CommandResult<DependencyImportOutcome> {
  const denied = authorizeSiteAdminAction(db, input.actorUserId);
  if (denied) return denied;
  if (input.bundle.dependencies.length === 0) return reject("bundle", "has no dependencies");
  const resolved = resolveAll(db, input);
  const errors: FieldErrors = {};
  resolved.forEach((r, index) => {
    if (r.entry.errors.length > 0) errors[`dependencies[${index}]`] = r.entry.errors;
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  try {
    return db.transaction((tx) => {
      const imported: DependencyImportOutcome["imported"] = [];
      resolved.forEach((r, index) => {
        const d = input.bundle.dependencies[index];
        const path = `dependencies[${index}]`;
        const raised = raiseDependency(tx, {
          raisingProjectId: r.raisingProjectId!,
          raisingCardNumber: r.entry.raisingCard.number,
          name: d.name,
          description: d.description,
          desiredEndDate: d.desiredEndDate,
          resolvingProjectId: r.resolvingProjectId!,
          actorUserId: input.actorUserId,
        });
        if (!raised.ok) throw new ImportRejected(prefix(raised.errors, path));
        if (r.resolvingCardNumbers.length > 0) {
          const linked = linkResolvingCards(tx, {
            projectId: r.resolvingProjectId!,
            dependencyNumber: raised.value.number,
            cardNumbers: r.resolvingCardNumbers,
            actorUserId: input.actorUserId,
          });
          if (!linked.ok) throw new ImportRejected(prefix(linked.errors, path));
          if (d.status === "RESOLVED") {
            const toggled = toggleDependencyResolved(tx, { projectId: r.resolvingProjectId!, dependencyNumber: raised.value.number, actorUserId: input.actorUserId });
            if (!toggled.ok) throw new ImportRejected(prefix(toggled.errors, path));
          }
        }
        imported.push({ source: d.number, number: raised.value.number });
      });
      emitEvent(tx, {
        type: "DependenciesImported",
        aggregateType: "DependencyImport",
        aggregateId: 0,
        payload: { exportedAt: input.bundle.exportedAt, imported },
        actorUserId: input.actorUserId,
      });
      return { ok: true, value: { imported } };
    });
  } catch (error) {
    if (error instanceof ImportRejected) return { ok: false, errors: error.errors };
    throw error;
  }
}

function prefix(errors: FieldErrors, path: string): FieldErrors {
  return Object.fromEntries(Object.entries(errors).map(([field, messages]) => [`${path}.${field}`, messages]));
}
