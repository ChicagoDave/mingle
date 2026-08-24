/**
 * Domain event emission — the single writer of `domain_events`.
 *
 * Purpose: gives every command handler one way to record the fact it
 * produced (rule 10). Emission happens on the same connection as the
 * state change, so callers that wrap both in a transaction get
 * atomicity for free.
 *
 * Public interface: `emitEvent`.
 *
 * Owner context: cross-context infrastructure (event store adapter).
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { domainEvents } from "~/db/schema/events";

/** Facts a command handler records about a produced event. */
export interface DomainEventInput {
  /** Past-tense event name, e.g. "UserRegistered". */
  type: string;
  aggregateType: string;
  aggregateId: number;
  /** JSON-serializable facts. Never include secrets or password material. */
  payload: Record<string, unknown>;
  actorUserId?: number | null;
}

/**
 * Appends one event row to domain_events.
 *
 * @param db - the Drizzle handle the surrounding command is using
 * @param event - the event facts
 */
export function emitEvent(
  db: BetterSQLite3Database,
  event: DomainEventInput,
): void {
  db.insert(domainEvents)
    .values({
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: JSON.stringify(event.payload),
      actorUserId: event.actorUserId ?? null,
    })
    .run();
}
