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
 *
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
import { data, Form, Link, useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards.grid";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { propertyDefinitions } from "~/db/schema/properties";
import { requireUserId } from "~/auth/session.server";
import {
  buildGridView,
  GRID_GROUPABLE_KINDS,
} from "~/domain/cards/grid-view.server";
import { setCardPropertyValue } from "~/domain/cards/properties.server";
import type { FieldErrors } from "~/shared/wire-types";
import "../styles/card-grid.css";

/** Loads the lane projection plus the group-by selector's options. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const groupByName = url.searchParams.get("group_by") ?? "";
  const filterStrings = url.searchParams.getAll("filters[]");
  const view = buildGridView(db, project.id, groupByName, filterStrings);

  const groupable = db
    .select({ name: propertyDefinitions.name, kind: propertyDefinitions.kind })
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .all()
    .filter((d) => (GRID_GROUPABLE_KINDS as readonly string[]).includes(d.kind))
    .map((d) => d.name);

  return {
    project: { name: project.name, identifier: project.identifier },
    groupByName,
    groupBy: view.groupBy ?? null,
    lanes: view.lanes,
    errors: view.errors,
    groupable,
    filterStrings,
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
  if (String(form.get("intent")) !== "drop")
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
  const result = setCardPropertyValue(db, {
    projectId: project.id,
    cardNumber,
    propertyDefinitionId: view.groupBy.id,
    value: value === "" ? null : value,
    actorUserId: userId,
  });
  if (!result.ok) {
    // A same-lane drop arrives as the command's no-change rejection
    // ("card has no changes to save") — that is a quiet success here.
    if (result.errors.card?.includes("has no changes to save"))
      return { ok: true as const };
    return data(
      { ok: false as const, errors: result.errors satisfies FieldErrors },
      { status: 400 },
    );
  }
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
  const { project, groupByName, groupBy, lanes, errors, groupable, filterStrings } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
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
              search: new URLSearchParams(
                filterStrings.map((f) => ["filters[]", f]),
              ).toString(),
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

      {errors.length === 0 && (
        <div id="content-simple" className="grid-results">
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <table id="swimming-pool" className="swimming-pool touchable-wall">
              {groupBy && (
                <thead>
                  <tr>
                    {lanes.map((lane) => (
                      <th
                        key={lane.value}
                        className="lane_header"
                        data-lane-value={lane.value}
                      >
                        <div className="header-title">
                          {lane.title}
                          <span className="lane-card-number aggregate">
                            {lane.cards.length}
                          </span>
                        </div>
                      </th>
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
