/**
 * Cross-context reference grammar — how a `#123` card reference is
 * spelled in free text.
 *
 * Purpose: two bounded contexts read the same token out of text
 * authored by a user. Wiki & Content turns it into a link while
 * rendering a page body (ADR-0011: references are stored as literal
 * text and resolved at render); Collaboration reads it out of a murmur
 * to write the card/murmur links legacy kept in `card_murmur_links`.
 * A second copy of the pattern would let a page and a murmur disagree
 * about the same characters — the class of failure ADR-0015 and
 * ADR-0016 were written about — so the grammar lives here, once, and
 * both contexts import it.
 *
 * This module knows nothing about cards, pages, or the database. It
 * defines a spelling, not a resolution: whether a referenced number
 * names a real card is each caller's question to ask.
 *
 * Public interface: `CARD_REFERENCE`, `cardNumbersInText`.
 *
 * Owner context: cross-context infrastructure (domain kernel), beside
 * command.server.ts and events.server.ts.
 */

/**
 * Matches a `#123` card reference that is not glued to a preceding
 * word character, `&`, or `#` — so "abc#7" and the HTML entity tail in
 * "&#39;" are not references. Group 1 is the separator that was
 * consumed (possibly empty, at the start of the text) and group 2 is
 * the digits; callers doing offset arithmetic must account for group
 * 1's length.
 *
 * Global, so every use must either be `matchAll` or reset `lastIndex`.
 */
export const CARD_REFERENCE = /(^|[^\w&#])#(\d+)/g;

/**
 * The distinct card numbers a run of plain text references, in the
 * order they first appear.
 *
 * @param text - plain text; markup is not interpreted, so a caller
 *   holding HTML should walk its text nodes instead (see
 *   `referencedCardNumbers` in app/domain/pages/content.server.ts)
 * @returns each referenced number once
 */
export function cardNumbersInText(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(CARD_REFERENCE)) found.add(Number(match[2]));
  return [...found];
}
