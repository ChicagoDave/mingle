/**
 * /programs/:identifier/team — program membership and roles (Phase
 * 26; legacy ProgramMembershipsController).
 *
 * Purpose: lists the program's members with their roles; program
 * administrators add (`intent=add`) and remove (`intent=remove`)
 * members. Authorization is enforced by the command handlers; the
 * route surfaces the rejection.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { sql } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/programs.team";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { users } from "~/db/schema/identity";
import { PrivilegeLevel, privilegeLevelForProgram } from "~/domain/identity/authorization.server";
import { addProgramMember, removeProgramMember } from "~/domain/identity/program-membership.server";
import { findProgramByIdentifier, programMembers } from "~/domain/programs/read.server";
import { DEFAULT_PROGRAM_ROLE, PROGRAM_ROLE_LABELS, PROGRAM_ROLES, type ProgramRole } from "~/shared/wire-types";

/** Loads the program's members and, for administrators, the users addable to it. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const members = programMembers(db, program.id);
  const memberIds = new Set(members.map((member) => member.userId));
  const canAdminister = privilegeLevelForProgram(db, userId, program.id) >= PrivilegeLevel.PROJECT_ADMIN;
  const addableUsers = canAdminister
    ? db
        .select({ id: users.id, name: users.name, login: users.login })
        .from(users)
        .orderBy(sql`lower(${users.name})`)
        .all()
        .filter((user) => !memberIds.has(user.id))
    : [];
  return {
    program: { name: program.name, identifier: program.identifier },
    members,
    addableUsers,
    canAdminister,
  };
}

/** Dispatches by `intent` to AddProgramMember or RemoveProgramMember; redirects back on success. */
export async function action({ request, params }: Route.ActionArgs) {
  const actorUserId = await requireUserId(request);
  const program = findProgramByIdentifier(db, params.identifier);
  if (!program) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const userId = Number(form.get("user_id") ?? 0);

  if (intent === "add") {
    const result = addProgramMember(db, {
      programId: program.id,
      userId,
      role: form.get("role") ? String(form.get("role")) : null,
      actorUserId,
    });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(`/programs/${program.identifier}/team`);
  }
  if (intent === "remove") {
    const result = removeProgramMember(db, { programId: program.id, userId, actorUserId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(`/programs/${program.identifier}/team`);
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Program team page. */
export default function ProgramTeam() {
  const { program, members, addableUsers, canAdminister } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/programs/${program.identifier}`;

  return (
    <main id="program-team" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <p>
        <Link to="/programs">All programs</Link> · <Link to={base}>{program.name}</Link>
      </p>
      <h1>{program.name} team</h1>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {members.length === 0 ? (
        <p>No members.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Login</th>
              <th>Role</th>
              {canAdminister && <th />}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>{member.name}</td>
                <td>{member.login}</td>
                <td>{PROGRAM_ROLE_LABELS[member.role as ProgramRole] ?? member.role}</td>
                {canAdminister && (
                  <td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="user_id" value={member.userId} />
                      <button type="submit">Remove</button>
                    </Form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canAdminister && addableUsers.length > 0 && (
        <>
          <h2>Add a member</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="add" />
            <label>
              User{" "}
              <select name="user_id" required defaultValue="">
                <option value="">(choose)</option>
                {addableUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} ({user.login})
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Role{" "}
              <select name="role" defaultValue={DEFAULT_PROGRAM_ROLE}>
                {PROGRAM_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {PROGRAM_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>{" "}
            <button type="submit">Add</button>
          </Form>
        </>
      )}
    </main>
  );
}
