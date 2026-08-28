/**
 * /projects/:identifier/trees/:treeId — one card tree's hierarchy view
 * (Phase 23; legacy cards "hierarchy" style and `_hierarchy_nodes`).
 *
 * Purpose: renders the tree's member cards nested by their
 * relationships, with per-node forms to remove a card (children
 * detached to its parent) or remove it with its subtree, a form to
 * add a card under a parent or at the root, and — for a project admin —
 * the reconfigure form (legacy card_trees/edit) that renames the tree
 * or changes its chain of card types.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Card Trees (HTTP adapter).
 */
import { asc, eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.trees.tree";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { cardTypes } from "~/db/schema/cards";
import { projects } from "~/db/schema/projects";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";
import { addCardToTree, reconfigureTree, removeCardFromTree } from "~/domain/trees/commands.server";
import { loadTree, treeHierarchy, type TreeNode } from "~/domain/trees/read.server";
import { levelFieldNames, levelsFromForm, MAX_TREE_LEVELS } from "~/shared/tree-levels-form";

function treeIdOf(params: { treeId: string }): number {
  const treeId = Number(params.treeId);
  if (!Number.isSafeInteger(treeId)) throw new Response("Not Found", { status: 404 });
  return treeId;
}

/** Loads the tree's shape and its nested member cards. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db.select().from(projects).where(eq(projects.identifier, params.identifier)).get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const shape = loadTree(db, project.id, treeIdOf(params));
  if (!shape) throw new Response("Not Found", { status: 404 });
  return {
    project: { name: project.name, identifier: project.identifier },
    tree: { id: shape.tree.id, name: shape.tree.name, description: shape.tree.description },
    levels: shape.levels.map((level) => ({
      position: level.position,
      cardTypeId: level.cardTypeId,
      cardTypeName: level.cardTypeName,
      relationshipName: level.relationship?.name ?? null,
    })),
    nodes: treeHierarchy(db, shape),
    cardTypes: db
      .select({ id: cardTypes.id, name: cardTypes.name })
      .from(cardTypes)
      .where(eq(cardTypes.projectId, project.id))
      .orderBy(asc(cardTypes.position))
      .all(),
    canReconfigure: privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.PROJECT_ADMIN,
    maxLevels: MAX_TREE_LEVELS,
  };
}

/** Dispatches `add`, `remove` and `reconfigure` to their commands. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const treeId = treeIdOf(params);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const here = `/projects/${project.identifier}/trees/${treeId}`;

  if (intent === "reconfigure") {
    const result = reconfigureTree(db, {
      projectId: project.id,
      treeId,
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
      levels: levelsFromForm(form),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(here);
  }

  const cardNumber = Number(form.get("card_number"));
  if (!Number.isSafeInteger(cardNumber)) throw new Response("Bad Request", { status: 400 });

  if (intent === "add") {
    const parentRaw = String(form.get("parent_card_number") ?? "").trim();
    const parentCardNumber = parentRaw === "" ? null : Number(parentRaw);
    if (parentCardNumber !== null && !Number.isSafeInteger(parentCardNumber))
      throw new Response("Bad Request", { status: 400 });
    const result = addCardToTree(db, { projectId: project.id, treeId, cardNumber, parentCardNumber, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(here);
  }
  if (intent === "remove") {
    const withChildren = String(form.get("with_children") ?? "") === "true";
    const result = removeCardFromTree(db, { projectId: project.id, treeId, cardNumber, withChildren, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(here);
  }
  throw new Response("Unknown intent", { status: 400 });
}

function Node({ node, base }: { node: TreeNode; base: string }) {
  return (
    <li id={`tree-node-${node.number}`} className={`tree-level-${node.level}`}>
      <Link to={`${base}/cards/${node.number}`}>
        #{node.number} {node.name}
      </Link>{" "}
      <small>({node.cardTypeName})</small>{" "}
      <Form method="post" style={{ display: "inline" }}>
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="card_number" value={node.number} />
        <input type="hidden" name="with_children" value="false" />
        <button type="submit">Remove from tree</button>
      </Form>{" "}
      {node.children.length > 0 && (
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="card_number" value={node.number} />
          <input type="hidden" name="with_children" value="true" />
          <button type="submit">Remove with children</button>
        </Form>
      )}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <Node key={child.number} node={child} base={base} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Hierarchy view (legacy cards hierarchy style). */
export default function TreeHierarchy() {
  const { project, tree, levels, nodes, cardTypes: types, canReconfigure, maxLevels } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;

  return (
    <main id="tree-hierarchy" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {tree.name} <small>({project.name})</small>
      </h1>
      <p>
        <Link to={`${base}/trees`}>All trees</Link> · <Link to={`${base}/cards`}>Cards</Link>
      </p>
      {tree.description && <p>{tree.description}</p>}
      <p>
        {levels.map((level, i) => (
          <span key={level.position}>
            {i > 0 && " > "}
            {level.cardTypeName}
            {level.relationshipName && <small> [{level.relationshipName}]</small>}
          </span>
        ))}
      </p>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {nodes.length === 0 ? (
        <p className="info-box">No cards are in this tree yet.</p>
      ) : (
        <ul id="tree-nodes">
          {nodes.map((node) => (
            <Node key={node.number} node={node} base={base} />
          ))}
        </ul>
      )}

      <h2>Add a card</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="add" />
        <label>
          Card number <input name="card_number" type="number" min={1} required />
        </label>{" "}
        <label>
          under card number <input name="parent_card_number" type="number" min={1} placeholder="(root)" />
        </label>{" "}
        <button type="submit">Add to tree</button>
      </Form>

      {canReconfigure && (
        <>
          <h2>Configure tree</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="reconfigure" />
            <p>
              <label>
                Name <input name="name" type="text" defaultValue={tree.name} required />
              </label>
            </p>
            <p>
              <label>
                Description <input name="description" type="text" size={50} defaultValue={tree.description ?? ""} />
              </label>
            </p>
            <table>
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Card type</th>
                  <th>Relationship name</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: maxLevels }, (_, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      <select name={levelFieldNames(i).type} defaultValue={levels[i]?.cardTypeId ?? ""}>
                        <option value="">(none)</option>
                        {types.map((type) => (
                          <option key={type.id} value={type.id}>
                            {type.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        name={levelFieldNames(i).relationship}
                        type="text"
                        defaultValue={levels[i]?.relationshipName ?? ""}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              <small>
                Dropping a card type takes its cards out of the tree (their children move up to the
                grandparent); card types cannot be reordered while the tree has cards.
              </small>
            </p>
            <button type="submit">Save configuration</button>
          </Form>
        </>
      )}
    </main>
  );
}
