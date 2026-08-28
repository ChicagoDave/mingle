/**
 * Formula engine — parser, type-checker, and evaluator for formula
 * properties (Phase 8).
 *
 * Purpose: compiles a formula expression string (legacy
 * formula_properties.grammar surface: + - * /, unary minus, ()/{}/[]
 * grouping, number literals, property references as bare or
 * quoted identifiers with doubled-quote escaping) into an evaluator
 * over a card's property values. Type rules match the legacy
 * Formula::* classes and ValidFormulaVisitor exactly:
 *
 *   number ⊕ number → number (all four operators, unary minus)
 *   date + number   → date (either order; fractional days truncate)
 *   date - number   → date
 *   date - date     → number (days)
 *   date + date, number - date, date in * or /, -date → INVALID
 *
 * Validity is decided at compile (definition) time, never at
 * evaluation time: unknown properties, non-numeric/non-date operands,
 * references to other formula properties (which also makes circular
 * references impossible), and type-incompatible operations are all
 * compile errors. Evaluation can only produce a value or null: an
 * unset input makes the result null (unless nullIsZero evaluates unset
 * NUMERIC property inputs as 0 — legacy null_is_zero), and division by
 * zero is null (legacy CASE WHEN ... THEN NULL).
 *
 * Output canonical forms match the property value store: numbers
 * rounded to 2 decimals (legacy default project precision) with
 * trailing zeros trimmed, dates as ISO yyyy-mm-dd.
 *
 * Public interface: `compileFormula`, `CompiledFormula`,
 * `FormulaPropertyShape`, and `formatNumber` — the canonical numeric
 * form, shared with the aggregate engine so a sum and a formula over
 * the same cards never disagree about how "7.50" is written.
 *
 * Owner context: Card Management. Pure module — no database, no
 * infrastructure imports; callers supply property shapes and values.
 */

/** The subset of a property definition the engine needs. */
export interface FormulaPropertyShape {
  id: number;
  name: string;
  kind: string;
}

/** A successfully compiled, type-checked formula. */
export interface CompiledFormula {
  /** "number" or "date" — decided at compile time from the type rules. */
  outputKind: "number" | "date";
  /** Ids of the property definitions the formula reads. */
  usedPropertyIds: number[];
  /**
   * Evaluates against a card's current values (canonical stored
   * strings by property definition id; absent/null = unset).
   *
   * @returns the canonical result string, or null when unset
   */
  evaluate(values: ReadonlyMap<number, string>): string | null;
}

export type CompileResult =
  | { ok: true; formula: CompiledFormula }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: "number"; value: number; text: string }
  | { kind: "identifier"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" }
  | { kind: "open" | "close"; paren: "(" | "{" | "[" };

const NUMBER_TOKEN = /^(\d+\.?\d*|\d*\.?\d+)/;
// Bare identifier: anything except whitespace, operators, all three
// grouping pairs, and the characters property names may not contain
// anyway (legacy lexer's excluded set). Multi-word names must be quoted.
const BARE_IDENTIFIER = /^[^\s+\-*/(){}[\]&=#;"']+/;
const CLOSER: Record<"(" | "{" | "[", string> = { "(": ")", "{": "}", "[": "]" };

function lex(input: string): Token[] | string {
  const tokens: Token[] = [];
  let rest = input;
  while (rest.length > 0) {
    const ws = rest.match(/^\s+/);
    if (ws) {
      rest = rest.slice(ws[0].length);
      continue;
    }
    const number = rest.match(NUMBER_TOKEN);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]), text: number[0] });
      rest = rest.slice(number[0].length);
      continue;
    }
    const ch = rest[0];
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", op: ch });
      rest = rest.slice(1);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      tokens.push({ kind: "open", paren: ch });
      rest = rest.slice(1);
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      tokens.push({
        kind: "close",
        paren: ch === ")" ? "(" : ch === "}" ? "{" : "[",
      });
      rest = rest.slice(1);
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Quoted identifier; a doubled quote escapes itself (legacy lexer).
      const quoted = rest.match(
        ch === "'" ? /^'((?:''|[^'])+)'/ : /^"((?:""|[^"])+)"/,
      );
      if (!quoted)
        return `Unexpected characters encountered: ${rest.slice(0, 10)}`;
      const name = quoted[1].replaceAll(ch + ch, ch);
      tokens.push({ kind: "identifier", name });
      rest = rest.slice(quoted[0].length);
      continue;
    }
    const bare = rest.match(BARE_IDENTIFIER);
    if (bare) {
      tokens.push({ kind: "identifier", name: bare[0] });
      rest = rest.slice(bare[0].length);
      continue;
    }
    return `Unexpected characters encountered: ${rest.slice(0, 10)}`;
  }
  return tokens;
}

// --------------------------------------------------------------- parser

type Node =
  | { type: "number"; value: number; text: string }
  | { type: "property"; name: string }
  | { type: "neg"; operand: Node }
  | { type: "binop"; op: "+" | "-" | "*" | "/"; left: Node; right: Node };

function parse(tokens: Token[]): Node | string {
  let pos = 0;
  const peek = () => tokens[pos];

  function primary(): Node | string {
    const token = peek();
    if (!token) return "The formula is not well formed. Unexpected end of formula.";
    if (token.kind === "number") {
      pos++;
      return { type: "number", value: token.value, text: token.text };
    }
    if (token.kind === "identifier") {
      pos++;
      return { type: "property", name: token.name };
    }
    if (token.kind === "open") {
      pos++;
      const inner = additive();
      if (typeof inner === "string") return inner;
      const close = peek();
      if (!close || close.kind !== "close" || close.paren !== token.paren)
        return `The formula is not well formed. Expected '${CLOSER[token.paren]}'.`;
      pos++;
      return inner;
    }
    if (token.kind === "op" && token.op === "-") {
      pos++;
      const operand = primary();
      if (typeof operand === "string") return operand;
      return { type: "neg", operand };
    }
    return "The formula is not well formed. Unexpected token.";
  }

  function multiplicative(): Node | string {
    let left = primary();
    if (typeof left === "string") return left;
    for (;;) {
      const token = peek();
      if (!token || token.kind !== "op" || (token.op !== "*" && token.op !== "/"))
        return left;
      pos++;
      const right = primary();
      if (typeof right === "string") return right;
      left = { type: "binop", op: token.op, left, right };
    }
  }

  function additive(): Node | string {
    let left = multiplicative();
    if (typeof left === "string") return left;
    for (;;) {
      const token = peek();
      if (!token || token.kind !== "op" || (token.op !== "+" && token.op !== "-"))
        return left;
      pos++;
      const right = multiplicative();
      if (typeof right === "string") return right;
      left = { type: "binop", op: token.op, left, right };
    }
  }

  const root = additive();
  if (typeof root === "string") return root;
  if (pos < tokens.length)
    return "The formula is not well formed. Unexpected token after the expression.";
  return root;
}

// --------------------------------------------------------- type checker

type OperandKind = "number" | "date";

/** Renders a node back to text for error messages. */
function describe(node: Node): string {
  switch (node.type) {
    case "number":
      return node.text;
    case "property":
      return /[\s+\-*/(){}[\]]/.test(node.name) ? `'${node.name}'` : node.name;
    case "neg":
      return `-${describe(node.operand)}`;
    case "binop":
      return `${describe(node.left)} ${node.op} ${describe(node.right)}`;
  }
}

function typeCheck(
  node: Node,
  byName: Map<string, FormulaPropertyShape>,
  errors: string[],
  used: Set<number>,
): OperandKind | null {
  switch (node.type) {
    case "number":
      return "number";
    case "property": {
      const property = byName.get(node.name.toLowerCase());
      if (!property) {
        errors.push(`No such property: ${node.name}`);
        return null;
      }
      used.add(property.id);
      if (property.kind === "formula") {
        errors.push(
          `Property ${property.name} is a formula property and cannot be used within another formula.`,
        );
        return null;
      }
      if (property.kind === "aggregate") {
        // Legacy let formulas read aggregates (dependant_formulas); the
        // cross-card recomputation order that needs is deferred, so the
        // reference is refused by name rather than computed stale.
        errors.push(
          `Property ${property.name} is an aggregate property and cannot be used within a formula.`,
        );
        return null;
      }
      if (property.kind === "number") return "number";
      if (property.kind === "date") return "date";
      errors.push(`Property ${property.name} is not numeric.`);
      return null;
    }
    case "neg": {
      const kind = typeCheck(node.operand, byName, errors, used);
      if (kind === "date")
        errors.push(
          `The expression -${describe(node.operand)} is invalid because a date cannot be negated.`,
        );
      return kind === "number" ? "number" : null;
    }
    case "binop": {
      const left = typeCheck(node.left, byName, errors, used);
      const right = typeCheck(node.right, byName, errors, used);
      if (left === null || right === null) return null;
      if (left === "number" && right === "number") return "number";
      const invalid = (reason: string) => {
        errors.push(
          `The expression ${describe(node)} is invalid because ${reason}.`,
        );
        return null;
      };
      switch (node.op) {
        case "+":
          if (left === "date" && right === "date")
            return invalid(
              `a date (${describe(node.left)}) cannot be added to a date (${describe(node.right)})`,
            );
          return "date";
        case "-":
          if (left === "number")
            return invalid(
              `a date (${describe(node.right)}) cannot be subtracted from a number (${describe(node.left)})`,
            );
          return right === "date" ? "number" : "date";
        case "*":
        case "/":
          return invalid("dates cannot be multiplied or divided");
      }
    }
  }
}

// ------------------------------------------------------------ evaluator

type Value = { kind: "number"; n: number } | { kind: "date"; d: Date } | null;

const MS_PER_DAY = 86_400_000;

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function evaluate(
  node: Node,
  byName: Map<string, FormulaPropertyShape>,
  values: ReadonlyMap<number, string>,
  nullIsZero: boolean,
): Value {
  switch (node.type) {
    case "number":
      return { kind: "number", n: node.value };
    case "property": {
      const property = byName.get(node.name.toLowerCase())!;
      const stored = values.get(property.id);
      if (stored === undefined || stored === null) {
        // legacy null_is_zero applies to numeric properties only
        if (nullIsZero && property.kind === "number")
          return { kind: "number", n: 0 };
        return null;
      }
      return property.kind === "date"
        ? { kind: "date", d: parseIsoDate(stored) }
        : { kind: "number", n: Number(stored) };
    }
    case "neg": {
      const operand = evaluate(node.operand, byName, values, nullIsZero);
      return operand === null || operand.kind !== "number"
        ? null
        : { kind: "number", n: -operand.n };
    }
    case "binop": {
      const left = evaluate(node.left, byName, values, nullIsZero);
      const right = evaluate(node.right, byName, values, nullIsZero);
      if (left === null || right === null) return null;
      if (left.kind === "number" && right.kind === "number") {
        switch (node.op) {
          case "+":
            return { kind: "number", n: left.n + right.n };
          case "-":
            return { kind: "number", n: left.n - right.n };
          case "*":
            return { kind: "number", n: left.n * right.n };
          case "/":
            // division by zero is null, not an error (legacy CASE WHEN)
            return right.n === 0 ? null : { kind: "number", n: left.n / right.n };
        }
      }
      // date arithmetic; the type checker guarantees valid combinations,
      // and fractional day counts truncate (legacy integer cast)
      if (node.op === "+") {
        const [date, days] =
          left.kind === "date"
            ? [left.d, (right as { n: number }).n]
            : [(right as { kind: "date"; d: Date }).d, left.n];
        return {
          kind: "date",
          d: new Date(date.getTime() + Math.trunc(days) * MS_PER_DAY),
        };
      }
      if (left.kind === "date" && right.kind === "date")
        return {
          kind: "number",
          n: Math.round((left.d.getTime() - right.d.getTime()) / MS_PER_DAY),
        };
      return {
        kind: "date",
        d: new Date(
          (left as { kind: "date"; d: Date }).d.getTime() -
            Math.trunc((right as { n: number }).n) * MS_PER_DAY,
        ),
      };
    }
  }
}

/** Canonical result form: precision-2 numbers, ISO dates (see header). */
function format(value: Value): string | null {
  if (value === null) return null;
  if (value.kind === "date") return value.d.toISOString().slice(0, 10);
  return formatNumber(value.n);
}

/**
 * The canonical stored form of a computed number: rounded to 2
 * decimals (legacy default project precision) with trailing zeros
 * trimmed, so "7.50" is stored as "7.5" and "3.00" as "3".
 *
 * @param n - the computed number
 * @returns the canonical string, or null when not finite (division by
 *   zero, overflow) — an unset value, never an error
 */
export function formatNumber(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  const rounded = n.toFixed(2);
  return rounded.includes(".")
    ? rounded.replace(/\.?0+$/, "") || "0"
    : rounded;
}

/**
 * Compiles a formula expression against a project's property
 * definitions: lexes, parses, and type-checks per the header's rules.
 *
 * @param text - the formula expression string
 * @param properties - the project's property definitions (the one being
 *   defined excluded — it does not exist yet)
 * @param nullIsZero - evaluate unset numeric inputs as 0 (legacy
 *   null_is_zero; a definition-time flag, fixed at compile)
 * @returns the compiled formula, or every definition-time error found
 */
export function compileFormula(
  text: string,
  properties: FormulaPropertyShape[],
  nullIsZero = false,
): CompileResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, errors: ["Formula cannot be blank."] };
  const tokens = lex(trimmed);
  if (typeof tokens === "string") return { ok: false, errors: [tokens] };
  const root = parse(tokens);
  if (typeof root === "string") return { ok: false, errors: [root] };

  const byName = new Map(
    properties.map((property) => [property.name.toLowerCase(), property]),
  );
  const errors: string[] = [];
  const used = new Set<number>();
  const outputKind = typeCheck(root, byName, errors, used);
  if (errors.length > 0 || outputKind === null)
    return { ok: false, errors };

  return {
    ok: true,
    formula: {
      outputKind,
      usedPropertyIds: [...used],
      evaluate: (values) => format(evaluate(root, byName, values, nullIsZero)),
    },
  };
}
