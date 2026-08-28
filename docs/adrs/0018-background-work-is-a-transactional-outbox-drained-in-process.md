# ADR-0018: Background work is a transactional outbox drained in-process

**Status**: ACCEPTED

## Context

ADR-0002 replaced pg-boss with "a SQLite-backed jobs table drained by an
in-process worker, established when first needed". Phase 22 (email and
subscription notifications) was the first phase that needed it, so the
queue's actual shape was decided there — and every later background
job (search indexing, program sync, murmur-mention delivery, scheduled
cleanups) will inherit that shape. This ADR records it so those phases
do not re-decide it.

Phase 22 also had to decide what a notification is *about*. The
Phase 21 history feed already settled that user-facing history is
projected over the version trails (`card_versions`, `page_versions`,
`murmurs`) and never over `domain_events`, because the event table is
command-shaped and carries no snapshot. Notifications are a second
reader of history, so the same question came up again, along with a
new one: how a reader that must deliver *each entry once* keeps its
place in three trails that share no sequence.

## Decision

### 1. A job is written on the command's own transaction (transactional outbox)

`enqueueJob(tx, …)` is called with the transaction the command is
already using, in the same block that writes the domain row. The job
commits with the change that needs it and cannot outlive a rollback.
There is no separate "publish after commit" step and no broker.

### 2. "Schedule once, however many changes ask" is a database fact

`jobs.dedupe_key` carries a partial unique index `WHERE status =
'pending' AND dedupe_key IS NOT NULL`. A second enqueue with the same
key while the first is still pending is absorbed by `ON CONFLICT DO
NOTHING` and returns null. A *running* job does not block a new
pending one, because the running one may have read its inputs before
the latest change. Dedupe is never a check-then-insert in application
code.

### 3. Delivery is at-least-once; handlers must be re-runnable

`runPendingJobs` claims exclusively (select + update in one SQLite
transaction — the single-writer model is what makes a claim exclusive),
runs the handler, and always writes the outcome back to the row: `done`;
`pending` again with `run_at` pushed out by a quadratic backoff
(30s · attempt²) and `last_error`; or `failed` once `attempts` reaches
`max_attempts` — immediately for a job type with no registered handler,
since retrying cannot make a handler appear. A process that dies
mid-job leaves the row `running`; `recoverStaleJobs` returns it to
`pending` at the next start. A handler that cannot tolerate running
twice for the same input is a bug in the handler, not in the queue.

### 4. One worker per process, started from the server entry

`ensureJobWorker` runs the drain loop on a timer inside the web process
(unref'd, non-overlapping ticks). It is started from
`app/entry.server.tsx` — the one module every server process evaluates
once per boot — behind a `globalThis` guard so the dev server's module
reloads cannot start a second loop. There is deliberately no worker
process: the install story is one container with one volume (ADR-0002),
and a second process would need its own supervision and connection for
no benefit at single-node scale.

### 5. Domain code requests background work through kernel modules, never by importing the consumer

A command that needs follow-up work calls a one-line cross-context
kernel function (`app/domain/notifications.server.ts`'s
`scheduleHistoryNotification`, placed exactly where `events.server.ts`
is) that enqueues a job by type. The context that *handles* the job
registers its handler in `app/jobs/handlers.server.ts`, the single
dispatch table. Cards, Wiki & Content, and Collaboration therefore
request notification delivery without importing the Subscriptions
context. The alternatives were rejected: hooking `emitEvent` would
couple the event store to the queue; a periodic poll would mean a
change does not *cause* its follow-up.

### 6. Job handlers resolve infrastructure from the environment; domain delivery takes interfaces

Domain delivery (`deliverHistoryNotifications`) takes a `Mailer`
interface it owns and never imports nodemailer. The handler in the
registry builds the SMTP mailer from `SMTP_HOST` / `SMTP_PORT` /
`SMTP_FROM` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` and the
site root from `SITE_URL`, the same way `DATABASE_FILE` configures
storage. `SMTP_HOST` unset makes the job fail with that message on the
row — the deployment has not been given a mail server, and the queue
records that rather than dropping the work.

### 7. Notifications read the version trails through the feed's projection, with per-trail cursors

Delivery reads `historyEntriesAfter`, the same union query the in-app
feed and the Atom feed read, so a subscriber is told about exactly what
the feed would show them; it never reads `domain_events` (ADR-0004's
historical values, Phase 21's reasoning). Because the three trails have
independent id spaces and no shared sequence, a subscription keeps
three cursors — the highest `card_versions.id`, `page_versions.id` and
`murmurs.id` already considered — rather than one timestamp, which
same-millisecond ties would make ambiguous. A new subscription starts
at the current end of every trail (legacy `last_max_*` at creation).
A cursor advances only after the relay accepted the email, and to the
batch end afterwards, so a mid-batch refusal resends only what was not
accepted — the duplicate is the cheaper failure, a silently lost
notification the one a subscriber cannot detect.

### 8. Mail is verified against a real SMTP server, not a stubbed mailer

The compose stack carries a Mailpit service, the app's SMTP_* point at
it, and the phase's acceptance test (`notifications.real.test.ts`)
drives the real command, the real jobs row, the real worker loop, the
real handler registry and the real nodemailer transport, then reads
the message back out of Mailpit's HTTP API (rule 13a: the queue is an
owned dependency). A capturing `Mailer` is acceptable in scaffolding
suites only because that test exists.

## Consequences

- Every future background job follows the same recipe: enqueue on the
  command's `tx` through a kernel function, register a handler in
  `handlers.server.ts`, make the handler idempotent, and — if it talks
  to the outside world — give the domain function an interface and
  build the adapter from the environment in the handler.
- Dedupe is per key while pending. Work that must run once *per
  change* (not once per burst) must not set a dedupe key; work that
  must run once per burst sets one and reads its inputs from the
  database, never from the payload alone.
- The queue has no priority, no fairness across types, and no
  cross-process coordination. Those are fine at one node; a multi-node
  deployment would be a migration to a broker, not a config flag —
  the same stance ADR-0002 took for the database.
- Operators have no page for the `jobs` table yet; a failed job is
  visible only in SQLite. That is an acknowledged gap, not a decision.
- The three-cursor design means any new history trail (a `revision`
  trail for SCM, if it is ever built) adds a cursor column to
  `history_subscriptions` and a branch to the union — the cost of
  projecting over trails instead of duplicating them into one table,
  first paid in Phase 21 and paid again here.
- MQL subscription filters are evaluated against the card as it stands
  now, not against the version snapshot; a deletion cannot match an
  MQL filter. Evaluating over the snapshot would reuse Phase 18's
  `AS OF` card source and is the path if that ever matters.

## Session

381b9b — 2026-08-27. Decided while executing Phase 22 of
`docs/work/mingle-ts-full-parity/plan.md`; written after the phase was
committed (`09c92ac`) at the user's confirmation.
