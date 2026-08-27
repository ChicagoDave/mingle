/**
 * Macro framework — finds `{{ name: params }}` in page content and
 * expands each registered macro into content nodes (Phase 17).
 *
 * Purpose: the extension seam between wiki content and the rest of the
 * domain. A macro is a named function from parsed parameters to
 * `ContentNode[]`; this module owns the syntax, the parameter parser,
 * the registry, and the failure surface, and knows nothing about what
 * any individual macro does.
 *
 * The accepted syntax is legacy's `MacroSubstitution::MATCH` —
 * `{{ name: params }}`, where `name` runs to the first space or colon
 * and everything after it is the parameter block. Legacy parses that
 * block as YAML; this reimplements the subset real macros use (a block
 * mapping, optionally nested, with `- ` sequences) rather than taking a
 * YAML dependency, because the full language admits constructs legacy
 * itself had to defend against — `Macro.parse_parameters` refuses
 * `!ruby/` tags outright. A backslash immediately before `{{` cancels
 * the expansion, as in legacy.
 *
 * ORDERING INVARIANT (ADR-0011 Decision 7): `expand` returns NODES.
 * Nothing here builds a markup string. A macro that wants an element
 * the authored allowlist forbids declares it through
 * `registerMacroElements` (content.server) at import time; macro output
 * is then cleaned against the authored allowlist widened by exactly
 * those declarations. Parameter text reaching output does so as text
 * nodes and attribute values, both escaped by `serialize`, so a macro
 * cannot inject markup even by accident.
 *
 * Public interface: `registerMacro`, `macroNames`, `expandMacros`,
 * `parseMacroParams`, `MacroDefinition`, `MacroContext`, `MacroParams`,
 * `MacroError`.
 *
 * Owner context: Wiki & Content. Depends on content.server for the node
 * type only; the dependency never points the other way, so
 * content.server stays pure and free of the registry.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { ContentNode } from "~/domain/pages/content.server";

// ------------------------------------------------------------- values

/** A parsed parameter block: scalars, nested mappings, and sequences. */
export type MacroParamValue = string | MacroParams | MacroParamValue[];

/** The parameter block of one macro invocation, keyed by lower-cased name. */
export interface MacroParams {
  [key: string]: MacroParamValue;
}

/**
 * A macro's refusal, carrying the message the reader sees in place of
 * the macro. Thrown by a macro's `expand`; never escapes `expandMacros`.
 */
export class MacroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroError";
  }
}

// ----------------------------------------------------------- registry

/** What a macro receives beyond its own parameters. */
export interface MacroContext {
  /** Identifier of the project whose page is being rendered. */
  projectIdentifier: string;
  /** Numeric id of that project, for queries. */
  projectId: number;
  /** Read handle; macros are read models and must never write. */
  db: BetterSQLite3Database;
  /** Who is viewing, for `CURRENT USER` in a macro's MQL. */
  currentUserId: number | null;
  /** Zero-based index of this macro within the body, for stable ids. */
  position: number;
}

/** One registered macro. */
export interface MacroDefinition {
  /** The name as written between `{{` and `:`, lower-cased. */
  name: string;
  /**
   * Expands one invocation.
   *
   * @param params - the parsed parameter block
   * @param context - project and position
   * @returns the nodes replacing the invocation
   * @throws MacroError when the parameters cannot produce output
   */
  expand: (params: MacroParams, context: MacroContext) => ContentNode[];
}

const REGISTRY = new Map<string, MacroDefinition>();

/**
 * Registers a macro under its name, replacing any earlier definition.
 *
 * @param definition - the macro; `name` is lower-cased on the way in
 * @returns nothing; the registration is process-wide
 */
export function registerMacro(definition: MacroDefinition): void {
  REGISTRY.set(definition.name.toLowerCase(), definition);
}

/**
 * The names currently registered, sorted — for the editor's macro list
 * and for tests asserting what a build exposes.
 */
export function macroNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

// ------------------------------------------------------------- syntax

/**
 * Legacy `MacroSubstitution::MATCH`. Group 1 is the name (which may
 * carry a trailing colon, as legacy's own `macro_name` allows for);
 * group 2 is the raw parameter block.
 */
const MACRO_PATTERN = /\{\{\s*([^}\s]*):?([^}]*)\}\}/g;

/** Strips the trailing colon legacy's name capture can include. */
function macroName(raw: string): string {
  return raw.replace(/:$/, "").trim().toLowerCase();
}

// --------------------------------------------------------- parameters

/** Splits a block into lines, dropping blanks and full-line comments. */
function paramLines(text: string): { indent: number; body: string }[] {
  const out: { indent: number; body: string }[] = [];
  for (const raw of text.split("\n")) {
    const body = raw.trim();
    if (body === "" || body.startsWith("#")) continue;
    out.push({ indent: raw.length - raw.trimStart().length, body });
  }
  return out;
}

/** Removes one layer of matching quotes from a scalar. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Splits `key: value` at the FIRST colon that ends a key.
 *
 * A macro parameter's value is very often MQL, which contains colons
 * of its own only inside quotes — but the key never does, so scanning
 * for the first colon outside quotes is both sufficient and what keeps
 * `query: SELECT name WHERE x = 'a:b'` intact.
 *
 * @param line - one trimmed line of the parameter block
 * @returns the key and the rest, or null when the line has no key
 */
function splitKey(line: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") {
      return { key: line.slice(0, i).trim(), rest: line.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * Parses the subset of YAML macro parameters actually use: a block
 * mapping whose values are scalars, nested mappings, or `- ` sequences.
 *
 * Keys are lower-cased and hyphens are preserved, so legacy names like
 * `chart-title` and `edit-any-number-property` arrive unchanged. A line
 * with no key at all is ignored rather than failing the whole macro,
 * matching legacy's tolerance for stray text in a parameter block.
 *
 * @param text - the raw block between the macro name and `}}`
 * @returns the parsed parameters; an empty object when the block is blank
 */
export function parseMacroParams(text: string): MacroParams {
  const lines = paramLines(text);
  let cursor = 0;

  const parseBlock = (indent: number): MacroParams => {
    const result: MacroParams = {};
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;

      if (line.body.startsWith("- ") || line.body === "-") {
        break;
      }

      const split = splitKey(line.body);
      if (!split) {
        cursor++;
        continue;
      }
      cursor++;
      const key = split.key.toLowerCase();

      if (split.rest !== "") {
        result[key] = unquote(split.rest);
        continue;
      }

      // An empty value means a nested block or sequence follows, at a
      // deeper indent. Anything shallower ends this key with "".
      const next = lines[cursor];
      if (!next || next.indent <= line.indent) {
        result[key] = "";
        continue;
      }
      result[key] = next.body.startsWith("- ") || next.body === "-"
        ? parseSequence(next.indent)
        : parseBlock(next.indent);
    }
    return result;
  };

  const parseSequence = (indent: number): MacroParamValue[] => {
    const items: MacroParamValue[] = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.indent < indent) break;
      if (!line.body.startsWith("- ") && line.body !== "-") break;

      const inline = line.body === "-" ? "" : line.body.slice(2).trim();
      cursor++;

      if (inline !== "" && splitKey(inline)) {
        // `- key: value` opens a mapping whose remaining keys are
        // indented past the dash.
        const entry: MacroParams = {};
        const split = splitKey(inline)!;
        entry[split.key.toLowerCase()] = unquote(split.rest);
        while (cursor < lines.length && lines[cursor].indent > indent) {
          const cont = lines[cursor];
          if (cont.body.startsWith("- ")) break;
          const contSplit = splitKey(cont.body);
          cursor++;
          if (!contSplit) continue;
          entry[contSplit.key.toLowerCase()] = unquote(contSplit.rest);
        }
        items.push(entry);
        continue;
      }
      items.push(unquote(inline));
    }
    return items;
  };

  return parseBlock(lines.length ? lines[0].indent : 0);
}

// ------------------------------------------------------------- output

/** Builds the node a failed macro leaves in place of its output. */
function errorNode(message: string): ContentNode {
  return {
    kind: "element",
    tag: "div",
    attrs: { class: "error macro" },
    children: [{ kind: "text", text: message }],
  };
}

/**
 * Expands every macro invocation in a node tree.
 *
 * Text nodes are scanned for `{{ … }}`; each invocation is replaced by
 * the registered macro's nodes, by an error node when the macro is
 * unknown or refuses, and by itself when a backslash immediately
 * precedes it. Elements whose text is never substituted (`code`,
 * `pre`) are left alone, so a page can document macro syntax without
 * running it.
 *
 * @param nodes - a cleaned content tree
 * @param context - project identity; `position` is assigned per macro
 * @param produced - collects macro output roots so the caller can skip
 *   them when linkifying (macro output is already final)
 * @returns a new tree with every invocation replaced
 */
export function expandMacros(
  nodes: ContentNode[],
  context: Omit<MacroContext, "position">,
  produced?: WeakSet<ContentNode>,
): ContentNode[] {
  let position = 0;

  const expandText = (text: string): ContentNode[] => {
    const out: ContentNode[] = [];
    let last = 0;
    MACRO_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(MACRO_PATTERN)) {
      const start = match.index!;
      // A backslash immediately before the braces cancels expansion,
      // as in legacy — the invocation stays visible as written.
      if (start > 0 && text[start - 1] === "\\") continue;
      if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
      last = start + match[0].length;

      const name = macroName(match[1] ?? "");
      const index = position++;
      if (name === "") {
        out.push(errorNode("No macro name given."));
        continue;
      }
      const definition = REGISTRY.get(name);
      if (!definition) {
        out.push(errorNode(`No such macro: ${name}`));
        continue;
      }
      try {
        const params = parseMacroParams(match[2] ?? "");
        const result = definition.expand(params, { ...context, position: index });
        for (const node of result) produced?.add(node);
        out.push(...result);
      } catch (error) {
        const message =
          error instanceof MacroError || error instanceof Error
            ? error.message
            : String(error);
        const node = errorNode(message);
        produced?.add(node);
        out.push(node);
      }
    }
    if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
    return out;
  };

  const walk = (input: ContentNode[]): ContentNode[] => {
    const out: ContentNode[] = [];
    for (const node of input) {
      if (node.kind === "text") {
        out.push(...expandText(node.text));
        continue;
      }
      if (node.tag === "code" || node.tag === "pre") {
        out.push(node);
        continue;
      }
      out.push({ ...node, children: walk(node.children) });
    }
    return out;
  };

  return walk(nodes);
}
