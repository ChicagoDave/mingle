/**
 * Wiki & Content command handlers — the Page aggregate and its
 * versioned history (Phase 16).
 *
 * Purpose: the write path for wiki pages, and the only writer of the
 * append-only `page_versions` trail. Each handler authorizes the actor
 * through the Phase 4 checkpoint at the legacy privilege level (page
 * create/update: full team member — legacy PagesController privileges;
 * page deletion: project administrator — legacy
 * `check_current_user_is_project_admin`), validates against the legacy
 * rules (page.rb), mutates state, and emits a past-tense domain event —
 * or rejects (rule 10).
 *
 * Versioning invariant: `page_versions` rows are only ever INSERTED —
 * never updated, never deleted. Every page mutation appends the next
 * version; deleting a page keeps its trail and appends a final
 * deletion version (legacy keep_versions_on_destroy +
 * `create_deletion_page_version`). This mirrors Phase 5's Card
 * discipline deliberately; the two aggregates share the pattern, not
 * the code, because they belong to different bounded contexts.
 *
 * Bodies are sanitized here, at the boundary, so nothing unsanitized
 * is ever stored (app/domain/pages/content.server.ts).
 *
 * Commands → events:
 *   CreatePage → PageCreated (+ version 1)
 *   UpdatePage → PageUpdated (+ next version)
 *   DeletePage → PageDeleted (+ deletion version)
 *
 * Renaming a page is deliberately absent, as it is in legacy: a page's
 * name is its address, and every `[[…]]` link to it is stored as text.
 *
 * Public interface: `createPage`, `updatePage`, `deletePage`.
 *
 * Owner context: Wiki & Content. Handlers take the Drizzle handle as a
 * parameter — no module-level infrastructure imports; tests supply
 * their own real database.
 */
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { pages, pageVersions, type PageRow } from "~/db/schema/pages";
import { projects } from "~/db/schema/projects";
import { type CommandResult, reject } from "~/domain/command.server";
import { emitEvent } from "~/domain/events.server";
import {
  isBlankContent,
  sanitizePageContent,
} from "~/domain/pages/content.server";
import {
  pageIdentifier,
  pageNameError,
  pageNameFromIdentifier,
} from "~/domain/pages/naming.server";
import {
  authorizeProjectAction,
  PrivilegeLevel,
} from "~/domain/identity/authorization.server";

/** True when the project id names an existing project. */
function projectExists(db: BetterSQLite3Database, projectId: number): boolean {
  return Boolean(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get(),
  );
}

/**
 * Looks a page up by URL identifier within a project, matching the
 * name case-insensitively (legacy `Page.find_by_identifier`).
 */
function findPageByIdentifier(
  db: BetterSQLite3Database,
  projectId: number,
  identifier: string,
): PageRow | undefined {
  const name = pageNameFromIdentifier(identifier);
  return db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.projectId, projectId),
        sql`lower(${pages.name}) = ${name.toLowerCase()}`,
      ),
    )
    .get();
}

/**
 * Normalizes a submitted body to its stored form: sanitized, trimmed,
 * and NULL when empty (legacy stored an empty page body as nil).
 */
function storedContent(content: string | null | undefined): string | null {
  const sanitized = sanitizePageContent(content ?? "").trim();
  // A rich editor serializes an empty document as markup ("<p></p>"),
  // so emptiness is decided by what the body shows, not by its length.
  return isBlankContent(sanitized) ? null : sanitized;
}

export interface CreatePageInput {
  projectId: number;
  name: string;
  content?: string | null;
  actorUserId: number;
}

/**
 * CreatePage — creates a wiki page as version 1 of its history.
 *
 * DOES: inserts a `pages` row (version 1, body sanitized) plus its
 * version-1 `page_versions` snapshot, and appends a PageCreated event,
 * all in one transaction.
 * REJECTS: unknown project; actor below full team member (legacy
 * PagesController grants create to FULL_TEAM_MEMBER — readonly members
 * cannot); a blank name, a name containing "/", or a name over 255
 * chars (legacy `Page.validate_page_name`); a name already taken in the
 * project case-insensitively.
 *
 * @returns the created page row, or field errors
 */
export function createPage(
  db: BetterSQLite3Database,
  input: CreatePageInput,
): CommandResult<PageRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const name = input.name.trim();
  const nameError = pageNameError(name);
  if (nameError) return reject("name", nameError);
  const taken = findPageByIdentifier(db, input.projectId, pageIdentifier(name));
  if (taken) return reject("name", "has already been taken");

  const content = storedContent(input.content);
  return db.transaction((tx) => {
    const row = tx
      .insert(pages)
      .values({
        projectId: input.projectId,
        name,
        content,
        version: 1,
        createdByUserId: input.actorUserId,
        modifiedByUserId: input.actorUserId,
      })
      .returning()
      .get();
    tx.insert(pageVersions)
      .values({
        pageId: row.id,
        projectId: input.projectId,
        version: 1,
        name,
        content,
        createdByUserId: input.actorUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    emitEvent(tx, {
      type: "PageCreated",
      aggregateType: "Page",
      aggregateId: row.id,
      payload: {
        projectId: input.projectId,
        name,
        identifier: pageIdentifier(name),
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<PageRow>;
  });
}

export interface UpdatePageInput {
  projectId: number;
  /** The page's URL identifier (name with underscores for spaces). */
  identifier: string;
  content?: string | null;
  actorUserId: number;
}

/**
 * UpdatePage — replaces a page's body, appending the next version.
 *
 * DOES: updates the `pages` row (body sanitized, version incremented,
 * modified stamps set), inserts the matching `page_versions` snapshot,
 * and appends a PageUpdated event, all in one transaction.
 * REJECTS: unknown project or page; actor below full team member; a
 * body that sanitizes to what is already stored (a version records a
 * change — legacy `Page#changed?` compared the stripped body and saved
 * nothing when it matched; rule 10 makes that refusal explicit).
 *
 * @returns the updated page row, or field errors
 */
export function updatePage(
  db: BetterSQLite3Database,
  input: UpdatePageInput,
): CommandResult<PageRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.FULL_TEAM_MEMBER,
  );
  if (denied) return denied;

  const current = findPageByIdentifier(db, input.projectId, input.identifier);
  if (!current) return reject("page", "does not exist");

  const content = storedContent(input.content);
  if (content === current.content)
    return reject("page", "has no changes to save");

  return db.transaction((tx) => {
    const nextVersion = current.version + 1;
    const row = tx
      .update(pages)
      .set({
        content,
        version: nextVersion,
        modifiedByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, current.id))
      .returning()
      .get();
    tx.insert(pageVersions)
      .values({
        pageId: current.id,
        projectId: input.projectId,
        version: nextVersion,
        name: current.name,
        content,
        createdByUserId: current.createdByUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    emitEvent(tx, {
      type: "PageUpdated",
      aggregateType: "Page",
      aggregateId: current.id,
      payload: {
        projectId: input.projectId,
        name: current.name,
        identifier: pageIdentifier(current.name),
        version: nextVersion,
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: row } as CommandResult<PageRow>;
  });
}

export interface DeletePageInput {
  projectId: number;
  identifier: string;
  actorUserId: number;
}

/**
 * DeletePage — deletes a page, keeping its history.
 *
 * DOES: deletes the `pages` row, keeps every existing `page_versions`
 * row, appends a final deletion version (next version number, name
 * retained, body empty — legacy `create_deletion_page_version` parity —
 * isDeletion flagged, stamped by the deleting user), and appends a
 * PageDeleted event, all in one transaction.
 * REJECTS: unknown project or page, or actor below project
 * administrator (legacy `check_current_user_is_project_admin` — full
 * members cannot delete a page even though they may edit it).
 *
 * @returns the deleted page row as it stood, or field errors
 */
export function deletePage(
  db: BetterSQLite3Database,
  input: DeletePageInput,
): CommandResult<PageRow> {
  if (!projectExists(db, input.projectId))
    return reject("project", "does not exist");
  const denied = authorizeProjectAction(
    db,
    input.actorUserId,
    input.projectId,
    PrivilegeLevel.PROJECT_ADMIN,
  );
  if (denied) return denied;

  const current = findPageByIdentifier(db, input.projectId, input.identifier);
  if (!current) return reject("page", "does not exist");

  return db.transaction((tx) => {
    tx.insert(pageVersions)
      .values({
        pageId: current.id,
        projectId: input.projectId,
        version: current.version + 1,
        name: current.name,
        content: null,
        isDeletion: true,
        createdByUserId: current.createdByUserId,
        modifiedByUserId: input.actorUserId,
      })
      .run();
    tx.delete(pages).where(eq(pages.id, current.id)).run();
    emitEvent(tx, {
      type: "PageDeleted",
      aggregateType: "Page",
      aggregateId: current.id,
      payload: {
        projectId: input.projectId,
        name: current.name,
        identifier: pageIdentifier(current.name),
      },
      actorUserId: input.actorUserId,
    });
    return { ok: true, value: current } as CommandResult<PageRow>;
  });
}
