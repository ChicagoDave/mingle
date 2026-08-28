/**
 * /projects/:identifier/subscriptions — a user's history subscriptions
 * in a project (Phase 22; legacy history_subscriptions controller and
 * the "Subscribe via email" links on history, card and page views).
 *
 * Purpose: lists the viewing user's subscriptions with unsubscribe
 * buttons, and is the single POST target for subscribing from
 * anywhere — the history page (project-wide, or an MQL filter), a
 * card page, or a wiki page post here with `intent=subscribe` and the
 * filter fields, plus an optional `returnTo` to land back where they
 * came from.
 *
 * Public interface: `loader`, `action`, default component.
 *
 * Owner context: Collaboration (HTTP adapter).
 */
import { eq } from "drizzle-orm";
import { data, Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.subscriptions";
import { requireUserId } from "~/auth/session.server";
import { db } from "~/db/client.server";
import { users } from "~/db/schema/identity";
import { projects } from "~/db/schema/projects";
import { subscribe, unsubscribe } from "~/domain/subscriptions/commands.server";
import type { SubscriptionFilter } from "~/domain/subscriptions/filter.server";
import { listSubscriptions } from "~/domain/subscriptions/read.server";
import { SUBSCRIPTION_KINDS, type SubscriptionKind } from "~/shared/wire-types";

/** Loads the viewing user's subscriptions in the project. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const me = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();

  return {
    project: { name: project.name, identifier: project.identifier },
    subscriptions: listSubscriptions(db, project, userId),
    hasEmail: Boolean(me?.email),
  };
}

/** The filter a subscribe form posted, or null when the fields do not form one. */
function filterFromForm(form: FormData): SubscriptionFilter | null {
  const kind = String(form.get("kind") ?? "");
  if (!(SUBSCRIPTION_KINDS as readonly string[]).includes(kind)) return null;
  switch (kind as SubscriptionKind) {
    case "project":
      return { kind: "project" };
    case "card": {
      const cardNumber = Number(form.get("card_number"));
      return Number.isSafeInteger(cardNumber) ? { kind: "card", cardNumber } : null;
    }
    case "page": {
      const pageIdentifier = String(form.get("page_identifier") ?? "");
      return pageIdentifier ? { kind: "page", pageIdentifier } : null;
    }
    case "mql":
      return { kind: "mql", mql: String(form.get("mql") ?? "") };
  }
}

/** A same-site path to return to after the action, or the subscriptions page. */
function returnPath(form: FormData, fallback: string): string {
  const requested = String(form.get("returnTo") ?? "");
  return requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;
}

/** Dispatches the posted form by `intent` to Subscribe or Unsubscribe. */
export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const project = db
    .select({ id: projects.id, identifier: projects.identifier })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const here = `/projects/${project.identifier}/subscriptions`;

  if (intent === "subscribe") {
    const filter = filterFromForm(form);
    if (!filter) throw new Response("Bad Request", { status: 400 });
    const result = subscribe(db, { projectId: project.id, filter, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(returnPath(form, here));
  }

  if (intent === "unsubscribe") {
    const subscriptionId = Number(form.get("id"));
    if (!Number.isSafeInteger(subscriptionId)) throw new Response("Bad Request", { status: 400 });
    const result = unsubscribe(db, { projectId: project.id, subscriptionId, actorUserId: userId });
    if (!result.ok) return data({ ok: false as const, errors: result.errors }, { status: 400 });
    throw redirect(returnPath(form, here));
  }

  throw new Response("Unknown intent", { status: 400 });
}

/** Subscriptions page (legacy history_subscriptions/index). */
export default function ProjectSubscriptions() {
  const { project, subscriptions, hasEmail } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && !actionData.ok ? Object.values(actionData.errors).flat() : [];
  const base = `/projects/${project.identifier}`;

  return (
    <main id="project-subscriptions" style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>
        {project.name} subscriptions <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`${base}/history`}>History</Link> ·{" "}
        <Link to={`${base}/cards`}>Cards</Link> ·{" "}
        <Link to={`${base}/wiki`}>Pages</Link>
      </p>

      {errors.length > 0 && (
        <ul className="error-box">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {!hasEmail && (
        <p className="info-box">
          Set an email address on your <Link to="/profile">profile</Link> to subscribe.
        </p>
      )}

      {subscriptions.length === 0 ? (
        <p className="info-box">You have no subscriptions in {project.name}.</p>
      ) : (
        <ul id="subscriptions">
          {subscriptions.map((subscription) => (
            <li key={subscription.id} className={`subscription-${subscription.kind}`}>
              {subscription.description}
              {subscription.lastError && (
                <small className="error"> — not delivering: {subscription.lastError}</small>
              )}{" "}
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="unsubscribe" />
                <input type="hidden" name="id" value={subscription.id} />
                <button type="submit">Unsubscribe</button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      <h2>Subscribe</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="subscribe" />
        <input type="hidden" name="kind" value="project" />
        <button type="submit">All {project.name} history</button>
      </Form>
      <Form method="post" style={{ marginTop: 8 }}>
        <input type="hidden" name="intent" value="subscribe" />
        <input type="hidden" name="kind" value="mql" />
        <label>
          Cards matching MQL{" "}
          <input type="text" name="mql" size={50} placeholder="Type = Story AND Status != Closed" />
        </label>{" "}
        <button type="submit">Subscribe</button>
      </Form>
    </main>
  );
}
