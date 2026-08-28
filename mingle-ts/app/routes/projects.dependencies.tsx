/**
 * /projects/:identifier/dependencies — a project's dependencies
 * (Phase 25; legacy DependenciesController#index + #create).
 *
 * Purpose: the dependencies tab. `?filter=resolving` (the legacy
 * default) lists what other projects are asking this one to resolve;
 * `?filter=raising` lists what this project's cards have asked of
 * others. Both are grouped by status the way the legacy tab was. The
 * raise form names one of this project's cards, the resolving
 * project, a name, description and desired end date.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Cross-Project Dependencies (HTTP adapter).
 */
import { asc, eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.dependencies";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { raiseDependency } from "~/domain/dependencies/commands.server";
import { listDependencies, type DependencySummary } from "~/domain/dependencies/read.server";
import { PrivilegeLevel, privilegeLevelFor } from "~/domain/identity/authorization.server";
import {
  DEPENDENCY_LIST_FILTERS,
  DEPENDENCY_STATUSES,
  type DependencyListFilter,
} from "~/shared/wire-types";

/** Loads one side's dependencies, the projects a dependency may be raised on, and whether the viewer may raise one. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db.select().from(projects).where(eq(projects.identifier, params.identifier)).get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const requested = new URL(request.url).searchParams.get("filter");
  const filter: DependencyListFilter = (DEPENDENCY_LIST_FILTERS as readonly string[]).includes(requested ?? "")
    ? (requested as DependencyListFilter)
    : "resolving";

  return {
    project: { name: project.name, identifier: project.identifier },
    filter,
    dependencies: listDependencies(db, project.id, filter),
    projects: db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .orderBy(asc(projects.name))
      .all(),
    canRaise: privilegeLevelFor(db, userId, project.id) >= PrivilegeLevel.FULL_TEAM_MEMBER,
  };
}

/** Dispatches the raise form to RaiseDependency; redirects to the new dependency on success. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "raise") throw new Response("Unknown intent", { status: 400 });
  const result = raiseDependency(db, {
    raisingProjectId: project.id,
    raisingCardNumber: Number(form.get("raising_card_number") ?? 0),
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    desiredEndDate: String(form.get("desired_end_date") ?? ""),
    resolvingProjectId: Number(form.get("resolving_project_id") ?? 0),
    actorUserId: userId,
  });
  if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
  throw redirect(`/projects/${project.identifier}/dependencies/${result.value.number}`);
}

/** One status group of the list (legacy dependency_tab_table section). */
function StatusGroup({ status, rows, filter, base }: { status: string; rows: DependencySummary[]; filter: DependencyListFilter; base: string }) {
  return (
    <section id={`dependencies-${status.toLowerCase()}`}>
      <h2>
        {status} <small>({rows.length})</small>
      </h2>
      {rows.length === 0 ? (
        <p className="info-box">None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Name</th>
              <th>Desired completion</th>
              <th>{filter === "resolving" ? "Raised by" : "Resolved by"}</th>
              <th>Raising card</th>
              <th>Resolving card(s)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((dep) => {
              const other = filter === "resolving" ? dep.raisingProject : dep.resolvingProject;
              return (
                <tr key={dep.id}>
                  <td>
                    <Link to={`${base}/dependencies/${dep.number}`}>{dep.prefixedNumber}</Link>
                  </td>
                  <td>{dep.name}</td>
                  <td>{dep.desiredEndDate}</td>
                  <td>{other.name}</td>
                  <td>
                    <Link to={`/projects/${dep.raisingProject.identifier}/cards/${dep.raisingCard.number}`}>
                      #{dep.raisingCard.number}
                    </Link>{" "}
                    {dep.raisingCard.name ?? "(deleted card)"}
                  </td>
                  <td>
                    {dep.resolvingCards.length === 0
                      ? "—"
                      : dep.resolvingCards.map((card, i) => (
                          <span key={card.number}>
                            {i > 0 && ", "}
                            <Link to={`/projects/${dep.resolvingProject.identifier}/cards/${card.number}`}>
                              #{card.number}
                            </Link>
                          </span>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Dependencies tab (legacy dependencies/index). */
export default function ProjectDependencies() {
  const { project, filter, dependencies, projects: all, canRaise } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;

  return (
    <main id="project-dependencies" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {project.name} dependencies <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> · <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/history`}>History</Link> · <Link to="/dependencies/import-export">Import / export</Link>
      </p>
      <p id="dependency-filter">
        {filter === "resolving" ? (
          <strong>Resolving</strong>
        ) : (
          <Link to={`${base}/dependencies?filter=resolving`}>Resolving</Link>
        )}{" "}
        ·{" "}
        {filter === "raising" ? <strong>Raising</strong> : <Link to={`${base}/dependencies?filter=raising`}>Raising</Link>}
      </p>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {DEPENDENCY_STATUSES.map((status) => (
        <StatusGroup
          key={status}
          status={status}
          rows={dependencies.filter((dep) => dep.status === status)}
          filter={filter}
          base={base}
        />
      ))}

      {canRaise && (
        <>
          <h2>Raise a dependency</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="raise" />
            <p>
              <label>
                Raising card number #<input name="raising_card_number" type="number" min={1} required />
              </label>
            </p>
            <p>
              <label>
                Name <input name="name" type="text" size={50} required />
              </label>
            </p>
            <p>
              <label>
                Description <input name="description" type="text" size={60} />
              </label>
            </p>
            <p>
              <label>
                Desired completion date <input name="desired_end_date" type="date" required />
              </label>
            </p>
            <p>
              <label>
                Resolving project{" "}
                <select name="resolving_project_id" required defaultValue="">
                  <option value="">(choose)</option>
                  {all.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <button type="submit">Raise dependency</button>
          </Form>
        </>
      )}
    </main>
  );
}
