/**
 * API HTTP helpers — the JSON envelope and status mapping for /api/v1.
 *
 * Purpose: every API route answers in one shape. Successes are the
 * resource itself; failures are `ApiErrorBody`. A command rejection
 * maps to 403 when the checkpoint refused the actor and 422 otherwise,
 * so a client can tell "not allowed" from "invalid" without parsing
 * messages. Body parsing is strict: a request body must be a JSON
 * object, and typed fields are checked rather than coerced.
 *
 * Public interface: `jsonResponse`, `apiError`, `rejectionResponse`,
 * `commandResponse`, `methodNotAllowed`, `readJsonObject`,
 * `optionalString`, `requiredString`, `optionalStringMap`.
 *
 * Owner context: Public API (HTTP adapter).
 */
import type { CommandResult } from "~/domain/command.server";
import type { ApiErrorBody, FieldErrors } from "~/shared/wire-types";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * A JSON response.
 *
 * @param body - serialized with JSON.stringify
 * @param status - HTTP status, default 200
 * @param headers - extra headers merged over the content type
 */
export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * An error response in the `ApiErrorBody` shape.
 *
 * @param status - HTTP status
 * @param error - one human-readable line
 * @param errors - field-keyed command rejections, when there are any
 * @param headers - extra headers (e.g. the 401 challenge)
 */
export function apiError(
  status: number,
  error: string,
  errors?: FieldErrors,
  headers: HeadersInit = {},
): Response {
  const body: ApiErrorBody = errors ? { error, errors } : { error };
  return jsonResponse(body, status, headers);
}

/**
 * Maps a command rejection to a response: 403 when the authorization
 * checkpoint refused the actor (its rejections are keyed
 * "authorization"), 422 for every other validation failure.
 *
 * @param errors - the command's field errors
 */
export function rejectionResponse(errors: FieldErrors): Response {
  if (errors.authorization) return apiError(403, errors.authorization.join("; "), errors);
  return apiError(422, "Validation failed", errors);
}

/**
 * Turns a command result into a response: the serialized value with
 * the given status on success, `rejectionResponse` otherwise.
 *
 * @param result - the command outcome
 * @param status - success status (200, 201)
 * @param serialize - value → response body
 */
export function commandResponse<T>(
  result: CommandResult<T>,
  status: number,
  serialize: (value: T) => unknown,
): Response {
  return result.ok ? jsonResponse(serialize(result.value), status) : rejectionResponse(result.errors);
}

/**
 * A 405 naming the methods the resource supports.
 *
 * @param allowed - e.g. ["GET", "POST"]
 */
export function methodNotAllowed(allowed: string[]): Response {
  return apiError(405, `Method not allowed; use ${allowed.join(", ")}`, undefined, { Allow: allowed.join(", ") });
}

/**
 * Parses the request body as a JSON object.
 *
 * @throws a 400 Response when the body is not valid JSON or not an object
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw apiError(400, "Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw apiError(400, "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Reads an optional string field: absent → undefined, null → null,
 * string → the string.
 *
 * @throws a 400 Response when present with another type
 */
export function optionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null || typeof value === "string") return value;
  throw apiError(400, `'${field}' must be a string`);
}

/**
 * Reads a required string field.
 *
 * @throws a 400 Response when absent, null, or not a string
 */
export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw apiError(400, `'${field}' is required and must be a string`);
  return value;
}

/**
 * Reads an optional object of string-or-null values (e.g. `properties`).
 *
 * @throws a 400 Response when present but not such an object
 */
export function optionalStringMap(
  body: Record<string, unknown>,
  field: string,
): Record<string, string | null> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw apiError(400, `'${field}' must be an object of string values`);
  const out: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw !== null && typeof raw !== "string") throw apiError(400, `'${field}.${key}' must be a string or null`);
    out[key] = raw;
  }
  return out;
}
