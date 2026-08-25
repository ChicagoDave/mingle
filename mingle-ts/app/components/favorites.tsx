/**
 * Favorites UI — the project tab bar and the favorites sidebar panel
 * shared by the card list and grid views (Phase 11).
 *
 * Purpose: renders the legacy layouts/_tabs.rhtml tab bar ("All" plus
 * each team favorite promoted to a tab, current tab highlighted) and
 * the shared/_favorites.rhtml sidebar (team favorites, my favorites,
 * and the "Add current view to favorites" save form, which posts to
 * the favorites route). Purely presentational: it receives the
 * serialized favorites list and the current view's parameters from a
 * route loader and never touches the database.
 *
 * Public interface: `ViewTabs`, `FavoritesPanel`, `CurrentViewParams`.
 *
 * Owner context: Card Management (presentation).
 */
import { Form, Link } from "react-router";
import type { CardViewStyle, FavoriteSummary } from "~/shared/wire-types";
import "../styles/favorites.css";

/** The project tab bar: "All" plus every tab favorite. */
export function ViewTabs({
  identifier,
  tabs,
  currentFavoriteId,
}: {
  identifier: string;
  tabs: FavoriteSummary[];
  currentFavoriteId: number | null;
}) {
  return (
    <div id="hd-nav">
      <div className="tab-nav">
        <ul className="sortable-tabs">
          <li className={currentFavoriteId === null ? "current-menu-item" : undefined}>
            <Link to={`/projects/${identifier}/cards`} role="tab-name" id="tab_all_link">
              All
            </Link>
          </li>
          {tabs.map((tab) => (
            <li
              key={tab.id}
              className={tab.id === currentFavoriteId ? "current-menu-item" : undefined}
              id={`tab_${tab.name.toLowerCase().replace(/\s/g, "_")}`}
            >
              <Link to={tab.href} role="tab-name" title={tab.name}>
                {tab.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The current view's parameters the save form carries as hidden fields. */
export interface CurrentViewParams {
  style: CardViewStyle;
  filters: string[];
  columns: string[];
  groupBy: string;
  /** Advanced filter MQL; "" or absent when filtering simply. */
  mql?: string;
}

/** Sidebar section: team favorites, my favorites, save-current-view form. */
export function FavoritesPanel({
  identifier,
  team,
  personal,
  currentFavoriteId,
  currentView,
  canSave,
}: {
  identifier: string;
  team: FavoriteSummary[];
  personal: FavoriteSummary[];
  currentFavoriteId: number | null;
  currentView: CurrentViewParams;
  canSave: boolean;
}) {
  const favoritesAction = `/projects/${identifier}/favorites`;
  const listing = (items: FavoriteSummary[]) => (
    <ul>
      {items.map((favorite) => (
        <li
          key={favorite.id}
          id={`favorite-${favorite.id}`}
          className={favorite.id === currentFavoriteId ? "current" : undefined}
        >
          <Link className="favorite-link" to={favorite.href} title={favorite.name}>
            {favorite.name}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div id="favorites-container">
      <h3>Team favorites</h3>
      <div id="favorites-team" className="favorites">
        {team.length === 0 ? (
          <p className="text-light">No team favorites yet.</p>
        ) : (
          listing(team)
        )}
        <div>
          <Link to={favoritesAction} className="tab-small manage_link">
            Manage team favorites and tabs
          </Link>
        </div>
      </div>

      <h3>My favorites</h3>
      <div id="favorites-personal" className="favorites">
        {personal.length === 0 ? (
          <p className="text-light">No personal favorites yet.</p>
        ) : (
          listing(personal)
        )}
      </div>

      {canSave && (
        <div id="view-save-panel" className="view-save-panel">
          <h3>Add current view to favorites</h3>
          <Form method="post" action={favoritesAction} id="create_saved_view_form">
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="style" value={currentView.style} />
            {currentView.filters.map((f, i) => (
              <input key={i} type="hidden" name="filters[]" value={f} />
            ))}
            {currentView.mql && (
              <input type="hidden" name="filters[mql]" value={currentView.mql} />
            )}
            {currentView.columns.length > 0 && (
              <input type="hidden" name="columns" value={currentView.columns.join(",")} />
            )}
            {currentView.groupBy !== "" && (
              <input type="hidden" name="group_by" value={currentView.groupBy} />
            )}
            <input
              type="text"
              name="name"
              id="new-view-name"
              placeholder="Favorite name"
              aria-label="Favorite name"
            />
            <label>
              <input type="checkbox" name="personal" value="1" /> Save as my favorite
              (only I can see it)
            </label>
            <p>
              <button type="submit" name="save-view" value="1">
                Save
              </button>
            </p>
          </Form>
        </div>
      )}
    </div>
  );
}
