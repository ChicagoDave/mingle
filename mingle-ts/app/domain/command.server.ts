/**
 * Command outcome kernel — the uniform result shape every command
 * handler returns.
 *
 * Purpose: gives all bounded contexts one way to say "the command
 * succeeded with this value" or "the command was rejected with these
 * field errors" (rule 10: a command produces an event or explicitly
 * rejects). Lives outside any single context so contexts never import
 * each other for this shape.
 *
 * Public interface: `CommandResult`, `reject`.
 *
 * Owner context: cross-context infrastructure (domain kernel).
 */
import type { FieldErrors } from "~/shared/wire-types";

/** Uniform command outcome: a value, or field-keyed rejection errors. */
export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldErrors };

/**
 * Builds a single-field rejection result.
 *
 * @param field - the input field the error is keyed on
 * @param message - human-readable message in legacy Mingle's phrasing
 */
export function reject<T>(field: string, message: string): CommandResult<T> {
  return { ok: false, errors: { [field]: [message] } };
}
