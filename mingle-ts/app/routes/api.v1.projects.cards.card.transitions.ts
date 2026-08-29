/**
 * /api/v1/projects/:identifier/cards/:number/transitions — the
 * transitions of one card (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiAvailableTransition>` (`?limit=`, `?cursor=`): the transitions the calling
 *      user may execute on the card right now, with the inputs each
 *      needs (legacy Card#transitions).
 * POST executes one via ExecuteTransition; body
 *      `ApiExecuteTransitionBody` (`transition` by id or name,
 *      `userInput` by property name); 200 with
 *      `ApiTransitionExecution`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Workflow.
 */
import type { Route } from "./+types/api.v1.projects.cards.card.transitions";
import { db } from "~/db/client.server";
import { executeTransition, loadTransitions } from "~/domain/cards/transitions.server";
import { requireApiUser } from "~/api/auth.server";
import {
  apiError,
  commandResponse,
  jsonResponse,
  methodNotAllowed,
  optionalStringMap,
  readJsonObject,
} from "~/api/http.server";
import {
  availableTransitionResources,
  cardPresenter,
  findPropertyDefinitionByName,
  listPropertyDefinitions,
  requireCard,
  requireProject,
  resolvePropertyInput,
} from "~/api/resources.server";
import type { ApiTransitionExecution, FieldErrors } from "~/shared/wire-types";
import { keysetPage, readPageParams } from "~/api/pagination.server";

/** GET: one page of the transitions the caller may execute on the card now, by name. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  const page = readPageParams(new URL(request.url));
  const byName = availableTransitionResources(db, project.id, card.number, user.id).sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id,
  );
  return jsonResponse(keysetPage(byName, page, (row) => [row.name.toLowerCase(), row.id]));
}

/**
 * Resolves `transition` (an id, or a name matched case-insensitively)
 * to a transition id of the project. An unknown name is a 422 in the
 * command's own wording; an unknown id is left to the command.
 */
function transitionIdFrom(body: Record<string, unknown>, projectId: number): number | Response {
  const value = body.transition;
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "")
    return apiError(400, "'transition' is required: a transition id or name");
  const wanted = value.trim().toLowerCase();
  const match = loadTransitions(db, projectId).find((detail) => detail.transition.name.toLowerCase() === wanted);
  if (!match) return apiError(422, "Validation failed", { transition: [`'${value}' is not a transition of this project`] });
  return match.transition.id;
}

/** POST: ExecuteTransition from a JSON body; 200 with the execution facts. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const transitionId = transitionIdFrom(body, project.id);
  if (transitionId instanceof Response) return transitionId;

  // userInput arrives keyed by property name; the command wants
  // definition ids, and user-kind values as ids rather than logins.
  const definitions = listPropertyDefinitions(db, project.id);
  const userInput: Record<string, string | null> = {};
  const inputErrors: FieldErrors = {};
  for (const [name, raw] of Object.entries(optionalStringMap(body, "userInput") ?? {})) {
    const definition = findPropertyDefinitionByName(definitions, name);
    if (!definition) {
      inputErrors[`userInput.${name}`] = ["is not a property of this project"];
      continue;
    }
    const resolved = resolvePropertyInput(db, definition, raw);
    if (!resolved.ok) {
      inputErrors[`userInput.${name}`] = [resolved.message];
      continue;
    }
    userInput[String(definition.id)] = resolved.value;
  }
  if (Object.keys(inputErrors).length > 0) return apiError(422, "Validation failed", inputErrors);

  const result = executeTransition(db, {
    projectId: project.id,
    cardNumber: card.number,
    transitionId,
    userInput,
    actorUserId: user.id,
  });
  const present = cardPresenter(db, project.id);
  return commandResponse(
    result,
    200,
    (execution): ApiTransitionExecution => ({
      card: present(execution.card),
      transition: execution.transitionName,
      changedProperties: execution.changedProperties,
    }),
  );
}
