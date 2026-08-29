/**
 * /api/v1/projects/:identifier/property_definitions — a project's
 * property definitions (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiPropertyDefinition>` (`?limit=`, `?cursor=`) in display order.
 * POST defines one via DefinePropertyDefinition (project admin, as in
 *      the UI); body `ApiDefinePropertyDefinitionBody`; 201 with the
 *      definition as the list presents it.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import type { Route } from "./+types/api.v1.projects.property-definitions";
import { db } from "~/db/client.server";
import { definePropertyDefinition } from "~/domain/cards/properties.server";
import { requireApiUser } from "~/api/auth.server";
import {
  apiError,
  commandResponse,
  jsonResponse,
  methodNotAllowed,
  optionalString,
  readJsonObject,
  requiredString,
} from "~/api/http.server";
import { propertyDefinitionResources, requireProject } from "~/api/resources.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";

/** GET: the project's property definitions in display order. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const page = readPageParams(new URL(request.url));
  const paged = keysetPage(propertyDefinitionResources(db, project.id), page, (row) => [row.position, row.id]);
  return jsonResponse(paged);
}

/** Reads the optional `values` list — strings only. */
function optionalStringList(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw apiError(400, `'${field}' must be an array of strings`);
  return value as string[];
}

/** Reads an optional boolean field. */
function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw apiError(400, `'${field}' must be a boolean`);
  return value;
}

/** POST: DefinePropertyDefinition from a JSON body; 201 with the definition. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = definePropertyDefinition(db, {
    projectId: project.id,
    name: requiredString(body, "name"),
    kind: requiredString(body, "kind"),
    values: optionalStringList(body, "values"),
    formula: optionalString(body, "formula"),
    nullIsZero: optionalBoolean(body, "nullIsZero"),
    transitionOnly: optionalBoolean(body, "transitionOnly"),
    actorUserId: user.id,
  });
  return commandResponse(result, 201, (row) =>
    propertyDefinitionResources(db, project.id).find((definition) => definition.id === row.id),
  );
}
