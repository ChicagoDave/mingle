/**
 * /programs/:identifier/backlog — the program's backlog: proposed
 * objectives in their explicit order (Phase 27; legacy
 * BacklogObjectivesController).
 *
 * Purpose: the backlog page. Everyone on the program sees the ordered
 * list; members add an item (`intent=create`), reorder the list
 * (`intent=reorder`, with either `order` — numbers separated by commas
 * or spaces — or repeated `number` fields; a subset is merged into the
 * current order per `backfillOrder`), and plan an item
 * (`intent=plan`), which lands on the program page with it on the
 * timeline. Deletion is on the objective page.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Program Management (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/programs.backlog";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { PrivilegeLevel, privilegeLevelForProgram } from "~/domain/identity/authorization.server";
import { createBacklogObjective, planBacklogObjective, reorderBacklog } from "~/domain/programs/backlog.server";
import { backlogObjectives, findProgramByIdentifier } from "~/domain/programs/read.server";

/** Optional integer form field: blank → null, else Number (NaN when malformed, rejected downstream). */
function optionalInt(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

/** The requested order: `order` (comma/space separated) when present, else every `number` field, in submission order. */
function requestedOrder(form: FormData): number[] {
  const order = String(form.get("order") ?? "").trim();
  const tokens = order ? order.split(/[\s,]+/).filter(Boolean) : form.getAll("number").map(String);
  return tokens.map(Number);
}

/** Loads the program, its backlog in order, and whether the viewer may change it. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const level = privilegeLevelForProgram(db, userId, program.id);
  return {
    program: { id: program.id, name: program.name, identifier: program.identifier },
    backlog: backlogObjectives(db, program.id),
    canPlan: level >= PrivilegeLevel.FULL_TEAM_MEMBER,
  };
}

/** Dispatches by `intent` to CreateBacklogObjective, ReorderBacklog or PlanBacklogObjective. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const base = `/programs/${program.identifier}`;

  if (intent === "create") {
    const result = createBacklogObjective(db, {
      programId: program.id,
      name: String(form.get("name") ?? ""),
      valueStatement: String(form.get("value_statement") ?? ""),
      size: optionalInt(form.get("size")),
      value: optionalInt(form.get("value")),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(`${base}/backlog`);
  }
  if (intent === "reorder") {
    const numbers = requestedOrder(form);
    if (numbers.some((n) => !Number.isInteger(n)))
      return data({ ok: false as const, errors: { numbers: ["must be objective numbers"] } }, { status: 400 });
    const result = reorderBacklog(db, { programId: program.id, numbers, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(`${base}/backlog`);
  }
  if (intent === "plan") {
    const result = planBacklogObjective(db, {
      programId: program.id,
      number: Number(form.get("number") ?? 0),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(base);
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Backlog page: the ordered list with per-item move-to-top and plan, a whole-list reorder form, and an add form. */
export default function BacklogPage() {
  const { program, backlog, canPlan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/programs/${program.identifier}`;

  return (
    <main id="backlog" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/programs">All programs</Link> · <Link to={base}>{program.name}</Link>
      </p>
      <h1>Backlog</h1>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {backlog.length === 0 ? (
        <p className="info-box">The backlog is empty.</p>
      ) : (
        <ol id="backlog-items">
          {backlog.map((item) => (
            <li key={item.id} data-number={item.number}>
              <Link to={`${base}/objectives/${item.number}`}>
                #{item.number} {item.name}
              </Link>{" "}
              <small>
                size {item.size} · value {item.value}
              </small>
              {canPlan && (
                <>
                  {" "}
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="reorder" />
                    <input
                      type="hidden"
                      name="order"
                      value={[item.number, ...backlog.filter((o) => o.id !== item.id).map((o) => o.number)].join(",")}
                    />
                    <button type="submit" disabled={item.position === 1}>
                      Move to top
                    </button>
                  </Form>{" "}
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="plan" />
                    <input type="hidden" name="number" value={item.number} />
                    <button type="submit">Plan</button>
                  </Form>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      {canPlan && backlog.length > 1 && (
        <Form method="post" id="reorder">
          <input type="hidden" name="intent" value="reorder" />
          <label>
            New order (objective numbers, top first){" "}
            <input name="order" type="text" size={40} defaultValue={backlog.map((item) => item.number).join(", ")} />
          </label>{" "}
          <button type="submit">Reorder</button>
        </Form>
      )}

      {canPlan && (
        <section id="add">
          <h2>Add to backlog</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
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
                Size <input name="size" type="number" min={0} defaultValue={0} />
              </label>{" "}
              <label>
                Value <input name="value" type="number" min={0} defaultValue={0} />
              </label>
            </p>
            <button type="submit">Add to backlog</button>
          </Form>
        </section>
      )}
    </main>
  );
}
