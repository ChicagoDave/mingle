// @vitest-environment jsdom
/**
 * Behavioral tests for the wiki page editor component (Phase 16).
 *
 * The editor's contract with the rest of the system is narrow and easy
 * to break silently: whatever the author does in the rich surface must
 * end up in the `<textarea>` that actually posts, because that textarea
 * is the only thing the server ever sees. These tests drive the real
 * TipTap editor in a DOM and assert on that textarea's value — not on
 * the editor's internal state, and not on a mock of it.
 *
 * Owner context: Wiki & Content verification.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PageEditor } from "../app/components/page-editor";

beforeAll(() => {
  // jsdom implements no layout, so the Range geometry ProseMirror asks
  // for when scrolling a selection into view does not exist. Empty
  // rects satisfy it; nothing under test depends on real coordinates.
  const emptyRect = {
    x: 0, y: 0, width: 0, height: 0,
    top: 0, left: 0, right: 0, bottom: 0,
    toJSON() {},
  } as DOMRect;
  // Same reason: a click asks the document what is at a coordinate.
  document.elementFromPoint = () => null;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => emptyRect;
});

afterEach(cleanup);

/** The field that posts — the editor's only output that matters. */
function postedField(): HTMLTextAreaElement {
  return screen.getByLabelText("Page content") as HTMLTextAreaElement;
}

/** Waits for TipTap to take over from the plain textarea. */
async function editorSurface(): Promise<HTMLElement> {
  return waitFor(() => {
    const surface = document.querySelector(".tiptap");
    if (!surface) throw new Error("editor has not mounted");
    return surface as HTMLElement;
  });
}

describe("PageEditor", () => {
  it("posts the stored body under the content field before anything is typed", () => {
    render(<PageEditor defaultValue="<p>Ship in June.</p>" />);
    const field = postedField();
    expect(field.name).toBe("content");
    expect(field.value).toBe("<p>Ship in June.</p>");
  });

  it("mounts the rich editor showing the stored body", async () => {
    render(<PageEditor defaultValue="<p>Ship in June.</p>" />);
    const surface = await editorSurface();
    expect(surface.textContent).toContain("Ship in June.");
    expect(surface.getAttribute("contenteditable")).toBe("true");
  });

  it("hides the textarea once the rich editor has taken over", async () => {
    render(<PageEditor defaultValue="<p>Ship in June.</p>" />);
    await editorSurface();
    await waitFor(() => expect(postedField().style.display).toBe("none"));
  });

  it("writes what the author types into the field that posts", async () => {
    render(<PageEditor defaultValue="<p>June</p>" />);
    const surface = await editorSurface();
    await userEvent.click(surface);
    await userEvent.type(surface, " and July");
    await waitFor(() => expect(postedField().value).toContain("June and July"));
  });

  it("writes a toolbar formatting change into the field that posts", async () => {
    render(<PageEditor defaultValue="<p>an item</p>" />);
    await editorSurface();
    expect(postedField().value).not.toContain("<ul>");

    await userEvent.click(screen.getByTitle("Bullet list"));
    await waitFor(() => {
      const value = postedField().value;
      expect(value).toContain("<ul>");
      expect(value).toContain("an item");
    });
  });

  it("inserts a wiki link as the literal text the renderer resolves", async () => {
    render(<PageEditor defaultValue="<p>see </p>" />);
    await editorSurface();
    await userEvent.click(screen.getByTitle("Link to another page"));
    await waitFor(() => expect(postedField().value).toContain("[[Page Name]]"));
  });

  it("starts empty for a new page and still exposes the posting field", async () => {
    render(<PageEditor defaultValue={null} />);
    await editorSurface();
    expect(postedField().name).toBe("content");
  });
});
