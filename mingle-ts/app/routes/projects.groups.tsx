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
import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.groups";
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

/** Groups page. Styling is deliberately minimal until the UX-harvest phases. */
export default function ProjectGroups() {
  const { project, groups, teamMembers } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: FieldErrors =
    (actionData && "errors" in actionData ? actionData.errors : undefined) ?? {};
  const saved = actionData && "saved" in actionData ? actionData.saved : null;

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {project.name} groups <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/settings`}>Settings</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/team`}>Team</Link>
      </p>
      {saved ? <p style={{ color: "seagreen" }}>Saved.</p> : null}
      <ErrorLines field="authorization" errors={errors} />
      <ErrorLines field="group" errors={errors} />
      <ErrorLines field="user" errors={errors} />

      {groups.length === 0 ? (
        <p>No groups defined.</p>
      ) : (
        groups.map((group) => (
          <section key={group.id}>
            <h2>{group.name}</h2>
            {group.members.length === 0 ? (
              <p>No members.</p>
            ) : (
              <ul>
                {group.members.map((member) => (
                  <li key={member.userId}>
                    {member.name}{" "}
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="remove-member" />
                      <input type="hidden" name="groupId" value={group.id} />
                      <input type="hidden" name="userId" value={member.userId} />
                      <button type="submit">Remove</button>
                    </Form>
                  </li>
                ))}
              </ul>
            )}
            {teamMembers.length > 0 ? (
              <Form method="post">
                <input type="hidden" name="intent" value="add-member" />
                <input type="hidden" name="groupId" value={group.id} />
                <select name="userId">
                  {teamMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>{" "}
                <button type="submit">Add to group</button>
              </Form>
            ) : null}
            <Form method="post">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="groupId" value={group.id} />
              <button type="submit">Delete group</button>
            </Form>
          </section>
        ))
      )}

      <h2>New group</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="create" />
        <p>
          <label>
            Name
            <br />
            <input name="name" />
          </label>
          <ErrorLines field="name" errors={errors} />
        </p>
        <button type="submit">Create group</button>
      </Form>
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
