/**
 * /api/v1/projects/:identifier/cards — a project's cards (resource
 * route, JSON).
 *
 * GET  lists an `ApiPage<ApiCard>`, newest number first, each with its
 *      property values by name (`?limit=`, `?cursor=` —
 *      app/api/pagination.server.ts). Filters use the card list page's
 *      own wire shape (legacy Filters#to_params): repeated
 *      `filters[]=[<property>][<operator>][<value>]` entries, or a
 *      `filters[mql]=<condition>` that replaces them; an invalid filter
 *      is 400 with the list page's messages under `errors.filters`.
 * POST creates a card via CreateCard, setting any `properties` in the
 *      same transaction (app/api/card-writes.server.ts); body
 *      `ApiCreateCardBody`; 201 with `ApiCardWrite`.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.cards";
import { db } from "~/db/client.server";
import { cards } from "~/db/schema/cards";
import { requireApiUser } from "~/api/auth.server";
import { createCardViaApi } from "~/api/card-writes.server";
import {
  apiError,
  commandResponse,
  jsonResponse,
  methodNotAllowed,
  optionalString,
  optionalStringMap,
  readJsonObject,
  requiredString,
} from "~/api/http.server";
import { cardPresenter, requireProject } from "~/api/resources.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";
import { buildCardListView, queryCardList } from "~/domain/cards/list-view.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import type { ApiCardWrite } from "~/shared/wire-types";

/** GET: one page of the project's cards matching the filters, highest number first. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const url = new URL(request.url);
  const page = readPageParams(url);
  const mql = url.searchParams.get("filters[mql]") ?? "";
  const filterStrings = mql.trim() === "" ? url.searchParams.getAll("filters[]") : [];
  const view = buildCardListView(db, project.id, filterStrings, [], mql);
  if (view.errors.length > 0) throw apiError(400, "invalid filters", { filters: view.errors });
  const matching = queryCardList(db, project.id, view.filters, {
    condition: view.mqlCondition,
    context: { currentUserId: user.id, today: todayIso() },
  });
  const paged = keysetPage(matching, page, (row) => [-row.number]);
  const ids = paged.items.map((row) => row.id);
  const rows =
    ids.length === 0
      ? []
      : db.select().from(cards).where(and(eq(cards.projectId, project.id), inArray(cards.id, ids))).orderBy(desc(cards.number)).all();
  const present = cardPresenter(db, project.id);
  return jsonResponse({ items: rows.map(present), nextCursor: paged.nextCursor });
}

/** POST: CreateCard plus its properties from a JSON body; 201 with the card. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonObject(request);
  const result = createCardViaApi(db, {
    projectId: project.id,
    name: requiredString(body, "name"),
    description: optionalString(body, "description"),
    typeName: optionalString(body, "type"),
    properties: optionalStringMap(body, "properties"),
    actorUserId: user.id,
  });
  const present = cardPresenter(db, project.id);
  return commandResponse(
    result,
    201,
    (outcome): ApiCardWrite => ({ card: present(outcome.card), appliedTransitions: outcome.appliedTransitions }),
  );
}
