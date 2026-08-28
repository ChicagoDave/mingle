/**
 * /programs/:identifier/objectives/:number — one objective: its
 * fields, an edit form, deletion, and its version trail (Phase 26).
 *
 * Purpose: the objective page. Members edit (`intent=update`); program
 * administrators delete (`intent=delete`), which returns to the
 * program page. The trail lists every version, newest first.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Program Management (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/programs.objectives.show";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { PrivilegeLevel, privilegeLevelForProgram } from "~/domain/identity/authorization.server";
import { deleteObjective, TIMELINE_ROWS, updateObjective } from "~/domain/programs/objectives.server";
import { findObjectiveByNumber, findProgramByIdentifier, objectiveHistory } from "~/domain/programs/read.server";

/** Optional integer form field: blank → null, else Number (NaN when malformed, rejected downstream). */
function optionalInt(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

/** Loads the program, the objective, its trail, and what the viewer may do. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const objective = findObjectiveByNumber(db, program.id, Number(params.number));
  if (!objective) throw new Response("Not Found", { status: 404 });
  const level = privilegeLevelForProgram(db, userId, program.id);
  return {
    program: { name: program.name, identifier: program.identifier },
    objective,
    history: objectiveHistory(db, objective.id),
    canEdit: level >= PrivilegeLevel.FULL_TEAM_MEMBER,
    canDelete: level >= PrivilegeLevel.PROJECT_ADMIN,
  };
}

/** Dispatches by `intent` to UpdateObjective or DeleteObjective. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const number = Number(params.number);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const base = `/programs/${program.identifier}`;

  if (intent === "update") {
    const result = updateObjective(db, {
      programId: program.id,
      number,
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
    throw redirect(`${base}/objectives/${number}`);
  }
  if (intent === "delete") {
    const result = deleteObjective(db, { programId: program.id, number, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(base);
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Objective page with edit form and version trail. */
export default function ObjectivePage() {
  const { program, objective, history, canEdit, canDelete } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/programs/${program.identifier}`;

  return (
    <main id="objective" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/programs">All programs</Link> · <Link to={base}>{program.name}</Link>
      </p>
      <h1>
        Objective #{objective.number}: {objective.name} <small>({objective.identifier})</small>
      </h1>
      <p>
        <strong>{objective.status}</strong> · {objective.startAt ?? "—"} → {objective.endAt ?? "—"} · row{" "}
        {objective.verticalPosition} · size {objective.size} · value {objective.value} · version {objective.version}
      </p>
      {objective.valueStatement ? (
        <section id="value-statement">
          <h2>Value statement</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{objective.valueStatement}</p>
        </section>
      ) : null}

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {canEdit && (
        <section id="edit">
          <h2>Edit</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="update" />
            <p>
              <label>
                Name <input name="name" type="text" size={50} maxLength={80} defaultValue={objective.name} required />
              </label>
            </p>
            <p>
              <label>
                Value statement{" "}
                <textarea name="value_statement" rows={4} cols={60} defaultValue={objective.valueStatement ?? ""} />
              </label>
            </p>
            <p>
              <label>
                Start <input name="start_at" type="date" defaultValue={objective.startAt ?? ""} required />
              </label>{" "}
              <label>
                End <input name="end_at" type="date" defaultValue={objective.endAt ?? ""} required />
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
                  defaultValue={objective.verticalPosition}
                />
              </label>{" "}
              <label>
                Size <input name="size" type="number" min={0} defaultValue={objective.size} />
              </label>{" "}
              <label>
                Value <input name="value" type="number" min={0} defaultValue={objective.value} />
              </label>
            </p>
            <button type="submit">Save objective</button>
          </Form>
        </section>
      )}

      {canDelete && (
        <Form method="post">
          <input type="hidden" name="intent" value="delete" />
          <button type="submit">Delete objective</button>
        </Form>
      )}

      <section id="history">
        <h2>History</h2>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Name</th>
              <th>Range</th>
              <th>Row</th>
              <th>Size</th>
              <th>Value</th>
              <th>Status</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.version}>
                <td>
                  {entry.version}
                  {entry.isDeletion ? " (deleted)" : ""}
                </td>
                <td>{entry.name}</td>
                <td>
                  {entry.startAt ?? "—"} → {entry.endAt ?? "—"}
                </td>
                <td>{entry.verticalPosition}</td>
                <td>{entry.size}</td>
                <td>{entry.value}</td>
                <td>{entry.status}</td>
                <td>{entry.modifiedBy?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
