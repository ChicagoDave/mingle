/**
 * API pagination — cursor paging for the /api/v1 collection routes (P-1).
 *
 * Purpose: every collection answers an `ApiPage<T>` — a `limit`-sized
 * slice of `items` plus a `nextCursor` to ask for the rest. Cursors are
 * keyset cursors, not offsets: a cursor is the (opaque, base64url-JSON)
 * sort key of the last item served, and the next page is the items
 * whose key sorts after it. A row inserted or deleted between two
 * requests therefore never shifts or repeats items, which offset
 * paging cannot promise. This is a deliberate departure from legacy's
 * `page=` parameter (proposal P-1); the port has no page numbers.
 *
 * Invariants: `limit` is an integer in [1, MAX_LIMIT] (a request above
 * the maximum is clamped, a non-integer or non-positive one is 400);
 * a cursor is an array of strings and numbers (anything else is 400);
 * rows handed to `keysetPage` are already in the collection's order
 * and `keyOf` yields keys ascending in that same order.
 *
 * Public interface: `readPageParams`, `keysetPage`, `encodeCursor`,
 * `DEFAULT_LIMIT`, `MAX_LIMIT`, `PageParams`, `CursorKey`.
 *
 * Owner context: Public API (HTTP adapter).
 */
import { apiError } from "~/api/http.server";
import type { ApiPage } from "~/shared/wire-types";

/** Items per page when `limit` is absent. */
export const DEFAULT_LIMIT = 50;
/** The largest page a client may ask for; larger requests are clamped. */
export const MAX_LIMIT = 200;

/** A sort key: the tuple that orders one item within its collection. */
export type CursorKey = (string | number)[];

/** The paging request: how many, and after which key. */
export interface PageParams {
  limit: number;
  cursor: CursorKey | null;
}

/**
 * Encodes a sort key as an opaque cursor token.
 *
 * @param key - the item's sort key
 */
export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** Decodes a cursor token, or throws a 400 when it is not one of ours. */
function decodeCursor(token: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw apiError(400, "'cursor' is not a cursor this API issued");
  }
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string" && typeof part !== "number"))
    throw apiError(400, "'cursor' is not a cursor this API issued");
  return parsed as CursorKey;
}

/**
 * Reads `limit` and `cursor` from a collection request's URL.
 *
 * @param url - the request URL
 * @returns the page parameters
 * @throws a 400 JSON Response when `limit` is not a positive integer or
 *   `cursor` is not a token this API issued
 */
export function readPageParams(url: URL): PageParams {
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) throw apiError(400, "'limit' must be a positive integer");
    limit = Math.min(Number(rawLimit), MAX_LIMIT);
  }
  const rawCursor = url.searchParams.get("cursor");
  return { limit, cursor: rawCursor === null || rawCursor === "" ? null : decodeCursor(rawCursor) };
}

/** Lexicographic comparison of two sort keys (numbers numerically, strings by code unit). */
function compareKeys(a: CursorKey, b: CursorKey): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
    return String(left) < String(right) ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Slices one page out of an ordered collection.
 *
 * @param rows - the whole collection in its wire order
 * @param params - the page requested
 * @param keyOf - the sort key of a row; must ascend along `rows`
 * @returns the page after the cursor, and the cursor for the page after
 *   that (null when this page is the last)
 */
export function keysetPage<T>(rows: T[], params: PageParams, keyOf: (row: T) => CursorKey): ApiPage<T> {
  const after = params.cursor;
  const remaining = after === null ? rows : rows.filter((row) => compareKeys(keyOf(row), after) > 0);
  const items = remaining.slice(0, params.limit);
  const hasMore = remaining.length > params.limit;
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? encodeCursor(keyOf(items[items.length - 1])) : null,
  };
}
