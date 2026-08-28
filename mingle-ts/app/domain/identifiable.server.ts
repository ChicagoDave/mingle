/**
 * Identifier kernel — the legacy `Identifiable` slug rules shared by
 * every aggregate that carries a URL identifier (projects, programs,
 * objectives).
 *
 * Purpose: one implementation of "lowercase `[0-9a-z_]`, max 30, no
 * leading digit" and of the derive-from-name-then-suffix-until-unique
 * generator (legacy `Identifiable` + `generate_identifier`), so no
 * bounded context imports another's command module just to slug a
 * name. Uniqueness is the caller's concern — each aggregate scopes it
 * differently (projects and programs across the install, objectives
 * within their program) — so the generator takes a probe.
 *
 * Public interface: `IDENTIFIER_MAX_LENGTH`, `identifierRuleError`,
 * `generateIdentifier`.
 *
 * Owner context: cross-context infrastructure (domain kernel).
 */

/** Legacy Identifiable::IDENTIFIER_MAX_LEN (the Oracle column limit it was sized for). */
export const IDENTIFIER_MAX_LENGTH = 30;
const IDENTIFIER_FORMAT = /^[0-9a-z_]+$/;

/**
 * Validates an explicitly supplied identifier against the shared rules
 * (length, character set, leading digit). Uniqueness and any
 * aggregate-specific reservations are checked by the caller.
 *
 * @param identifier - the candidate slug
 * @returns an error message in legacy phrasing, or null when valid
 */
export function identifierRuleError(identifier: string): string | null {
  if (identifier.length > IDENTIFIER_MAX_LENGTH)
    return `is too long (maximum is ${IDENTIFIER_MAX_LENGTH} characters)`;
  if (!IDENTIFIER_FORMAT.test(identifier))
    return "may contain only lower case letters, numbers and underscore ('_')";
  if (/^\d/.test(identifier)) return "may not start with a digit";
  return null;
}

/**
 * Generates a unique identifier from a display name: non-alphanumerics
 * become "_", lowercased, `digitPrefix` prepended when the result would
 * start with a digit, truncated to the maximum length, then suffixed
 * with 2, 3, … until the probe says it is free.
 *
 * @param name - the display name to derive from
 * @param isTaken - uniqueness probe in the caller's scope
 * @param options.digitPrefix - prefix used when the slug would start with a digit (legacy `project_` / `objective_`)
 * @param options.fallback - slug used when nothing survives the transform
 * @returns a valid, untaken identifier
 */
export function generateIdentifier(
  name: string,
  isTaken: (candidate: string) => boolean,
  options: { digitPrefix: string; fallback: string },
): string {
  let candidate = name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  if (/^\d/.test(candidate)) candidate = `${options.digitPrefix}${candidate}`;
  candidate = candidate.slice(0, IDENTIFIER_MAX_LENGTH).replace(/^_+|_+$/g, "");
  if (!candidate) candidate = options.fallback;
  let unique = candidate;
  let n = 1;
  while (isTaken(unique)) {
    const suffix = String(++n);
    unique = candidate.slice(0, IDENTIFIER_MAX_LENGTH - suffix.length) + suffix;
  }
  return unique;
}
