/**
 * Import/Export — the project template bundle format (Phase 28).
 *
 * Purpose: the one document shape a project's configuration — and,
 * since version 2, a project template's content — travels in. A
 * bundle is versioned JSON (this is a rewrite, so not legacy's
 * YAML-per-table archive) that names everything by NAME, never by id:
 * card types, properties, trees, aggregates, transitions and project
 * variables reference each other the way a person would describe
 * them, so a bundle imports into any installation. Version 1 carried
 * configuration only; version 2 (ADR-0024) adds four OPTIONAL content
 * sections — `cardDefaults`, `favorites` (team favorites, tabs, WIP
 * limits), `cards` (seed cards) and `pages` — each empty when absent,
 * so a version-1 document is a version-2 document with none of them.
 * A template is a bundle: `mingle-ts/templates/*.json` are documents
 * of this shape. Identity is still per installation: `is_user` /
 * `in_group` prerequisites and UserType / CardType variable values
 * are not carried, and the only user value a card or default may hold
 * is the marker `(current user)` (wire-types `CURRENT_USER_MARKER`),
 * resolved to the importing actor. Page content may carry
 * `{{template:today}}` / `{{template:today±N}}` tokens, which the
 * importer expands to ISO dates before storage (Decision 5).
 *
 * Invariant: no runtime-specific types — plain data and a parser, so
 * both the exporter and any client can import this file.
 *
 * Public interface: `BUNDLE_FORMAT`, `BUNDLE_VERSION`,
 * `SUPPORTED_BUNDLE_VERSIONS`, the `ProjectBundle` type family,
 * `parseBundle`, `TEMPLATE_TODAY_TOKEN`, `expandTemplateTokens`.
 *
 * Owner context: Import/Export.
 */
import { type CommandResult, reject } from "~/domain/command.server";
import {
  AGGREGATE_TYPES,
  CARD_VIEW_STYLES,
  CURRENT_USER_MARKER,
  PROJECT_VARIABLE_DATA_TYPES,
  TRANSITION_ACTION_INPUT_MODES,
  type CardViewStyle,
  type ProjectVariableDataType,
  type TransitionActionInputMode,
} from "~/shared/wire-types";

export const BUNDLE_FORMAT = "mingle-project-template";
/** The version this code writes; every version in SUPPORTED_BUNDLE_VERSIONS still reads. */
export const BUNDLE_VERSION = 2;
export const SUPPORTED_BUNDLE_VERSIONS = [1, 2] as const;

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

/** One card type's default property values, by property name (P-2). */
export interface BundleCardDefaults {
  cardType: string;
  /** Property name → value; a user property may hold only `(current user)`. */
  values: Record<string, string>;
}

/** A team favorite — a saved card view, optionally a tab, with WIP limits (P-3). */
export interface BundleFavorite {
  name: string;
  style: CardViewStyle;
  filters: string[];
  columns: string[];
  /** Lane property name (grid); "" when ungrouped. */
  groupBy: string;
  mql?: string;
  tabView: boolean;
  /** Lane value → count limit (grid style grouped by an enumerated property). */
  wipLimits: Record<string, number>;
}

/** A seed card. */
export interface BundleCard {
  name: string;
  cardType: string;
  /** Kept when given; the project's next number otherwise. */
  number?: number;
  description?: string | null;
  /** Property name → value; a user property may hold only `(current user)`. */
  values: Record<string, string>;
}

/** A wiki page; `content` may carry template tokens. */
export interface BundlePage {
  name: string;
  content: string | null;
}

/** A project's full configuration, portable by name, plus optional content (version 2). */
export interface ProjectBundle {
  format: typeof BUNDLE_FORMAT;
  version: (typeof SUPPORTED_BUNDLE_VERSIONS)[number];
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
  /** Content sections (version 2; empty for a version-1 document). */
  cardDefaults: BundleCardDefaults[];
  favorites: BundleFavorite[];
  cards: BundleCard[];
  pages: BundlePage[];
}

/** The template-time token: `{{template:today}}`, `{{template:today+14}}`, `{{template:today-2}}`. */
export const TEMPLATE_TODAY_TOKEN = /\{\{\s*template:today\s*(?:([+-])\s*(\d+))?\s*\}\}/g;

/**
 * Replaces every template-time token in page content with an ISO date
 * relative to `today` (Decision 5 — expanded once, on import).
 *
 * @param content - page content as authored in the template
 * @param today - the instantiation date
 */
export function expandTemplateTokens(content: string, today: Date): string {
  return content.replace(TEMPLATE_TODAY_TOKEN, (_match, sign: string | undefined, days: string | undefined) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (sign && days) date.setUTCDate(date.getUTCDate() + (sign === "-" ? -Number(days) : Number(days)));
    return date.toISOString().slice(0, 10);
  });
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

/** An optional list (absent = empty), for the version-2 content sections. */
function optList<T>(raw: Raw, key: string, path: string, item: (entry: Raw, itemPath: string) => T): T[] {
  if (raw[key] === undefined || raw[key] === null) return [];
  return list(raw, key, path, item);
}

/** A `{name: string}` map; values must be non-blank strings. */
function stringMap(raw: Raw, key: string, path: string): Record<string, string> {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new BundleError(`${path}.${key}`, "must be an object of property name to value");
  for (const [name, entry] of Object.entries(value))
    if (typeof entry !== "string" || entry.trim() === "") throw new BundleError(`${path}.${key}.${name}`, "must be a non-blank string");
  return value as Record<string, string>;
}

/** Only the current-user marker may stand for a user (ADR-0024 Decision 4). */
function checkUserValues(values: Record<string, string>, userProperties: Set<string>, path: string): void {
  for (const [name, value] of Object.entries(values))
    if (userProperties.has(name.toLowerCase()) && value.trim().toLowerCase() !== CURRENT_USER_MARKER)
      throw new BundleError(`${path}.${name}`, `a user property may only default to "${CURRENT_USER_MARKER}" — identity does not travel`);
}

function parseFavorite(raw: Raw, path: string): BundleFavorite {
  const favorite: BundleFavorite = {
    name: str(raw, "name", path),
    style: oneOf(raw, "style", path, CARD_VIEW_STYLES),
    filters: raw.filters === undefined ? [] : stringList(raw, "filters", path),
    columns: raw.columns === undefined ? [] : stringList(raw, "columns", path),
    groupBy: optStr(raw, "groupBy", path) ?? "",
    tabView: bool(raw, "tabView", path, false),
    wipLimits: {},
  };
  const mql = optStr(raw, "mql", path);
  if (mql !== undefined) favorite.mql = mql;
  const limits = raw.wipLimits;
  if (limits !== undefined && limits !== null) {
    if (!isRecord(limits)) throw new BundleError(`${path}.wipLimits`, "must be an object of lane value to limit");
    for (const [lane, limit] of Object.entries(limits)) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
        throw new BundleError(`${path}.wipLimits.${lane}`, "must be a positive whole number");
      favorite.wipLimits[lane] = limit;
    }
  }
  return favorite;
}

function parseCard(raw: Raw, path: string): BundleCard {
  const card: BundleCard = { name: str(raw, "name", path), cardType: str(raw, "cardType", path), values: stringMap(raw, "values", path) };
  if (raw.number !== undefined && raw.number !== null) {
    if (typeof raw.number !== "number" || !Number.isInteger(raw.number) || raw.number <= 0)
      throw new BundleError(`${path}.number`, "must be a positive whole number");
    card.number = raw.number;
  }
  const description = nullableStr(raw, "description", path);
  if (description !== null) card.description = description;
  return card;
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
    if (!(SUPPORTED_BUNDLE_VERSIONS as readonly unknown[]).includes(raw.version))
      throw new BundleError("version", `must be one of ${SUPPORTED_BUNDLE_VERSIONS.join(", ")}`);
    if (!isRecord(raw.source)) throw new BundleError("source", "must be an object");
    const bundle: ProjectBundle = {
      format: BUNDLE_FORMAT,
      version: raw.version as ProjectBundle["version"],
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
      cardDefaults: optList(raw, "cardDefaults", "bundle", (entry, path) => ({
        cardType: str(entry, "cardType", path),
        values: stringMap(entry, "values", path),
      })),
      favorites: optList(raw, "favorites", "bundle", parseFavorite),
      cards: optList(raw, "cards", "bundle", parseCard),
      pages: optList(raw, "pages", "bundle", (entry, path) => ({ name: str(entry, "name", path), content: nullableStr(entry, "content", path) })),
    };
    const userProperties = new Set(bundle.properties.filter((p) => p.kind === "user").map((p) => p.name.toLowerCase()));
    bundle.cardDefaults.forEach((entry, index) => checkUserValues(entry.values, userProperties, `cardDefaults[${index}].values`));
    bundle.cards.forEach((entry, index) => checkUserValues(entry.values, userProperties, `cards[${index}].values`));
    return { ok: true, value: bundle };
  } catch (error) {
    if (error instanceof BundleError) return reject("bundle", `${error.path.replace(/^bundle\./, "")} ${error.message}`);
    throw error;
  }
}
