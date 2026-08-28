/**
 * Import/Export — the dependencies bundle format (Phase 29; legacy
 * `.dependencies` export archive).
 *
 * Purpose: the document a set of dependencies travels in — versioned
 * JSON naming projects by identifier, cards by number (with the name
 * as a hint for remapping), and the raising user by login. Pure: the
 * shape and its structural parser only.
 *
 * Public interface: `DEPENDENCIES_FORMAT`, `DEPENDENCIES_VERSION`,
 * `DependenciesBundle`, `BundleDependency`, `parseDependenciesBundle`.
 *
 * Owner context: Import/Export.
 */
import { type CommandResult, reject } from "~/domain/command.server";
import { DEPENDENCY_STATUSES, type DependencyStatus } from "~/shared/wire-types";

export const DEPENDENCIES_FORMAT = "mingle-dependencies";
export const DEPENDENCIES_VERSION = 1;

export interface BundleCardRef {
  number: number;
  name: string | null;
}

export interface BundleDependency {
  /** The number in the exporting installation — informational; the import assigns a fresh one. */
  number: number;
  name: string;
  description: string | null;
  desiredEndDate: string;
  status: DependencyStatus;
  raisingProject: string;
  raisingCard: BundleCardRef;
  raisingUser: string;
  resolvingProject: string;
  resolvingCards: BundleCardRef[];
}

export interface DependenciesBundle {
  format: typeof DEPENDENCIES_FORMAT;
  version: typeof DEPENDENCIES_VERSION;
  exportedAt: string;
  dependencies: BundleDependency[];
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

function str(raw: Raw, key: string, path: string): string {
  const value = raw[key];
  return typeof value === "string" && value.trim() !== "" ? value : fail(`${path}.${key}`, "must be a non-blank string");
}

function nullableStr(raw: Raw, key: string, path: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : fail(`${path}.${key}`, "must be a string or null");
}

function int(raw: Raw, key: string, path: string): number {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fail(`${path}.${key}`, "must be a positive whole number");
}

function cardRef(raw: unknown, path: string): BundleCardRef {
  if (!isRecord(raw)) fail(path, "must be an object");
  return { number: int(raw, "number", path), name: nullableStr(raw, "name", path) };
}

/**
 * Parses and structurally validates bundle text.
 *
 * @returns the typed bundle, or a single `bundle`-keyed error naming the offending path
 */
export function parseDependenciesBundle(text: string): CommandResult<DependenciesBundle> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject("bundle", "is not valid JSON");
  }
  if (!isRecord(raw)) return reject("bundle", "must be a JSON object");
  try {
    if (raw.format !== DEPENDENCIES_FORMAT) fail("format", `must be "${DEPENDENCIES_FORMAT}"`);
    if (raw.version !== DEPENDENCIES_VERSION) fail("version", `must be ${DEPENDENCIES_VERSION}`);
    if (!Array.isArray(raw.dependencies)) fail("dependencies", "must be a list");
    const dependencies = raw.dependencies.map((entry, index): BundleDependency => {
      const path = `dependencies[${index}]`;
      if (!isRecord(entry)) fail(path, "must be an object");
      const status = str(entry, "status", path);
      if (!(DEPENDENCY_STATUSES as readonly string[]).includes(status)) fail(`${path}.status`, `must be one of ${DEPENDENCY_STATUSES.join(", ")}`);
      if (!Array.isArray(entry.resolvingCards)) fail(`${path}.resolvingCards`, "must be a list");
      return {
        number: int(entry, "number", path),
        name: str(entry, "name", path),
        description: nullableStr(entry, "description", path),
        desiredEndDate: str(entry, "desiredEndDate", path),
        status: status as DependencyStatus,
        raisingProject: str(entry, "raisingProject", path),
        raisingCard: cardRef(entry.raisingCard, `${path}.raisingCard`),
        raisingUser: str(entry, "raisingUser", path),
        resolvingProject: str(entry, "resolvingProject", path),
        resolvingCards: entry.resolvingCards.map((c, i) => cardRef(c, `${path}.resolvingCards[${i}]`)),
      };
    });
    return {
      ok: true,
      value: { format: DEPENDENCIES_FORMAT, version: DEPENDENCIES_VERSION, exportedAt: str(raw, "exportedAt", "bundle"), dependencies },
    };
  } catch (error) {
    if (error instanceof Error) return reject("bundle", error.message.replace(/^bundle\./, ""));
    throw error;
  }
}
