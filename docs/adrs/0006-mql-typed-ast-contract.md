# ADR-0006: MQL parses to a resolved, typed AST; unsupported constructs are rejected by name

**Status**: ACCEPTED

## Context

Phase 12 rebuilt the MQL parser in TypeScript. Legacy Mingle's
`CardQuery` parsed and resolved in one step (racc grammar actions
instantiated `Column` objects that looked up the property definition
immediately) and evaluated by generating SQL text. Every later MQL
consumer — the advanced filter (Phase 13), chart macros (Phases 17–19),
the daily history chart (Phase 18), execute_mql API — needs the same
parse. The choices were: what the parser hands downstream, how much of
the legacy grammar to accept while trees, tags, plans, and card
relationship properties do not yet exist in this rewrite, and where
type-checking of literal values happens.

## Decision

- **The parser's output is a resolved, typed AST** (`MqlQuery` in
  `mingle-ts/app/domain/cards/mql.server.ts`), never a name-keyed
  syntax tree. Every column node carries a `PropertyRef`: a definition
  `id` + `kind` for managed properties, or a `predefined` key for the
  six definition-less properties (Type, Name, Number, Created On,
  Modified On, Project — Project is SELECT-only). Consumers never
  resolve names themselves (ADR-0004: MQL evaluates against
  `card_property_values` by definition id).
- **Literals carry a `canonical` stored form** decided at parse time
  from the property kind: enumeration value in defined casing, user id
  for a login, card-type name in defined casing, validated numeric
  string, ISO date. Evaluators compare canonical values to stored
  values directly and never re-validate.
- **Context-dependent values stay symbolic**: `CURRENT USER`, `TODAY`,
  `THIS CARD`, `THIS CARD.prop` are AST nodes bound by the evaluator
  from its execution context, not by the parser.
- **The full legacy `card_query.grammar` surface is accepted by the
  grammar** (FROM TREE, TAGGED WITH, IN PLAN, NUMBER n, NUMBERS IN,
  THIS CARD, nested IN (SELECT …), project variables). Constructs whose
  backing model does not exist yet are **rejected by the resolver with
  a specific message**, never silently dropped or parsed as a literal.
  When trees (Phase 23), tags, or plans arrive, only the resolver rule
  changes — the grammar and AST shape do not.
- **The AST is generic over the column type** (`Query<C>`): `string`
  for the unresolved parse, `PropertyRef` for the resolved result. One
  set of node types, no duplicated syntax/semantic trees.
- **Error contract**: lexer or grammar failure returns exactly one
  `parse error …` message; semantic failures return every error found
  in source order, deduplicated, in legacy wording where legacy had
  wording (`Card property 'X' does not exist!`, the quoted
  TODAY / CURRENT USER hints, the relationship-only NUMBER / THIS CARD
  clause messages). A result is never a query plus errors.
- The pure parser takes an `MqlSchema` value; loading it from the
  database is a separate adapter (`mql-schema.server.ts`). The parser
  has no infrastructure imports.

## Consequences

- Phase 13's evaluator translates `MqlQuery` to a Drizzle query by
  switching on `PropertyRef.source`/`kind` and comparing `canonical`
  values — no name lookups, no literal parsing. The same holds for
  chart macros and the daily-history reconstruction.
- Enabling a deferred construct means deleting its resolver rejection
  and adding evaluator support; the corpus tests that assert the
  rejection message flip to assert the resolved shape.
- Rename semantics: because the AST is id-keyed, a stored MQL *string*
  (saved view filter, macro body) still names properties by text. The
  legacy `MqlGeneration` rewrite-on-rename is a separate, future
  deliverable that re-generates text from an AST; the AST shape here
  must stay round-trippable to text (every node retains its source
  literal `text`).
- The bare date literal (`2026-01-01` unquoted) is accepted, following
  legacy `mql.grammar`'s lexer rather than `card_query.grammar`'s; this
  is strictly more permissive than what CardQuery accepted.
- Anyone adding an AST node type must add it to the resolver switch;
  TypeScript's exhaustiveness on the discriminated unions enforces this
  at compile time.

## Session

2026-08-25 (session 9ef269, Phase 12 — MQL parser).
