/**
 * /projects/:identifier/cards/:number/attachments/:attachmentId —
 * attachment download.
 *
 * Purpose: streams an attachment's stored bytes with its recorded
 * content type and a download disposition. Read-only; requires a
 * logged-in session (readonly members may download, matching legacy
 * read access).
 *
 * Public interface: `loader`.
 *
 * Owner context: Card Management (HTTP adapter).
 */
import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/projects.cards.attachment";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { cards } from "~/db/schema/cards";
import { attachments } from "~/db/schema/card-content";
import { readAttachmentFile } from "~/files/attachment-storage.server";
import { requireUserId } from "~/auth/session.server";

/** Looks the attachment up through its project and card, then streams the bytes. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.identifier, params.identifier))
    .get();
  if (!project) throw new Response("Not Found", { status: 404 });
  const card = db
    .select({ id: cards.id })
    .from(cards)
    .where(
      and(eq(cards.projectId, project.id), eq(cards.number, Number(params.number))),
    )
    .get();
  if (!card) throw new Response("Not Found", { status: 404 });
  const attachment = db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, Number(params.attachmentId)),
        eq(attachments.cardId, card.id),
      ),
    )
    .get();
  if (!attachment) throw new Response("Not Found", { status: 404 });
  const bytes = readAttachmentFile(attachment.fileKey);
  if (!bytes) throw new Response("Not Found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": attachment.contentType,
      "Content-Disposition": `attachment; filename="${attachment.fileName}"`,
      "Content-Length": String(bytes.length),
    },
  });
}
