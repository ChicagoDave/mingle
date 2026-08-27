/**
 * Wiki & Content — page body sanitization and link substitution.
 *
 * Purpose: page bodies are authored as HTML by the rich editor, so
 * they can never be trusted to the browser as written. This module
 * parses a body into a small node tree, rebuilds it from an allowlist
 * of elements, attributes and URL schemes, and serializes it back —
 * output is *generated*, never passed through, so anything the parser
 * does not recognize cannot survive into the page. On top of that it
 * ports the two legacy renderable substitutions a wiki page needs:
 * `[[Page Name]]` cross-page links (Renderable::WikiLinkSubstitution,
 * including the `[[display|Page]]` and `[[project/Page]]` forms) and
 * `#123` page-to-card links (Renderable::CardLinkSubstitution).
 *
 * Substitution runs over the parsed tree's TEXT nodes only, which is
 * how the legacy guards are honoured structurally rather than by
 * lookbehind: text inside an existing `<a>`, or inside `<code>` /
 * `<pre>`, is never linkified, because the walk skips those subtrees.
 *
 * Deliberate deviations from legacy, both narrowing: entity-escaped
 * markup (`&#35;123`) decodes to text and therefore linkifies, where
 * legacy used escaping as an opt-out — `<code>` is the supported
 * opt-out here; and an invalid `[[…]]` target renders an inert
 * error span instead of a link to a `show_page_name_error` action
 * that does not exist in this rewrite.
 *
 * Public interface: `sanitizePageContent` (write path),
 * `renderPageContent` (display path), `PageRenderContext`.
 *
 * Owner context: Wiki & Content. Pure functions — existence lookups
 * arrive as caller-supplied predicates, so this module never touches
 * the database and is testable without one.
 */
import {
  pageIdentifier,
  pageNameError,
  pageNameFromIdentifier,
} from "~/domain/pages/naming.server";

/** A parsed body node: either literal text or an element with children. */
export type ContentNode =
  | { kind: "text"; text: string }
  | {
      kind: "element";
      tag: string;
      attrs: Record<string, string>;
      children: ContentNode[];
    };

/**
 * Elements a page body may contain. Anything outside this set is
 * dropped; its children are kept unless the tag is in DROP_SUBTREE.
 */
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark",
  "sub", "sup",
  "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
]);

/** Elements dropped together with everything inside them. */
const DROP_SUBTREE = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template",
  "link", "meta", "base", "head", "title",
  "form", "input", "button", "select", "textarea", "option",
  "svg", "math",
]);

/** Elements whose contents are raw text, not markup, in the HTML spec. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** Elements that never have children or a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "img"]);

/** Attributes permitted on any allowed element. */
const GLOBAL_ATTRS = new Set(["class", "title"]);

/** Attributes permitted per element, on top of GLOBAL_ATTRS. */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  ol: new Set(["start"]),
};

/** Attributes carrying a URL, checked against SAFE_URL below. */
const URL_ATTRS = new Set(["href", "src"]);

/** Subtrees whose text is never linkified (legacy escape behaviour). */
const NO_SUBSTITUTION_TAGS = new Set(["a", "code", "pre"]);

// ------------------------------------------------- macro element policy

/**
 * The element rules one `clean` pass enforces. Authored bodies use
 * AUTHORED_POLICY; macro output uses a widened one (see
 * `registerMacroElements`), so a chart macro can emit `<svg>` without
 * `<svg>` becoming legal in something a team member typed.
 */
interface ElementPolicy {
  allowed: Set<string>;
  dropSubtree: Set<string>;
  tagAttrs: Record<string, Set<string>>;
}

/** What an authored page body may contain. */
const AUTHORED_POLICY: ElementPolicy = {
  allowed: ALLOWED_TAGS,
  dropSubtree: DROP_SUBTREE,
  tagAttrs: TAG_ATTRS,
};

/** Elements macros have declared, tag -> attributes beyond GLOBAL_ATTRS. */
const MACRO_ELEMENTS = new Map<string, Set<string>>();

/** Rebuilt whenever MACRO_ELEMENTS changes; null means "recompute". */
let macroPolicy: ElementPolicy | null = null;

/**
 * Declares the elements and attributes a macro may emit.
 *
 * ADR-0011 Decision 7 requires macro output to be nodes inside the
 * tree, and its consequences require those nodes to be *registered*
 * rather than smuggled past the allowlist by editing it in place. This
 * is that extension point: a macro module declares its tags once, at
 * import time, and macro output is then cleaned against the authored
 * allowlist widened by exactly those declarations — never trusted
 * wholesale. A declared tag also leaves DROP_SUBTREE for macro output
 * only, which is how `<svg>` becomes emittable by a chart macro while
 * staying dropped from anything a person typed.
 *
 * @param spec - tag name -> attribute names permitted on that tag
 * @returns nothing; the declaration is process-wide and additive
 */
export function registerMacroElements(spec: Record<string, string[]>): void {
  for (const [tag, attrs] of Object.entries(spec)) {
    const existing = MACRO_ELEMENTS.get(tag) ?? new Set<string>();
    for (const attr of attrs) existing.add(attr);
    MACRO_ELEMENTS.set(tag, existing);
  }
  macroPolicy = null;
}

/** The authored policy widened by every registered macro element. */
function currentMacroPolicy(): ElementPolicy {
  if (macroPolicy) return macroPolicy;
  const allowed = new Set(ALLOWED_TAGS);
  const dropSubtree = new Set(DROP_SUBTREE);
  const tagAttrs: Record<string, Set<string>> = { ...TAG_ATTRS };
  for (const [tag, attrs] of MACRO_ELEMENTS) {
    allowed.add(tag);
    dropSubtree.delete(tag);
    tagAttrs[tag] = new Set([...(TAG_ATTRS[tag] ?? []), ...attrs]);
  }
  macroPolicy = { allowed, dropSubtree, tagAttrs };
  return macroPolicy;
}

/**
 * Accepts only http, https and mailto absolute URLs plus same-document
 * and site-relative references. Everything else — `javascript:`,
 * `data:`, protocol-relative `//host` — is rejected, so a link can
 * never become a script vector.
 */
function safeUrl(value: string): boolean {
  const url = value.trim();
  if (url === "") return false;
  if (url.startsWith("//")) return false;
  if (url.startsWith("/") || url.startsWith("#") || url.startsWith("?"))
    return true;
  return /^(https?:|mailto:)/i.test(url);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Decodes the entity forms a body can carry into plain text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Escapes text for emission into HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Reads a tag's attributes from the raw text between name and ">". */
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Parses a body fragment into a node tree, dropping comments and
 * doctypes. Unclosed elements are closed at the end of input and a
 * stray closing tag with no open counterpart is ignored, so malformed
 * input degrades to a well-formed tree rather than an exception.
 */
function parseFragment(html: string): ContentNode[] {
  const root: ContentNode = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: Extract<ContentNode, { kind: "element" }>[] = [root as Extract<ContentNode, { kind: "element" }>];
  const top = () => stack[stack.length - 1];
  const pushText = (text: string) => {
    if (text === "") return;
    top().children.push({ kind: "text", text: decodeEntities(text) });
  };

  let i = 0;
  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next === -1) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, next));
    i = next;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html.startsWith("</", i);
    const nameStart = i + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameStart));
    if (!nameMatch) {
      // A bare "<" that starts no tag is literal text.
      pushText("<");
      i += 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    const gt = html.indexOf(">", nameStart + nameMatch[0].length);
    if (gt === -1) {
      pushText(html.slice(i));
      break;
    }
    const rawAttrs = html.slice(nameStart + nameMatch[0].length, gt);
    i = gt + 1;

    if (closing) {
      let openAt = -1;
      for (let level = stack.length - 1; level > 0; level--) {
        if (stack[level].tag === tag) {
          openAt = level;
          break;
        }
      }
      if (openAt > 0) stack.length = openAt;
      continue;
    }

    if (RAW_TEXT_TAGS.has(tag)) {
      // Raw-text elements are skipped whole: their contents are not
      // markup, so parsing them as markup would be wrong (and unsafe).
      const closeAt = html.toLowerCase().indexOf(`</${tag}`, i);
      i = closeAt === -1 ? html.length : html.indexOf(">", closeAt) + 1 || html.length;
      continue;
    }

    const element: Extract<ContentNode, { kind: "element" }> = {
      kind: "element",
      tag,
      attrs: parseAttributes(rawAttrs),
      children: [],
    };
    top().children.push(element);
    if (!VOID_TAGS.has(tag) && !rawAttrs.trimEnd().endsWith("/")) {
      stack.push(element);
    }
  }

  return (root as Extract<ContentNode, { kind: "element" }>).children;
}

/**
 * Rebuilds a parsed tree from the allowlist: a disallowed element is
 * replaced by its (cleaned) children, a DROP_SUBTREE element is
 * removed entirely, and every surviving attribute is one this tag
 * permits — with URL attributes additionally scheme-checked.
 */
function clean(
  nodes: ContentNode[],
  policy: ElementPolicy = AUTHORED_POLICY,
): ContentNode[] {
  const out: ContentNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      out.push(node);
      continue;
    }
    if (policy.dropSubtree.has(node.tag)) continue;
    const children = clean(node.children, policy);
    if (!policy.allowed.has(node.tag)) {
      out.push(...children);
      continue;
    }
    const permitted = policy.tagAttrs[node.tag];
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!GLOBAL_ATTRS.has(name) && !permitted?.has(name)) continue;
      if (URL_ATTRS.has(name) && !safeUrl(value)) continue;
      attrs[name] = value;
    }
    out.push({ kind: "element", tag: node.tag, attrs, children });
  }
  return out;
}

/** Serializes a cleaned tree back to HTML, escaping every text node. */
function serialize(nodes: ContentNode[]): string {
  let html = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      html += escapeHtml(node.text);
      continue;
    }
    const attrs = Object.entries(node.attrs)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join("");
    if (VOID_TAGS.has(node.tag)) {
      html += `<${node.tag}${attrs} />`;
      continue;
    }
    html += `<${node.tag}${attrs}>${serialize(node.children)}</${node.tag}>`;
  }
  return html;
}

/**
 * Sanitizes an authored page body to the storage form.
 *
 * @param html - the body as submitted by the editor
 * @returns HTML containing only allowlisted elements and attributes
 */
export function sanitizePageContent(html: string): string {
  return serialize(clean(parseFragment(html)));
}

/**
 * True when a body carries nothing a reader would see. A rich editor
 * serializes an empty document as `<p></p>` and a cleared one as
 * `<p><br></p>`, so "empty" cannot be tested by string comparison —
 * this walks the parsed body for visible content instead, counting
 * text that is not whitespace and the elements that are visible while
 * childless.
 *
 * @param html - a body, sanitized or not
 */
export function isBlankContent(html: string | null | undefined): boolean {
  if (!html) return true;
  const VISIBLE_WHEN_EMPTY = new Set(["img", "hr", "table"]);
  const visible = (nodes: ContentNode[]): boolean =>
    nodes.some((node) =>
      node.kind === "text"
        ? node.text.trim() !== ""
        : VISIBLE_WHEN_EMPTY.has(node.tag) || visible(node.children),
    );
  return !visible(clean(parseFragment(html)));
}

/** What the render path needs to resolve links to real targets. */
export interface PageRenderContext {
  /** Identifier of the project the page belongs to. */
  projectIdentifier: string;
  /**
   * True when a page with this identifier exists in that project — a
   * missing page still links (legacy created it on visit), but is
   * marked with the legacy `non-existent-wiki-page-link` class.
   */
  pageExists: (projectIdentifier: string, identifier: string) => boolean;
  /** True when the project has a card with this number. */
  cardExists: (projectIdentifier: string, cardNumber: number) => boolean;
}

/**
 * Expands macros in a cleaned tree, adding each output root to `produced`.
 *
 * Declared as a callback rather than an import so the dependency runs
 * macros -> content and never back: this module stays pure and knows
 * nothing of the macro registry. The return type is `ContentNode[]`,
 * not a string, which is what makes ADR-0011 Decision 7 unbreakable
 * here rather than merely documented.
 */
export type MacroExpansion = (
  nodes: ContentNode[],
  produced: WeakSet<ContentNode>,
) => ContentNode[];

/** Matches `[[Page]]`, `[[display|Page]]` and `[[project/Page]]`. */
const WIKI_LINK = /\[\[[\t ]*(?:([^|\]]+?)[\t ]*\|)?[\t ]*(?:([a-z0-9_-]+)[\t ]*\/[\t ]*)?([^\]]*?)[\t ]*\]\]/gi;

/** Matches a `#123` card reference not glued to a preceding word. */
const CARD_LINK = /(^|[^\w&#])#(\d+)/g;

/** Builds an anchor node. */
function link(href: string, text: string, className?: string): ContentNode {
  return {
    kind: "element",
    tag: "a",
    attrs: className ? { href, class: className } : { href },
    children: [{ kind: "text", text }],
  };
}

/**
 * Applies the wiki-link substitution to one text node, returning the
 * nodes that replace it. A `[[…]]` escaped with a leading backslash is
 * left as literal text, minus the backslash (legacy pre_match guard).
 */
function substituteWikiLinks(
  text: string,
  ctx: PageRenderContext,
): ContentNode[] {
  const out: ContentNode[] = [];
  let last = 0;
  for (const match of text.matchAll(WIKI_LINK)) {
    const at = match.index;
    const escaped = at > 0 && text[at - 1] === "\\";
    if (at > last) out.push({ kind: "text", text: text.slice(last, escaped ? at - 1 : at) });
    last = at + match[0].length;
    if (escaped) {
      out.push({ kind: "text", text: match[0] });
      continue;
    }

    const [, display, project, rawName] = match;
    const name = (rawName ?? "").trim();
    const label = display?.trim() || name;
    const error = pageNameError(name);
    if (error) {
      out.push({
        kind: "element",
        tag: "span",
        attrs: { class: "invalid-wiki-page-link", title: `${error} You cannot create this page.` },
        children: [{ kind: "text", text: label || match[0] }],
      });
      continue;
    }
    const target = (project ?? ctx.projectIdentifier).toLowerCase();
    const identifier = pageIdentifier(name);
    const exists = ctx.pageExists(target, identifier);
    out.push(
      link(
        `/projects/${target}/wiki/${encodeURIComponent(identifier)}`,
        label,
        exists ? undefined : "non-existent-wiki-page-link",
      ),
    );
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/**
 * Applies the card-link substitution to already wiki-linked nodes: a
 * `#123` in a remaining text node becomes a link to that card, carrying
 * the legacy `card-link-<number>` class. A number with no card behind
 * it is left as plain text (legacy rendered a dead link; an unlinked
 * reference is the narrower behaviour).
 */
function substituteCardLinks(
  nodes: ContentNode[],
  ctx: PageRenderContext,
): ContentNode[] {
  const out: ContentNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "text") {
      out.push(node);
      continue;
    }
    const text = node.text;
    let last = 0;
    for (const match of text.matchAll(CARD_LINK)) {
      const number = Number(match[2]);
      if (!ctx.cardExists(ctx.projectIdentifier, number)) continue;
      const at = match.index + match[1].length;
      if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
      last = at + match[0].length - match[1].length;
      out.push(
        link(
          `/projects/${ctx.projectIdentifier}/cards/${number}`,
          `#${number}`,
          `card-link-${number}`,
        ),
      );
    }
    if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  }
  return out;
}

/**
 * Walks the tree, linkifying text outside `<a>`, `<code>` and `<pre>`.
 *
 * `skip` holds macro output roots. Macro output is already final —
 * a table cell holding a card name is not a place to go looking for
 * `[[…]]` syntax — so those subtrees pass through untouched.
 */
function linkify(
  nodes: ContentNode[],
  ctx: PageRenderContext,
  skip?: WeakSet<ContentNode>,
): ContentNode[] {
  const out: ContentNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      out.push(...substituteCardLinks(substituteWikiLinks(node.text, ctx), ctx));
      continue;
    }
    if (skip?.has(node)) {
      out.push(node);
      continue;
    }
    out.push({
      ...node,
      children: NO_SUBSTITUTION_TAGS.has(node.tag)
        ? node.children
        : linkify(node.children, ctx, skip),
    });
  }
  return out;
}

/**
 * Renders a stored page body for display: sanitized, then with wiki
 * and card links substituted.
 *
 * @param html - the stored body (already sanitized at write time;
 *   re-sanitized here so a body written before an allowlist change
 *   cannot leak through)
 * @param ctx - link-resolution context
 * @returns display HTML, safe to inject
 */
export function renderPageContent(
  html: string | null,
  ctx: PageRenderContext,
  expand?: MacroExpansion,
): string {
  if (!html) return "";
  const authored = clean(parseFragment(html));
  if (!expand) return serialize(linkify(authored, ctx));

  // Order is the ADR-0011 Decision 7 constraint made concrete: macros
  // produce nodes into the tree, those nodes are exempt from link
  // substitution, and the whole tree passes the allowlist again —
  // widened by exactly what macros declared — before serialization.
  // Authored markup was already cleaned above, so widening the second
  // pass cannot let an authored `<svg>` survive; only macro output
  // reaches that pass carrying declared tags.
  const produced = new WeakSet<ContentNode>();
  const expanded = expand(authored, produced);
  return serialize(clean(linkify(expanded, ctx, produced), currentMacroPolicy()));
}

/**
 * The page identifiers a body links to, so callers can resolve
 * existence in one query instead of one per link.
 *
 * @param html - the stored body
 * @returns identifiers referenced by `[[…]]` links in THIS project
 *   (cross-project references are excluded — they resolve elsewhere)
 */
export function referencedPageIdentifiers(html: string | null): string[] {
  if (!html) return [];
  const found = new Set<string>();
  const walk = (nodes: ContentNode[]) => {
    for (const node of nodes) {
      if (node.kind === "text") {
        for (const match of node.text.matchAll(WIKI_LINK)) {
          if (match[2]) continue;
          const name = (match[3] ?? "").trim();
          if (name && !pageNameError(name)) found.add(pageIdentifier(name));
        }
        continue;
      }
      if (!NO_SUBSTITUTION_TAGS.has(node.tag)) walk(node.children);
    }
  };
  walk(clean(parseFragment(html)));
  return [...found];
}

/**
 * The card numbers a body references, for the same batching reason as
 * `referencedPageIdentifiers`.
 *
 * @param html - the stored body
 */
export function referencedCardNumbers(html: string | null): number[] {
  if (!html) return [];
  const found = new Set<number>();
  const walk = (nodes: ContentNode[]) => {
    for (const node of nodes) {
      if (node.kind === "text") {
        for (const match of node.text.matchAll(CARD_LINK)) found.add(Number(match[2]));
        continue;
      }
      if (!NO_SUBSTITUTION_TAGS.has(node.tag)) walk(node.children);
    }
  };
  walk(clean(parseFragment(html)));
  return [...found];
}

/** Re-exported for callers building page URLs from a name. */
export { pageIdentifier, pageNameFromIdentifier };
