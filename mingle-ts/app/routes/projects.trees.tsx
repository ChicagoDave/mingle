/**
 * /projects/:identifier/trees — a project's card trees (Phase 23;
 * legacy card_trees/list + new).
 *
 * Purpose: lists the trees with their type chains and offers the
 * define form: a name, a description, and up to five levels, each a
 * card type with the relationship name cards below it will carry.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Trees (HTTP adapter).
 */
import { asc, eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.trees";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { cardTypes } from "~/db/schema/cards";
import { projects } from "~/db/schema/projects";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";
import { defineTree } from "~/domain/trees/commands.server";
import { listTrees } from "~/domain/trees/read.server";
import { levelFieldNames, levelsFromForm, MAX_TREE_LEVELS } from "~/shared/tree-levels-form";

/** Loads the project's trees, its card types, and whether the viewer may define one. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db.select().from(projects).where(eq(projects.identifier, params.identifier)).get();
  if (!project) throw new Response("Not Found", { status: 404 });
  return {
    project: { name: project.name, identifier: project.identifier },
    trees: listTrees(db, project.id),
    cardTypes: db
      .select({ id: cardTypes.id, name: cardTypes.name })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, project.id))
      .orderBy(asc(cardTypes.position))
      .all(),
    canDefine: privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.PROJECT_ADMIN,
    maxLevels: MAX_TREE_LEVELS,
  };
}

/** Dispatches the define form to DefineTree; redirects to the new tree on success. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "define")
    throw new Response("Unknown intent", { status: 400 });
  const result = defineTree(db, {
    projectId: project.id,
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    levels: levelsFromForm(form),
    actorUserId: userId,
  });
  if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
  throw redirect(`/projects/${project.identifier}/trees/${result.value.id}`);
}

/** Tree list and define form (legacy card_trees/list.rhtml + _form.rhtml). */
export default function ProjectTrees() {
  const { project, trees, cardTypes: types, canDefine, maxLevels } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;

  return (
    <main id="project-trees" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {project.name} card trees <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> · <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/settings`}>Settings</Link>
      </p>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {trees.length === 0 ? (
        <p className="info-box">No card trees have been configured for {project.name}.</p>
      ) : (
        <ul id="trees">
          {trees.map((tree) => (
            <li key={tree.id}>
              <Link to={`${base}/trees/${tree.id}`}>{tree.name}</Link>{" "}
              <small>({tree.cardTypeNames.join(" > ")})</small>
              {tree.description && <> — {tree.description}</>}
            </li>
          ))}
        </ul>
      )}

      {canDefine && (
        <>
          <h2>New card tree</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="define" />
            <p>
              <label>
                Name <input name="name" type="text" required />
              </label>
            </p>
            <p>
              <label>
                Description <input name="description" type="text" size={50} />
              </label>
            </p>
            <table>
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Card type</th>
                  <th>Relationship name (cards below carry this)</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: maxLevels }, (_, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      <select name={levelFieldNames(i).type} defaultValue="">
                        <option value="">(none)</option>
                        {types.map((type) => (
                          <option key={type.id} value={type.id}>
                            {type.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input name={levelFieldNames(i).relationship} type="text" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              <small>The last level chosen is the leaf type and needs no relationship name.</small>
            </p>
            <button type="submit">Create tree</button>
          </Form>
        </>
      )}
    </main>
  );
}
