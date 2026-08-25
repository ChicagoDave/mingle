/**
 * Property comparison rules — how a property's stored values compare.
 *
 * Purpose: the single answer, shared by the simple-filter read model
 * (list-view.server) and the MQL evaluator (mql-evaluator.server), to
 * "given this definition, do its canonical stored strings compare as
 * numbers, as ISO-date text, as case-insensitive text, or by the
 * defined position of an enumeration value?" Formula properties defer
 * to their compiled output kind (Phase 8), so a date-valued formula
 * compares like a date.
 *
 * Public interface: `comparisonKind`, `ComparisonKind`.
 *
 * Owner context: Card Management (read model support). Read-only.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import {
  propertyDefinitions,
  type PropertyDefinitionRow,
} from "~/db/schema/properties";
import { compileFormula } from "./formula.server";

/**
 * "number" casts to REAL, "date"/"text" compare as text (ISO dates
 * lexically = chronologically; text case-insensitively), "position"
 * compares enumerated values by their defined order.
 */
export type ComparisonKind = "number" | "date" | "text" | "position";

/**
 * Decides how a definition's stored values compare.
 *
 * @param db - Drizzle handle (formula kinds read their sibling definitions)
 * @param definition - the property definition
 * @returns the comparison kind
 */
export function comparisonKind(
  db: BetterSQLite3Database,
  definition: PropertyDefinitionRow,
): ComparisonKind {
  switch (definition.kind) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "enumerated":
      return "position";
    case "formula": {
      // The compiled output kind decides how materialized values compare.
      const inputs = db
        .select()
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.projectId, definition.projectId))
        .all()
        .map((d) => ({ id: d.id, name: d.name, kind: d.kind }));
      const compiled = compileFormula(definition.formula ?? "", inputs);
      return compiled.ok && compiled.formula.outputKind === "date" ? "date" : "number";
    }
    default:
      return "text";
  }
}
