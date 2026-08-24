/**
 * /projects/:identifier/team — project team membership and roles.
 *
 * Purpose: the Phase 4 team page. Lists members with their roles; three
 * forms post to one action discriminated by `intent`: "add" runs
 * AddTeamMember, "role" runs ChangeTeamMemberRole, "remove" runs
 * RemoveTeamMember. Authorization is enforced by the command handlers
 * (project-admin actions, legacy parity); the route just surfaces the
 * rejection. Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { eq, sql } from "drizzle-orm";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.team";
import {
  PROJECT_ROLES,
  PROJECT_ROLE_LABELS,
  DEFAULT_PROJECT_ROLE,
  type FieldErrors,
  type ProjectRole,
} from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { teamMemberships } from "~/db/schema/membership";
import { users } from "~/db/schema/identity";
import {
  addTeamMember,
  changeTeamMemberRole,
  removeTeamMember,
} from "~/domain/identity/membership.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the project's team (with user names) and the users addable to it. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const members = db
    .select({
      userId: teamMemberships.userId,
      role: teamMemberships.role,
      name: users.name,
      login: users.login,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, project.id))
    .orderBy(sql`lower(${users.name})`)
    .all();
  const memberIds = new Set(members.map((m) => m.userId));
  const addableUsers = db
    .select({ id: users.id, name: users.name, login: users.login })
    .from(users)
    .orderBy(sql`lower(${users.name})`)
    .all()
    .filter((u) => !memberIds.has(u.id));
  return {
    project: { name: project.name, identifier: project.identifier },
    members,
    addableUsers,
  };
}

/**
 * Dispatches the posted form by `intent` to AddTeamMember,
 * ChangeTeamMemberRole, or RemoveTeamMember; returns field errors or a
 * saved flag.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const actorUserId = await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const userId = Number(form.get("userId") ?? 0);

  if (intent === "add") {
    const result = addTeamMember(db, {
      projectId: project.id,
      userId,
      role: form.get("role") ? String(form.get("role")) : null,
      actorUserId,
    });
    return result.ok
      ? { saved: "add" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "role") {
    const result = changeTeamMemberRole(db, {
      projectId: project.id,
      userId,
      role: String(form.get("role") ?? ""),
      actorUserId,
    });
    return result.ok
      ? { saved: "role" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "remove") {
    const result = removeTeamMember(db, {
      projectId: project.id,
      userId,
      actorUserId,
    });
    return result.ok
      ? { saved: "remove" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Team page. Styling is deliberately minimal until the UX-harvest phases. */
export default function ProjectTeam() {
  const { project, members, addableUsers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {project.name} team <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/settings`}>Settings</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/groups`}>Groups</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}
      <ErrorLines field="authorization" errors={errors} />

      <h2>Members</h2>
      {members.length === 0 ? (
        <p>No team members.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>
                  {member.name} ({member.login})
                </td>
                <td>
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="role" />
                    <input type="hidden" name="userId" value={member.userId} />
                    <select name="role" defaultValue={member.role}>
                      {PROJECT_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {PROJECT_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>{" "}
                    <button type="submit">Change role</button>
                  </Form>
                </td>
                <td>
                  <Form method="post" style={{ display: "inline" }}>
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="userId" value={member.userId} />
                    <button type="submit">Remove</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorLines field="user" errors={errors} />
      <ErrorLines field="role" errors={errors} />

      <h2>Add member</h2>
      {addableUsers.length === 0 ? (
        <p>Every user is already on this team.</p>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="add" />
          <p>
            <label>
              User
              <br />
              <select name="userId">
                {addableUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} ({user.login})
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Role
              <br />
              <select name="role" defaultValue={DEFAULT_PROJECT_ROLE}>
                {PROJECT_ROLES.map((role: ProjectRole) => (
                  <option key={role} value={role}>
                    {PROJECT_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <button type="submit">Add to team</button>
        </Form>
      )}
    </main>
  );
}

/** Renders a field's error messages, if any. */
function ErrorLines({ field, errors }: { field: string; errors: FieldErrors }) {
  return (
    <>
      {errors[field]?.map((message) => (
        <span key={message} style={{ color: "crimson", display: "block" }}>
          {message}
        </span>
      ))}
    </>
  );
}
