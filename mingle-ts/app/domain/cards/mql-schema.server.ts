/**
 * MQL schema loader — the infrastructure adapter that assembles a
 * project's `MqlSchema` for the pure MQL parser (Phase 12).
 *
 * Purpose: one read of everything MQL resolution needs — property
 * definitions with their enumeration values, card type names, team
 * members' logins, and project variables — so `parseMql` stays a pure
 * function of (text, schema). Callers that parse several queries for
 * the same project load the schema once and reuse it.
 *
 * Public interface: `loadMqlSchema`, `parseProjectMql`.
 *
 * Owner context: Query. Takes the Drizzle handle as a parameter — no
 * module-level infrastructure imports.
 */
import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cardTypes } from "~/db/schema/cards";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import { projectVariables } from "~/db/schema/projects";
import { enumerationValues, propertyDefinitions } from "~/db/schema/properties";
import type { ProjectVariableDataType, PropertyKind } from "~/shared/wire-types";
import {
  type MqlParseResult,
  type MqlPropertyShape,
  type MqlSchema,
  parseMql,
} from "~/domain/cards/mql.server";

/**
 * Loads the MQL-visible schema of one project.
 *
 * @param db - Drizzle handle
 * @param projectId - the project whose definitions scope the query
 * @returns the schema; empty collections for an unknown project
 */
export function loadMqlSchema(db: BetterSQLite3Database, projectId: number): MqlSchema {
  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, projectId))
    .orderBy(asc(propertyDefinitions.position), asc(propertyDefinitions.id))
    .all();
  const byId = new Map<number, MqlPropertyShape>();
  for (const d of definitions) {
    byId.set(d.id, { id: d.id, name: d.name, kind: d.kind as PropertyKind });
  }
  if (definitions.length > 0) {
    const values = db
      .select({
        definitionId: enumerationValues.propertyDefinitionId,
        value: enumerationValues.value,
      })
      .from(enumerationValues)
      .innerJoin(
        propertyDefinitions,
        eq(propertyDefinitions.id, enumerationValues.propertyDefinitionId),
      )
      .where(eq(propertyDefinitions.projectId, projectId))
      .orderBy(asc(enumerationValues.position))
      .all();
    for (const v of values) {
      const shape = byId.get(v.definitionId);
      if (shape) (shape.values ??= []).push(v.value);
    }
  }
  const types = db
    .select({ name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .orderBy(asc(cardTypes.position))
    .all();
  const members = db
    .select({ id: users.id, login: users.login })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, projectId))
    .all();
  const variables = db
    .select({
      name: projectVariables.name,
      dataType: projectVariables.dataType,
      value: projectVariables.value,
    })
    .from(projectVariables)
    .where(eq(projectVariables.projectId, projectId))
    .all();
  return {
    properties: [...byId.values()],
    cardTypes: types.map((t) => t.name),
    users: members,
    projectVariables: variables.map((v) => ({
      name: v.name,
      dataType: v.dataType as ProjectVariableDataType,
      value: v.value,
    })),
  };
}

/**
 * Convenience: loads the project's schema and parses one query.
 *
 * @param db - Drizzle handle
 * @param projectId - scoping project
 * @param text - the MQL string
 * @returns the parse result (see parseMql)
 */
export function parseProjectMql(
  db: BetterSQLite3Database,
  projectId: number,
  text: string,
): MqlParseResult {
  return parseMql(text, loadMqlSchema(db, projectId));
}
