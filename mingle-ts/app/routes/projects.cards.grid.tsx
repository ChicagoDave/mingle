/**
 * /projects/:identifier/cards/grid — the card wall (Phase 10).
 *
 * Purpose: grid view of the project's cards grouped into lanes by a
 * finite-valued property (enumerated or user), with dnd-kit drag-drop
 * between lanes. A drop issues the "drop" action, which dispatches
 * SetCardPropertyValue — the property gains the target lane's value
 * (cleared on the "(not set)" lane) and the card gains a version row,
 * per the Behavior Statement in the session log. Markup and classes
 * harvested from the legacy _card_grid_results.rhtml /
 * _group_lanes.rhtml / _card_div.rhtml (#content-simple.grid-results,
 * table#swimming-pool, th.lane_header, td.cell, div.card-icon).
 * Accepts the same legacy-encoded `filters[]` parameter as the list
 * view (semantics reused from the Phase 9 read model); the filter
 * panel UI itself joins the grid with Phase 13's advanced filters.
 * Since Phase 11 the page carries the project tab bar and the
 * favorites panel; `favorite_id` marks the current favorite. When that
 * favorite is a team grid favorite, its lane WIP limits (P-3) render on
 * the lane headers and the "wip" action sets them; a drop into a full
 * lane is still accepted, as legacy's was.
 *
 *
 * Since Phase 15 a drop is applied through the auto-transition
 * dispatcher rather than the raw property command: a lane of a
 * transition-only property is reachable only by running the transition
 * that moves the card there, and a drop that cannot resolve to exactly
 * one unattended transition is refused rather than silently accepted.
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { eq } from "drizzle-orm";
import { data, Form, Link, useActionData, useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards.grid";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { propertyDefinitions } from "~/db/schema/properties";
import { requireUserId } from "~/auth/session.server";
import {
  buildGridView,
  GRID_GROUPABLE_KINDS,
} from "~/domain/cards/grid-view.server";
import { applyCardPropertyValue } from "~/domain/cards/transition-workflows.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import { listFavorites, serializeFavorite, setLaneWipLimit, wipLimitsFor } from "~/domain/cards/favorites.server";
import { LaneHeader } from "~/components/lane-header";
import {
  PrivilegeLevel,
  privilegeLevelFor,
} from "~/domain/identity/authorization.server";
import { FavoritesPanel } from "~/components/favorites";
import type { FieldErrors } from "~/shared/wire-types";
import "../styles/card-grid.css";

/** Loads the lane projection plus the group-by selector's options. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const groupByName = url.searchParams.get("group_by") ?? "";
  const mql = (url.searchParams.get("filters[mql]") ?? "").trim();
  // MQL replaces the simple filters (legacy MqlFilters is an alternative).
  const filterStrings = mql === "" ? url.searchParams.getAll("filters[]") : [];
  const view = buildGridView(db, project.id, groupByName, filterStrings, mql, {
    currentUserId: userId,
    today: todayIso(),
  });

  const groupable = db
    .select({ name: propertyDefinitions.name, kind: propertyDefinitions.kind })
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .all()
    .filter((d) => (GRID_GROUPABLE_KINDS as readonly string[]).includes(d.kind))
    .map((d) => d.name);

  const favoriteIdParam = url.searchParams.get("favorite_id");
  const wip = favoriteIdParam === null ? null : wipLimitsFor(db, project.id, Number(favoriteIdParam));
  const all = listFavorites(db, project.id, userId);
  const serialize = (list: typeof all.tabs) =>
    list.map((f) => serializeFavorite(project.identifier, f));

  return {
    project: { name: project.name, identifier: project.identifier },
    favorites: { tabs: serialize(all.tabs), team: serialize(all.team), personal: serialize(all.personal) },
    currentFavoriteId: favoriteIdParam === null ? null : Number(favoriteIdParam),
    canSaveFavorites:
      privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
    wipFavoriteId: wip?.favoriteId ?? null,
    wipLimits: wip?.limits ?? {},
    canEditWipLimits:
      wip !== null && privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
    groupByName,
    groupBy: view.groupBy ?? null,
    lanes: view.lanes,
    errors: view.errors,
    groupable,
    filterStrings,
    mql,
  };
}

/**
 * Handles a lane drop: sets (or clears, for the "(not set)" lane) the
 * group-by property on the dropped card via SetCardPropertyValue. A
 * same-lane drop is a no-op success. See the drop Behavior Statement.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "wip") {
    const raw = String(form.get("limit") ?? "").trim();
    const result = setLaneWipLimit(db, {
      projectId: project.id,
      favoriteId: Number(form.get("favoriteId") ?? 0),
      laneValue: String(form.get("laneValue") ?? ""),
      limit: raw === "" ? null : Number(raw),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors satisfies FieldErrors }, { status: 400 });
    return { ok: true as const };
  }
  if (intent !== "drop")
    throw new Response("Unknown intent", { status: 400 });

  const url = new URL(request.url);
  const view = buildGridView(
    db,
    project.id,
    url.searchParams.get("group_by") ?? "",
    [],
  );
  if (!view.groupBy)
    throw new Response("The grid is not grouped by a property", { status: 400 });

  const cardNumber = Number(form.get("cardNumber"));
  const value = String(form.get("value") ?? "");
  // Phase 15: a drop is a property change, so it goes through the
  // auto-transition dispatcher — dragging a card into a lane of a
  // transition-only property runs the transition that moves it there
  // (legacy AutoTransition), rather than overwriting the value and
  // skipping the transition's other actions.
  const outcome = applyCardPropertyValue(db, {
    projectId: project.id,
    cardNumber,
    propertyDefinitionId: view.groupBy.id,
    value: value === "" ? null : value,
    actorUserId: userId,
  });
  if (!outcome.ok) {
    return data(
      { ok: false as const, errors: outcome.errors satisfies FieldErrors },
      { status: 400 },
    );
  }
  // A same-lane drop reports "unchanged" — a quiet success here. The
  // three "cannot pick a transition" outcomes wrote nothing, so the
  // drag must be reported as refused rather than silently accepted.
  if (outcome.value.kind === "require_user_input")
    return data(
      {
        ok: false as const,
        errors: {
          transition: [
            `${outcome.value.transition.name} moves the card there, but needs values you must enter on the card page.`,
          ],
        } satisfies FieldErrors,
      },
      { status: 400 },
    );
  if (outcome.value.kind === "multi_transitions_matched")
    return data(
      {
        ok: false as const,
        errors: {
          transition: [
            `More than one transition moves the card there (${outcome.value.transitions
              .map((transition) => transition.name)
              .join(", ")}); apply the one you want on the card page.`,
          ],
        } satisfies FieldErrors,
      },
      { status: 400 },
    );
  if (outcome.value.kind === "no_transition_matched")
    return data(
      {
        ok: false as const,
        errors: {
          transition: [
            "That lane can only be reached by a transition, and none is available for this card right now.",
          ],
        } satisfies FieldErrors,
      },
      { status: 400 },
    );
  return { ok: true as const };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

/** One draggable mini card (legacy .card-icon). */
function CardIcon({
  card,
  identifier,
  disabled,
}: {
  card: LoaderData["lanes"][number]["cards"][number];
  identifier: string;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: card.number, disabled });
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card-icon${isDragging ? " dragging" : ""}`}
      data-card-number={card.number}
      {...listeners}
      {...attributes}
    >
      <div className="card-inner-wrapper">
        <span className="card-summary-number">
          <a href={`/projects/${identifier}/cards/${card.number}`}>#{card.number}</a>
        </span>
        <div className="card-name">{card.name}</div>
      </div>
    </div>
  );
}

/** One droppable lane cell (legacy td.cell). */
function LaneCell({
  lane,
  identifier,
  disabled,
}: {
  lane: LoaderData["lanes"][number];
  identifier: string;
  disabled: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${lane.value}`, disabled });
  return (
    <td
      ref={setNodeRef}
      className={`cell${isOver ? " cell-highlighted" : ""}`}
      data-lane-value={lane.value}
    >
      {lane.cards.map((card) => (
        <CardIcon
          key={card.number}
          card={card}
          identifier={identifier}
          disabled={disabled}
        />
      ))}
    </td>
  );
}

/** The card wall page — legacy swimming-pool layout with dnd-kit drops. */
export default function ProjectCardGrid() {
  const {
    project,
    groupByName,
    groupBy,
    lanes,
    errors,
    groupable,
    filterStrings,
    mql,
    favorites,
    currentFavoriteId,
    canSaveFavorites,
    wipFavoriteId,
    wipLimits,
    canEditWipLimits,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const actionData = useActionData<typeof action>();
  const wipError =
    actionData && !actionData.ok ? Object.values(actionData.errors).flat().join(" ") : null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [dropError, setDropError] = useState<string | null>(null);
  const dragDisabled = !groupBy;

  function onDragEnd(event: DragEndEvent) {
    if (!event.over || !groupBy) return;
    const cardNumber = Number(event.active.id);
    const value = String(event.over.id).replace(/^lane:/, "");
    const from = lanes.find((lane) => lane.cards.some((c) => c.number === cardNumber));
    if (from && from.value === value) return; // same-lane drop: nothing to do
    setDropError(null);
    fetcher.submit(
      { intent: "drop", cardNumber: String(cardNumber), value },
      { method: "post" },
    );
  }

  const fetcherErrors =
    fetcher.data && !fetcher.data.ok && "errors" in fetcher.data
      ? Object.values(fetcher.data.errors).flat().join("; ")
      : null;

  return (
    <main style={{ fontFamily: "sans-serif" }}>
      <div style={{ padding: "16px 16px 0" }}>
        <h1 style={{ margin: 0 }}>
          {project.name} wall <small>({project.identifier})</small>
        </h1>
        <p>
          <Link to="/projects">All projects</Link> ·{" "}
          <Link
            to={{
              pathname: `/projects/${project.identifier}/cards`,
              search: new URLSearchParams([
                ...filterStrings.map((f) => ["filters[]", f]),
                ...(mql !== "" ? [["filters[mql]", mql]] : []),
              ]).toString(),
            }}
          >
            List
          </Link>{" "}
          · <Link to={`/projects/${project.identifier}/cards/new`}>New card</Link>
        </p>
      </div>

      <div className="grid-actions">
        <Form method="get">
          {filterStrings.map((f, i) => (
            <input key={i} type="hidden" name="filters[]" value={f} />
          ))}
          {mql !== "" && <input type="hidden" name="filters[mql]" value={mql} />}
          <label>
            Group by{" "}
            <select name="group_by" defaultValue={groupByName}>
              <option value="">(none)</option>
              {groupable.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>{" "}
          <button type="submit" className="link_as_button">
            Apply
          </button>
        </Form>
        <Form method="get" className="mql-filter" id="mql-filter-form">
          {groupByName !== "" && <input type="hidden" name="group_by" value={groupByName} />}
          <label>
            Filter by MQL{" "}
            <input
              type="text"
              name="filters[mql]"
              id="mql_filter_edit_window"
              defaultValue={mql}
              placeholder="type = card AND size != 4"
              size={48}
            />
          </label>{" "}
          <button type="submit" className="link_as_button">
            Apply filter
          </button>
        </Form>
        <FavoritesPanel
          identifier={project.identifier}
          team={favorites.team}
          personal={favorites.personal}
          currentFavoriteId={currentFavoriteId}
          currentView={{ style: "grid", filters: filterStrings, columns: [], groupBy: groupBy?.name ?? "", mql }}
          canSave={canSaveFavorites}
        />
      </div>

      {errors.length > 0 && (
        <ul className="grid-errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {(fetcherErrors ?? dropError) && (
        <p className="grid-errors">{fetcherErrors ?? dropError}</p>
      )}
      {wipError && <p className="grid-errors">{wipError}</p>}

      {errors.length === 0 && (
        <div id="content-simple" className="grid-results">
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <table id="swimming-pool" className="swimming-pool touchable-wall">
              {groupBy && (
                <thead>
                  <tr>
                    {lanes.map((lane) => (
                      <LaneHeader
                        key={lane.value}
                        title={lane.title}
                        laneValue={lane.value}
                        count={lane.cards.length}
                        limit={wipLimits[lane.value] ?? null}
                        favoriteId={wipFavoriteId}
                        editable={canEditWipLimits}
                      />
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                <tr className="grid-row">
                  {lanes.map((lane) => (
                    <LaneCell
                      key={lane.value}
                      lane={lane}
                      identifier={project.identifier}
                      disabled={dragDisabled}
                    />
                  ))}
                </tr>
              </tbody>
            </table>
          </DndContext>
        </div>
      )}
    </main>
  );
}
