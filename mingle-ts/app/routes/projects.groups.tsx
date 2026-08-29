/**
 * /projects/:identifier/groups — user-defined groups.
 *
 * Purpose: the Phase 4 groups page. Lists each group with its members;
 * four forms post to one action discriminated by `intent`: "create"
 * runs CreateGroup, "delete" runs DeleteGroup, "add-member" runs
 * AddUserToGroup, "remove-member" runs RemoveUserFromGroup.
 * Authorization is enforced by the command handlers (project-admin
 * actions, legacy parity); the route just surfaces the rejection.
 * Requires a logged-in session.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Identity & Access (HTTP adapter).
 */
import { eq, inArray, sql } from "drizzle-orm";
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.groups";
import { ErrorLines, FlashBox, AdminPage } from "~/components/forms";
import type { FieldErrors } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { groupMemberships, groups, teamMemberships } from "~/db/schema/membership";
import { users } from "~/db/schema/identity";
import {
  addUserToGroup,
  createGroup,
  deleteGroup,
  removeUserFromGroup,
} from "~/domain/identity/membership.server";
import { requireUserId } from "~/auth/session.server";

/** Loads the project's groups with their members, and the team members addable to groups. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const projectGroups = db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(eq(groups.projectId, project.id))
    .orderBy(sql`lower(${groups.name})`)
    .all();
  const groupIds = projectGroups.map((g) => g.id);
  const memberships =
    groupIds.length === 0
      ? []
      : db
          .select({
            groupId: groupMemberships.groupId,
            userId: groupMemberships.userId,
            name: users.name,
          })
          .from(groupMemberships)
          .innerJoin(users, eq(users.id, groupMemberships.userId))
          .where(inArray(groupMemberships.groupId, groupIds))
          .orderBy(sql`lower(${users.name})`)
          .all();
  const teamMembers = db
    .select({ id: users.id, name: users.name })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.projectId, project.id))
    .orderBy(sql`lower(${users.name})`)
    .all();
  return {
    project: { name: project.name, identifier: project.identifier },
    groups: projectGroups.map((group) => ({
      ...group,
      members: memberships.filter((m) => m.groupId === group.id),
    })),
    teamMembers,
  };
}

/**
 * Dispatches the posted form by `intent` to CreateGroup, DeleteGroup,
 * AddUserToGroup, or RemoveUserFromGroup; returns field errors or a
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

  if (intent === "create") {
    const result = createGroup(db, {
      projectId: project.id,
      name: String(form.get("name") ?? ""),
      actorUserId,
    });
    return result.ok
      ? { saved: "create" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  const groupId = Number(form.get("groupId") ?? 0);
  if (intent === "delete") {
    const result = deleteGroup(db, { groupId, actorUserId });
    return result.ok
      ? { saved: "delete" as const }
      : { errors: result.errors satisfies FieldErrors };
  }
  if (intent === "add-member" || intent === "remove-member") {
    const input = {
      groupId,
      userId: Number(form.get("userId") ?? 0),
      actorUserId,
    };
    const result =
      intent === "add-member"
        ? addUserToGroup(db, input)
        : removeUserFromGroup(db, input);
    return result.ok
      ? { saved: intent }
      : { errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** Groups page — legacy groups/index.rhtml (quick-add box, groups table) with each group's members per groups/show.rhtml, beside the admin nav. */
export default function ProjectGroups() {
  const { project, groups, teamMembers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  const savedMessage =
    saved === "create"
      ? "Group was successfully created."
      : saved === "delete"
        ? "Group was successfully deleted."
        : saved === "add-member"
          ? "Member was successfully added to the group."
          : saved === "remove-member"
            ? "Member was successfully removed from the group."
            : null;

  return (
    <AdminPage identifier={project.identifier} current="groups">
      <div>
        <h1>{project.name} user groups</h1>
      </div>
      {savedMessage ? <FlashBox kind="success">{savedMessage}</FlashBox> : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="group" errors={errors} />
      <ErrorLines field="user" errors={errors} />
      <div className="basic-panel-one quick-add-group">
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <ErrorLines field="name" errors={errors} prefix="Name" />
          <input id="group_name" name="name" className="quick-add-text-field" placeholder="New group name" />
          <button type="submit" id="submit-quick-add" className="quick-add-add-btn primary">
            Create
          </button>
        </Form>
      </div>
      <div id="content" className="content-margin-adjust">
        <table id="project_groups" className="highlightable-table">
          <thead>
            <tr className="table-top">
              <th>Group name</th>
              <th>Number of users</th>
              <th className="align-right last">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={3} className="italic-light align-center last">
                  There are currently no groups to list.
                </td>
              </tr>
            ) : (
              groups.map((group, index) => (
                <tr key={group.id} className={`group ${index % 2 === 0 ? "odd" : "even"}`}>
                  <td className="name">
                    <span id={`group_${group.id}_name`}>
                      <a href={`#group-${group.id}`}>{group.name}</a>
                    </span>
                  </td>
                  <td className="numberofusers">{group.members.length}</td>
                  <td className="action align-right last inline-forms">
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="groupId" value={group.id} />
                      <button type="submit" id={`delete_group_${group.id}`} className="inline delete inline-delete-link">
                        Delete
                      </button>
                    </Form>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {groups.map((group) => (
        <div key={group.id} id={`group-${group.id}`} className="group-members-section">
          <h2>{group.name}</h2>
          <table id={`group-members-${group.id}`} className="highlightable-table">
            <thead>
              <tr className="table-top">
                <th>Display name</th>
                <th className="align-right last">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {group.members.length === 0 ? (
                <tr>
                  <td colSpan={2} className="italic-light align-center last">
                    There are currently no members to list.
                  </td>
                </tr>
              ) : (
                group.members.map((member, index) => (
                  <tr key={member.userId} className={index % 2 === 0 ? "odd" : "even"}>
                    <td>{member.name}</td>
                    <td className="align-right last inline-forms">
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove-member" />
                        <input type="hidden" name="groupId" value={group.id} />
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
          {teamMembers.length > 0 ? (
            <Form method="post" className="add-to-group">
              <input type="hidden" name="intent" value="add-member" />
              <input type="hidden" name="groupId" value={group.id} />
              <select name="userId">
                {teamMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>{" "}
              <button type="submit" className="primary inline">
                Add user as member
              </button>
            </Form>
          ) : null}
        </div>
      ))}
    </AdminPage>
  );
}
