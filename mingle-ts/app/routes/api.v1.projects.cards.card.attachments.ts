/**
 * /api/v1/projects/:identifier/cards/:number/attachments — a card's
 * attachments (resource route, JSON).
 *
 * GET  lists an `ApiPage<ApiAttachment>` by file name (`?limit=`,
 *      `?cursor=`).
 * POST attaches a file: a `multipart/form-data` body with one `file`
 *      part, exactly what the card page posts. The bytes are stored
 *      first and AddCardAttachment records them (deleting the bytes
 *      again if it rejects — the card page's own sequence); 201 with
 *      `ApiAttachment`, whose `url` serves the bytes back.
 *
 * Authentication: bearer API key (app/api/auth.server.ts).
 *
 * Public interface: `loader`, `action`.
 * Owner context: Public API (HTTP adapter) for Card Management.
 */
import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Route } from "./+types/api.v1.projects.cards.card.attachments";
import { db } from "~/db/client.server";
import { attachments } from "~/db/schema/card-content";
import { requireApiUser } from "~/api/auth.server";
import { apiError, commandResponse, jsonResponse, methodNotAllowed } from "~/api/http.server";
import { keysetPage, readPageParams } from "~/api/pagination.server";
import { attachmentPresenter, requireCard, requireProject } from "~/api/resources.server";
import { addCardAttachment } from "~/domain/cards/attachments.server";
import { deleteAttachmentFile, sanitizeFileName, saveAttachmentFile } from "~/files/attachment-storage.server";

/** GET: one page of the card's attachments, by file name. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  const page = readPageParams(new URL(request.url));
  const rows = db
    .select()
    .from(attachments)
    .where(eq(attachments.cardId, card.id))
    .orderBy(asc(attachments.fileName), asc(attachments.id))
    .all();
  const paged = keysetPage(rows, page, (row) => [row.fileName, row.id]);
  const present = attachmentPresenter(db, project.identifier, card.number);
  return jsonResponse({ items: paged.items.map(present), nextCursor: paged.nextCursor });
}

/** POST: store the uploaded `file` part, then AddCardAttachment; 201 with the attachment. */
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireApiUser(request);
  const project = requireProject(db, params.identifier);
  const card = requireCard(db, project.id, params.number);
  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data"))
    throw apiError(400, "attachments are uploaded as multipart/form-data with a 'file' part");
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw apiError(400, "'file' must be a non-empty file part");
  const fileName = sanitizeFileName(file.name);
  const fileKey = saveAttachmentFile(new Uint8Array(await file.arrayBuffer()), fileName);
  const result = addCardAttachment(db, {
    projectId: project.id,
    cardNumber: card.number,
    fileName,
    fileKey,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    uniqueSuffix: randomBytes(3).toString("hex"),
    actorUserId: user.id,
  });
  if (!result.ok) deleteAttachmentFile(fileKey);
  return commandResponse(result, 201, attachmentPresenter(db, project.identifier, card.number));
}
