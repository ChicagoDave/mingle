/**
 * /api/v1/projects/:identifier/transitions — a project's transition
 * definitions (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiTransition>` by name (`?limit=`,
 *      `?cursor=`) with legacy one-line prerequisite and action
 *      descriptions. Executing a transition on a card is the card's
 *      own transitions resource (api.v1.projects.cards.card.transitions).
 * POST defines a transition via DefineTransition — the same command
 *      and validation the transitions page uses; body
 *      `ApiDefineTransitionBody` with properties, card type, users and
 *      groups named rather than numbered (an unknown name is 422 under
 *      its field). A prerequisite `value: null` requires the property
 *      to be UNSET and is stored as the nil-valued HasSpecificValue
 *      (ADR-0010). Editing is delete-and-recreate on
 *      `/transitions/:id` (ADR-0007). 201 with `ApiTransition`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Workflow.
 */
import type { Route } from "./+types/api.v1.projects.transitions";
import { db } from "~/db/client.server";
import { requireApiUser } from "~/api/auth.server";
import { and, eq, sql } from "drizzle-orm";
import { groups } from "~/db/schema/membership";
import { apiError, commandResponse, jsonResponse, methodNotAllowed, readJsonObject, optionalString, requiredString } from "~/api/http.server";
import { findCardTypeByName, findPropertyDefinitionByName, listPropertyDefinitions, userIdForLogin } from "~/api/resources.server";
import {
  defineTransition,
  type TransitionActionInput,
  type TransitionPrerequisiteInput,
} from "~/domain/cards/transitions.server";
import type { ApiTransition, FieldErrors } from "~/shared/wire-types";
import { requireProject, transitionResources } from "~/api/resources.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";

/** GET: every transition of the project, ordered by name. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const page = readPageParams(new URL(request.url));
  // Legacy lists transitions by name (smart_sort); the id breaks ties.
  const byName = transitionResources(db, project.id).sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id,
  );
  return jsonResponse(keysetPage(byName, page, (row) => [row.name.toLowerCase(), row.id]));
}

/** Carries a name-resolution failure out of the body walk as a 422 field error. */
class Unresolved extends Error {
  constructor(readonly errors: FieldErrors) {
    super("unresolved");
  }
}

/** Reads `body[field]` as an array of objects, or throws 400. */
function objectList(body: Record<string, unknown>, field: string, required: boolean): Record<string, unknown>[] {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw apiError(400, `'${field}' is required`);
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null || Array.isArray(item)))
    throw apiError(400, `'${field}' must be an array of objects`);
  return value as Record<string, unknown>[];
}

/** Reads `body[field]` as an array of strings, or throws 400. */
function stringList(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw apiError(400, `'${field}' must be an array of strings`);
  return value as string[];
}

/** Translates the wire definition into DefineTransition's input, resolving every name. */
function definitionFromBody(projectId: number, body: Record<string, unknown>, actorUserId: number) {
  const definitions = listPropertyDefinitions(db, projectId);
  const propertyId = (field: string, entry: Record<string, unknown>, index: number): number => {
    const name = entry.property;
    if (typeof name !== "string" || name.trim() === "") throw apiError(400, `'${field}[${index}].property' must be a property name`);
    const definition = findPropertyDefinitionByName(definitions, name);
    if (!definition) throw new Unresolved({ [field]: [`unknown property '${name}'`] });
    return definition.id;
  };

  const prerequisites: TransitionPrerequisiteInput[] = objectList(body, "prerequisites", false).map((entry, index) => {
    const propertyDefinitionId = propertyId("prerequisites", entry, index);
    if (entry.set === true) return { kind: "has_set_value", propertyDefinitionId };
    if (!("value" in entry)) throw apiError(400, `'prerequisites[${index}]' needs 'value' (a string, or null for unset) or 'set: true'`);
    if (entry.value !== null && typeof entry.value !== "string")
      throw apiError(400, `'prerequisites[${index}].value' must be a string or null`);
    return { kind: "has_specific_value", propertyDefinitionId, value: entry.value as string | null };
  });

  const actions: TransitionActionInput[] = objectList(body, "actions", true).map((entry, index) => {
    const propertyDefinitionId = propertyId("actions", entry, index);
    if (entry.input !== undefined) {
      if (entry.input !== "required" && entry.input !== "optional")
        throw apiError(400, `'actions[${index}].input' must be "required" or "optional"`);
      return { propertyDefinitionId, inputMode: entry.input === "required" ? "user_input_required" : "user_input_optional", value: null };
    }
    if (entry.value !== undefined && entry.value !== null && typeof entry.value !== "string")
      throw apiError(400, `'actions[${index}].value' must be a string or null`);
    return { propertyDefinitionId, inputMode: "fixed", value: (entry.value as string | null | undefined) ?? null };
  });

  const usedBy = body.usedBy;
  if (usedBy !== undefined && usedBy !== null) {
    if (typeof usedBy !== "object" || Array.isArray(usedBy)) throw apiError(400, "'usedBy' must be an object");
    const scope = usedBy as Record<string, unknown>;
    for (const login of stringList(scope, "users")) {
      const userId = userIdForLogin(db, login);
      if (userId === undefined) throw new Unresolved({ usedBy: [`unknown user '${login}'`] });
      prerequisites.push({ kind: "is_user", userId });
    }
    for (const groupName of stringList(scope, "groups")) {
      const group = db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.projectId, projectId), sql`lower(${groups.name}) = ${groupName.trim().toLowerCase()}`))
        .get();
      if (!group) throw new Unresolved({ usedBy: [`unknown group '${groupName}'`] });
      prerequisites.push({ kind: "in_group", groupId: group.id });
    }
  }

  const cardTypeName = optionalString(body, "cardType");
  let cardTypeId: number | null = null;
  if (cardTypeName) {
    const cardType = findCardTypeByName(db, projectId, cardTypeName);
    if (!cardType) throw new Unresolved({ cardType: [`unknown card type '${cardTypeName}'`] });
    cardTypeId = cardType.id;
  }

  return { projectId, name: requiredString(body, "name"), cardTypeId, prerequisites, actions, actorUserId };
}

/** POST: DefineTransition from a JSON body; 201 with the transition. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  let input: ReturnType<typeof definitionFromBody>;
  try {
    input = definitionFromBody(project.id, body, user.id);
  } catch (error) {
    if (error instanceof Unresolved) return jsonResponse({ error: "transition definition names something unknown", errors: error.errors }, 422);
    throw error;
  }
  const result = defineTransition(db, input);
  return commandResponse(result, 201, (row): ApiTransition => transitionResources(db, project.id).find((t) => t.id === row.id)!);
}
