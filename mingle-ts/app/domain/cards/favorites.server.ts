/**
 * Card Management command handlers and read helpers — Favorites, tabs,
 * and saved views (Phase 11).
 *
 * Purpose: the only write path for the Favorite aggregate — a named,
 * saved list/grid configuration scoped to the team or to one user, and
 * optionally promoted to a project tab. Ports the legacy rules from
 * favorite.rb / card_list_view.rb / favorites_controller.rb: names are
 * required and unique case-insensitively within their scope; saving an
 * existing name replaces that favorite's view (create_or_update); only
 * team favorites become tabs; full team members save views and remove
 * team favorites, project administrators promote/demote tabs and
 * delete. A favorite's view parameters are validated through the
 * Phase 9/10 read models before they are stored, so a saved favorite
 * always reopens to a renderable view — never to a filter error.
 *
 * A team grid favorite may carry a WIP limit per lane (P-3, legacy
 * `wip_limits` view params — count type only): `n / limit` on the
 * wall's lane header, over-limit highlighted, never refused (legacy
 * warned, it did not block a drop). Limits are keyed by the lane's
 * stored value and cleared when a re-save changes the lane property.
 *
 * Commands → events:
 *   SaveFavorite       → FavoriteSaved
 *   MakeFavoriteTab    → FavoritePromotedToTab
 *   RemoveFavoriteTab  → FavoriteDemotedFromTab
 *   DeleteFavorite     → FavoriteDeleted
 *   SetLaneWipLimit    → FavoriteWipLimitSet
 *
 * Public interface: `saveFavorite`, `makeFavoriteTab`,
 * `removeFavoriteTab`, `deleteFavorite`, `setLaneWipLimit`,
 * `listFavorites`, `favoriteViewParams`, `favoriteHref`,
 * `serializeFavorite`, `findFavoriteByName`, `wipLimitsOf`,
 * `wipLimitsFor`, and the `FavoriteViewParams` / `ProjectFavorites`
 * / `WipLimits` types.
 *
 * Owner context: Card Management. Handlers take the Drizzle handle as a
 * parameter — this module holds no module-level infrastructure imports,
 * and tests supply their own real database.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { favorites, type FavoriteRow } from "~/db/schema/favorites";
import { projects } from "~/db/schema/projects";
import { propertyDefinitions } from "~/db/schema/properties";
import { canonicalPropertyValue } from "~/domain/cards/properties.server";
import {
  CARD_VIEW_STYLES,
  type CardViewStyle,
  type FavoriteSummary,
} from "~/shared/wire-types";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";
import { buildCardListView } from "./list-view.server";
import { buildGridView } from "./grid-view.server";

/** Legacy database limit on card_list_views.name. */
const NAME_MAX_LENGTH = 255;

/** The view configuration a favorite stores and reopens into. */
export interface FavoriteViewParams {
  style: CardViewStyle;
  /** Legacy-encoded `filters[]` entries. */
  filters: string[];
  /** Column names (list style only; empty for grid). */
  columns: string[];
  /** Lane property name (grid style only; "" when ungrouped or list). */
  groupBy: string;
  /** Advanced filter MQL (legacy `filters[mql]`); "" or absent when filtering simply. */
  mql?: string;
}

export interface SaveFavoriteInput extends FavoriteViewParams {
  projectId: number;
  name: string;
  /** True saves a personal favorite owned by the actor; false, a team favorite. */
  personal: boolean;
  actorUserId: number;
}

export interface FavoriteIdInput {
  projectId: number;
  favoriteId: number;
  actorUserId: number;
}

/** Lane stored value → count limit, as stored in `favorites.wip_limits`. */
export type WipLimits = Record<string, number>;

export interface SetLaneWipLimitInput extends FavoriteIdInput {
  /** The lane's stored value (an enumerated value, or a user id). */
  laneValue: string;
  /** A positive whole number, or null to remove the lane's limit. */
  limit: number | null;
}

/** The favorites a viewer sees on a project's card views. */
export interface ProjectFavorites {
  /** Team favorites promoted to tabs, by name. */
  tabs: FavoriteRow[];
  /** Team favorites that are not tabs, by name. */
  team: FavoriteRow[];
  /** The viewer's own favorites, by name. */
  personal: FavoriteRow[];
}

function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return (
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get() !== undefined
  );
}

function findFavorite(
  db: BetterSQLite3Database,
  projectId: number,
  favoriteId: number,
): FavoriteRow | undefined {
  return db
    .select()
    .from(favorites)
    .where(and(eq(favorites.projectId, projectId), eq(favorites.id, favoriteId)))
    .get();
}

/**
 * Finds a favorite by name (case-insensitive) within one scope.
 *
 * @param db - Drizzle handle
 * @param projectId - the project
 * @param name - the favorite's name
 * @param userId - null for the team scope, else the personal scope's owner
 */
export function findFavoriteByName(
  db: BetterSQLite3Database,
  projectId: number,
  name: string,
  userId: number | null,
): FavoriteRow | undefined {
  return db
    .select()
    .from(favorites)
    .where(
      and(
        eq(favorites.projectId, projectId),
        userId === null ? isNull(favorites.userId) : eq(favorites.userId, userId),
        sql`lower(${favorites.name}) = lower(${name})`,
      ),
    )
    .get();
}

/**
 * Validates view parameters through the read model that will render
 * them, returning the canonical parameters to store.
 *
 * @returns the normalized params, or a rejection keyed on "view"
 */
function canonicalViewParams(
  db: BetterSQLite3Database,
  projectId: number,
  input: FavoriteViewParams,
): CommandResult<FavoriteViewParams> {
  if (!(CARD_VIEW_STYLES as readonly string[]).includes(input.style))
    return reject("style", "is not a supported view style");
  const mql = (input.mql ?? "").trim();
  // MQL replaces the simple filters (legacy MqlFilters is an alternative).
  const filters = mql === "" ? input.filters.map((f) => f.trim()).filter(Boolean) : [];
  if (input.style === "grid") {
    const view = buildGridView(db, projectId, input.groupBy.trim(), filters, mql);
    if (view.errors.length > 0) return { ok: false, errors: { view: view.errors } };
    return {
      ok: true,
      value: { style: "grid", filters, columns: [], groupBy: view.groupBy?.name ?? "", mql },
    };
  }
  const columns = input.columns.map((c) => c.trim()).filter(Boolean);
  const view = buildCardListView(db, projectId, filters, columns, mql);
  if (view.errors.length > 0) return { ok: false, errors: { view: view.errors } };
  return {
    ok: true,
    value: { style: "list", filters, columns: view.columns.map((c) => c.name), groupBy: "", mql },
  };
}

/**
 * SaveFavorite: creates a favorite, or replaces the view of the
 * favorite already carrying this name in the same scope (legacy
 * CardListView.create_or_update). Emits FavoriteSaved.
 *
 * Requires FULL_TEAM_MEMBER (legacy cards#create_view). Rejects when
 * the project is missing, the name is blank or too long, or the view
 * parameters do not validate against the project's properties.
 *
 * @returns the persisted favorite row
 */
export function saveFavorite(
  db: BetterSQLite3Database,
  input: SaveFavoriteInput,
): CommandResult<FavoriteRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const name = input.name.trim();
  if (name === "") return reject("name", "can't be blank");
  if (name.length > NAME_MAX_LENGTH)
    return reject("name", `is too long (maximum is ${NAME_MAX_LENGTH} characters)`);

  const params = canonicalViewParams(db, input.projectId, input);
  if (!params.ok) return params;

  const userId = input.personal ? input.actorUserId : null;
  const existing = findFavoriteByName(db, input.projectId, name, userId);
  const groupBy = params.value.groupBy === "" ? null : params.value.groupBy;
  const stored = {
    name,
    style: params.value.style,
    filters: JSON.stringify(params.value.filters),
    columns: JSON.stringify(params.value.columns),
    groupBy,
    mql: params.value.mql === "" ? null : params.value.mql,
    // Limits are keyed by the lane property's values: a re-save that
    // changes the lane property (or the style) drops them (P-3).
    ...(existing && (existing.groupBy !== groupBy || existing.style !== params.value.style) ? { wipLimits: "{}" } : {}),
  };

  return db.transaction((tx) => {
    const row = existing
      ? tx
          .update(favorites)
          .set({ ...stored, updatedAt: new Date() })
          .where(eq(favorites.id, existing.id))
          .returning()
          .get()!
      : tx
          .insert(favorites)
          .values({ ...stored, projectId: input.projectId, userId })
          .returning()
          .get();
    emitEvent(tx, {
      type: "FavoriteSaved",
      aggregateType: "Favorite",
      aggregateId: row.id,
      payload: {
        projectId: input.projectId,
        name: row.name,
        personal: userId !== null,
        replaced: existing !== undefined,
        ...params.value,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

/**
 * MakeFavoriteTab: promotes a team favorite to a project tab. Emits
 * FavoritePromotedToTab. Requires PROJECT_ADMIN (legacy
 * favorites#move_to_tab). Rejects personal favorites (tabs are a team
 * concept) and favorites that are already tabs.
 */
export function makeFavoriteTab(
  db: BetterSQLite3Database,
  input: FavoriteIdInput,
): CommandResult<FavoriteRow> {
  return setTabView(db, input, true);
}

/**
 * RemoveFavoriteTab: demotes a tab back to a plain team favorite.
 * Emits FavoriteDemotedFromTab. Requires PROJECT_ADMIN (legacy
 * favorites#move_to_team_favorite). Rejects favorites that are not tabs.
 */
export function removeFavoriteTab(
  db: BetterSQLite3Database,
  input: FavoriteIdInput,
): CommandResult<FavoriteRow> {
  return setTabView(db, input, false);
}

function setTabView(
  db: BetterSQLite3Database,
  input: FavoriteIdInput,
  tabView: boolean,
): CommandResult<FavoriteRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;
  const favorite = findFavorite(db, input.projectId, input.favoriteId);
  if (!favorite) return reject("favorite", "does not exist");
  if (favorite.userId !== null)
    return reject("favorite", "is a personal favorite and cannot be a tab");
  if (favorite.tabView === tabView)
    return reject("favorite", tabView ? "is already a tab" : "is not a tab");

  return db.transaction((tx) => {
    const row = tx
      .update(favorites)
      .set({ tabView, updatedAt: new Date() })
      .where(eq(favorites.id, favorite.id))
      .returning()
      .get()!;
    emitEvent(tx, {
      type: tabView ? "FavoritePromotedToTab" : "FavoriteDemotedFromTab",
      aggregateType: "Favorite",
      aggregateId: row.id,
      payload: { projectId: input.projectId, name: row.name },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

/** Parses a favorite's stored WIP limits; a malformed column reads as none. */
export function wipLimitsOf(favorite: FavoriteRow): WipLimits {
  try {
    const parsed: unknown = JSON.parse(favorite.wipLimits);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const limits: WipLimits = {};
    for (const [lane, limit] of Object.entries(parsed as Record<string, unknown>))
      if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) limits[lane] = limit;
    return limits;
  } catch {
    return {};
  }
}

/**
 * The WIP limits the wall shows for a favorite: only a team favorite
 * of grid style in the project carries any; anything else is null,
 * which also tells the grid not to offer editing.
 */
export function wipLimitsFor(
  db: BetterSQLite3Database,
  projectId: number,
  favoriteId: number,
): { favoriteId: number; limits: WipLimits } | null {
  const favorite = findFavorite(db, projectId, favoriteId);
  if (!favorite || favorite.userId !== null || favorite.style !== "grid" || favorite.groupBy === null) return null;
  return { favoriteId: favorite.id, limits: wipLimitsOf(favorite) };
}

/**
 * SetLaneWipLimit — sets or removes one lane's WIP limit on a team
 * grid favorite.
 *
 * DOES: rewrites the favorite's `wip_limits` JSON with the lane's
 * limit (or without the lane when clearing), bumps `updated_at`, and
 * emits FavoriteWipLimitSet naming the favorite, lane and limit.
 * REJECTS: unknown project or favorite; actor below full team member
 * (the level that saves team favorites); a personal favorite; a list
 * style or ungrouped favorite; the "(not set)" lane; a value the lane
 * property does not hold (validated as a property value would be); a
 * limit that is not a positive whole number.
 *
 * @returns the updated favorite row, or field errors
 */
export function setLaneWipLimit(
  db: BetterSQLite3Database,
  input: SetLaneWipLimitInput,
): CommandResult<FavoriteRow> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const denied = authorizeProjectAction(db, input.actorUserId, input.projectId, PrivilegeLevel.FULL_TEAM_MEMBER);
  if (denied) return denied;
  const favorite = findFavorite(db, input.projectId, input.favoriteId);
  if (!favorite) return reject("favorite", "does not exist");
  if (favorite.userId !== null) return reject("favorite", "is a personal favorite; WIP limits belong to team favorites");
  if (favorite.style !== "grid" || favorite.groupBy === null)
    return reject("favorite", "is not a grid grouped by a property, so it has no lanes to limit");
  const laneValue = input.laneValue.trim();
  if (laneValue === "") return reject("lane", "the (not set) lane cannot carry a WIP limit");
  const definition = db
    .select()
    .from(propertyDefinitions)
    .where(and(eq(propertyDefinitions.projectId, input.projectId), sql`lower(${propertyDefinitions.name}) = lower(${favorite.groupBy})`))
    .get();
  if (!definition) return reject("favorite", `is grouped by ${favorite.groupBy}, which is no longer a property of this project`);
  const canonical = canonicalPropertyValue(db, input.projectId, definition, laneValue);
  if (!canonical.ok) return reject("lane", Object.values(canonical.errors).flat().join("; "));
  if (input.limit !== null && (!Number.isInteger(input.limit) || input.limit <= 0))
    return reject("limit", "must be a positive whole number");

  const limits = wipLimitsOf(favorite);
  if (input.limit === null) delete limits[canonical.value];
  else limits[canonical.value] = input.limit;

  return db.transaction((tx) => {
    const row = tx
      .update(favorites)
      .set({ wipLimits: JSON.stringify(limits), updatedAt: new Date() })
      .where(eq(favorites.id, favorite.id))
      .returning()
      .get()!;
    emitEvent(tx, {
      type: "FavoriteWipLimitSet",
      aggregateType: "Favorite",
      aggregateId: row.id,
      payload: { projectId: input.projectId, name: row.name, laneValue: canonical.value, limit: input.limit },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row };
  });
}

/**
 * DeleteFavorite: removes a favorite. Emits FavoriteDeleted.
 * Authorization follows the legacy ladder: a personal favorite may be
 * deleted only by its owner; a team favorite by any FULL_TEAM_MEMBER
 * (favorites#remove_team_favorite); a tab only by a PROJECT_ADMIN
 * (favorites#delete).
 *
 * @returns the deleted row's id
 */
export function deleteFavorite(
  db: BetterSQLite3Database,
  input: FavoriteIdInput,
): CommandResult<{ id: number }> {
  if (!projectExists(db, input.projectId)) return reject("project", "does not exist");
  const favorite = findFavorite(db, input.projectId, input.favoriteId);
  if (!favorite) return reject("favorite", "does not exist");

  if (favorite.userId !== null && favorite.userId !== input.actorUserId)
    return reject("authorization", "only the owner may delete a personal favorite");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    favorite.tabView ? PrivilegeLevel.PROJECT_ADMIN : PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  return db.transaction((tx) => {
    tx.delete(favorites).where(eq(favorites.id, favorite.id)).run();
    emitEvent(tx, {
      type: "FavoriteDeleted",
      aggregateType: "Favorite",
      aggregateId: favorite.id,
      payload: {
        projectId: input.projectId,
        name: favorite.name,
        personal: favorite.userId !== null,
        wasTab: favorite.tabView,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: { id: favorite.id } };
  });
}

/**
 * Lists the favorites a viewer sees: tabs, team favorites, and the
 * viewer's personal favorites, each ordered case-insensitively by name
 * (legacy smart_sort_by name).
 *
 * @param db - Drizzle handle
 * @param projectId - the project
 * @param viewerUserId - whose personal favorites to include
 */
export function listFavorites(
  db: BetterSQLite3Database,
  projectId: number,
  viewerUserId: number,
): ProjectFavorites {
  const rows = db
    .select()
    .from(favorites)
    .where(eq(favorites.projectId, projectId))
    .orderBy(asc(sql`lower(${favorites.name})`))
    .all();
  return {
    tabs: rows.filter((r) => r.userId === null && r.tabView),
    team: rows.filter((r) => r.userId === null && !r.tabView),
    personal: rows.filter((r) => r.userId === viewerUserId),
  };
}

/**
 * Decodes a favorite row's stored view parameters.
 *
 * @param favorite - the persisted row
 */
export function favoriteViewParams(favorite: FavoriteRow): FavoriteViewParams {
  return {
    style: favorite.style as CardViewStyle,
    filters: JSON.parse(favorite.filters) as string[],
    columns: JSON.parse(favorite.columns) as string[],
    groupBy: favorite.groupBy ?? "",
    mql: favorite.mql ?? "",
  };
}

/**
 * Builds the canonical URL a favorite reopens into (legacy
 * Favorite#to_params → cards#index with the view's params plus
 * favorite_id).
 *
 * @param identifier - the project identifier
 * @param favorite - the persisted row
 */
export function favoriteHref(identifier: string, favorite: FavoriteRow): string {
  const params = favoriteViewParams(favorite);
  const search = new URLSearchParams();
  for (const filter of params.filters) search.append("filters[]", filter);
  if (params.mql) search.set("filters[mql]", params.mql);
  if (params.style === "grid") {
    if (params.groupBy !== "") search.set("group_by", params.groupBy);
  } else if (params.columns.length > 0) {
    search.set("columns", params.columns.join(","));
  }
  search.set("favorite_id", String(favorite.id));
  const path = `/projects/${identifier}/cards${params.style === "grid" ? "/grid" : ""}`;
  return `${path}?${search.toString()}`;
}

/**
 * Serializes a favorite row for a loader response (Date columns and
 * stored JSON stay server-side).
 *
 * @param identifier - the project identifier the href is built under
 * @param favorite - the persisted row
 */
export function serializeFavorite(identifier: string, favorite: FavoriteRow): FavoriteSummary {
  return {
    id: favorite.id,
    name: favorite.name,
    style: favorite.style as CardViewStyle,
    tabView: favorite.tabView,
    personal: favorite.userId !== null,
    href: favoriteHref(identifier, favorite),
  };
}
