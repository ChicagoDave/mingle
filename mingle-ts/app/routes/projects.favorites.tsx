/**
 * /projects/:identifier/favorites — team favorites and tabs management
 * (Phase 11).
 *
 * Purpose: the legacy favorites_controller surface — lists team
 * favorites and tabs (favorites/list.rhtml, _summary_table.rhtml) and
 * accepts the favorites commands as form posts: `save` (from the card
 * views' "Add current view to favorites" panel — redirects into the
 * saved view), `make-tab`, `remove-tab`, and `delete`. Every intent
 * dispatches a Card Management command; nothing here writes tables
 * directly.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.favorites";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { requireUserId } from "~/auth/session.server";
import {
  deleteFavorite,
  favoriteHref,
  listFavorites,
  makeFavoriteTab,
  removeFavoriteTab,
  saveFavorite,
  serializeFavorite,
} from "~/domain/cards/favorites.server";
import {
  PrivilegeLevel,
  privilegeLevelFor,
} from "~/domain/identity/authorization.server";
import type { CardViewStyle, FieldErrors } from "~/shared/wire-types";
import "../styles/favorites.css";

/** Lists team favorites, tabs, and the viewer's personal favorites. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const all = listFavorites(db, project.id, userId);
  const serialize = (rows: typeof all.tabs) =>
    rows.map((row) => serializeFavorite(project.identifier, row));
  return {
    project: { name: project.name, identifier: project.identifier },
    tabs: serialize(all.tabs),
    team: serialize(all.team),
    personal: serialize(all.personal),
    isAdmin:
      privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.PROJECT_ADMIN,
  };
}

/**
 * Dispatches the favorites commands. `save` redirects into the saved
 * favorite's view on success; the other intents re-render the list.
 * Rejections return 400 with the command's field errors.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (errors: FieldErrors) => data({ ok: false as const, errors }, { status: 400 });

  if (intent === "save") {
    const columnsField = String(form.get("columns") ?? "");
    const result = saveFavorite(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      style: String(form.get("style") ?? "list") as CardViewStyle,
      filters: form.getAll("filters[]").map(String),
      columns: columnsField === "" ? [] : columnsField.split(","),
      groupBy: String(form.get("group_by") ?? ""),
      mql: String(form.get("filters[mql]") ?? ""),
      personal: form.get("personal") !== null,
      actorUserId: userId,
    });
    if (!result.ok) return fail(result.errors);
    throw redirect(favoriteHref(project.identifier, result.value));
  }

  const favoriteId = Number(form.get("favoriteId"));
  const input = { projectId: project.id, favoriteId, actorUserId: userId };
  const result =
    intent === "make-tab"
      ? makeFavoriteTab(db, input)
      : intent === "remove-tab"
        ? removeFavoriteTab(db, input)
        : intent === "delete"
          ? deleteFavorite(db, input)
          : null;
  if (result === null) throw new Response("Unknown intent", { status: 400 });
  if (!result.ok) return fail(result.errors);
  return { ok: true as const };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

/** One summary table (legacy favorites/_summary_table.rhtml). */
function SummaryTable({
  id,
  rows,
  section,
  moveTo,
  isAdmin,
}: {
  id: string;
  rows: LoaderData["team"];
  section: string;
  moveTo: { label: string; intent: string } | null;
  isAdmin: boolean;
}) {
  return (
    <table id={id}>
      <thead>
        <tr className="table-top">
          <th>Name</th>
          <th>Style</th>
          <th className="last">&nbsp;</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={3} className="italic-light align-center last">
              There are currently no {section}s to list.
            </td>
          </tr>
        )}
        {rows.map((favorite, i) => (
          <tr key={favorite.id} className={i % 2 === 0 ? "odd text-light" : "even text-light"}>
            <td>
              <Link to={favorite.href} className="favorite-link">
                {favorite.name}
              </Link>
            </td>
            <td>{favorite.style}</td>
            <td className="align-right standard-link-spacing last">
              {isAdmin && moveTo && (
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value={moveTo.intent} />
                  <input type="hidden" name="favoriteId" value={favorite.id} />
                  <button type="submit">Make {moveTo.label}</button>
                </Form>
              )}
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="favoriteId" value={favorite.id} />
                <button type="submit">Delete</button>
              </Form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Favorites management page (legacy favorites/list.rhtml). */
export default function ProjectFavorites() {
  const { project, tabs, team, personal, isAdmin } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors =
    actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];

  return (
    <main id="favorites-page" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/cards`}>Cards</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/settings`}>Settings</Link>
      </p>
      <h1>
        {project.name}: Team favorites <small>({project.identifier})</small>
      </h1>
      {errors.length > 0 && (
        <ul className="favorite-errors" style={{ color: "#b00020" }}>
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div id="content">
        <SummaryTable
          id="favorites"
          rows={team}
          section="team favorite"
          moveTo={{ label: "tab", intent: "make-tab" }}
          isAdmin={isAdmin}
        />
      </div>

      <h1>Tabs</h1>
      <div id="tab_content" className="content">
        <SummaryTable
          id="tab_views"
          rows={tabs}
          section="tab"
          moveTo={{ label: "team favorite", intent: "remove-tab" }}
          isAdmin={isAdmin}
        />
      </div>

      <h1>My favorites</h1>
      <div id="personal_content" className="content">
        <SummaryTable
          id="personal_views"
          rows={personal}
          section="personal favorite"
          moveTo={null}
          isAdmin={isAdmin}
        />
      </div>
    </main>
  );
}
