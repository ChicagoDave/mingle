/**
 * Attachment byte storage — local filesystem volume (Phase 6).
 *
 * Purpose: the single place attachment BYTES are written, read, and
 * removed. Files live under the attachments root (ATTACHMENTS_DIR env,
 * else an `attachments/` directory beside the database file — on the
 * container's /data volume either way), each in its own random
 * directory so storage paths never collide even when display names do
 * (legacy DataDir::Attachments.random_directory parity). Attachment
 * ROWS are the domain layer's business; this module knows nothing
 * about cards or the database.
 *
 * Public interface: `sanitizeFileName`, `saveAttachmentFile`,
 * `readAttachmentFile`, `deleteAttachmentFile`.
 *
 * Owner context: infrastructure (file storage adapter) for Card
 * Management.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

/** The attachments root: env override, else beside the database file. */
function attachmentsRoot(): string {
  if (process.env.ATTACHMENTS_DIR) return resolve(process.env.ATTACHMENTS_DIR);
  const databaseFile = resolve(process.env.DATABASE_FILE ?? "data/mingle.db");
  return join(dirname(databaseFile), "attachments");
}

/**
 * Reduces an uploaded name to a safe basename: path separators stripped,
 * anything outside [A-Za-z0-9._-] replaced by "_" (legacy
 * FileColumn::sanitize_filename intent). Never returns an empty name.
 *
 * @param fileName - the client-supplied file name
 */
export function sanitizeFileName(fileName: string): string {
  const name = basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_");
  return name === "" || name === "." || name === ".." ? "file" : name;
}

/**
 * Writes attachment bytes under a fresh random directory.
 *
 * @param bytes - the file content
 * @param fileName - a sanitized display name (see sanitizeFileName)
 * @returns the storage key ("<random-dir>/<fileName>") for later reads
 */
export function saveAttachmentFile(
  bytes: Uint8Array,
  fileName: string,
): string {
  const dir = randomBytes(3).toString("hex");
  const fileKey = `${dir}/${sanitizeFileName(fileName)}`;
  const absolute = join(attachmentsRoot(), fileKey);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return fileKey;
}

/**
 * Reads attachment bytes by storage key.
 *
 * @param fileKey - a key returned by saveAttachmentFile
 * @returns the stored bytes, or null when the file is missing
 */
export function readAttachmentFile(fileKey: string): Buffer | null {
  const absolute = join(attachmentsRoot(), fileKey);
  return existsSync(absolute) ? readFileSync(absolute) : null;
}

/**
 * Removes an attachment's bytes and its (per-attachment) directory.
 * Missing files are ignored — deletion must be idempotent.
 *
 * @param fileKey - a key returned by saveAttachmentFile
 */
export function deleteAttachmentFile(fileKey: string): void {
  const absolute = join(attachmentsRoot(), fileKey);
  rmSync(dirname(absolute), { recursive: true, force: true });
}
