/**
 * Domain events schema — the append-only `domain_events` table.
 *
 * Purpose: every command handler records the fact it produced (rule 10:
 * a command yields at least one event or rejects — silent state changes
 * are bugs). This table is the durable record of those facts and, in
 * later phases, feeds the history feed, murmurs, and subscriptions.
 *
 * Public interface: `domainEvents` (Drizzle table), written only through
 * app/domain/events.server.ts.
 *
 * Owner context: cross-context infrastructure (event store).
 *
 * INVARIANT — append-only: rows are never updated or deleted by
 * application code.
 */
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

export const domainEvents = sqliteTable(
  "domain_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Past-tense event name, e.g. "UserRegistered" (rule 10). */
    type: text("type").notNull(),
    /** Aggregate the event belongs to, e.g. "User". */
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: integer("aggregate_id").notNull(),
    /** JSON payload — the event's facts, never secrets or password material. */
    payload: text("payload").notNull(),
    /** Acting user, when the action had one (null for system actions). */
    actorUserId: integer("actor_user_id"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("domain_events_aggregate_idx").on(t.aggregateType, t.aggregateId)],
);

export type DomainEventRow = typeof domainEvents.$inferSelect;
