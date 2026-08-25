/**
 * /projects/:identifier/cards — the project's card list (Phase 9).
 *
 * Purpose: the card list view — a results table with selectable
 * property columns and either simple property filters (equality and
 * range) or, since Phase 13, an advanced MQL filter carried in the
 * legacy `filters[mql]` parameter (MqlFilters#to_params) that replaces
 * the simple filters when present. Layout harvested from the legacy
 * _card_list_results.rhtml (#content, table.edit-table, .cards-header,
 * tr.table-column-header, td.number/.card-name), _column_selector.rhtml
 * (Add / remove columns dropdown), and the interactive filter tab
 * ("Show cards where:", filter rows, "Add a filter"). Filters travel
 * in the legacy-encoded `filters[]` query parameter; the no-JS filter
 * and column forms submit their own field names, which the loader
 * canonicalizes into the legacy URL shape via redirect. Since Phase 11
 * the page carries the project tab bar and the favorites panel;
 * `?view=<name>` (legacy cards#index view param) opens the team
 * favorite of that name and `favorite_id` marks the current favorite.
 *
 * Public interface: `loader`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { asc, eq, inArray } from "drizzle-orm";
import { Form, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { cardTypes } from "~/db/schema/cards";
import {
  cardPropertyValues,
  enumerationValues,
  propertyDefinitions,
} from "~/db/schema/properties";
import { users } from "~/db/schema/identity";
import { teamMemberships } from "~/db/schema/membership";
import { requireUserId } from "~/auth/session.server";
import {
  buildCardListView,
  CARD_TYPE_COLUMN_NAME,
  encodeFilterString,
  parseFilterString,
  queryCardList,
} from "~/domain/cards/list-view.server";
import { todayIso } from "~/domain/cards/mql-evaluator.server";
import {
  favoriteHref,
  findFavoriteByName,
  listFavorites,
  serializeFavorite,
} from "~/domain/cards/favorites.server";
import {
  PrivilegeLevel,
  privilegeLevelFor,
} from "~/domain/identity/authorization.server";
import { FavoritesPanel, ViewTabs } from "~/components/favorites";
import {
  filterOperatorLabel,
  filterOperatorsFor,
  type PropertyKind,
} from "~/shared/wire-types";
import "../styles/card-list.css";

/** Rebuilds the canonical list URL from filters[] / filters[mql] and columns. */
function listSearch(filterStrings: string[], columnNames: string[], mql = ""): string {
  const params = new URLSearchParams();
  for (const filter of filterStrings) params.append("filters[]", filter);
  if (mql !== "") params.set("filters[mql]", mql);
  if (columnNames.length > 0) params.set("columns", columnNames.join(","));
  const search = params.toString();
  return search ? `?${search}` : "";
}

/**
 * Loads the filtered card list plus everything the filter/column
 * widgets render from. Canonicalizes no-JS form submissions (fp/fo/fv
 * filter rows, col checkboxes) into the legacy `filters[]`/`columns`
 * URL shape via redirect before answering.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const url = new URL(request.url);

  // Legacy `view=<name>` opens the team favorite of that name.
  const viewName = url.searchParams.get("view");
  if (viewName !== null) {
    const favorite = findFavoriteByName(db, project.id, viewName, null);
    if (!favorite) throw new Response("Not Found", { status: 404 });
    throw redirect(favoriteHref(project.identifier, favorite));
  }

  const columnsParam = url.searchParams.get("columns");
  let columnNames =
    columnsParam !== null
      ? columnsParam.split(",").map((c) => c.trim()).filter(Boolean)
      : [];

  const mql = (url.searchParams.get("filters[mql]") ?? "").trim();

  // Canonicalize a column-selector submission (col checkboxes).
  if (url.searchParams.has("apply-columns")) {
    const filters = url.searchParams.getAll("filters[]");
    throw redirect(
      `/projects/${project.identifier}/cards${listSearch(filters, url.searchParams.getAll("col"), mql)}`,
    );
  }

  // Canonicalize an MQL-filter submission: MQL replaces simple filters
  // (legacy: the MQL filter tab is an alternative to the filter widget).
  if (url.searchParams.has("apply-mql")) {
    throw redirect(
      `/projects/${project.identifier}/cards${listSearch([], columnNames, mql)}`,
    );
  }

  // Canonicalize a filter-form submission (aligned fp/fo/fv rows).
  if (url.searchParams.has("apply-filters")) {
    const names = url.searchParams.getAll("fp");
    const operators = url.searchParams.getAll("fo");
    const values = url.searchParams.getAll("fv");
    const encoded = names
      .map((name, i) => ({ name, operator: operators[i] ?? "is", value: values[i] ?? "" }))
      .filter((row) => row.name !== "")
      .map((row) => encodeFilterString(row.name, row.operator, row.value));
    throw redirect(
      `/projects/${project.identifier}/cards${listSearch(encoded, columnNames)}`,
    );
  }

  const filterStrings = mql === "" ? url.searchParams.getAll("filters[]") : [];
  const view = buildCardListView(db, project.id, filterStrings, columnNames, mql);
  columnNames = view.columns.map((c) => c.name);
  const rows =
    view.errors.length > 0
      ? []
      : queryCardList(db, project.id, view.filters, {
          condition: view.mqlCondition,
          context: { currentUserId: userId, today: todayIso() },
        });

  // Everything the widgets offer: definitions (with enum values), team
  // members for user-kind selects, and card type names.
  const definitions = db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .orderBy(asc(propertyDefinitions.position), asc(propertyDefinitions.id))
    .all();
  const enumValues =
    definitions.length > 0
      ? db
          .select()
          .from(enumerationValues)
          .where(
            inArray(
              enumerationValues.propertyDefinitionId,
              definitions.map((d) => d.id),
            ),
          )
          .orderBy(asc(enumerationValues.position))
          .all()
      : [];
  const members = db
    .select({ id: users.id, name: users.name })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, project.id))
    .orderBy(asc(users.name))
    .all();
  const typeNames = db
    .select({ name: cardTypes.name })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, project.id))
    .orderBy(asc(cardTypes.position), asc(cardTypes.id))
    .all()
    .map((t) => t.name);

  // Cell values for the selected property columns.
  const columnDefinitions = view.columns.flatMap((c) => (c.definition ? [c.definition] : []));
  const cellRows =
    rows.length > 0 && columnDefinitions.length > 0
      ? db
          .select()
          .from(cardPropertyValues)
          .where(
            inArray(
              cardPropertyValues.cardId,
              rows.map((r) => r.id),
            ),
          )
          .all()
          .filter((v) =>
            columnDefinitions.some((d) => d.id === v.propertyDefinitionId),
          )
      : [];
  const userIds = new Set<number>();
  for (const definition of columnDefinitions) {
    if (definition.kind !== "user") continue;
    for (const cell of cellRows) {
      if (cell.propertyDefinitionId === definition.id) userIds.add(Number(cell.value));
    }
  }
  const userNames = new Map(
    userIds.size > 0
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, [...userIds]))
          .all()
          .map((u) => [u.id, u.name] as const)
      : [],
  );
  const cells: Record<number, Record<string, string>> = {};
  for (const cell of cellRows) {
    const definition = columnDefinitions.find((d) => d.id === cell.propertyDefinitionId);
    if (!definition) continue;
    const display =
      definition.kind === "user"
        ? (userNames.get(Number(cell.value)) ?? cell.value)
        : cell.value;
    (cells[cell.cardId] ??= {})[String(definition.id)] = display;
  }

  const favoriteIdParam = url.searchParams.get("favorite_id");
  const all = listFavorites(db, project.id, userId);
  const serialize = (list: typeof all.tabs) =>
    list.map((f) => serializeFavorite(project.identifier, f));

  return {
    project: { name: project.name, identifier: project.identifier },
    favorites: { tabs: serialize(all.tabs), team: serialize(all.team), personal: serialize(all.personal) },
    currentFavoriteId: favoriteIdParam === null ? null : Number(favoriteIdParam),
    canSaveFavorites:
      privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
    cards: rows.map((row) => ({
      number: row.number,
      name: row.name,
      cardTypeName: row.cardTypeName,
      cells: cells[row.id] ?? {},
    })),
    columns: view.columns.map((c) => ({ key: c.key, name: c.name })),
    errors: view.errors,
    // One row per raw filters[] entry (parseable or not) so the widget
    // shows exactly what the URL says and remove-links index correctly.
    filterRows: filterStrings.map(
      (f) => parseFilterString(f) ?? { propertyName: "", operator: "is", value: "" },
    ),
    filterStrings,
    mql,
    columnNames,
    options: {
      properties: definitions.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind as PropertyKind,
        enumValues: enumValues
          .filter((v) => v.propertyDefinitionId === d.id)
          .map((v) => v.value),
      })),
      members,
      typeNames,
    },
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type FilterRow = { propertyName: string; operator: string; value: string };

/** One filter row's three widgets (property, operator, value). */
function FilterRowFields({
  row,
  options,
}: {
  row: FilterRow;
  options: LoaderData["options"];
}) {
  const property = options.properties.find(
    (p) => p.name.toLowerCase() === row.propertyName.toLowerCase(),
  );
  const isType =
    row.propertyName.toLowerCase() === CARD_TYPE_COLUMN_NAME.toLowerCase();
  const kind: PropertyKind | "type" | undefined = isType
    ? "type"
    : property?.kind;
  const operators = kind ? filterOperatorsFor(kind) : (["is", "is not"] as const);
  const isDate = kind === "date";
  const choices = isType
    ? options.typeNames
    : property?.kind === "enumerated"
      ? property.enumValues
      : undefined;
  return (
    <>
      <select name="fp" defaultValue={row.propertyName} aria-label="Property">
        <option value="">(select...)</option>
        <option value={CARD_TYPE_COLUMN_NAME}>{CARD_TYPE_COLUMN_NAME}</option>
        {options.properties.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <select name="fo" defaultValue={row.operator} aria-label="Operator">
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {filterOperatorLabel(operator, isDate)}
          </option>
        ))}
      </select>
      {choices ? (
        <select name="fv" defaultValue={row.value} aria-label="Value">
          <option value="">(not set)</option>
          {choices.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      ) : kind === "user" ? (
        <select name="fv" defaultValue={row.value} aria-label="Value">
          <option value="">(not set)</option>
          {options.members.map((member) => (
            <option key={member.id} value={String(member.id)}>
              {member.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          name="fv"
          defaultValue={row.value}
          placeholder="(not set)"
          aria-label="Value"
        />
      )}
    </>
  );
}

/** Card list page — legacy _card_list_results layout plus filter panel. */
export default function ProjectCards() {
  const data = useLoaderData<typeof loader>();
  const {
    project,
    cards,
    columns,
    filterRows,
    errors,
    filterStrings,
    mql,
    columnNames,
    options,
    favorites,
    currentFavoriteId,
    canSaveFavorites,
  } = data;
  const base = `/projects/${project.identifier}/cards`;
  const removeFilterHref = (index: number) => {
    const params = new URLSearchParams();
    filterStrings
      .filter((_, i) => i !== index)
      .forEach((f) => params.append("filters[]", f));
    if (columnNames.length > 0) params.set("columns", columnNames.join(","));
    const search = params.toString();
    return search ? `${base}?${search}` : base;
  };

  return (
    <main style={{ fontFamily: "sans-serif" }}>
      <div style={{ padding: "16px 16px 0" }}>
        <h1 style={{ margin: 0 }}>
          {project.name} cards <small>({project.identifier})</small>
        </h1>
        <p>
          <Link to="/projects">All projects</Link> ·{" "}
          <Link to={`/projects/${project.identifier}/settings`}>Settings</Link> ·{" "}
          <Link to={`/projects/${project.identifier}/transitions`}>Transitions</Link> ·{" "}
          <Link to={`/projects/${project.identifier}/team`}>Team</Link> ·{" "}
          <Link
            to={{
              pathname: `${base}/grid`,
              search: new URLSearchParams([
                ...filterStrings.map((f) => ["filters[]", f]),
                ...(mql !== "" ? [["filters[mql]", mql]] : []),
              ]).toString(),
            }}
          >
            Grid
          </Link>{" "}
          · <Link to={`${base}/new`}>New card</Link>
        </p>
      </div>

      <ViewTabs
        identifier={project.identifier}
        tabs={favorites.tabs}
        currentFavoriteId={currentFavoriteId}
      />

      <div id="card-list-page">
        <div id="content">
          <table className="edit-table sortable_table" id="cards">
            <thead>
              <tr className="cards-header">
                <td colSpan={2 + columns.length}>
                  <span className="view_controls">
                    <details id="column-selector-container">
                      <summary>Add / remove columns</summary>
                      <Form method="get" action={base} id="column-selector">
                        {filterStrings.map((f, i) => (
                          <input key={i} type="hidden" name="filters[]" value={f} />
                        ))}
                        {mql !== "" && <input type="hidden" name="filters[mql]" value={mql} />}
                        <ul id="options-container">
                          {[CARD_TYPE_COLUMN_NAME, ...options.properties.map((p) => p.name)].map(
                            (name) => (
                              <li key={name}>
                                <input
                                  type="checkbox"
                                  name="col"
                                  value={name}
                                  id={`toggle_column_${name}`}
                                  defaultChecked={columnNames.some(
                                    (c) => c.toLowerCase() === name.toLowerCase(),
                                  )}
                                />
                                <label htmlFor={`toggle_column_${name}`}>{name}</label>
                              </li>
                            ),
                          )}
                        </ul>
                        <button type="submit" name="apply-columns" value="1">
                          Apply
                        </button>
                      </Form>
                    </details>
                  </span>
                  <span className="card_count">
                    Showing {cards.length} card{cards.length === 1 ? "" : "s"}
                  </span>
                </td>
              </tr>
              <tr className="table-column-header">
                <th className="number">#</th>
                <th>Name</th>
                {columns.map((column) => (
                  <th key={column.key}>{column.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr className="card-row" key={card.number}>
                  <td className="number">
                    <a href={`${base}/${card.number}`} className="number">
                      {card.number}
                    </a>
                  </td>
                  <td className="card-name">
                    <a href={`${base}/${card.number}`}>{card.name}</a>
                  </td>
                  {columns.map((column) => (
                    <td key={column.key}>
                      {column.key === "type"
                        ? card.cardTypeName
                        : (card.cells[column.key] ?? " ")}
                    </td>
                  ))}
                </tr>
              ))}
              {cards.length === 0 && (
                <tr>
                  <td colSpan={2 + columns.length}>
                    {errors.length > 0 ? "Fix the filter errors to see cards." : "No cards found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside id="filter-panel">
          <h2>Filter</h2>
          {errors.length > 0 && (
            <ul className="filter-errors">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          {mql !== "" ? (
            <p id="filter-and-or" className="text-light">
              Filtering by MQL. Clear the MQL filter to use the simple filters.
            </p>
          ) : (
            <p id="filter-and-or" className="text-light">
              Show cards where:
            </p>
          )}
          {mql === "" && (
          <Form method="get" action={base} id="filter-widget">
            {columnNames.length > 0 && (
              <input type="hidden" name="columns" value={columnNames.join(",")} />
            )}
            {filterRows.map((filter, index) => (
              <div
                className="filter-row"
                key={`${filter.propertyName}-${filter.operator}-${filter.value}-${index}`}
              >
                <FilterRowFields row={filter} options={options} />
                <a
                  className="remove-filter"
                  href={removeFilterHref(index)}
                  aria-label={`Remove filter on ${filter.propertyName}`}
                >
                  ×
                </a>
              </div>
            ))}
            <div className="filter-row">
              <FilterRowFields
                row={{ propertyName: "", operator: "is", value: "" }}
                options={options}
              />
            </div>
            <div id="add_new_filter_link">
              <button type="submit" name="apply-filters" value="1" className="link_as_button">
                Apply filters
              </button>
            </div>
          </Form>
          )}
          <section id="mql-filter" className="mql-filter">
            <h3>Filter by MQL</h3>
            <p className="text-light">
              Using MQL conditions in filter. For example:{" "}
              <code>type = card AND size != 4</code>.
            </p>
            <Form method="get" action={base} id="mql-filter-form">
              {columnNames.length > 0 && (
                <input type="hidden" name="columns" value={columnNames.join(",")} />
              )}
              <textarea
                name="filters[mql]"
                id="mql_filter_edit_window"
                rows={6}
                defaultValue={mql}
                aria-label="MQL filter"
              />
              <div className="mql-filter-actions">
                <button type="submit" name="apply-mql" value="1" className="link_as_button">
                  Apply filter
                </button>{" "}
                {mql !== "" && (
                  <Link to={`${base}${listSearch([], columnNames)}`}>Clear</Link>
                )}
              </div>
            </Form>
          </section>
          <FavoritesPanel
            identifier={project.identifier}
            team={favorites.team}
            personal={favorites.personal}
            currentFavoriteId={currentFavoriteId}
            currentView={{ style: "list", filters: filterStrings, columns: columnNames, groupBy: "", mql }}
            canSave={canSaveFavorites}
          />
        </aside>
      </div>
    </main>
  );
}
