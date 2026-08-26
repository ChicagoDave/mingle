/**
 * Wiki page body editor — the rich authoring surface for a page
 * (Phase 16).
 *
 * Purpose: renders the page body field for the new and edit forms as a
 * TipTap rich-text editor. The field that actually posts is a plain
 * `<textarea name={name}>` holding the document's HTML: the editor
 * writes into it on every change, and with scripting unavailable the
 * textarea is simply left visible and edited as source, so a page can
 * still be written and saved without JavaScript.
 *
 * The editor is NOT a trust boundary. Whatever it posts is sanitized
 * server-side on the way in (app/domain/pages/content.server.ts) —
 * never treat markup as safe because this component produced it.
 *
 * Wiki links (`[[Page Name]]`) and card links (`#123`) are authored as
 * literal text rather than as editor nodes, matching how they are
 * stored and how the renderer resolves them at display time; the
 * toolbar's two link buttons insert that text.
 *
 * Public interface: `PageEditor`.
 *
 * Owner context: Wiki & Content (presentation).
 */
import { useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import "../styles/page-editor.css";

/** One toolbar control: what it shows, what it toggles, when it is on. */
interface Control {
  label: string;
  title: string;
  run: (editor: Editor) => void;
  isActive?: (editor: Editor) => boolean;
}

const CONTROLS: Control[] = [
  {
    label: "B",
    title: "Bold",
    run: (editor) => editor.chain().focus().toggleBold().run(),
    isActive: (editor) => editor.isActive("bold"),
  },
  {
    label: "I",
    title: "Italic",
    run: (editor) => editor.chain().focus().toggleItalic().run(),
    isActive: (editor) => editor.isActive("italic"),
  },
  {
    label: "S",
    title: "Strikethrough",
    run: (editor) => editor.chain().focus().toggleStrike().run(),
    isActive: (editor) => editor.isActive("strike"),
  },
  {
    label: "H2",
    title: "Heading",
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (editor) => editor.isActive("heading", { level: 2 }),
  },
  {
    label: "H3",
    title: "Sub-heading",
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (editor) => editor.isActive("heading", { level: 3 }),
  },
  {
    label: "•",
    title: "Bullet list",
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
    isActive: (editor) => editor.isActive("bulletList"),
  },
  {
    label: "1.",
    title: "Numbered list",
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
    isActive: (editor) => editor.isActive("orderedList"),
  },
  {
    label: "❝",
    title: "Quote",
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
    isActive: (editor) => editor.isActive("blockquote"),
  },
  {
    label: "</>",
    title: "Code",
    run: (editor) => editor.chain().focus().toggleCode().run(),
    isActive: (editor) => editor.isActive("code"),
  },
  {
    label: "▤",
    title: "Code block",
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    isActive: (editor) => editor.isActive("codeBlock"),
  },
  {
    label: "—",
    title: "Horizontal rule",
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    label: "[[ ]]",
    title: "Link to another page",
    run: (editor) => editor.chain().focus().insertContent("[[Page Name]]").run(),
  },
  {
    label: "#",
    title: "Link to a card",
    run: (editor) => editor.chain().focus().insertContent("#123").run(),
  },
  {
    label: "↶",
    title: "Undo",
    run: (editor) => editor.chain().focus().undo().run(),
  },
  {
    label: "↷",
    title: "Redo",
    run: (editor) => editor.chain().focus().redo().run(),
  },
];

/**
 * The page body field: a TipTap editor over the textarea that posts.
 *
 * @param name - the form field name the body posts under
 * @param defaultValue - the stored body, or null for a new page
 * @param id - element id for the textarea, for label association
 */
export function PageEditor({
  name = "content",
  defaultValue,
  id = "page-content-field",
}: {
  name?: string;
  defaultValue?: string | null;
  id?: string;
}) {
  const initial = defaultValue ?? "";
  const [html, setHtml] = useState(initial);

  const editor = useEditor({
    extensions: [StarterKit],
    content: initial,
    // The server renders this component too; deferring the first render
    // to the client is what keeps SSR output and hydration in step.
    immediatelyRender: false,
    onUpdate: ({ editor }) => setHtml(editor.getHTML()),
  });

  // Until the editor exists — no scripting, or the client bundle still
  // loading — the textarea IS the editor, so it stays visible.
  const enhanced = editor !== null;

  return (
    <div className="page-editor">
      {enhanced && (
        <div className="page-editor-toolbar" role="toolbar" aria-label="Formatting">
          {CONTROLS.map((control) => (
            <button
              key={control.title}
              type="button"
              title={control.title}
              aria-label={control.title}
              aria-pressed={control.isActive ? control.isActive(editor) : undefined}
              onClick={() => control.run(editor)}
            >
              {control.label}
            </button>
          ))}
        </div>
      )}

      {enhanced && <EditorContent editor={editor} />}

      <textarea
        id={id}
        name={name}
        value={html}
        onChange={(event) => setHtml(event.target.value)}
        rows={20}
        spellCheck
        aria-label="Page content"
        // Hidden rather than removed: it is the field that posts, and
        // it is the whole editor when scripting is unavailable.
        style={
          enhanced
            ? { display: "none" }
            : { width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 14 }
        }
      />

      <p className="page-editor-help" style={{ color: "#666", fontSize: 13 }}>
        Link to another page with <code>[[Page Name]]</code> (or{" "}
        <code>[[shown text|Page Name]]</code>), and to a card with{" "}
        <code>#123</code>. Unsupported markup is removed when the page is saved.
      </p>
    </div>
  );
}
