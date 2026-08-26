/**
 * Wiki & Content — page naming rules and the name/identifier mapping.
 *
 * Purpose: a page is addressed in URLs by its *identifier* — its name
 * with spaces replaced by underscores (legacy `Page.name2identifier` /
 * `Page.identifier2name`) — and validated by the legacy
 * `Page.validate_page_name` rules. Both the write path (commands) and
 * the render path (content substitution) need these, so they live in
 * their own module rather than in either one, keeping the dependency
 * acyclic.
 *
 * Public interface: `PAGE_NAME_MAX_LENGTH`, `pageIdentifier`,
 * `pageNameFromIdentifier`, `pageNameError`.
 *
 * Owner context: Wiki & Content.
 */

/** Legacy `use_database_limits_for_all_attributes` cap on page names. */
export const PAGE_NAME_MAX_LENGTH = 255;

/**
 * Converts a page name to its URL identifier (legacy
 * `Page.name2identifier`): spaces become underscores.
 *
 * @param name - the page's display name
 */
export function pageIdentifier(name: string): string {
  return name.replace(/ /g, "_");
}

/**
 * Converts a URL identifier back to a page name (legacy
 * `Page.identifier2name`): underscores become spaces.
 *
 * @param identifier - the identifier taken from the URL
 */
export function pageNameFromIdentifier(identifier: string): string {
  return identifier.replace(/_/g, " ");
}

/**
 * Validates a page name against the legacy rules
 * (`Page.validate_page_name` plus validates_presence_of :name).
 *
 * @param name - the candidate name, already trimmed by the caller
 * @returns the legacy error message, or null when the name is usable
 */
export function pageNameError(name: string): string | null {
  if (!name) return "Name can't be blank.";
  if (name.includes("/"))
    return `The page name ${name} contains at least one invalid character.`;
  if (name.length > PAGE_NAME_MAX_LENGTH) return "The page name is too long.";
  return null;
}
