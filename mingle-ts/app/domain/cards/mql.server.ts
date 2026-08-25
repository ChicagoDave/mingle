/**
 * MQL (Mingle Query Language) parser — lexer, recursive-descent parser,
 * and schema-validating resolver producing a typed AST (Phase 12).
 *
 * Purpose: turns an MQL string into an `MqlQuery` whose every property
 * reference is resolved against the project's actual definitions, or
 * into a specific error — never a silent empty result. The accepted
 * surface is the legacy `card_query.grammar` (the grammar CardQuery
 * really parses, not the lighter `mql.grammar` formatter):
 *
 *   [SELECT [DISTINCT] cols] [AS OF date] [FROM TREE t] [WHERE conds]
 *   [GROUP BY cols] [ORDER BY cols [ASC|DESC]]      — or bare conditions
 *
 *   conds := conds AND conds | conds OR conds | NOT conds | (conds)
 *          | col op value | col op PROPERTY col | col op NUMBER n
 *          | col = NULL | col != NULL | col = CURRENT USER | col op TODAY
 *          | col op THIS CARD[.prop] | col op (project variable)
 *          | col [NUMBERS] IN (v, ...) | col IN (SELECT ...)
 *          | TAGGED WITH tag | IN PLAN plan
 *
 * Keywords are case-insensitive (`IS`/`IS NOT`/`NOT =` alias `=`/`!=`);
 * identifiers may be bare, 'single' or "double" quoted with backslash
 * escapes, exactly as the legacy StringScanner lexer tokenizes them.
 *
 * Resolution rules mirror legacy CardQuery::Column / MqlValidations:
 * an unknown property is "Card property 'X' does not exist!"; the six
 * predefined properties (Type, Name, Number, Created On, Modified On,
 * Project — the last SELECT-only) resolve without a definition row;
 * literals are type-checked per property kind and canonicalized to the
 * stored form (enumeration casing, user id, numeric string, ISO date);
 * CURRENT USER / TODAY are confined to user / date properties, and the
 * quoted-keyword mistake gets legacy's hint. Constructs whose backing
 * model does not exist in this rewrite yet (trees, tags, plans, card
 * relationship properties) parse into the AST and are rejected by the
 * resolver with a specific message, so the grammar stays legacy-faithful
 * while the evaluator (Phase 13) never sees an unsupported node.
 *
 * Public interface: `parseMql`, `MqlParseResult`, `MqlQuery` and its
 * node types, `MqlSchema`/`MqlPropertyShape`, `MQL_PREDEFINED_PROPERTIES`,
 * `MQL_AGGREGATE_FUNCTIONS`.
 *
 * Owner context: Query. Pure module — no database, no infrastructure
 * imports; callers supply the schema (see mql-schema.server.ts).
 */
import type {
  ProjectVariableDataType,
  PropertyKind,
} from "~/shared/wire-types";

// -------------------------------------------------------------- schema

/** The subset of a property definition the resolver needs. */
export interface MqlPropertyShape {
  id: number;
  name: string;
  kind: PropertyKind;
  /** Enumerated kind only: the allowed values in defined casing. */
  values?: string[];
}

/** Everything a project exposes to MQL, loaded once per parse. */
export interface MqlSchema {
  properties: MqlPropertyShape[];
  /** Card type names in defined casing (values of the Type property). */
  cardTypes: string[];
  /** Team members (values of user properties are logins on the wire). */
  users: { id: number; login: string }[];
  projectVariables: {
    name: string;
    dataType: ProjectVariableDataType;
    value: string | null;
  }[];
}

/** Keys of the predefined (definition-less) card properties. */
export type PredefinedPropertyKey =
  | "type"
  | "name"
  | "number"
  | "created_on"
  | "modified_on"
  | "project";

/**
 * The predefined properties MQL may reference (legacy help: "these six
 * predefined properties can be used in MQL"), keyed by normalized name.
 */
export const MQL_PREDEFINED_PROPERTIES: Record<
  PredefinedPropertyKey,
  { name: string; kind: "text" | "number" | "date"; selectOnly: boolean }
> = {
  type: { name: "Type", kind: "text", selectOnly: false },
  name: { name: "Name", kind: "text", selectOnly: false },
  number: { name: "Number", kind: "number", selectOnly: false },
  created_on: { name: "Created On", kind: "date", selectOnly: false },
  modified_on: { name: "Modified On", kind: "date", selectOnly: false },
  project: { name: "Project", kind: "text", selectOnly: true },
};

/** Legacy CardQuery::AggregateFunction's recognized functions. */
export const MQL_AGGREGATE_FUNCTIONS = ["avg", "count", "max", "min", "sum"] as const;
export type MqlAggregateFunction = (typeof MQL_AGGREGATE_FUNCTIONS)[number];

// ----------------------------------------------------------------- AST

/** A resolved property reference — the only way the AST names a property. */
export type PropertyRef =
  | {
      source: "predefined";
      key: PredefinedPropertyKey;
      name: string;
      kind: "text" | "number" | "date";
    }
  | { source: "defined"; id: number; name: string; kind: PropertyKind };

export type MqlOperator = "=" | "!=" | "<" | ">" | "<=" | ">=";

/** Generic over the column representation: `string` unresolved, `PropertyRef` resolved. */
export interface Column<C> {
  type: "column";
  property: C;
}

export type SelectColumn<C> =
  | Column<C>
  | {
      type: "aggregate";
      /** Lower-cased function name. */
      fn: string;
      /** null means `*` (count only). */
      column: Column<C> | null;
    };

export interface OrderByColumn<C> {
  column: Column<C>;
  direction: "asc" | "desc" | null;
}

export type Value<C> =
  | {
      type: "literal";
      /** The text as written (unquoted, unescaped). */
      text: string;
      /**
       * The stored form the evaluator compares against (enumeration
       * casing, user id, card type casing, numeric string, ISO date).
       * Equals `text` for plain text properties; unresolved = `text`.
       */
      canonical: string;
    }
  | { type: "null" }
  | { type: "today" }
  | { type: "currentUser" }
  | { type: "thisCard" }
  | { type: "thisCardProperty"; column: Column<C> }
  | { type: "property"; column: Column<C> }
  | { type: "cardNumber"; number: string }
  | {
      type: "projectVariable";
      name: string;
      /** The variable's stored value once resolved; null while unresolved or unset. */
      value: string | null;
    };

export type Condition<C> =
  | { type: "and"; left: Condition<C>; right: Condition<C> }
  | { type: "or"; left: Condition<C>; right: Condition<C> }
  | { type: "not"; operand: Condition<C> }
  | {
      type: "comparison";
      column: Column<C>;
      operator: MqlOperator;
      value: Value<C>;
    }
  | {
      type: "in";
      column: Column<C>;
      values: Value<C>[];
      /** `NUMBER IN` / `NUMBERS IN` — values are card numbers. */
      byNumber: boolean;
    }
  | { type: "inQuery"; column: Column<C>; query: Query<C> }
  | { type: "inPlan"; plan: string }
  | { type: "taggedWith"; tag: string };

export interface Query<C> {
  select: { columns: SelectColumn<C>[]; distinct: boolean } | null;
  /** ISO yyyy-mm-dd once resolved. */
  asOf: string | null;
  from: { trees: string[] } | null;
  where: Condition<C> | null;
  groupBy: Column<C>[] | null;
  orderBy: OrderByColumn<C>[] | null;
}

/** The resolved, typed query — what Phase 13 evaluates. */
export type MqlQuery = Query<PropertyRef>;
export type MqlCondition = Condition<PropertyRef>;
export type MqlValue = Value<PropertyRef>;
export type MqlSelectColumn = SelectColumn<PropertyRef>;

export type MqlParseResult =
  | { ok: true; query: MqlQuery }
  | { ok: false; errors: string[] };

// --------------------------------------------------------------- lexer

type KeywordKind =
  | "SELECT"
  | "DISTINCT"
  | "FROM"
  | "TREE"
  | "WHERE"
  | "GROUP_BY"
  | "ORDER_BY"
  | "TAGGED_WITH"
  | "IN_PLAN"
  | "NULL"
  | "CURRENT_USER"
  | "THIS_CARD"
  | "IN"
  | "AND"
  | "OR"
  | "NOT"
  | "TODAY"
  | "PROPERTY"
  | "NUMBER"
  | "NUMBERS"
  | "AS_OF";

type Token =
  | { kind: KeywordKind; text: string }
  | { kind: "IDENTIFIER"; text: string }
  | { kind: "ORDER"; text: string; direction: "asc" | "desc" }
  | { kind: "OP"; text: string; op: MqlOperator }
  | { kind: "OPEN" | "CLOSE" | "COMMA" | "STAR" | "DOT"; text: string };

/** Legacy lexer rules in legacy order — first match wins. */
const KEYWORDS: [RegExp, KeywordKind][] = [
  [/^select\b/i, "SELECT"],
  [/^distinct\b/i, "DISTINCT"],
  [/^from\b/i, "FROM"],
  [/^tree\b/i, "TREE"],
  [/^where\b/i, "WHERE"],
  [/^group\s+by\b/i, "GROUP_BY"],
  [/^order\s+by\b/i, "ORDER_BY"],
  [/^tagged\s+with\b/i, "TAGGED_WITH"],
  [/^in\s+plan\b/i, "IN_PLAN"],
  [/^null\b/i, "NULL"],
  [/^current\s+user\b/i, "CURRENT_USER"],
  [/^this\s+card\b/i, "THIS_CARD"],
  [/^in\b/i, "IN"],
];
const LATE_KEYWORDS: [RegExp, KeywordKind][] = [
  [/^and\b/i, "AND"],
  [/^or\b/i, "OR"],
  [/^not\b/i, "NOT"],
  [/^today\b/i, "TODAY"],
  [/^property\b/i, "PROPERTY"],
  [/^number\b/i, "NUMBER"],
  [/^numbers\b/i, "NUMBERS"],
  [/^as\s+of\b/i, "AS_OF"],
];
const OPERATORS: [RegExp, MqlOperator][] = [
  [/^<=/, "<="],
  [/^>=/, ">="],
  [/^</, "<"],
  [/^>/, ">"],
  [/^(!=|is\s+not\b|not\s+=)/i, "!="],
  [/^(=|is\b)/i, "="],
];
const SINGLE_QUOTED = /^'((?:\\'|[^'])*)'/;
const DOUBLE_QUOTED = /^"((?:\\"|[^"])*)"/;
const DATE_LITERAL = /^\d{4}-\d{1,2}-\d{1,2}\b/;
const NUMERIC = /^((\d+\.?\d*)|(\d*\.?\d+))\b/;
// Everything except whitespace, grouping, `*`, `.`, `,`, comparison
// characters and `$ % #` — legacy's excluded set.
const BARE = /^(\\"|\\'|[^\s()*.,=!><$%#])+/;

function unescapeQuotes(text: string): string {
  return text.replace(/\\(['"])/g, "$1");
}

function lex(input: string): Token[] | string {
  const tokens: Token[] = [];
  let rest = input;
  const take = (n: number) => (rest = rest.slice(n));
  outer: while (rest.length > 0) {
    const ws = rest.match(/^\s+/);
    if (ws) {
      take(ws[0].length);
      continue;
    }
    for (const [re, kind] of KEYWORDS) {
      const m = rest.match(re);
      if (m) {
        tokens.push({ kind, text: m[0] });
        take(m[0].length);
        continue outer;
      }
    }
    const ch = rest[0];
    if (ch === ".") {
      tokens.push({ kind: "DOT", text: ch });
      take(1);
      continue;
    }
    if (ch === "*") {
      tokens.push({ kind: "STAR", text: ch });
      take(1);
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "COMMA", text: ch });
      take(1);
      continue;
    }
    for (const [re, op] of OPERATORS) {
      const m = rest.match(re);
      if (m) {
        tokens.push({ kind: "OP", text: m[0], op });
        take(m[0].length);
        continue outer;
      }
    }
    for (const [re, kind] of LATE_KEYWORDS) {
      const m = rest.match(re);
      if (m) {
        tokens.push({ kind, text: m[0] });
        take(m[0].length);
        continue outer;
      }
    }
    const order = rest.match(/^(asc|desc)\b/i);
    if (order) {
      tokens.push({
        kind: "ORDER",
        text: order[0],
        direction: order[0].toLowerCase() as "asc" | "desc",
      });
      take(order[0].length);
      continue;
    }
    const quoted = rest.match(SINGLE_QUOTED) ?? rest.match(DOUBLE_QUOTED);
    if (quoted) {
      tokens.push({ kind: "IDENTIFIER", text: unescapeQuotes(quoted[1]) });
      take(quoted[0].length);
      continue;
    }
    // Date literal (mql.grammar's lexer rule; card_query's lexer would
    // split 2026-01-01 into 2026 and -01-01, which the help avoids by
    // quoting — accepting the bare form is strictly more permissive).
    const date = rest.match(DATE_LITERAL);
    if (date) {
      tokens.push({ kind: "IDENTIFIER", text: date[0] });
      take(date[0].length);
      continue;
    }
    const numeric = rest.match(NUMERIC);
    if (numeric) {
      tokens.push({ kind: "IDENTIFIER", text: numeric[0] });
      take(numeric[0].length);
      continue;
    }
    const bare = rest.match(BARE);
    if (bare) {
      tokens.push({ kind: "IDENTIFIER", text: unescapeQuotes(bare[0]) });
      take(bare[0].length);
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "OPEN", text: ch });
      take(1);
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "CLOSE", text: ch });
      take(1);
      continue;
    }
    return `unexpected characters ${rest.slice(0, 5)}`;
  }
  return tokens;
}

// -------------------------------------------------------------- parser

type SyntaxQuery = Query<string>;

/** Thrown internally; converted to a result by parseMql. */
class MqlSyntaxError extends Error {}

const CLAUSE_STARTERS = new Set<Token["kind"]>([
  "SELECT",
  "AS_OF",
  "FROM",
  "WHERE",
  "GROUP_BY",
  "ORDER_BY",
]);

/** Tokens that legacy's `identifier` rule also accepts as plain words. */
const IDENTIFIER_LIKE = new Set<Token["kind"]>([
  "IDENTIFIER",
  "TODAY",
  "CURRENT_USER",
  "NUMBER",
  "NUMBERS",
  "NULL",
  "THIS_CARD",
]);

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parseTarget(): SyntaxQuery {
    if (this.tokens.length === 0) return emptyQuery<string>();
    if (CLAUSE_STARTERS.has(this.peek()!.kind)) {
      const query = this.parseClauses(false);
      this.expectEnd();
      return query;
    }
    const where = this.parseOr();
    this.expectEnd();
    return { ...emptyQuery(), where };
  }

  // -- clauses ----------------------------------------------------------

  private parseClauses(requireSelect: boolean): SyntaxQuery {
    const query = emptyQuery<string>();
    if (this.at("SELECT")) {
      this.next();
      const distinct = this.at("DISTINCT") ? (this.next(), true) : false;
      query.select = { columns: this.parseSelectColumns(), distinct };
    } else if (requireSelect) {
      this.fail(this.peek());
    }
    if (this.at("AS_OF")) {
      this.next();
      query.asOf = this.expectIdentifierLike();
    }
    if (this.at("FROM")) {
      this.next();
      this.expect("TREE");
      query.from = { trees: this.parseValueList().map(valueText) };
    }
    if (this.at("WHERE")) {
      this.next();
      query.where = this.parseOr();
    }
    if (this.at("GROUP_BY")) {
      this.next();
      query.groupBy = this.parseColumnList();
    }
    if (this.at("ORDER_BY")) {
      this.next();
      query.orderBy = this.parseOrderByColumns();
    }
    return query;
  }

  private parseSelectColumns(): SelectColumn<string>[] {
    const columns: SelectColumn<string>[] = [];
    do {
      if (this.at("IDENTIFIER") && this.peek(1)?.kind === "OPEN") {
        const fn = this.next().text.toLowerCase();
        this.next(); // (
        const column = this.at("STAR") ? (this.next(), null) : this.parseColumn();
        this.expect("CLOSE");
        columns.push({ type: "aggregate", fn, column });
      } else {
        columns.push(this.parseColumn());
      }
    } while (this.at("COMMA") && this.next());
    return columns;
  }

  private parseColumnList(): Column<string>[] {
    const columns: Column<string>[] = [];
    do columns.push(this.parseColumn());
    while (this.at("COMMA") && this.next());
    return columns;
  }

  private parseOrderByColumns(): OrderByColumn<string>[] {
    const columns: OrderByColumn<string>[] = [];
    do {
      const column = this.parseColumn();
      const direction = this.at("ORDER")
        ? (this.next() as Extract<Token, { kind: "ORDER" }>).direction
        : null;
      columns.push({ column, direction });
    } while (this.at("COMMA") && this.next());
    return columns;
  }

  /** column := IDENTIFIER | NUMBER | NUMBERS | PROPERTY (IDENTIFIER|PROPERTY) */
  private parseColumn(): Column<string> {
    const t = this.peek();
    if (!t) this.fail(undefined);
    if (t.kind === "PROPERTY") {
      this.next();
      const name = this.peek();
      if (!name || (name.kind !== "IDENTIFIER" && name.kind !== "PROPERTY")) {
        this.fail(name);
      }
      this.next();
      return { type: "column", property: name.text };
    }
    if (t.kind === "IDENTIFIER" || t.kind === "NUMBER" || t.kind === "NUMBERS") {
      this.next();
      return { type: "column", property: t.text };
    }
    this.fail(t);
  }

  // -- conditions -------------------------------------------------------

  private parseOr(): Condition<string> {
    let left = this.parseAnd();
    while (this.at("OR")) {
      this.next();
      left = { type: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Condition<string> {
    let left = this.parseNot();
    while (this.at("AND")) {
      this.next();
      left = { type: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Condition<string> {
    if (this.at("NOT")) {
      this.next();
      return { type: "not", operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Condition<string> {
    const t = this.peek();
    if (!t) this.fail(undefined);
    if (t.kind === "OPEN") {
      this.next();
      const inner = this.parseOr();
      this.expect("CLOSE");
      return inner;
    }
    if (t.kind === "TAGGED_WITH") {
      this.next();
      return { type: "taggedWith", tag: this.expectIdentifier() };
    }
    if (t.kind === "IN_PLAN") {
      this.next();
      return { type: "inPlan", plan: this.expectIdentifier() };
    }
    const column = this.parseColumn();
    if (this.at("IN")) {
      this.next();
      return this.parseInRest(column, false);
    }
    if ((this.at("NUMBER") || this.at("NUMBERS")) && this.peek(1)?.kind === "IN") {
      this.next();
      this.next();
      return this.parseInRest(column, true);
    }
    const opToken = this.peek();
    if (!opToken || opToken.kind !== "OP") this.fail(opToken);
    this.next();
    const operator = opToken.op;
    return { type: "comparison", column, operator, value: this.parseValue(operator) };
  }

  private parseInRest(column: Column<string>, byNumber: boolean): Condition<string> {
    this.expect("OPEN");
    if (!byNumber && this.at("SELECT")) {
      const query = this.parseClauses(true);
      this.expect("CLOSE");
      return { type: "inQuery", column, query };
    }
    const values = this.parseValueItems();
    this.expect("CLOSE");
    return { type: "in", column, values, byNumber };
  }

  /** Right-hand side of a comparison. */
  private parseValue(operator: MqlOperator): Value<string> {
    const t = this.peek();
    if (!t) this.fail(undefined);
    switch (t.kind) {
      case "OPEN":
        return this.parseProjectVariable();
      case "NUMBER": {
        this.next();
        if (this.at("IDENTIFIER")) return { type: "cardNumber", number: this.next().text };
        return { type: "property", column: { type: "column", property: t.text } };
      }
      case "TODAY":
        this.next();
        return { type: "today" };
      case "THIS_CARD":
        return this.parseThisCard();
      case "PROPERTY":
        return { type: "property", column: this.parseColumn() };
      case "IDENTIFIER":
        this.next();
        return { type: "literal", text: t.text, canonical: t.text };
      case "NULL":
        if (operator !== "=" && operator !== "!=") this.fail(t);
        this.next();
        return { type: "null" };
      case "CURRENT_USER":
        if (operator !== "=" && operator !== "!=") this.fail(t);
        this.next();
        return { type: "currentUser" };
      default:
        this.fail(t);
    }
  }

  private parseThisCard(): Value<string> {
    this.expect("THIS_CARD");
    if (this.at("DOT")) {
      this.next();
      const name = this.peek();
      if (!name || (name.kind !== "IDENTIFIER" && name.kind !== "NUMBER")) this.fail(name);
      this.next();
      return { type: "thisCardProperty", column: { type: "column", property: name.text } };
    }
    return { type: "thisCard" };
  }

  /** `( words... )` — legacy plv_name joins identifier-like tokens with spaces. */
  private parseProjectVariable(): Value<string> {
    this.expect("OPEN");
    const words: string[] = [];
    while (this.peek() && IDENTIFIER_LIKE.has(this.peek()!.kind)) {
      const w = this.next();
      words.push(w.kind === "THIS_CARD" ? "this card" : w.text);
    }
    if (words.length === 0) this.fail(this.peek());
    this.expect("CLOSE");
    return { type: "projectVariable", name: words.join(" "), value: null };
  }

  /** IN-list item := THIS CARD.prop | IDENTIFIER | (plv) */
  private parseValueItems(): Value<string>[] {
    const values: Value<string>[] = [];
    do values.push(this.parseValueItem());
    while (this.at("COMMA") && this.next());
    return values;
  }

  private parseValueItem(): Value<string> {
    const t = this.peek();
    if (!t) this.fail(undefined);
    if (t.kind === "THIS_CARD") {
      const v = this.parseThisCard();
      if (v.type !== "thisCardProperty") this.fail(t);
      return v;
    }
    if (t.kind === "OPEN") return this.parseProjectVariable();
    if (t.kind === "IDENTIFIER") {
      this.next();
      return { type: "literal", text: t.text, canonical: t.text };
    }
    this.fail(t);
  }

  private parseValueList(): Value<string>[] {
    return this.parseValueItems();
  }

  // -- token helpers ----------------------------------------------------

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }
  private at(kind: Token["kind"]): boolean {
    return this.peek()?.kind === kind;
  }
  private next(): Token {
    const t = this.tokens[this.i];
    if (!t) this.fail(undefined);
    this.i += 1;
    return t;
  }
  private expect(kind: Token["kind"]): Token {
    const t = this.peek();
    if (!t || t.kind !== kind) this.fail(t);
    return this.next();
  }
  private expectIdentifier(): string {
    const t = this.peek();
    if (!t || t.kind !== "IDENTIFIER") this.fail(t);
    return this.next().text;
  }
  private expectIdentifierLike(): string {
    const t = this.peek();
    if (!t || !IDENTIFIER_LIKE.has(t.kind)) this.fail(t);
    return this.next().text;
  }
  private expectEnd(): void {
    if (this.i < this.tokens.length) this.fail(this.peek());
  }
  private fail(t: Token | undefined): never {
    if (!t) throw new MqlSyntaxError("parse error: unexpected end of query");
    throw new MqlSyntaxError(`parse error on value "${t.text}" (${t.kind})`);
  }
}

function emptyQuery<C>(): Query<C> {
  return { select: null, asOf: null, from: null, where: null, groupBy: null, orderBy: null };
}

function valueText(v: Value<string>): string {
  return v.type === "literal" ? v.text : v.type === "projectVariable" ? v.name : "";
}

// ------------------------------------------------------------ resolver

const NUMERIC_FORMAT = /^[+-]?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/** Legacy predefined-name normalization: lowercase, non-word runs → "_". */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Which comparison family a property's values belong to. */
type ValueFamily = "number" | "date" | "user" | "text" | "enumerated" | "type" | "formula";

function familyOf(ref: PropertyRef): ValueFamily {
  if (ref.source === "predefined") {
    if (ref.key === "type") return "type";
    return ref.kind;
  }
  return ref.kind;
}

/** Human label for the kind, in legacy's "is a <type> property" phrasing. */
function describeKind(ref: PropertyRef): string {
  const family = familyOf(ref);
  return family === "type" ? "card type" : family;
}

class Resolver {
  readonly errors: string[] = [];
  private readonly byLowerName = new Map<string, MqlPropertyShape>();
  private readonly cardTypesByLower = new Map<string, string>();
  private readonly usersByLogin = new Map<string, number>();
  private readonly plvsByLower = new Map<string, MqlSchema["projectVariables"][number]>();

  constructor(schema: MqlSchema) {
    for (const p of schema.properties) this.byLowerName.set(p.name.toLowerCase(), p);
    for (const t of schema.cardTypes) this.cardTypesByLower.set(t.toLowerCase(), t);
    for (const u of schema.users) this.usersByLogin.set(u.login.toLowerCase(), u.id);
    for (const v of schema.projectVariables) this.plvsByLower.set(v.name.toLowerCase(), v);
  }

  private error(message: string): void {
    if (!this.errors.includes(message)) this.errors.push(message);
  }

  resolveQuery(q: SyntaxQuery, nested = false): MqlQuery {
    const out = emptyQuery<PropertyRef>();
    if (q.select) {
      out.select = {
        distinct: q.select.distinct,
        columns: q.select.columns.map((c) => this.resolveSelectColumn(c)),
      };
      if (nested) {
        const [only, ...more] = q.select.columns;
        if (more.length > 0 || !only || only.type !== "column") {
          this.error("A nested IN query must select exactly one property.");
        }
      }
    }
    if (q.asOf !== null) {
      if (!isIsoDate(q.asOf)) {
        this.error(`AS OF requires a date in yyyy-mm-dd format; '${q.asOf}' is not one.`);
      }
      out.asOf = q.asOf;
    }
    if (q.from) {
      if (q.from.trees.length > 1) {
        this.error("You cannot select more than one tree using the FROM TREE syntax.");
      }
      for (const tree of q.from.trees) {
        this.error(`Tree with name '${tree}' does not exist`);
      }
      out.from = { trees: [...q.from.trees] };
    }
    if (q.where) out.where = this.resolveCondition(q.where);
    if (q.groupBy) out.groupBy = q.groupBy.map((c) => this.resolveColumn(c, "GROUP BY"));
    if (q.orderBy) {
      out.orderBy = q.orderBy.map((o) => ({
        column: this.resolveColumn(o.column, "ORDER BY"),
        direction: o.direction,
      }));
    }
    return out;
  }

  private resolveSelectColumn(c: SelectColumn<string>): MqlSelectColumn {
    if (c.type === "column") return this.resolveColumn(c, "SELECT");
    if (!(MQL_AGGREGATE_FUNCTIONS as readonly string[]).includes(c.fn)) {
      this.error(`${c.fn} is not a recognized aggregate function.`);
    }
    if (c.column === null && c.fn !== "count") {
      this.error("* can only be used with the count aggregate function.");
    }
    return {
      type: "aggregate",
      fn: c.fn,
      column: c.column ? this.resolveColumn(c.column, "SELECT") : null,
    };
  }

  /**
   * Resolves a column name to a PropertyRef. Unknown names are recorded
   * as errors and yield a placeholder text ref so resolution can keep
   * collecting further errors; the result is discarded when errors exist.
   */
  private resolveColumn(c: Column<string>, clause: string): Column<PropertyRef> {
    return { type: "column", property: this.resolveProperty(c.property, clause) };
  }

  private resolveProperty(name: string, clause: string): PropertyRef {
    const defined = this.byLowerName.get(name.trim().toLowerCase());
    if (defined) {
      return { source: "defined", id: defined.id, name: defined.name, kind: defined.kind };
    }
    const key = normalizeName(name) as PredefinedPropertyKey;
    if (Object.hasOwn(MQL_PREDEFINED_PROPERTIES, key)) {
      const predefined = MQL_PREDEFINED_PROPERTIES[key];
      if (predefined.selectOnly && clause !== "SELECT") {
        this.error(`${predefined.name} can only be used in MQL SELECT statements, not in ${clause}.`);
      }
      return { source: "predefined", key, name: predefined.name, kind: predefined.kind };
    }
    this.error(`Card property '${name}' does not exist!`);
    return { source: "predefined", key: "name", name, kind: "text" };
  }

  private resolveCondition(c: Condition<string>): MqlCondition {
    switch (c.type) {
      case "and":
      case "or":
        return { type: c.type, left: this.resolveCondition(c.left), right: this.resolveCondition(c.right) };
      case "not":
        return { type: "not", operand: this.resolveCondition(c.operand) };
      case "taggedWith":
        this.error("TAGGED WITH is not supported yet: this Mingle has no card tags.");
        return { type: "taggedWith", tag: c.tag };
      case "inPlan":
        this.error("IN PLAN is not supported: program plans are not available in this Mingle.");
        return { type: "inPlan", plan: c.plan };
      case "inQuery": {
        const column = this.resolveColumn(c.column, "WHERE");
        return { type: "inQuery", column, query: this.resolveQuery(c.query, true) };
      }
      case "in": {
        const column = this.resolveColumn(c.column, "WHERE");
        if (c.byNumber) {
          for (const v of c.values) {
            if (v.type === "literal" && !NUMERIC_FORMAT.test(v.text)) {
              this.error(
                `${v.text} is not a valid value for ${column.property.name}. Only numbers can be used as values in a 'column NUMBERS IN (...)' clause.`,
              );
            }
          }
          this.error(
            `only card relationship properties or tree relationship properties can be used in '${column.property.name} NUMBERS IN (...)' clause`,
          );
          return { type: "in", column, byNumber: true, values: c.values.map((v) => this.passThrough(v)) };
        }
        return {
          type: "in",
          column,
          byNumber: false,
          values: c.values.map((v) => this.resolveValue(column.property, "=", v)),
        };
      }
      case "comparison": {
        const column = this.resolveColumn(c.column, "WHERE");
        return {
          type: "comparison",
          column,
          operator: c.operator,
          value: this.resolveValue(column.property, c.operator, c.value),
        };
      }
    }
  }

  /** Unresolved carry-through for values already rejected. */
  private passThrough(v: Value<string>): MqlValue {
    if (v.type === "thisCardProperty") {
      return { type: "thisCardProperty", column: this.resolveColumn(v.column, "WHERE") };
    }
    if (v.type === "property") {
      return { type: "property", column: this.resolveColumn(v.column, "WHERE") };
    }
    return v;
  }

  private resolveValue(left: PropertyRef, operator: MqlOperator, v: Value<string>): MqlValue {
    const family = familyOf(left);
    const ordinal = operator !== "=" && operator !== "!=";
    if (ordinal && family === "user") {
      this.error(`Operators > and < are not supported for user property ${left.name}.`);
    }
    if (ordinal && family === "type") {
      this.error(`Operators > and < are not supported for the ${left.name} property.`);
    }
    switch (v.type) {
      case "null":
        return v;
      case "today":
        if (family !== "date") {
          this.error(`${left.name} is a ${describeKind(left)} property; TODAY can only be compared with date properties.`);
        }
        return v;
      case "currentUser":
        if (family !== "user") {
          this.error(`${left.name} is a ${describeKind(left)} property; CURRENT USER can only be compared with user properties.`);
        }
        return v;
      case "thisCard":
        this.error(
          `only card relationship properties or tree relationship properties can be used in '${left.name} = THIS CARD' clause`,
        );
        return v;
      case "cardNumber":
        if (!NUMERIC_FORMAT.test(v.number)) {
          this.error(
            `${v.number} is not a valid value for ${left.name}. Only numbers can be used as values in a 'column = NUMBER ...' clause`,
          );
        }
        this.error(
          `only card relationship properties or tree relationship properties can be used in '${left.name} = NUMBER ...' clause`,
        );
        return v;
      case "thisCardProperty": {
        const column = this.resolveColumn(v.column, "WHERE");
        this.checkComparable(left, column.property);
        return { type: "thisCardProperty", column };
      }
      case "property": {
        const column = this.resolveColumn(v.column, "WHERE");
        this.checkComparable(left, column.property);
        return { type: "property", column };
      }
      case "projectVariable":
        return this.resolveProjectVariable(left, v.name);
      case "literal":
        return { type: "literal", text: v.text, canonical: this.canonicalLiteral(left, v.text) };
    }
  }

  /** "Numeric and date property values, if of the same type, can be compared." */
  private checkComparable(a: PropertyRef, b: PropertyRef): void {
    const fa = comparisonFamily(a);
    const fb = comparisonFamily(b);
    const numericOrDate = (f: ValueFamily) => f === "number" || f === "date";
    const compatible =
      fa === fb ||
      (fa === "formula" && numericOrDate(fb)) ||
      (fb === "formula" && numericOrDate(fa));
    if (!compatible) {
      this.error(
        `${a.name} (${describeKind(a)}) and ${b.name} (${describeKind(b)}) are not the same type and cannot be compared.`,
      );
    }
  }

  private resolveProjectVariable(left: PropertyRef, name: string): MqlValue {
    const plv = this.plvsByLower.get(name.toLowerCase());
    if (!plv) {
      this.error(`The project variable (${name}) does not exist`);
      return { type: "projectVariable", name, value: null };
    }
    const family = familyOf(left);
    const compatible: Record<ProjectVariableDataType, ValueFamily[]> = {
      StringType: ["text", "enumerated", "type"],
      NumericType: ["number", "formula"],
      DateType: ["date", "formula"],
      UserType: ["user"],
      CardType: [],
    };
    if (!(compatible[plv.dataType] ?? []).includes(family)) {
      this.error(
        `Project variable (${plv.name}) is a ${plv.dataType.replace(/Type$/, "").toLowerCase()} variable and cannot be compared with ${left.name} (${describeKind(left)}).`,
      );
    }
    return { type: "projectVariable", name: plv.name, value: plv.value };
  }

  /**
   * Type-checks a literal against the property's kind and returns the
   * stored form. Legacy phrasing: "<name> is a <type> property, and
   * value <v> is not <type>."
   */
  private canonicalLiteral(left: PropertyRef, text: string): string {
    const family = familyOf(left);
    const lower = text.toLowerCase();
    if (family === "user" && lower === "current user") {
      this.error(
        `${left.name} is a user property, and value ${text} is not user. To use CURRENT USER do not enclose in any quotes or parenthesis.`,
      );
      return text;
    }
    if (family === "date" && lower === "today") {
      this.error(
        `${left.name} is a date property, and value ${text} is not date. To use TODAY do not enclose in any quotes or parenthesis.`,
      );
      return text;
    }
    switch (family) {
      case "number":
        if (!NUMERIC_FORMAT.test(text)) {
          this.error(`${left.name} is a number property, and value ${text} is not number.`);
        }
        return text;
      case "date":
        if (!isIsoDate(text)) {
          this.error(`${left.name} is a date property, and value ${text} is not date (use yyyy-mm-dd).`);
        }
        return text;
      case "formula":
        if (!NUMERIC_FORMAT.test(text) && !isIsoDate(text)) {
          this.error(`${left.name} is a formula property, and value ${text} is neither number nor date.`);
        }
        return text;
      case "user": {
        const id = this.usersByLogin.get(lower);
        if (id === undefined) {
          this.error(`${left.name} is a user property, and value ${text} is not a team member's login.`);
          return text;
        }
        return String(id);
      }
      case "enumerated": {
        const shape = left.source === "defined" ? this.byLowerName.get(left.name.toLowerCase()) : undefined;
        const match = shape?.values?.find((v) => v.toLowerCase() === lower);
        if (match === undefined) {
          this.error(`${left.name} is a managed text property, and value ${text} is not one of its values.`);
          return text;
        }
        return match;
      }
      case "type": {
        const match = this.cardTypesByLower.get(lower);
        if (match === undefined) {
          this.error(`Card type ${text} does not exist in this project.`);
          return text;
        }
        return match;
      }
      case "text":
        return text;
    }
  }
}

/** Family used for property-to-property comparisons (formula is a wildcard). */
function comparisonFamily(ref: PropertyRef): ValueFamily {
  const family = familyOf(ref);
  return family === "enumerated" ? "text" : family;
}

// -------------------------------------------------------------- public

/**
 * Parses and resolves an MQL string against a project's schema.
 *
 * An empty or whitespace-only string is a valid empty query (legacy
 * `CardQuery.parse("")`): all clauses null. A lexer or grammar failure
 * yields a single "parse error ..." message; a resolvable-but-invalid
 * query yields every semantic error found, in source order, so a user
 * fixes them in one pass. Never returns a query alongside errors.
 *
 * @param text - the MQL string as typed
 * @param schema - the project's properties, card types, users, variables
 * @returns the resolved typed AST, or the specific errors
 */
export function parseMql(text: string, schema: MqlSchema): MqlParseResult {
  const tokens = lex(text ?? "");
  if (typeof tokens === "string") return { ok: false, errors: [tokens] };
  let syntax: SyntaxQuery;
  try {
    syntax = new Parser(tokens).parseTarget();
  } catch (e) {
    if (e instanceof MqlSyntaxError) return { ok: false, errors: [e.message] };
    throw e;
  }
  const resolver = new Resolver(schema);
  const query = resolver.resolveQuery(syntax);
  if (resolver.errors.length > 0) return { ok: false, errors: resolver.errors };
  return { ok: true, query };
}
