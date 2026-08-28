/**
 * /projects/:identifier/dependencies/:number — one dependency as seen
 * from a project (Phase 25; legacy dependency_lightbox_show +
 * link_cards / toggle_resolved / unlink_card / delete).
 *
 * Purpose: the dependency's details, its resolving cards, and the
 * actions the viewing project may take: the resolving project links
 * and unlinks its cards; either side toggles resolved; the raising
 * project edits the request and its admins delete it. Which forms
 * appear follows from which side this project is, as the legacy
 * lightbox decided from `allowed_to_edit_raising/resolving`. The
 * version trail is listed below.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Cross-Project Dependencies (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.dependencies.show";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import {
  deleteDependency,
  linkResolvingCards,
  toggleDependencyResolved,
  unlinkResolvingCard,
  updateDependency,
} from "~/domain/dependencies/commands.server";
import { dependencyHistory, findDependencyForProject } from "~/domain/dependencies/read.server";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";

/** Loads the dependency (404 unless this project is a side of it), its history, and what the viewer may do. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db.select().from(projects).where(eq(projects.identifier, params.identifier)).get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const dependency = findDependencyForProject(db, project.id, Number(params.number));
  if (!dependency) throw new Response("Not Found", { status: 404 });

  const privilege = privilegeLevelFor(db, userId, project.id);
  const mayEdit = privilege >= PrivilegeLevel.FULL_TEAM_MEMBER;
  const isRaising = dependency.raisingProject.id === project.id;
  const isResolving = dependency.resolvingProject.id === project.id;
  return {
    project: { name: project.name, identifier: project.identifier },
    dependency,
    history: dependencyHistory(db, dependency.id),
    canLink: mayEdit && isResolving,
    canToggle: mayEdit,
    canEdit: mayEdit && isRaising,
    canDelete: privilege >= PrivilegeLevel.PROJECT_ADMIN && isRaising,
  };
}

/** Parses "12, 14 15" into card numbers, dropping anything that is not a positive integer. */
function cardNumbersFrom(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((piece) => Number(piece.replace(/^#/, "")))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** Dispatches link / unlink / toggle / update / delete to their commands. */
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
  const dependencyNumber = Number(params.number);
  const common = { projectId: project.id, dependencyNumber, actorUserId: userId };

  const result =
    intent === "link"
      ? linkResolvingCards(db, { ...common, cardNumbers: cardNumbersFrom(String(form.get("card_numbers") ?? "")) })
      : intent === "unlink"
        ? unlinkResolvingCard(db, { ...common, cardNumber: Number(form.get("card_number") ?? 0) })
        : intent === "toggle-resolved"
          ? toggleDependencyResolved(db, common)
          : intent === "update"
            ? updateDependency(db, {
                ...common,
                name: String(form.get("name") ?? ""),
                description: String(form.get("description") ?? ""),
                desiredEndDate: String(form.get("desired_end_date") ?? ""),
              })
            : intent === "delete"
              ? deleteDependency(db, common)
              : null;
  if (result === null) throw new Response("Unknown intent", { status: 400 });
  if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
  if (intent === "delete") throw redirect(`/projects/${project.identifier}/dependencies?filter=raising`);
  throw redirect(`/projects/${project.identifier}/dependencies/${dependencyNumber}`);
}

/** Dependency page (legacy dependency_lightbox_show, as a page). */
export default function DependencyPage() {
  const { project, dependency: dep, history, canLink, canToggle, canEdit, canDelete } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;

  return (
    <main id="dependency" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to={`${base}/dependencies`}>All dependencies</Link> · <Link to={`${base}/cards`}>Cards</Link>
      </p>
      <h1>
        {dep.prefixedNumber} {dep.name} <small id="dependency-status">({dep.status})</small>
      </h1>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <dl>
        <dt>Raised by</dt>
        <dd>
          {dep.raisingProject.name} — card{" "}
          <Link to={`/projects/${dep.raisingProject.identifier}/cards/${dep.raisingCard.number}`}>
            #{dep.raisingCard.number}
          </Link>{" "}
          {dep.raisingCard.name ?? "(deleted card)"}, by {dep.raisingUserName}
        </dd>
        <dt>Resolved by</dt>
        <dd>{dep.resolvingProject.name}</dd>
        <dt>Desired completion date</dt>
        <dd>{dep.desiredEndDate}</dd>
        {dep.description && (
          <>
            <dt>Description</dt>
            <dd>{dep.description}</dd>
          </>
        )}
        <dt>Resolving card(s)</dt>
        <dd>
          {dep.resolvingCards.length === 0 ? (
            "none yet"
          ) : (
            <ul id="resolving-cards">
              {dep.resolvingCards.map((card) => (
                <li key={card.number}>
                  <Link to={`/projects/${dep.resolvingProject.identifier}/cards/${card.number}`}>#{card.number}</Link>{" "}
                  {card.name ?? "(deleted card)"}
                  {canLink && (
                    <Form method="post" style={{ display: "inline", marginLeft: 8 }}>
                      <input type="hidden" name="intent" value="unlink" />
                      <input type="hidden" name="card_number" value={card.number} />
                      <button type="submit">Unlink</button>
                    </Form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      {canLink && (
        <Form method="post" id="link-cards">
          <input type="hidden" name="intent" value="link" />
          <label>
            Link resolving card numbers (e.g. 12, 14){" "}
            <input name="card_numbers" type="text" size={30} required />
          </label>{" "}
          <button type="submit">Link cards</button>
        </Form>
      )}

      {canToggle && (
        <Form method="post" id="toggle-resolved" style={{ marginTop: 8 }}>
          <input type="hidden" name="intent" value="toggle-resolved" />
          <button type="submit">{dep.status === "RESOLVED" ? "Reopen" : "Mark resolved"}</button>
        </Form>
      )}

      {canEdit && (
        <>
          <h2>Edit</h2>
          <Form method="post" id="edit-dependency">
            <input type="hidden" name="intent" value="update" />
            <p>
              <label>
                Name <input name="name" type="text" size={50} defaultValue={dep.name} required />
              </label>
            </p>
            <p>
              <label>
                Description <input name="description" type="text" size={60} defaultValue={dep.description ?? ""} />
              </label>
            </p>
            <p>
              <label>
                Desired completion date{" "}
                <input name="desired_end_date" type="date" defaultValue={dep.desiredEndDate} required />
              </label>
            </p>
            <button type="submit">Save</button>
          </Form>
        </>
      )}

      {canDelete && (
        <Form method="post" id="delete-dependency" style={{ marginTop: 8 }}>
          <input type="hidden" name="intent" value="delete" />
          <button type="submit">Delete dependency</button>
        </Form>
      )}

      <h2>History</h2>
      <ol id="dependency-history" reversed>
        {history.map((v) => (
          <li key={v.version}>
            Version {v.version} — {v.isDeletion ? "deleted" : v.status} — {v.name}, due {v.desiredEndDate}
            {v.resolvingCardNumbers.length > 0 && <> — resolving #{v.resolvingCardNumbers.join(", #")}</>} — by{" "}
            {v.modifiedByName}
          </li>
        ))}
      </ol>
    </main>
  );
}
