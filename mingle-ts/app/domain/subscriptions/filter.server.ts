/**
 * Collaboration — what a history subscription watches (Phase 22).
 *
 * Purpose: the one definition of a subscription's filter: its typed
 * shape, its comparable key (legacy `hashed_filter_params`), its human
 * description, and how an MQL filter is parsed. Both the write side
 * (subscribe validates and keys) and the delivery side (notify
 * re-parses at send time, since a property may have been renamed
 * since) read this module, so they cannot drift on what "the same
 * subscription" or "a valid filter" means.
 *
 * Public interface: `SubscriptionFilter`, `filterOf`, `filterKeyOf`,
 * `describeFilter`, `parseMqlFilter`, `MqlFilterParse`.
 *
 * Owner context: Collaboration.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { HistorySubscriptionRow } from "~/db/schema/subscriptions";
import { conditionUsesThisCard } from "~/domain/cards/mql-evaluator.server";
import type { MqlCondition } from "~/domain/cards/mql.server";
import { parseProjectMql } from "~/domain/cards/mql-schema.server";
import { pageNameFromIdentifier } from "~/domain/pages/naming.server";

/** A subscription's filter, one variant per SUBSCRIPTION_KINDS entry. */
export type SubscriptionFilter =
  | { kind: "project" }
  | { kind: "card"; cardNumber: number }
  | { kind: "page"; pageIdentifier: string }
  | { kind: "mql"; mql: string };

/**
 * The filter a stored row encodes.
 *
 * @throws Error when the row's kind and columns disagree — the write
 *   side guarantees they do not, so this is a corrupted row, not input
 */
export function filterOf(row: HistorySubscriptionRow): SubscriptionFilter {
  switch (row.kind) {
    case "project":
      return { kind: "project" };
    case "card":
      if (row.cardNumber === null) break;
      return { kind: "card", cardNumber: row.cardNumber };
    case "page":
      if (row.pageIdentifier === null) break;
      return { kind: "page", pageIdentifier: row.pageIdentifier };
    case "mql":
      if (row.mql === null) break;
      return { kind: "mql", mql: row.mql };
  }
  throw new Error(`history subscription ${row.id} has kind "${row.kind}" without its filter value`);
}

/**
 * The comparable form of a filter: two filters that watch the same
 * thing produce the same key. Page identifiers compare
 * case-insensitively, as page lookup does; MQL compares with
 * whitespace collapsed and case folded, so "type = Story" and
 * "TYPE  =  story" are one subscription, not two.
 */
export function filterKeyOf(filter: SubscriptionFilter): string {
  switch (filter.kind) {
    case "project":
      return "project";
    case "card":
      return `card:${filter.cardNumber}`;
    case "page":
      return `page:${filter.pageIdentifier.toLowerCase()}`;
    case "mql":
      return `mql:${filter.mql.replace(/\s+/g, " ").trim().toLowerCase()}`;
  }
}

/**
 * The wording the subscriptions page and the email footer use
 * (legacy `HistorySubscription#description`).
 *
 * @param filter - the filter to describe
 * @param projectName - the project's display name
 */
export function describeFilter(filter: SubscriptionFilter, projectName: string): string {
  switch (filter.kind) {
    case "project":
      return `${projectName} history`;
    case "card":
      return `Card #${filter.cardNumber}`;
    case "page":
      return `Page ${pageNameFromIdentifier(filter.pageIdentifier)}`;
    case "mql":
      return `Cards matching "${filter.mql}"`;
  }
}

/** The outcome of parsing a subscription's MQL text. */
export type MqlFilterParse =
  | { ok: true; condition: MqlCondition | null }
  | { ok: false; errors: string[] };

/**
 * Parses an MQL filter for a subscription: a bare condition such as
 * `Type = Story AND Status != Closed`. The same conditions-only rule
 * the card list applies holds here — SELECT, GROUP BY, ORDER BY and
 * AS OF make a query, not a filter, and THIS CARD has no card to bind
 * to — so a subscription and a filtered list cannot disagree about
 * what counts as a filter.
 *
 * @param db - the Drizzle handle
 * @param projectId - the project whose schema resolves property names
 * @param mql - the filter text
 * @returns the resolved condition (null for an empty filter, which
 *   matches every card), or the errors
 */
export function parseMqlFilter(
  db: BetterSQLite3Database,
  projectId: number,
  mql: string,
): MqlFilterParse {
  const parsed = parseProjectMql(db, projectId, mql);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const { query } = parsed;
  if (query.select || query.groupBy || query.orderBy || query.asOf !== null) {
    return {
      ok: false,
      errors: ["A subscription filter is a condition only — no SELECT, GROUP BY, ORDER BY or AS OF."],
    };
  }
  if (query.where && conditionUsesThisCard(query.where)) {
    return { ok: false, errors: ["THIS CARD is not supported in subscription filters."] };
  }
  return { ok: true, condition: query.where ?? null };
}
