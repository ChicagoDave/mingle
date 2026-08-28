/**
 * /programs/:identifier/settings — program name, identifier and
 * description, and deletion (Phase 26; legacy ProgramSettingsController,
 * ProgramsController#confirm_delete).
 *
 * Purpose: program administrators edit the settings (`intent=update`,
 * redirecting to the possibly-renamed program's settings); Mingle
 * administrators delete the program (`intent=delete`, redirecting to
 * the list).
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Program Management (HTTP adapter).
 */
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/programs.settings";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import {
  authorizeSiteAdminAction,
  PrivilegeLevel,
  privilegeLevelForProgram,
} from "~/domain/identity/authorization.server";
import { deleteProgram, updateProgramSettings } from "~/domain/programs/commands.server";
import { findProgramByIdentifier } from "~/domain/programs/read.server";

/** Loads the program and what the viewer may do to it. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  return {
    program: { name: program.name, identifier: program.identifier, description: program.description },
    canEdit: privilegeLevelForProgram(db, userId, program.id) >= PrivilegeLevel.PROJECT_ADMIN,
    canDelete: authorizeSiteAdminAction(db, userId) === null,
  };
}

/** Dispatches by `intent` to UpdateProgramSettings or DeleteProgram. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "update") {
    const result = updateProgramSettings(db, {
      programId: program.id,
      name: String(form.get("name") ?? ""),
      identifier: String(form.get("identifier") ?? ""),
      description: String(form.get("description") ?? ""),
      actorUserId: userId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(`/programs/${result.value.identifier}/settings`);
  }
  if (intent === "delete") {
    const result = deleteProgram(db, { programId: program.id, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect("/programs");
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Program settings page. */
export default function ProgramSettings() {
  const { program, canEdit, canDelete } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/programs/${program.identifier}`;

  return (
    <main id="program-settings" style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <p>
        <Link to="/programs">All programs</Link> · <Link to={base}>{program.name}</Link>
      </p>
      <h1>{program.name} settings</h1>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <Form method="post">
          <input type="hidden" name="intent" value="update" />
          <p>
            <label>
              Name <input name="name" type="text" size={40} defaultValue={program.name} required />
            </label>
          </p>
          <p>
            <label>
              Identifier <input name="identifier" type="text" size={30} defaultValue={program.identifier} required />
            </label>
          </p>
          <p>
            <label>
              Description <input name="description" type="text" size={60} defaultValue={program.description ?? ""} />
            </label>
          </p>
          <button type="submit">Save settings</button>
        </Form>
      ) : (
        <p>Only a program administrator can change these settings.</p>
      )}

      {canDelete && (
        <Form method="post" style={{ marginTop: 32 }}>
          <input type="hidden" name="intent" value="delete" />
          <button type="submit">Delete this program</button>
        </Form>
      )}
    </main>
  );
}
