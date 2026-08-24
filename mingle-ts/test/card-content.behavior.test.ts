/**
 * Behavioral tests for the Card Management attachment and checklist
 * commands (Phase 6).
 *
 * Derived line-by-line from the rule 12 Behavior Statements: every DOES
 * asserts on rows reloaded from the database (and, for attachments, on
 * bytes read back from the real filesystem store — the phase exit
 * criterion), and every REJECTS WHEN has its own independent rejection
 * test that also proves nothing mutated.
 *
 * These run against a real, file-backed SQLite database created fresh
 * per suite with the real generated migrations, and a real temp
 * directory as the attachment store (ATTACHMENTS_DIR) — no stubs.
 *
 * Owner context: Card Management verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { projects } from "../app/db/schema/projects";
import { users } from "../app/db/schema/identity";
import { teamMemberships } from "../app/db/schema/membership";
import { cards, cardTypes, cardVersions } from "../app/db/schema/cards";
import {
  attachments,
  cardChecklistItems,
} from "../app/db/schema/card-content";
import { domainEvents } from "../app/db/schema/events";
import { registerUser } from "../app/domain/identity/commands.server";
import { addTeamMember } from "../app/domain/identity/membership.server";
import { createProject } from "../app/domain/projects/commands.server";
import { createCard, deleteCard } from "../app/domain/cards/commands.server";
import {
  addCardAttachment,
  removeCardAttachment,
} from "../app/domain/cards/attachments.server";
import {
  addChecklistItem,
  markChecklistItem,
  removeChecklistItem,
} from "../app/domain/cards/checklist.server";
import {
  deleteAttachmentFile,
  readAttachmentFile,
  sanitizeFileName,
  saveAttachmentFile,
} from "../app/files/attachment-storage.server";
import type { CommandResult } from "../app/domain/command.server";

const dir = mkdtempSync(join(tmpdir(), "mingle-card-content-"));
process.env.ATTACHMENTS_DIR = join(dir, "attachments");
const sqlite = new Database(join(dir, "test.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
const db: BetterSQLite3Database = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

let adminId: number; //    site admin (first registered user)
let memberId: number; //   full_member of the project
let readonlyId: number; // readonly_member of the project
let projectId: number;
let cardNumber: number;
let cardId: number;

function register(login: string): number {
  const result = registerUser(db, {
    login,
    name: login,
    password: "card-wall-2010!",
  });
  if (!result.ok) throw new Error(`test registration failed for ${login}`);
  return result.value.id;
}

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

beforeEach(() => {
  db.delete(domainEvents).run();
  db.delete(attachments).run();
  db.delete(cardChecklistItems).run();
  db.delete(cardVersions).run();
  db.delete(cards).run();
  db.delete(cardTypes).run();
  db.delete(teamMemberships).run();
  db.delete(projects).run();
  db.delete(users).run();
  adminId = register("boss");
  memberId = register("dev");
  readonlyId = register("viewer");
  projectId = mustOk(
    createProject(db, { name: "Card Wall", identifier: "card_wall", actorUserId: adminId }),
    "test project creation",
  ).id;
  const typeId = db
    .select({ id: cardTypes.id })
    .from(cardTypes)
    .where(eq(cardTypes.projectId, projectId))
    .get()!.id;
  for (const [userId, role] of [
    [memberId, "full_member"],
    [readonlyId, "readonly_member"],
  ] as const) {
    mustOk(
      addTeamMember(db, { projectId, userId, role, actorUserId: adminId }),
      `membership setup for ${userId}`,
    );
  }
  const card = mustOk(
    createCard(db, {
      projectId,
      name: "Story One",
      cardTypeId: typeId,
      actorUserId: memberId,
    }),
    "test card creation",
  );
  cardNumber = card.number;
  cardId = card.id;
  db.delete(domainEvents).run(); // only events under test matter below
});

function attachmentsOf(ofCardId = cardId) {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.cardId, ofCardId))
    .all();
}

function checklistOf(ofCardId = cardId) {
  return db
    .select()
    .from(cardChecklistItems)
    .where(eq(cardChecklistItems.cardId, ofCardId))
    .all();
}

function eventsOfType(type: string) {
  return db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.type, type))
    .all();
}

function allEvents() {
  return db.select().from(domainEvents).all();
}

function expectRejected<T>(
  result: CommandResult<T>,
  field: string,
  message: string,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.errors[field]).toContain(message);
  expect(allEvents()).toHaveLength(0); // a rejected command emits nothing
}

/** Saves real bytes and runs AddCardAttachment, as the route does. */
function attach(
  fileName: string,
  content = "hello mingle",
  actor = memberId,
  suffix = "abc123",
) {
  const fileKey = saveAttachmentFile(
    new TextEncoder().encode(content),
    sanitizeFileName(fileName),
  );
  return addCardAttachment(db, {
    projectId,
    cardNumber,
    fileName: sanitizeFileName(fileName),
    fileKey,
    contentType: "text/plain",
    size: content.length,
    uniqueSuffix: suffix,
    actorUserId: actor,
  });
}

const NEEDS_FULL_MEMBER = "requires Team member access to this project";

describe("addCardAttachment (AddCardAttachment → CardAttachmentAdded)", () => {
  it("persists the row and the bytes are retrievable by the stored key (exit criterion)", () => {
    const result = attach("notes.txt", "hello mingle");
    expect(result.ok).toBe(true);
    const rows = attachmentsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileName: "notes.txt",
      contentType: "text/plain",
      size: 12,
      cardVersion: 1,
      uploadedByUserId: memberId,
    });
    // real-path retrieval: read the bytes back from the filesystem store
    const bytes = readAttachmentFile(rows[0].fileKey);
    expect(bytes).not.toBeNull();
    expect(bytes!.toString("utf8")).toBe("hello mingle");
    const events = eventsOfType("CardAttachmentAdded");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: cardNumber,
      fileName: "notes.txt",
      size: 12,
    });
  });

  it("suffixes a display name already taken in the project", () => {
    mustOk(attach("notes.txt"), "first attach");
    db.delete(domainEvents).run();
    const result = attach("notes.txt", "second file", memberId, "d3f456");
    expect(result.ok).toBe(true);
    const names = attachmentsOf().map((a) => a.fileName).sort();
    expect(names).toEqual(["notes-d3f456.txt", "notes.txt"]);
  });

  it("treats .tar.gz as one extension when suffixing", () => {
    mustOk(attach("backup.tar.gz"), "first attach");
    db.delete(domainEvents).run();
    const result = attach("backup.tar.gz", "again", memberId, "9e8d7c");
    expect(result.ok).toBe(true);
    expect(attachmentsOf().map((a) => a.fileName).sort()).toEqual([
      "backup-9e8d7c.tar.gz",
      "backup.tar.gz",
    ]);
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      addCardAttachment(db, {
        projectId: 999,
        cardNumber,
        fileName: "x.txt",
        fileKey: "aa/x.txt",
        contentType: "text/plain",
        size: 1,
        uniqueSuffix: "abc123",
        actorUserId: memberId,
      }),
      "project",
      "does not exist",
    );
  });

  it("rejects when the card does not exist", () => {
    expectRejected(
      addCardAttachment(db, {
        projectId,
        cardNumber: 42,
        fileName: "x.txt",
        fileKey: "ab/x.txt",
        contentType: "text/plain",
        size: 1,
        uniqueSuffix: "abc123",
        actorUserId: memberId,
      }),
      "card",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor, writing no row", () => {
    expectRejected(attach("x.txt", "content", readonlyId), "authorization", NEEDS_FULL_MEMBER);
    expect(attachmentsOf()).toHaveLength(0);
  });

  it("rejects a blank file name", () => {
    expectRejected(
      addCardAttachment(db, {
        projectId,
        cardNumber,
        fileName: "  ",
        fileKey: "ac/blank",
        contentType: "text/plain",
        size: 1,
        uniqueSuffix: "abc123",
        actorUserId: memberId,
      }),
      "file",
      "can't be blank",
    );
  });
});

describe("removeCardAttachment (RemoveCardAttachment → CardAttachmentRemoved)", () => {
  it("deletes the row and events it, returning the fileKey for byte cleanup", () => {
    const added = mustOk(attach("notes.txt"), "attach setup");
    db.delete(domainEvents).run();
    const result = removeCardAttachment(db, {
      projectId,
      cardNumber,
      attachmentId: added.id,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fileKey).toBe(added.fileKey);
    expect(attachmentsOf()).toHaveLength(0);
    const events = eventsOfType("CardAttachmentRemoved");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId,
      number: cardNumber,
      fileName: "notes.txt",
    });
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      removeCardAttachment(db, {
        projectId: 999,
        cardNumber,
        attachmentId: 1,
        actorUserId: memberId,
      }),
      "project",
      "does not exist",
    );
  });

  it("rejects when the card does not exist", () => {
    expectRejected(
      removeCardAttachment(db, {
        projectId,
        cardNumber: 42,
        attachmentId: 1,
        actorUserId: memberId,
      }),
      "card",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor, leaving the row", () => {
    const added = mustOk(attach("notes.txt"), "attach setup");
    db.delete(domainEvents).run();
    expectRejected(
      removeCardAttachment(db, {
        projectId,
        cardNumber,
        attachmentId: added.id,
        actorUserId: readonlyId,
      }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
    expect(attachmentsOf()).toHaveLength(1);
  });

  it("rejects an attachment that does not belong to the card", () => {
    expectRejected(
      removeCardAttachment(db, {
        projectId,
        cardNumber,
        attachmentId: 999,
        actorUserId: memberId,
      }),
      "attachment",
      "does not exist",
    );
  });
});

describe("addChecklistItem (AddChecklistItem → ChecklistItemAdded)", () => {
  it("persists the item at the end of the incomplete list (exit criterion: queryable row)", () => {
    mustOk(
      addChecklistItem(db, { projectId, cardNumber, text: "write tests", actorUserId: memberId }),
      "first item",
    );
    const result = addChecklistItem(db, {
      projectId,
      cardNumber,
      text: "ship it",
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);
    const items = checklistOf();
    expect(items).toHaveLength(2);
    expect(items.map((i) => [i.text, i.completed, i.position])).toEqual([
      ["write tests", false, 0],
      ["ship it", false, 1],
    ]);
    expect(eventsOfType("ChecklistItemAdded")).toHaveLength(2);
  });

  it("rejects when the project does not exist", () => {
    expectRejected(
      addChecklistItem(db, { projectId: 999, cardNumber, text: "x", actorUserId: memberId }),
      "project",
      "does not exist",
    );
  });

  it("rejects when the card does not exist", () => {
    expectRejected(
      addChecklistItem(db, { projectId, cardNumber: 42, text: "x", actorUserId: memberId }),
      "card",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor", () => {
    expectRejected(
      addChecklistItem(db, { projectId, cardNumber, text: "x", actorUserId: readonlyId }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
    expect(checklistOf()).toHaveLength(0);
  });

  it("rejects blank text", () => {
    expectRejected(
      addChecklistItem(db, { projectId, cardNumber, text: "   ", actorUserId: memberId }),
      "text",
      "can't be blank",
    );
  });

  it("rejects text over 255 characters", () => {
    expectRejected(
      addChecklistItem(db, {
        projectId,
        cardNumber,
        text: "x".repeat(256),
        actorUserId: memberId,
      }),
      "text",
      "is too long (maximum is 255 characters)",
    );
  });
});

describe("markChecklistItem (MarkChecklistItem → ChecklistItemCompleted/Reopened)", () => {
  function seedItems(): number[] {
    const ids = ["one", "two", "three"].map(
      (text) =>
        mustOk(
          addChecklistItem(db, { projectId, cardNumber, text, actorUserId: memberId }),
          `seed ${text}`,
        ).id,
    );
    db.delete(domainEvents).run();
    return ids;
  }

  it("completes an item, moving it to the end of the completed list", () => {
    const [first, second] = seedItems();
    mustOk(
      markChecklistItem(db, { projectId, cardNumber, itemId: first, completed: true, actorUserId: memberId }),
      "complete first",
    );
    const result = markChecklistItem(db, {
      projectId,
      cardNumber,
      itemId: second,
      completed: true,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);
    const rows = checklistOf();
    const completedRows = rows.filter((i) => i.completed);
    expect(completedRows.map((i) => [i.text, i.position])).toEqual([
      ["one", 0],
      ["two", 1],
    ]);
    expect(eventsOfType("ChecklistItemCompleted")).toHaveLength(2);
  });

  it("reopens an item, moving it to the end of the incomplete list", () => {
    const [first] = seedItems();
    mustOk(
      markChecklistItem(db, { projectId, cardNumber, itemId: first, completed: true, actorUserId: memberId }),
      "complete first",
    );
    db.delete(domainEvents).run();
    const result = markChecklistItem(db, {
      projectId,
      cardNumber,
      itemId: first,
      completed: false,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);
    const reopened = checklistOf().find((i) => i.id === first)!;
    expect(reopened.completed).toBe(false);
    expect(reopened.position).toBe(2); // after "two" (0) and "three" (1)
    expect(eventsOfType("ChecklistItemReopened")).toHaveLength(1);
  });

  it("rejects completing an already-completed item", () => {
    const [first] = seedItems();
    mustOk(
      markChecklistItem(db, { projectId, cardNumber, itemId: first, completed: true, actorUserId: memberId }),
      "complete first",
    );
    db.delete(domainEvents).run();
    expectRejected(
      markChecklistItem(db, { projectId, cardNumber, itemId: first, completed: true, actorUserId: memberId }),
      "item",
      "is already completed",
    );
  });

  it("rejects reopening an incomplete item", () => {
    const [first] = seedItems();
    expectRejected(
      markChecklistItem(db, { projectId, cardNumber, itemId: first, completed: false, actorUserId: memberId }),
      "item",
      "is not completed",
    );
  });

  it("rejects an unknown item", () => {
    expectRejected(
      markChecklistItem(db, { projectId, cardNumber, itemId: 999, completed: true, actorUserId: memberId }),
      "item",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor, leaving the item unchanged", () => {
    const [first] = seedItems();
    expectRejected(
      markChecklistItem(db, { projectId, cardNumber, itemId: first, completed: true, actorUserId: readonlyId }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
    expect(checklistOf().find((i) => i.id === first)!.completed).toBe(false);
  });
});

describe("removeChecklistItem (RemoveChecklistItem → ChecklistItemRemoved)", () => {
  it("deletes the row and events it", () => {
    const added = mustOk(
      addChecklistItem(db, { projectId, cardNumber, text: "temp", actorUserId: memberId }),
      "item setup",
    );
    db.delete(domainEvents).run();
    const result = removeChecklistItem(db, {
      projectId,
      cardNumber,
      itemId: added.id,
      actorUserId: memberId,
    });
    expect(result.ok).toBe(true);
    expect(checklistOf()).toHaveLength(0);
    expect(eventsOfType("ChecklistItemRemoved")).toHaveLength(1);
  });

  it("rejects an unknown item", () => {
    expectRejected(
      removeChecklistItem(db, { projectId, cardNumber, itemId: 999, actorUserId: memberId }),
      "item",
      "does not exist",
    );
  });

  it("rejects a readonly member as actor, leaving the row", () => {
    const added = mustOk(
      addChecklistItem(db, { projectId, cardNumber, text: "temp", actorUserId: memberId }),
      "item setup",
    );
    db.delete(domainEvents).run();
    expectRejected(
      removeChecklistItem(db, { projectId, cardNumber, itemId: added.id, actorUserId: readonlyId }),
      "authorization",
      NEEDS_FULL_MEMBER,
    );
    expect(checklistOf()).toHaveLength(1);
  });
});

describe("deleteAttachmentFile (storage adapter)", () => {
  it("removes the stored bytes so the key no longer resolves", () => {
    const fileKey = saveAttachmentFile(
      new TextEncoder().encode("ephemeral"),
      "temp.txt",
    );
    expect(readAttachmentFile(fileKey)).not.toBeNull();
    deleteAttachmentFile(fileKey);
    expect(readAttachmentFile(fileKey)).toBeNull();
  });

  it("is a no-op on a key that was never stored or is already deleted", () => {
    const fileKey = saveAttachmentFile(
      new TextEncoder().encode("once"),
      "once.txt",
    );
    deleteAttachmentFile(fileKey);
    expect(() => deleteAttachmentFile(fileKey)).not.toThrow(); // idempotent
    expect(() => deleteAttachmentFile("never/existed.txt")).not.toThrow();
    expect(readAttachmentFile(fileKey)).toBeNull();
  });

  it("deletes only its own attachment's directory, not its siblings", () => {
    const doomed = saveAttachmentFile(new TextEncoder().encode("bye"), "a.txt");
    const kept = saveAttachmentFile(new TextEncoder().encode("stay"), "b.txt");
    deleteAttachmentFile(doomed);
    expect(readAttachmentFile(doomed)).toBeNull();
    expect(readAttachmentFile(kept)!.toString("utf8")).toBe("stay");
  });
});

describe("deleteCard cleanup (Phase 6 extension)", () => {
  it("deletes the card's checklist items and attachment rows with the card", () => {
    mustOk(attach("notes.txt"), "attach setup");
    mustOk(
      addChecklistItem(db, { projectId, cardNumber, text: "todo", actorUserId: memberId }),
      "item setup",
    );
    db.delete(domainEvents).run();
    mustOk(
      deleteCard(db, { projectId, cardNumber, actorUserId: adminId }),
      "delete card",
    );
    expect(attachmentsOf()).toHaveLength(0);
    expect(checklistOf()).toHaveLength(0);
    // versions survive (Phase 5 invariant untouched)
    expect(
      db.select().from(cardVersions).where(eq(cardVersions.cardId, cardId)).all()
        .length,
    ).toBeGreaterThan(0);
  });
});
