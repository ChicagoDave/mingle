/**
 * /projects/:identifier/trees/:treeId — one card tree's hierarchy view
 * (Phase 23; legacy cards "hierarchy" style and `_hierarchy_nodes`).
 *
 * Purpose: renders the tree's member cards nested by their
 * relationships, with per-node forms to remove a card (children
 * detached to its parent) or remove it with its subtree, a form to
 * add a card under a parent or at the root, and — for a project admin —
 * the reconfigure form (legacy card_trees/edit) that renames the tree
 * or changes its chain of card types, plus the tree's aggregate
 * properties (Phase 24; legacy card_trees "aggregate properties"
 * panel) with a form to define one on a non-leaf card type.
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
import { propertyDefinitions } from "~/db/schema/properties";
import { AGGREGATE_TYPE_LABELS, AGGREGATE_TYPES, type AggregateType } from "~/shared/wire-types";
import { defineAggregateProperty } from "~/domain/cards/properties.server";
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
  const definitions = db
    .select({
      id: propertyDefinitions.id,
      name: propertyDefinitions.name,
      kind: propertyDefinitions.kind,
      treeConfigurationId: propertyDefinitions.treeConfigurationId,
      aggregateType: propertyDefinitions.aggregateType,
      aggregateTargetId: propertyDefinitions.aggregateTargetId,
      aggregateCardTypeId: propertyDefinitions.aggregateCardTypeId,
      aggregateScopeCardTypeId: propertyDefinitions.aggregateScopeCardTypeId,
      aggregateCondition: propertyDefinitions.aggregateCondition,
    })
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.projectId, project.id))
    .orderBy(asc(propertyDefinitions.position))
    .all();
  const typeName = (id: number | null) => shape.levels.find((l) => l.cardTypeId === id)?.cardTypeName ?? null;
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
    aggregates: definitions
      .filter((d) => d.kind === "aggregate" && d.treeConfigurationId === shape.tree.id)
      .map((d) => ({
        id: d.id,
        name: d.name,
        aggregateType: d.aggregateType as AggregateType,
        holderTypeName: typeName(d.aggregateCardTypeId),
        targetName: definitions.find((t) => t.id === d.aggregateTargetId)?.name ?? null,
        scopeTypeName: d.aggregateScopeCardTypeId === null ? null : typeName(d.aggregateScopeCardTypeId),
        condition: d.aggregateCondition,
      })),
    // Targets: number properties and formulas (the command rejects a
    // date-valued formula by name, so the list need not compile them).
    targetCandidates: definitions
      .filter((d) => d.kind === "number" || d.kind === "formula")
      .map((d) => ({ id: d.id, name: d.name })),
    aggregateTypes: AGGREGATE_TYPES.map((type) => ({ value: type, label: AGGREGATE_TYPE_LABELS[type] })),
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

  if (intent === "define-aggregate") {
    const targetRaw = String(form.get("target") ?? "").trim();
    const scopeRaw = String(form.get("scope") ?? "").trim();
    const result = defineAggregateProperty(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      treeId,
      aggregateCardTypeId: Number(form.get("aggregate_card_type")),
      aggregateType: String(form.get("aggregate_type") ?? ""),
      targetPropertyDefinitionId: targetRaw === "" ? null : Number(targetRaw),
      scopeCardTypeId: scopeRaw === "" ? null : Number(scopeRaw),
      condition: String(form.get("condition") ?? ""),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(here);
  }

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
  const { project, tree, levels, nodes, cardTypes: types, canReconfigure, maxLevels, aggregates, targetCandidates, aggregateTypes } =
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

      <h2>Aggregate properties</h2>
      {aggregates.length === 0 ? (
        <p>No aggregate properties are defined on this tree.</p>
      ) : (
        <ul id="tree-aggregates">
          {aggregates.map((aggregate) => (
            <li key={aggregate.id}>
              <strong>{aggregate.name}</strong> on {aggregate.holderTypeName}:{" "}
              {aggregateTypes.find((t) => t.value === aggregate.aggregateType)?.label ?? aggregate.aggregateType}
              {aggregate.targetName ? ` of ${aggregate.targetName}` : ""} over{" "}
              {aggregate.scopeTypeName ? `${aggregate.scopeTypeName} cards` : "all descendants"}
              {aggregate.condition ? (
                <>
                  {" "}
                  where <code>{aggregate.condition}</code>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canReconfigure && (
        <Form method="post" id="define-aggregate">
          <input type="hidden" name="intent" value="define-aggregate" />
          <p>
            <label>
              Name <input name="name" type="text" required />
            </label>{" "}
            <label>
              on{" "}
              <select name="aggregate_card_type" required>
                {levels
                  .filter((level) => level.relationshipName !== null)
                  .map((level) => (
                    <option key={level.cardTypeId} value={level.cardTypeId}>
                      {level.cardTypeName}
                    </option>
                  ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Function{" "}
              <select name="aggregate_type">
                {aggregateTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              of property{" "}
              <select name="target">
                <option value="">(none — count only)</option>
                {targetCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              over{" "}
              <select name="scope">
                <option value="">All descendants</option>
                {levels.slice(1).map((level) => (
                  <option key={level.cardTypeId} value={level.cardTypeId}>
                    {level.cardTypeName} cards
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Condition (optional MQL, e.g. <code>Status = Closed</code>){" "}
              <input name="condition" type="text" size={50} />
            </label>
          </p>
          <button type="submit">Define aggregate</button>
        </Form>
      )}

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
