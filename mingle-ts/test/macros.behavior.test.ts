/**
 * Behavioral tests for the macro framework (Phase 17).
 *
 * Derived from the rule 12 Behavior Statements for
 * `registerMacroElements`, `registerMacro` and `expandMacros`. The
 * registries are module-level state, so each DOES line asserts on what
 * the registry then does — an expansion that finds the macro, a policy
 * that admits the element — rather than on a return value, and the
 * `produced` WeakSet is asserted directly because skipping macro
 * output during linkification depends on it.
 *
 * `registerMacroElements` has no rejection path, so its constraint is
 * tested as the negative it actually is: declaring `svg` for macros
 * must NOT make `<svg>` survive in a body a person typed.
 *
 * These need no database — the framework never queries. The macros
 * that do are covered in macro-cards.behavior.test.ts against real
 * SQLite.
 *
 * Owner context: Wiki & Content verification.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  registerMacroElements,
  renderPageContent,
  sanitizePageContent,
  type ContentNode,
  type PageRenderContext,
} from "../app/domain/pages/content.server";
import {
  expandMacros,
  macroNames,
  parseMacroParams,
  registerMacro,
  MacroError,
  type MacroContext,
  type MacroParams,
} from "../app/domain/pages/macros.server";

const db = {} as BetterSQLite3Database;

const context: Omit<MacroContext, "position"> = {
  projectIdentifier: "wiki_land",
  projectId: 1,
  db,
  currentUserId: null,
};

const renderCtx: PageRenderContext = {
  projectIdentifier: "wiki_land",
  pageExists: () => true,
  cardExists: () => true,
};

/** Serializes a tree the way the render path does, for assertions. */
function html(nodes: ContentNode[]): string {
  const walk = (list: ContentNode[]): string =>
    list
      .map((node) =>
        node.kind === "text"
          ? node.text
          : `<${node.tag}>${walk(node.children)}</${node.tag}>`,
      )
      .join("");
  return walk(nodes);
}

function textOf(nodes: ContentNode[]): string {
  const walk = (list: ContentNode[]): string =>
    list
      .map((node) => (node.kind === "text" ? node.text : walk(node.children)))
      .join("");
  return walk(nodes);
}

beforeEach(() => {
  // Fixtures used across the suite. registerMacro replaces by name, so
  // re-registering each test is the documented idempotence, not setup
  // that leaks between tests.
  registerMacro({
    name: "echo",
    expand: (params) => [
      { kind: "text", text: String(params.say ?? "") },
    ],
  });
  registerMacro({
    name: "boom",
    expand: () => {
      throw new MacroError("this macro refused");
    },
  });
  registerMacro({
    name: "positioned",
    expand: (_params, ctx) => [{ kind: "text", text: `#${ctx.position}` }],
  });
});

describe("registerMacro", () => {
  it("makes a macro findable by the name written in the page", () => {
    expect(macroNames()).toContain("echo");
    const out = expandMacros([{ kind: "text", text: "{{ echo say: hi }}" }], context);
    expect(textOf(out)).toBe("hi");
  });

  it("matches the name case-insensitively", () => {
    const out = expandMacros([{ kind: "text", text: "{{ ECHO say: loud }}" }], context);
    expect(textOf(out)).toBe("loud");
  });

  it("replaces an earlier definition rather than adding a second", () => {
    registerMacro({ name: "echo", expand: () => [{ kind: "text", text: "replaced" }] });
    expect(macroNames().filter((n) => n === "echo")).toHaveLength(1);
    const out = expandMacros([{ kind: "text", text: "{{ echo say: hi }}" }], context);
    expect(textOf(out)).toBe("replaced");
  });
});

describe("expandMacros", () => {
  it("replaces the invocation and keeps the text around it", () => {
    const out = expandMacros(
      [{ kind: "text", text: "before {{ echo say: MID }} after" }],
      context,
    );
    expect(textOf(out)).toBe("before MID after");
  });

  it("adds each output root to the caller's produced set", () => {
    const produced = new WeakSet<ContentNode>();
    const out = expandMacros(
      [{ kind: "text", text: "{{ echo say: x }}" }],
      context,
      produced,
    );
    const roots = out.filter((node) => produced.has(node));
    expect(roots).toHaveLength(1);
    expect(textOf(roots)).toBe("x");
  });

  it("leaves nodes it did not produce out of the produced set", () => {
    const produced = new WeakSet<ContentNode>();
    const out = expandMacros(
      [{ kind: "text", text: "plain {{ echo say: x }}" }],
      context,
      produced,
    );
    const plain = out.find((node) => node.kind === "text" && node.text === "plain ");
    expect(plain).toBeDefined();
    expect(produced.has(plain!)).toBe(false);
  });

  it("numbers macros by position within the body", () => {
    const out = expandMacros(
      [{ kind: "text", text: "{{ positioned }} {{ positioned }} {{ positioned }}" }],
      context,
    );
    expect(textOf(out)).toBe("#0 #1 #2");
  });

  it("expands macros nested inside elements", () => {
    const out = expandMacros(
      [
        {
          kind: "element",
          tag: "p",
          attrs: {},
          children: [{ kind: "text", text: "{{ echo say: deep }}" }],
        },
      ],
      context,
    );
    expect(html(out)).toBe("<p>deep</p>");
  });

  it("does not expand inside code, so a page can document the syntax", () => {
    const out = expandMacros(
      [
        {
          kind: "element",
          tag: "code",
          attrs: {},
          children: [{ kind: "text", text: "{{ echo say: hi }}" }],
        },
      ],
      context,
    );
    expect(textOf(out)).toBe("{{ echo say: hi }}");
  });

  it("does not expand inside pre", () => {
    const out = expandMacros(
      [
        {
          kind: "element",
          tag: "pre",
          attrs: {},
          children: [{ kind: "text", text: "{{ echo say: hi }}" }],
        },
      ],
      context,
    );
    expect(textOf(out)).toBe("{{ echo say: hi }}");
  });

  it("leaves a backslash-escaped invocation as literal text", () => {
    const out = expandMacros(
      [{ kind: "text", text: "see \\{{ echo say: hi }} here" }],
      context,
    );
    expect(textOf(out)).toBe("see \\{{ echo say: hi }} here");
  });

  it("still expands a later macro after an escaped one", () => {
    const out = expandMacros(
      [{ kind: "text", text: "\\{{ echo say: no }} and {{ echo say: yes }}" }],
      context,
    );
    expect(textOf(out)).toBe("\\{{ echo say: no }} and yes");
  });

  it("reports an unknown macro in place instead of rendering nothing", () => {
    const out = expandMacros([{ kind: "text", text: "{{ nosuch }}" }], context);
    expect(textOf(out)).toBe("No such macro: nosuch");
    expect(out[0]).toMatchObject({ kind: "element", tag: "div", attrs: { class: "error macro" } });
  });

  it("reports an empty macro name", () => {
    const out = expandMacros([{ kind: "text", text: "{{ }}" }], context);
    expect(textOf(out)).toBe("No macro name given.");
  });

  it("renders a macro's refusal in place and does not throw", () => {
    const out = expandMacros([{ kind: "text", text: "{{ boom }}" }], context);
    expect(textOf(out)).toBe("this macro refused");
    expect(out[0]).toMatchObject({ attrs: { class: "error macro" } });
  });

  it("adds an error node to the produced set, so it is not linkified", () => {
    const produced = new WeakSet<ContentNode>();
    const out = expandMacros([{ kind: "text", text: "{{ boom }}" }], context, produced);
    expect(produced.has(out[0])).toBe(true);
  });

  it("keeps expanding after one macro refuses", () => {
    const out = expandMacros(
      [{ kind: "text", text: "{{ boom }} then {{ echo say: ok }}" }],
      context,
    );
    expect(textOf(out)).toBe("this macro refused then ok");
  });
});

describe("parseMacroParams", () => {
  it("reads a scalar", () => {
    expect(parseMacroParams("query: SELECT number")).toEqual({ query: "SELECT number" });
  });

  it("keeps colons inside a value, splitting only at the key", () => {
    expect(parseMacroParams("query: SELECT name WHERE x = 'a:b'")).toEqual({
      query: "SELECT name WHERE x = 'a:b'",
    });
  });

  it("lower-cases keys but preserves hyphens", () => {
    expect(parseMacroParams("Chart-Title: Burn")).toEqual({ "chart-title": "Burn" });
  });

  it("strips one layer of matching quotes", () => {
    expect(parseMacroParams(`title: "Quoted"`)).toEqual({ title: "Quoted" });
  });

  it("leaves mismatched quotes alone", () => {
    expect(parseMacroParams(`title: "unbalanced`)).toEqual({ title: `"unbalanced` });
  });

  it("reads several keys across lines", () => {
    expect(parseMacroParams("query: SELECT number\nproject: other")).toEqual({
      query: "SELECT number",
      project: "other",
    });
  });

  it("ignores blank lines and comments", () => {
    expect(parseMacroParams("\n# a comment\nquery: SELECT number\n\n")).toEqual({
      query: "SELECT number",
    });
  });

  it("ignores a line carrying no key", () => {
    expect(parseMacroParams("stray text\nquery: SELECT number")).toEqual({
      query: "SELECT number",
    });
  });

  it("returns an empty block for blank parameters", () => {
    expect(parseMacroParams("   ")).toEqual({});
  });

  it("reads a nested mapping", () => {
    expect(parseMacroParams("series:\n  label: Open\n  data: SELECT number")).toEqual({
      series: { label: "Open", data: "SELECT number" },
    });
  });

  it("reads a sequence of scalars", () => {
    expect(parseMacroParams("levels:\n  - one\n  - two")).toEqual({
      levels: ["one", "two"],
    });
  });

  it("reads a sequence of mappings", () => {
    expect(
      parseMacroParams("series:\n  - label: A\n    data: q1\n  - label: B\n    data: q2"),
    ).toEqual({
      series: [
        { label: "A", data: "q1" },
        { label: "B", data: "q2" },
      ],
    });
  });

  it("treats a key with nothing under it as empty", () => {
    expect(parseMacroParams("query:\nproject: p")).toEqual({ query: "", project: "p" });
  });
});

describe("registerMacroElements", () => {
  it("does not let a declared macro element into an authored body", () => {
    // macros-charts declares svg for macro output. That declaration
    // must not travel to content a team member typed — the whole point
    // of two policies rather than one widened allowlist.
    registerMacroElements({ svg: ["viewBox"] });
    const stored = sanitizePageContent('<p>hi</p><svg viewBox="0 0 1 1"></svg>');
    expect(stored).toBe("<p>hi</p>");
    expect(stored).not.toContain("svg");
  });

  it("still drops an authored svg when a macro on the same page emits one", () => {
    registerMacroElements({ svg: ["viewBox"] });
    registerMacro({
      name: "chartish",
      expand: () => [
        { kind: "element", tag: "svg", attrs: { viewBox: "0 0 2 2" }, children: [] },
      ],
    });
    const out = renderPageContent(
      '<p>{{ chartish }}</p><svg viewBox="0 0 9 9"></svg>',
      renderCtx,
      (nodes, produced) => expandMacros(nodes, context, produced),
    );
    // Exactly one svg survives: the macro's. The authored one was
    // already gone before the widened pass ever ran.
    expect(out.match(/<svg/g) ?? []).toHaveLength(1);
    expect(out).toContain('viewBox="0 0 2 2"');
    expect(out).not.toContain("0 0 9 9");
  });

  it("drops an attribute a macro did not declare on its element", () => {
    registerMacroElements({ svg: ["viewBox"] });
    registerMacro({
      name: "sneaky",
      expand: () => [
        {
          kind: "element",
          tag: "svg",
          attrs: { viewBox: "0 0 1 1", onload: "steal()" },
          children: [],
        },
      ],
    });
    const out = renderPageContent("{{ sneaky }}", renderCtx, (nodes, produced) =>
      expandMacros(nodes, context, produced),
    );
    expect(out).toContain("<svg");
    expect(out).not.toContain("onload");
  });

  it("escapes markup characters a macro emits from its parameters", () => {
    const out = renderPageContent(
      "{{ echo say: a &lt;b&gt; &amp; c }}",
      renderCtx,
      (nodes, produced) => expandMacros(nodes, context, produced),
    );
    // The macro emitted a text node containing "<b>"; serialize must
    // escape it on the way out, so it can never become an element.
    expect(out).toContain("a &lt;b&gt; &amp; c");
    expect(out).not.toContain("<b>");
  });

  it("has already removed authored script before a macro can read it", () => {
    // Worth pinning: the authored clean runs first, so a script in the
    // body is gone before expansion. The invocation is split across the
    // hole it leaves and therefore does not expand either — the macro
    // never sees the payload by any route.
    const out = renderPageContent(
      "{{ echo say: <script>alert(1)</script> }}",
      renderCtx,
      (nodes, produced) => expandMacros(nodes, context, produced),
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toBe("{{ echo say:  }}");
  });
});

describe("renderPageContent with macros", () => {
  it("does not linkify macro output", () => {
    registerMacro({
      name: "linky",
      expand: (): ContentNode[] => [
        { kind: "element", tag: "p", attrs: {}, children: [{ kind: "text", text: "see [[Other]] and #7" }] },
      ],
    });
    const out = renderPageContent("{{ linky }}", renderCtx, (nodes, produced) =>
      expandMacros(nodes, context, produced),
    );
    expect(out).not.toContain("<a");
    expect(out).toContain("[[Other]]");
    expect(out).toContain("#7");
  });

  it("still linkifies authored text on a page that also has a macro", () => {
    const out = renderPageContent(
      "<p>see [[Other]]</p><p>{{ echo say: hi }}</p>",
      renderCtx,
      (nodes, produced) => expandMacros(nodes, context, produced),
    );
    expect(out).toContain("<a");
    expect(out).toContain("hi");
  });

  it("renders without macros when no expander is given", () => {
    const out = renderPageContent("<p>{{ echo say: hi }}</p>", renderCtx);
    expect(out).toContain("{{ echo say: hi }}");
  });
});
