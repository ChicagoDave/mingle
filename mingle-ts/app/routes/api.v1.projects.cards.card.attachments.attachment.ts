/**
 * /api/v1/projects/:identifier/cards/:number/attachments/:attachmentId
 * — one attachment's bytes (resource route).
 *
 * GET streams the stored file with its recorded content type and a
 *     download disposition — the same bytes the card page serves — or
 *     404 (unknown id, or the file missing from storage). Send
 *     `Accept: application/json` for the `ApiAttachment` metadata
 *     instead.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.cards.card.attachments.attachment";
import { db } from "~/db/client.server";
import { attachments } from "~/db/schema/card-content";
import { requireApiUser } from "~/api/auth.server";
import { apiError, jsonResponse } from "~/api/http.server";
import { attachmentPresenter, requireCard, requireProject } from "~/api/resources.server";
import { readAttachmentFile } from "~/files/attachment-storage.server";

/** GET: the bytes (or, for `Accept: application/json`, the metadata). */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  const id = /^\d+$/.test(params.attachmentId ?? "") ? Number(params.attachmentId) : NaN;
  const attachment = Number.isNaN(id)
    ? undefined
    : db.select().from(attachments).where(and(eq(attachments.cardId, card.id), eq(attachments.id, id))).get();
  if (!attachment) throw apiError(404, "attachment not found");
  if (request.headers.get("Accept")?.includes("application/json"))
    return jsonResponse(attachmentPresenter(db, project.identifier, card.number)(attachment));
  const bytes = readAttachmentFile(attachment.fileKey);
  if (!bytes) throw apiError(404, "attachment file is missing from storage");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": attachment.contentType,
      "Content-Disposition": `attachment; filename="${attachment.fileName}"`,
      "Content-Length": String(bytes.length),
    },
  });
}
