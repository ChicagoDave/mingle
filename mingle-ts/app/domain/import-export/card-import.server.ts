/**
 * Import/Export — card import from CSV/TSV (Phase 29; legacy
 * `CardImporter` / `CardImport::CardReader` / `CardImport::Mappings`).
 *
 * Purpose: the first row names columns; each column is mapped to the
 * card number, name, description, type, one of the project's settable
 * properties, or ignored. A mapping is suggested from the header
 * (legacy heuristics: a standard name, else a property with that name)
 * and may be overridden. A row whose number names an existing card
 * UPDATES it; any other row CREATES a card, keeping the number when
 * one is given. The preview resolves every row exactly as the import
 * will — same lookups, same value validation through
 * `canonicalPropertyValue` — so what it reports is what happens.
 *
 * Two deliberate departures from legacy: nothing is auto-created (an
 * unknown card type, enumeration value or property is a row error, not
 * a new definition — configuration is entered on the settings page or
 * imported as a template), and an import with any row error writes
 * NOTHING (legacy committed row by row; the preview exists so a file
 * is fixed before it is imported). Each imported row's property values
 * land in one card version through `appendPropertyValueChanges`.
 *
 * Commands → events:
 *   ImportCards → CardsImported (the cards' own CardCreated/CardUpdated
 *   events are appended by the commands this runs)
 *
 * Public interface: `ColumnTarget`, `parseColumnTarget`,
 * `formatColumnTarget`, `settableProperties`, `suggestMappings`,
 * `previewCardImport`, `importCards`.
 *
 * Owner context: Import/Export (depends inward on Card Management).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cards, cardTypes, cardVersions, type CardRow } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import { propertyDefinitions, type PropertyDefinitionRow } from "~/db/schema/properties";
import { createCard, updateCard } from "~/domain/cards/commands.server";
import {
  appendPropertyValueChanges,
  canonicalPropertyValue,
  cardPropertySnapshot,
  samePropertyValue,
  type PropertyValueChange,
} from "~/domain/cards/properties.server";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import { authorizeProjectAction, privilegeLevelFor, PrivilegeLevel } from "~/domain/identity/authorization.server";
import { parseDelimited, type DelimitedTable } from "~/domain/import-export/delimited.server";
import type { FieldErrors, PropertyKind } from "~/shared/wire-types";

/** What a column imports as. */
export type ColumnTarget =
  | { kind: "number" | "name" | "description" | "type" | "ignore" }
  | { kind: "property"; propertyDefinitionId: number };

/** Parses the form encoding of a target: `number|name|description|type|ignore|property:<id>`. */
export function parseColumnTarget(text: string): ColumnTarget | null {
  const value = text.trim();
  if (value === "number" || value === "name" || value === "description" || value === "type" || value === "ignore")
    return { kind: value };
  const match = /^property:(\d+)$/.exec(value);
  return match ? { kind: "property", propertyDefinitionId: Number(match[1]) } : null;
}

/** The form encoding of a target (inverse of `parseColumnTarget`). */
export function formatColumnTarget(target: ColumnTarget): string {
  return target.kind === "property" ? `property:${target.propertyDefinitionId}` : target.kind;
}

/** Legacy `MISSING`: a cell holding just a dash is "no value for this cell". */
const MISSING = "-";
const STANDARD_HEADERS: Record<string, "number" | "name" | "description" | "type"> = {
  number: "number",
  "#": "number",
  name: "name",
  description: "description",
  type: "type",
  "card type": "type",
};

/** Property kinds a value can be written to directly — the ones import may target. */
const SETTABLE_KINDS: ReadonlySet<string> = new Set(["text", "number", "date", "user", "enumerated"]);

/** The project's properties an import may target, in position order. */
export function settableProperties(db: BetterSQLite3Database, projectId: number): PropertyDefinitionRow[] {
  return db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, projectId))
    .orderBy(asc(propertyDefinitions.position))
    .all()
    .filter((d) => SETTABLE_KINDS.has(d.kind));
}

/**
 * Suggests a target per header cell: a standard column by name, else
 * the settable property with that name, else ignore (legacy
 * heuristics, minus creating new properties).
 */
export function suggestMappings(db: BetterSQLite3Database, projectId: number, header: string[]): ColumnTarget[] {
  const properties = settableProperties(db, projectId);
  return header.map((cell) => {
    const key = cell.trim().toLowerCase();
    const standard = STANDARD_HEADERS[key];
    if (standard) return { kind: standard };
    const property = properties.find((p) => p.name.toLowerCase() === key);
    return property ? { kind: "property", propertyDefinitionId: property.id } : { kind: "ignore" };
  });
}

/** One row as the preview reports it. */
export interface PreviewRow {
  /** The row's line in the file (the header is row 1). */
  row: number;
  action: "create" | "update" | "error";
  number: number | null;
  name: string | null;
  cardType: string | null;
  /** Property values that will be set or cleared, by property name. */
  values: { property: string; value: string | null }[];
  errors: string[];
}

export interface CardImportPreview {
  header: string[];
  mapping: ColumnTarget[];
  rows: PreviewRow[];
  creates: number;
  updates: number;
  errorCount: number;
}

export interface PreviewCardImportInput {
  projectId: number;
  text: string;
  /** One target per header column; absent means suggest from the header. */
  mapping?: ColumnTarget[] | null;
  actorUserId: number;
}

/** A row resolved against the project — what the import will do with it. */
interface ResolvedRow {
  preview: PreviewRow;
  existing: CardRow | null;
  number: number | null;
  name: string | null;
  description: string | null;
  cardTypeId: number | null;
  changes: PropertyValueChange[];
}

/** Rejects a mapping that is structurally unusable (before any row is looked at). */
function mappingError(header: string[], mapping: ColumnTarget[], properties: PropertyDefinitionRow[]): string | null {
  if (mapping.length !== header.length) return "must name a target for every column";
  for (const kind of ["number", "name", "type", "description"] as const) {
    const count = mapping.filter((m) => m.kind === kind).length;
    if (count > 1) return `more than one column is mapped as ${kind}`;
  }
  const seen = new Set<number>();
  for (const [index, target] of mapping.entries()) {
    if (target.kind !== "property") continue;
    const property = properties.find((p) => p.id === target.propertyDefinitionId);
    if (!property) return `"${header[index]}" is mapped to a property that cannot be imported`;
    if (seen.has(property.id)) return `more than one column is mapped to ${property.name}`;
    seen.add(property.id);
  }
  return null;
}

/** Resolves every row of the table against the project; never writes. */
function resolveRows(
  db: BetterSQLite3Database,
  projectId: number,
  table: DelimitedTable,
  mapping: ColumnTarget[],
  actorUserId: number,
): ResolvedRow[] {
  const properties = settableProperties(db, projectId);
  const types = db
    .select({ id: cardTypes.id, name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .orderBy(asc(cardTypes.position))
    .all();
  const isAdmin = privilegeLevelFor(db, actorUserId, projectId) >= PrivilegeLevel.PROJECT_ADMIN;
  const column = (kind: ColumnTarget["kind"]) => mapping.findIndex((m) => m.kind === kind);
  const numberColumn = column("number");
  const nameColumn = column("name");
  const descriptionColumn = column("description");
  const typeColumn = column("type");
  const propertyColumns = mapping.flatMap((m, index) =>
    m.kind === "property" ? [{ index, definition: properties.find((p) => p.id === m.propertyDefinitionId)! }] : [],
  );
  const numbersSeen = new Set<number>();

  return table.rows.map((cells, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const errors: string[] = [];
    const cell = (index: number) => (index < 0 ? "" : cells[index].trim());

    let number: number | null = null;
    let existing: CardRow | null = null;
    const numberText = cell(numberColumn);
    if (numberText !== "" && numberText !== MISSING) {
      const match = /^#?(\d+)$/.exec(numberText);
      if (!match) errors.push(`Number "${numberText}" is not a valid card number`);
      else {
        number = Number(match[1]);
        if (number <= 0) errors.push(`Number "${numberText}" is not a valid card number`);
        else if (numbersSeen.has(number)) errors.push(`Number ${number} appears more than once`);
        numbersSeen.add(number);
        existing =
          db
            .select()
            .from(cards)
            .where(and(eq(cards.projectId, projectId), eq(cards.number, number)))
            .get() ?? null;
        if (!existing && numberBelongsToDeletedCard(db, projectId, number))
          errors.push(`Number ${number} belongs to a deleted card and cannot be reused`);
      }
    }

    const nameText = cell(nameColumn);
    const name = nameText === "" || nameText === MISSING ? null : nameText;
    if (!existing && name === null) errors.push("Name can't be blank");
    if (name !== null && name.length > CARD_NAME_MAX_LENGTH)
      errors.push(`Name is too long (maximum is ${CARD_NAME_MAX_LENGTH} characters)`);

    const descriptionText = descriptionColumn < 0 ? "" : cells[descriptionColumn];
    const description = descriptionText.trim() === "" || descriptionText.trim() === MISSING ? null : descriptionText;

    let cardTypeId: number | null = null;
    let cardTypeName: string | null = null;
    const typeText = cell(typeColumn);
    if (typeText !== "" && typeText !== MISSING) {
      const type = types.find((t) => t.name.toLowerCase() === typeText.toLowerCase());
      if (!type) errors.push(`Card type "${typeText}" does not exist`);
      else {
        cardTypeId = type.id;
        cardTypeName = type.name;
      }
    } else if (!existing) {
      cardTypeId = types[0]?.id ?? null;
      cardTypeName = types[0]?.name ?? null;
      if (cardTypeId === null) errors.push("The project has no card type");
    } else {
      cardTypeName = types.find((t) => t.id === existing!.cardTypeId)?.name ?? null;
    }

    const changes: PropertyValueChange[] = [];
    const values: PreviewRow["values"] = [];
    const current = existing ? cardPropertySnapshot(db, existing.id) : {};
    const unchanged = (definition: PropertyDefinitionRow, next: string | null) =>
      samePropertyValue(definition.kind as PropertyKind, next, current[String(definition.id)] ?? null);
    for (const { index, definition } of propertyColumns) {
      const raw = cell(index);
      if (raw === MISSING) continue;
      if (raw === "") {
        if (existing && !unchanged(definition, null)) {
          changes.push({ definition, value: null });
          values.push({ property: definition.name, value: null });
        }
        continue;
      }
      const canonical = canonicalPropertyValue(db, projectId, definition, userInputToId(db, definition, raw));
      if (!canonical.ok) {
        errors.push(...Object.values(canonical.errors).flat());
        continue;
      }
      if (existing && unchanged(definition, canonical.value)) continue;
      if (definition.transitionOnly && !isAdmin) {
        errors.push(`${definition.name}: is a transition only property.`);
        continue;
      }
      changes.push({ definition, value: canonical.value });
      values.push({ property: definition.name, value: canonical.value });
    }

    const action: PreviewRow["action"] = errors.length > 0 ? "error" : existing ? "update" : "create";
    return {
      preview: { row: rowNumber, action, number: number ?? existing?.number ?? null, name: name ?? existing?.name ?? null, cardType: cardTypeName, values, errors },
      existing,
      number,
      name,
      description,
      cardTypeId,
      changes,
    };
  });
}

/** Legacy card name limit, mirrored so the preview reports what CreateCard/UpdateCard would reject. */
const CARD_NAME_MAX_LENGTH = 255;

/** Whether a number with no live card was once used — numbers are never reused (CreateCard's rule). */
function numberBelongsToDeletedCard(db: BetterSQLite3Database, projectId: number, number: number): boolean {
  return Boolean(
    db
      .select({ id: cardVersions.id })
      .from(cardVersions)
      .where(and(eq(cardVersions.projectId, projectId), eq(cardVersions.number, number)))
      .get(),
  );
}

/** Legacy imported user properties by login; the value rule wants an id, so a login is resolved first. */
function userInputToId(db: BetterSQLite3Database, definition: PropertyDefinitionRow, raw: string): string {
  if (definition.kind !== "user" || /^\d+$/.test(raw)) return raw;
  const user = db.select({ id: users.id }).from(users).where(sql`lower(${users.login}) = ${raw.toLowerCase()}`).get();
  return user ? String(user.id) : raw;
}

/** Shared front half of preview and import: authorization, parsing, mapping and resolution. */
function prepare(
  db: BetterSQLite3Database,
  input: PreviewCardImportInput,
): CommandResult<{ table: DelimitedTable; mapping: ColumnTarget[]; resolved: ResolvedRow[] }> {
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const table = parseDelimited(input.text);
  if (table.header.length === 0) return reject("text", "has no header row");
  if (table.rows.length === 0) return reject("text", "has no card rows");
  const mapping = input.mapping ?? suggestMappings(db, input.projectId, table.header);
  const badMapping = mappingError(table.header, mapping, settableProperties(db, input.projectId));
  if (badMapping) return reject("mapping", badMapping);
  return { ok: true, value: { table, mapping, resolved: resolveRows(db, input.projectId, table, mapping, input.actorUserId) } };
}

/**
 * Resolves the file against the project without writing: what each
 * row would create or update, with the values it would set, and every
 * row error. Rejects (not per row) when the actor is below full team
 * member, the text has no header or no rows, or the mapping is
 * structurally unusable.
 */
export function previewCardImport(db: BetterSQLite3Database, input: PreviewCardImportInput): CommandResult<CardImportPreview> {
  const prepared = prepare(db, input);
  if (!prepared.ok) return prepared;
  const { table, mapping, resolved } = prepared.value;
  const rows = resolved.map((r) => r.preview);
  return {
    ok: true,
    value: {
      header: table.header,
      mapping,
      rows,
      creates: rows.filter((r) => r.action === "create").length,
      updates: rows.filter((r) => r.action === "update").length,
      errorCount: rows.filter((r) => r.action === "error").length,
    },
  };
}

export interface ImportCardsInput extends PreviewCardImportInput {}

export interface CardImportOutcome {
  created: number[];
  updated: number[];
}

/**
 * ImportCards — creates and updates cards from a delimited file.
 *
 * DOES: on one transaction, for each row: creates the card (keeping
 * the file's number when given) or updates its name, description and
 * type when they differ, then applies its property values as ONE
 * further card version through `appendPropertyValueChanges`; appends
 * a CardsImported event listing the created and updated numbers.
 * WHEN: the actor is at least a full team member, the file has a
 * header and rows, the mapping is usable, and EVERY row resolves
 * without error (a valid number, a name for new cards, a known card
 * type, values valid for their properties, no transition-only value
 * from a non-admin).
 * BECAUSE: an import is a batch of ordinary card edits; the file is
 * corrected from the preview rather than half-applied.
 * REJECTS WHEN: the preview would reject, or any row has an error —
 * `rows` errors of the form "Row N: message", nothing written.
 */
export function importCards(db: BetterSQLite3Database, input: ImportCardsInput): CommandResult<CardImportOutcome> {
  const prepared = prepare(db, input);
  if (!prepared.ok) return prepared;
  const { resolved } = prepared.value;
  const rowErrors = resolved.flatMap((r) => r.preview.errors.map((message) => `Row ${r.preview.row}: ${message}`));
  if (rowErrors.length > 0) return { ok: false, errors: { rows: rowErrors } };

  try {
    return db.transaction((tx) => runImport(tx, input, resolved));
  } catch (error) {
    if (error instanceof ImportRejected) return { ok: false, errors: error.errors };
    throw error;
  }
}

/** Carries a command's rejection out of the transaction so it rolls back and is reported, not thrown. */
class ImportRejected extends Error {
  constructor(readonly errors: FieldErrors) {
    super("import rejected");
  }
}

/** A command rejection on a row the preview passed — reported as that row's error after rollback. */
function rowRejected(row: number, errors: FieldErrors): ImportRejected {
  return new ImportRejected({ rows: [`Row ${row}: ${Object.values(errors).flat().join("; ")}`] });
}

/** The write half of ImportCards, on the caller's transaction. */
function runImport(tx: BetterSQLite3Database, input: ImportCardsInput, resolved: ResolvedRow[]): CommandResult<CardImportOutcome> {
  {
    const created: number[] = [];
    const updated: number[] = [];
    for (const row of resolved) {
      let card: CardRow;
      if (row.existing) {
        card = row.existing;
        const name = row.name ?? card.name;
        const description = row.description ?? card.description;
        const cardTypeId = row.cardTypeId ?? card.cardTypeId;
        if (name !== card.name || description !== card.description || cardTypeId !== card.cardTypeId) {
          const result = updateCard(tx, { projectId: input.projectId, cardNumber: card.number, name, description, cardTypeId, actorUserId: input.actorUserId });
          if (!result.ok) throw rowRejected(row.preview.row, result.errors);
          card = result.value;
        }
        updated.push(card.number);
      } else {
        const result = createCard(tx, {
          projectId: input.projectId,
          name: row.name!,
          description: row.description,
          cardTypeId: row.cardTypeId!,
          number: row.number,
          actorUserId: input.actorUserId,
        });
        if (!result.ok) throw rowRejected(row.preview.row, result.errors);
        card = result.value;
        created.push(card.number);
      }
      if (row.changes.length > 0) appendPropertyValueChanges(tx, input.projectId, card, row.changes, input.actorUserId);
    }
    emitEvent(tx, {
      type: "CardsImported",
      aggregateType: "Project",
      aggregateId: input.projectId,
      payload: { created, updated },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { created, updated } };
  }
}
