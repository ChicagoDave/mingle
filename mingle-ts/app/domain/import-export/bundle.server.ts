/**
 * Import/Export — the project template bundle format (Phase 28).
 *
 * Purpose: the one document shape a project's configuration travels
 * in. A bundle is versioned JSON (this is a rewrite, so not legacy's
 * YAML-per-table archive) that names everything by NAME, never by id:
 * card types, properties, trees, aggregates, transitions and project
 * variables reference each other the way a person would describe
 * them, so a bundle imports into any installation. It carries
 * configuration only — no cards, versions, members, pages or history
 * (legacy `ImportExport::TEMPLATE_MODELS` minus what later phases
 * own). Identity is per installation, so `is_user` / `in_group`
 * prerequisites and the values of UserType / CardType variables are
 * not carried.
 *
 * Invariant: no runtime-specific types — plain data and a parser, so
 * both the exporter and any client can import this file.
 *
 * Public interface: `BUNDLE_FORMAT`, `BUNDLE_VERSION`, the
 * `ProjectBundle` type family, `parseBundle`.
 *
 * Owner context: Import/Export.
 */
import { type CommandResult, reject } from "~/domain/command.server";
import {
  AGGREGATE_TYPES,
  PROJECT_VARIABLE_DATA_TYPES,
  TRANSITION_ACTION_INPUT_MODES,
  type ProjectVariableDataType,
  type TransitionActionInputMode,
} from "~/shared/wire-types";

export const BUNDLE_FORMAT = "mingle-project-template";
export const BUNDLE_VERSION = 1;

/** The property kinds a bundle lists under `properties` (defined directly, not by a tree). */
export const BUNDLE_PROPERTY_KINDS = ["text", "number", "date", "user", "enumerated", "formula"] as const;
export type BundlePropertyKind = (typeof BUNDLE_PROPERTY_KINDS)[number];

export interface BundleProperty {
  name: string;
  kind: BundlePropertyKind;
  /** enumerated only: allowed values in order. */
  values?: string[];
  /** formula only. */
  formula?: string;
  nullIsZero?: boolean;
  transitionOnly: boolean;
}

export interface BundleTreeLevel {
  cardType: string;
  /** Every level but the last. */
  relationshipName?: string;
}

export interface BundleTree {
  name: string;
  description: string | null;
  /** Top level first. */
  levels: BundleTreeLevel[];
}

export interface BundleAggregate {
  name: string;
  tree: string;
  holderCardType: string;
  aggregateType: (typeof AGGREGATE_TYPES)[number];
  /** The numeric property aggregated; absent for count. */
  targetProperty?: string;
  scopeCardType?: string;
  condition?: string;
}

export type BundlePrerequisite =
  | { kind: "has_specific_value"; property: string; value: string | null }
  | { kind: "has_set_value"; property: string };

export interface BundleTransitionAction {
  property: string;
  inputMode: TransitionActionInputMode;
  value?: string | null;
}

export interface BundleTransition {
  name: string;
  /** Restricts the transition to one card type; absent = any. */
  cardType?: string;
  prerequisites: BundlePrerequisite[];
  actions: BundleTransitionAction[];
}

export interface BundleVariable {
  name: string;
  dataType: ProjectVariableDataType;
  /** Null for UserType and CardType (not portable) and for unset variables. */
  value: string | null;
}

/** A project's full configuration, portable by name. */
export interface ProjectBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  /** ISO timestamp of the export. */
  exportedAt: string;
  source: { name: string; identifier: string; description: string | null };
  /** In position order. */
  cardTypes: string[];
  /** In position order; tree relationships and aggregates are listed under `trees` / `aggregates`. */
  properties: BundleProperty[];
  trees: BundleTree[];
  aggregates: BundleAggregate[];
  transitions: BundleTransition[];
  variables: BundleVariable[];
}

type Raw = Record<string, unknown>;

class BundleError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(raw: Raw, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") throw new BundleError(`${path}.${key}`, "must be a non-blank string");
  return value;
}

function optStr(raw: Raw, key: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BundleError(`${path}.${key}`, "must be a string");
  return value;
}

function nullableStr(raw: Raw, key: string, path: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BundleError(`${path}.${key}`, "must be a string or null");
  return value;
}

function bool(raw: Raw, key: string, path: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new BundleError(`${path}.${key}`, "must be true or false");
  return value;
}

function oneOf<T extends string>(raw: Raw, key: string, path: string, allowed: readonly T[]): T {
  const value = str(raw, key, path);
  if (!(allowed as readonly string[]).includes(value))
    throw new BundleError(`${path}.${key}`, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function list<T>(raw: Raw, key: string, path: string, item: (entry: Raw, itemPath: string) => T): T[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw new BundleError(`${path}.${key}`, "must be a list");
  return value.map((entry, index) => {
    const itemPath = `${path}.${key}[${index}]`;
    if (!isRecord(entry)) throw new BundleError(itemPath, "must be an object");
    return item(entry, itemPath);
  });
}

function stringList(raw: Raw, key: string, path: string): string[] {
  const value = raw[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new BundleError(`${path}.${key}`, "must be a list of strings");
  return value as string[];
}

function parseProperty(raw: Raw, path: string): BundleProperty {
  const kind = oneOf(raw, "kind", path, BUNDLE_PROPERTY_KINDS);
  const property: BundleProperty = { name: str(raw, "name", path), kind, transitionOnly: bool(raw, "transitionOnly", path, false) };
  if (kind === "enumerated") property.values = stringList(raw, "values", path);
  if (kind === "formula") {
    property.formula = str(raw, "formula", path);
    property.nullIsZero = bool(raw, "nullIsZero", path, false);
  }
  return property;
}

function parseTree(raw: Raw, path: string): BundleTree {
  return {
    name: str(raw, "name", path),
    description: nullableStr(raw, "description", path),
    levels: list(raw, "levels", path, (level, levelPath) => {
      const parsed: BundleTreeLevel = { cardType: str(level, "cardType", levelPath) };
      const relationshipName = optStr(level, "relationshipName", levelPath);
      if (relationshipName !== undefined) parsed.relationshipName = relationshipName;
      return parsed;
    }),
  };
}

function parseAggregate(raw: Raw, path: string): BundleAggregate {
  const aggregate: BundleAggregate = {
    name: str(raw, "name", path),
    tree: str(raw, "tree", path),
    holderCardType: str(raw, "holderCardType", path),
    aggregateType: oneOf(raw, "aggregateType", path, AGGREGATE_TYPES),
  };
  for (const key of ["targetProperty", "scopeCardType", "condition"] as const) {
    const value = optStr(raw, key, path);
    if (value !== undefined) aggregate[key] = value;
  }
  return aggregate;
}

function parseTransition(raw: Raw, path: string): BundleTransition {
  const transition: BundleTransition = {
    name: str(raw, "name", path),
    prerequisites: list(raw, "prerequisites", path, (p, pPath) => {
      const kind = oneOf(p, "kind", pPath, ["has_specific_value", "has_set_value"] as const);
      return kind === "has_specific_value"
        ? { kind, property: str(p, "property", pPath), value: nullableStr(p, "value", pPath) }
        : { kind, property: str(p, "property", pPath) };
    }),
    actions: list(raw, "actions", path, (a, aPath) => ({
      property: str(a, "property", aPath),
      inputMode: oneOf(a, "inputMode", aPath, TRANSITION_ACTION_INPUT_MODES),
      value: nullableStr(a, "value", aPath),
    })),
  };
  const cardType = optStr(raw, "cardType", path);
  if (cardType !== undefined) transition.cardType = cardType;
  return transition;
}

function parseVariable(raw: Raw, path: string): BundleVariable {
  return {
    name: str(raw, "name", path),
    dataType: oneOf(raw, "dataType", path, PROJECT_VARIABLE_DATA_TYPES),
    value: nullableStr(raw, "value", path),
  };
}

/**
 * Parses and structurally validates bundle text.
 *
 * @param text - the JSON document as uploaded or pasted
 * @returns the typed bundle, or a single `bundle`-keyed error naming
 *   the offending path (semantic rules — name clashes, unknown
 *   references — are the importing commands' to enforce)
 */
export function parseBundle(text: string): CommandResult<ProjectBundle> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject("bundle", "is not valid JSON");
  }
  if (!isRecord(raw)) return reject("bundle", "must be a JSON object");
  try {
    if (raw.format !== BUNDLE_FORMAT) throw new BundleError("format", `must be "${BUNDLE_FORMAT}"`);
    if (raw.version !== BUNDLE_VERSION) throw new BundleError("version", `must be ${BUNDLE_VERSION}`);
    if (!isRecord(raw.source)) throw new BundleError("source", "must be an object");
    const bundle: ProjectBundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      exportedAt: str(raw, "exportedAt", "bundle"),
      source: {
        name: str(raw.source, "name", "source"),
        identifier: str(raw.source, "identifier", "source"),
        description: nullableStr(raw.source, "description", "source"),
      },
      cardTypes: stringList(raw, "cardTypes", "bundle"),
      properties: list(raw, "properties", "bundle", parseProperty),
      trees: list(raw, "trees", "bundle", parseTree),
      aggregates: list(raw, "aggregates", "bundle", parseAggregate),
      transitions: list(raw, "transitions", "bundle", parseTransition),
      variables: list(raw, "variables", "bundle", parseVariable),
    };
    return { ok: true, value: bundle };
  } catch (error) {
    if (error instanceof BundleError) return reject("bundle", `${error.path.replace(/^bundle\./, "")} ${error.message}`);
    throw error;
  }
}
