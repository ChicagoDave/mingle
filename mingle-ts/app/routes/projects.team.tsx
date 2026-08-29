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
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.team";
import { ActionBar, FormItem, ErrorLines, FlashBox, AdminPage } from "~/components/forms";
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
import {
  constraintMessage,
  identitySatisfiesConstraint,
  permittedStrategyKindsFor,
} from "~/domain/identity/access-constraint.server";

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
  // ADR-0021 Decision 6: the list reports who the constraint refuses; it never changes membership.
  const permitted = permittedStrategyKindsFor(db, project.id);
  const admins = new Set(db.select({ id: users.id }).from(users).where(eq(users.admin, true)).all().map((u) => u.id));
  const badged = members.map((member) => ({
    ...member,
    qualifies: permitted.length === 0 || admins.has(member.userId) || identitySatisfiesConstraint(db, member.userId, permitted),
  }));
  const memberIds = new Set(members.map((m) => m.userId));
  const addableUsers = db
    .select({ id: users.id, name: users.name, login: users.login })
    .from(users)
    .orderBy(sql`lower(${users.name})`)
    .all()
    .filter((u) => !memberIds.has(u.id));
  return {
    project: { name: project.name, identifier: project.identifier },
    members: badged,
    constraint: permitted.length === 0 ? null : constraintMessage(permitted),
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

/** Team page — legacy team/list.rhtml with team/_members.rhtml and _user.rhtml beside the admin nav. */
export default function ProjectTeam() {
  const { project, members, constraint, addableUsers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const savedMessage =
    saved === "add"
      ? "Team member was successfully added."
      : saved === "role"
        ? "Permissions were successfully updated."
        : saved === "remove"
          ? "Team member was successfully removed."
          : null;

  return (
    <AdminPage identifier={project.identifier} current="team">
      <ActionBar>
        <a href="#add-member" className="add-user link_as_button primary">
          Add team member
        </a>
      </ActionBar>
      <div>
        <h1>{project.name} team members</h1>
      </div>
      {savedMessage ? <FlashBox kind="success">{savedMessage}</FlashBox> : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="user" errors={errors} />
      <ErrorLines field="role" errors={errors} />
      <div id="content" className="content-margin-adjust">
        <table id="users" className="highlightable-table">
          <thead>
            <tr className="table-top">
              <th>Display name</th>
              <th>Sign-in name</th>
              <th className="align-center">Permissions</th>
              <th className="align-right last">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr>
                <td colSpan={4} className="italic-light align-center last">
                  There are currently no members to list.
                </td>
              </tr>
            ) : (
              members.map((member, index) => (
                <tr key={member.userId} id={`user_${member.userId}`} className={index % 2 === 0 ? "odd" : "even"}>
                  <td className="user-name">
                    {member.name}
                    {member.qualifies ? null : (
                      <span className="constraint-badge notes" title={constraint ?? undefined}>
                        {" "}
                        (cannot access under the project&apos;s authentication constraint)
                      </span>
                    )}
                  </td>
                  <td>{member.login}</td>
                  <td className="permissions_column inline-forms">
                    <div className="member_permission">
                      <Form method="post">
                        <input type="hidden" name="intent" value="role" />
                        <input type="hidden" name="userId" value={member.userId} />
                        <select name="role" defaultValue={member.role}>
                          {PROJECT_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {PROJECT_ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>{" "}
                        <button type="submit" className="inline">
                          Change
                        </button>
                      </Form>
                    </div>
                  </td>
                  <td className="align-right last inline-forms">
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="userId" value={member.userId} />
                      <button type="submit" className="inline delete">
                        Remove
                      </button>
                    </Form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 id="add-member">Add team member</h2>
      {addableUsers.length === 0 ? (
        <p className="italic-light">Every user is already on this team.</p>
      ) : (
        <Form method="post" className="form_contents">
          <input type="hidden" name="intent" value="add" />
          <div className="form_section last">
            <FormItem label="User:" htmlFor="add_user_id" required>
              <select id="add_user_id" name="userId">
                {addableUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} ({user.login})
                  </option>
                ))}
              </select>
            </FormItem>
            <FormItem label="Permissions:" htmlFor="add_role" required>
              <select id="add_role" name="role" defaultValue={DEFAULT_PROJECT_ROLE}>
                {PROJECT_ROLES.map((role: ProjectRole) => (
                  <option key={role} value={role}>
                    {PROJECT_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </FormItem>
          </div>
          <ActionBar>
            <button type="submit" className="save">
              Add to team
            </button>
          </ActionBar>
        </Form>
      )}
    </AdminPage>
  );
}
