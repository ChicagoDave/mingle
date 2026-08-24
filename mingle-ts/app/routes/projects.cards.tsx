/**
 * /projects/:identifier/cards — the project's card list.
 *
 * Purpose: Phase 5 card CRUD entry point. Lists cards (number, name,
 * type) newest-first by number. Requires a logged-in session; mutations
 * live on the new/show routes.
 *
 * Public interface: `loader`, default component.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { desc, eq } from "drizzle-orm";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/projects.cards";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { cards, cardTypes } from "~/db/schema/cards";
import { requireUserId } from "~/auth/session.server";

/** Loads the project's cards with their type names, newest number first. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const rows = db
    .select({
      number: cards.number,
      name: cards.name,
      cardTypeName: cardTypes.name,
    })
    .from(cards)
    .innerJoin(cardTypes, eq(cardTypes.id, cards.cardTypeId))
    .where(eq(cards.projectId, project.id))
    .orderBy(desc(cards.number))
    .all();
  return {
    project: { name: project.name, identifier: project.identifier },
    cards: rows,
  };
}

/** Card list page. Styling is deliberately minimal until the UX-harvest phases. */
export default function ProjectCards() {
  const { project, cards } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {project.name} cards <small>({project.identifier})</small>
      </h1>
      <p>
        <Link to="/projects">All projects</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/settings`}>Settings</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/team`}>Team</Link> ·{" "}
        <Link to={`/projects/${project.identifier}/cards/new`}>New card</Link>
      </p>
      {cards.length === 0 ? (
        <p>No cards yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <tr key={card.number}>
                <td>#{card.number}</td>
                <td>
                  <Link to={`/projects/${project.identifier}/cards/${card.number}`}>
                    {card.name}
                  </Link>
                </td>
                <td>{card.cardTypeName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
