/**
 * /programs/:identifier — a program's overview: plan window, member
 * projects and objectives (Phase 26; legacy PlansController#show,
 * ProgramProjectsController#index).
 *
 * Purpose: the program's home page. Members see the plan window with
 * a form to move it and a form to add an objective; program
 * administrators also add and remove member projects. Four intents
 * post to one action: `update_plan`, `add_project`, `remove_project`,
 * `create_objective`.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Program Management (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/programs.program";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { PrivilegeLevel, privilegeLevelForProgram } from "~/domain/identity/authorization.server";
import { addProgramProject, removeProgramProject } from "~/domain/programs/commands.server";
import { createObjective, TIMELINE_ROWS, VERTICALLY_MIDDLE_OF_TIMELINE } from "~/domain/programs/objectives.server";
import { updatePlan } from "~/domain/programs/plan.server";
import { addableProjects, findProgramByIdentifier, programOverview } from "~/domain/programs/read.server";

/** Optional integer form field: blank → null, else Number (NaN when malformed, rejected downstream). */
function optionalInt(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

/** Loads the program, its overview, the projects addable to it, and what the viewer may do. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const overview = programOverview(db, program.id);
  if (!overview) throw new Response("Not Found", { status: 404 });
  const level = privilegeLevelForProgram(db, userId, program.id);
  const canAdminister = level >= PrivilegeLevel.PROJECT_ADMIN;
  return {
    program: { id: program.id, name: program.name, identifier: program.identifier, description: program.description },
    ...overview,
    addableProjects: canAdminister ? addableProjects(db, program.id) : [],
    canPlan: level >= PrivilegeLevel.FULL_TEAM_MEMBER,
    canAdminister,
  };
}

/** Dispatches by `intent` to UpdatePlan, AddProgramProject, RemoveProgramProject or CreateObjective. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const base = `/programs/${program.identifier}`;

  if (intent === "update_plan") {
    const result = updatePlan(db, {
      programId: program.id,
      startAt: String(form.get("start_at") ?? ""),
      endAt: String(form.get("end_at") ?? ""),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(base);
  }
  if (intent === "add_project" || intent === "remove_project") {
    const command = intent === "add_project" ? addProgramProject : removeProgramProject;
    const result = command(db, {
      programId: program.id,
      projectId: Number(form.get("project_id") ?? 0),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(base);
  }
  if (intent === "create_objective") {
    const result = createObjective(db, {
      programId: program.id,
      name: String(form.get("name") ?? ""),
      valueStatement: String(form.get("value_statement") ?? ""),
      startAt: String(form.get("start_at") ?? ""),
      endAt: String(form.get("end_at") ?? ""),
      verticalPosition: optionalInt(form.get("vertical_position")),
      size: optionalInt(form.get("size")),
      value: optionalInt(form.get("value")),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(`${base}/objectives/${result.value.objective.number}`);
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Program overview page (legacy plans/show + program projects). */
export default function ProgramPage() {
  const { program, plan, projects, objectives, addableProjects: addable, canPlan, canAdminister } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/programs/${program.identifier}`;

  return (
    <main id="program" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {program.name} <small>({program.identifier})</small>
      </h1>
      {program.description ? <p>{program.description}</p> : null}
      <p>
        <Link to="/programs">All programs</Link> · <Link to={`${base}/team`}>Team</Link>
        {canAdminister ? (
          <>
            {" "}
            · <Link to={`${base}/settings`}>Settings</Link>
          </>
        ) : null}
      </p>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <section id="plan">
        <h2>Plan</h2>
        <p>
          {plan.startAt} → {plan.endAt}
        </p>
        {canPlan && (
          <Form method="post">
            <input type="hidden" name="intent" value="update_plan" />
            <label>
              Start <input name="start_at" type="date" defaultValue={plan.startAt} required />
            </label>{" "}
            <label>
              End <input name="end_at" type="date" defaultValue={plan.endAt} required />
            </label>{" "}
            <button type="submit">Move plan window</button>
          </Form>
        )}
      </section>

      <section id="program-projects">
        <h2>Projects</h2>
        {projects.length === 0 ? (
          <p className="info-box">No projects belong to this program yet.</p>
        ) : (
          <ul>
            {projects.map((project) => (
              <li key={project.id}>
                <Link to={`/projects/${project.identifier}/cards`}>{project.name}</Link>{" "}
                {canAdminister && (
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="remove_project" />
                    <input type="hidden" name="project_id" value={project.id} />
                    <button type="submit">Remove</button>
                  </Form>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAdminister && addable.length > 0 && (
          <Form method="post">
            <input type="hidden" name="intent" value="add_project" />
            <label>
              Add project{" "}
              <select name="project_id" required defaultValue="">
                <option value="">(choose)</option>
                {addable.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>{" "}
            <button type="submit">Add</button>
          </Form>
        )}
      </section>

      <section id="objectives">
        <h2>Objectives</h2>
        {objectives.length === 0 ? (
          <p className="info-box">No objectives yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Status</th>
                <th>Start</th>
                <th>End</th>
                <th>Row</th>
                <th>Size</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {objectives.map((objective) => (
                <tr key={objective.id}>
                  <td>{objective.number}</td>
                  <td>
                    <Link to={`${base}/objectives/${objective.number}`}>{objective.name}</Link>
                  </td>
                  <td>{objective.status}</td>
                  <td>{objective.startAt ?? "—"}</td>
                  <td>{objective.endAt ?? "—"}</td>
                  <td>{objective.verticalPosition}</td>
                  <td>{objective.size}</td>
                  <td>{objective.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canPlan && (
          <>
            <h3>Add an objective</h3>
            <Form method="post">
              <input type="hidden" name="intent" value="create_objective" />
              <p>
                <label>
                  Name <input name="name" type="text" size={50} maxLength={80} required />
                </label>
              </p>
              <p>
                <label>
                  Value statement <textarea name="value_statement" rows={4} cols={60} />
                </label>
              </p>
              <p>
                <label>
                  Start <input name="start_at" type="date" required />
                </label>{" "}
                <label>
                  End <input name="end_at" type="date" required />
                </label>
              </p>
              <p>
                <label>
                  Timeline row{" "}
                  <input
                    name="vertical_position"
                    type="number"
                    min={1}
                    max={TIMELINE_ROWS}
                    defaultValue={VERTICALLY_MIDDLE_OF_TIMELINE}
                  />
                </label>{" "}
                <label>
                  Size <input name="size" type="number" min={0} defaultValue={0} />
                </label>{" "}
                <label>
                  Value <input name="value" type="number" min={0} defaultValue={0} />
                </label>
              </p>
              <button type="submit">Add objective</button>
            </Form>
          </>
        )}
      </section>
    </main>
  );
}
