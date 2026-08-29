# ADR-0023: Time-triggered work is an in-process scheduler that enqueues onto the outbox

**Status**: ACCEPTED

## Context

ADR-0018 made every background job a transactional outbox row: "enqueue
on the command's `tx` through a kernel function, register a handler,
make the handler idempotent." Both jobs so far — history-notification
email (`HISTORY_NOTIFICATIONS_JOB`) and integration delivery to Slack
(`INTEGRATION_DELIVERIES_JOB`), the only rows in `jobHandlers` — are
caused by a command, so each has a transaction to enqueue on.

Proposal `post-parity-deferrals` item P-14 (scheduled backups) is the
first piece of work with no command behind it: nothing a user does
causes a nightly backup. The same shape is already visible on the
horizon — a daily-history cache if multi-year charts ever arrive
(ADR-0015 Consequences), email digests, retention sweeps. The review
flagged that how time-triggered work enters the system is a decision
that governs all of them, not a backup detail:

- **Operator cron** keeps the app ignorant of time: the operator runs
  `docker compose exec app node backup.js` from the host's cron. It is
  zero code inside the app and it is invisible to the app — no history
  event, no admin visibility, no retry, and every operator writes their
  own crontab.
- **An in-process scheduler** keeps the app the owner of its own
  maintenance: it knows the schedule, enqueues the work, records the
  outcome. It is one more thing running in the single container, and
  it must not double-enqueue across restarts or overlapping ticks.

ADR-0002 and ADR-0018 both chose single-node simplicity over
distributed coordination; a scheduler inherits that stance.

## Decision

1. **The app hosts a scheduler.** `app/jobs/scheduler.server.ts` starts
   with the outbox worker, wakes on a fixed tick, and for each schedule
   whose next-run time has passed enqueues one job through the same
   kernel function commands use.
2. **A scheduler enqueue is its own short transaction** that writes the
   job row and advances the schedule's `next_run_at` together. The
   dedupe key is `<schedule>:<next_run_at>`, so a restart, an overlapping
   tick, or a clock jump can never enqueue the same occurrence twice —
   the ADR-0018 dedupe rule, applied to time instead of to a burst.
3. **Schedules are rows, not code, edited on a site-admin page from
   the start.** A `schedules` table holds the job type, a cron
   expression, `enabled`, `next_run_at`, `last_run_at`, and the last
   outcome. Built-in schedules are seeded by migration with a default
   (the backup at `0 3 * * *`, disabled until a site admin enables it)
   and a site admin edits the expression, enables or disables the row,
   and can run it now from `/admin/schedules`; a schedule that does not
   exist as a row does not run. There is no environment variable for a
   schedule — the page is the only writer, so there is never a second
   source to reconcile against, and the outcome of the last run is
   visible where the schedule is set. A "run now" enqueues through the
   same kernel path with the dedupe key `<schedule>:manual:<now>`.
4. **The handler is an ordinary outbox handler** and therefore
   idempotent; the scheduler never calls domain code directly.
5. **Backup archives go to `BACKUPS_DIR`, defaulting to `/data/backups`,
   and the newest N are kept.** The variable follows the `ATTACHMENTS_DIR`
   precedent from the Phase 33 Dockerfile: with no configuration the
   archives land on the data volume, so the README's "archive the
   volume" recipe captures them; an operator who wants them on a
   different disk mounts one at `BACKUPS_DIR` and changes nothing else.
   Retention is keep-last-N, `BACKUP_KEEP` defaulting to 7, applied by
   the backup handler after a successful write — never by a separate
   sweep, so a failed backup can never delete an old one. Off-site
   copies (S3, rsync) are EXTERNAL and are the operator's job or a
   later item, and the README says so.
6. **The scheduler ticks once a minute and thinks in UTC; people see
   their own zone.** Cron expressions are interpreted in UTC and
   `next_run_at` is stored as a UTC epoch, so `<schedule>:<next_run_at>`
   is unambiguous through every DST changeover and no zone offset is
   folded into a key. Display is a presentation concern: each user has
   a `time_zone` profile setting (an IANA zone name, default `UTC`, set
   on the profile page), and `/admin/schedules` shows the next and last
   run converted to the viewing admin's zone beside the UTC expression.
   Legacy had a per-*project* time zone (`project.time_zone`) and no
   per-user one; this is a deliberate addition, and the per-user zone
   is the one every later timestamp display should use.
7. **A missed window runs once, not once per missed tick.** If the app
   was down across several occurrences, `next_run_at` advances to the
   first future occurrence and one job is enqueued for the catch-up —
   the same "catch up run by run" posture Phase 32 gave Slack delivery.

## Consequences

- ADR-0018's recipe gains a second enqueue origin — a tick as well as a
  command — and nothing else changes: same table, same worker, same
  handler contract, same at-least-once semantics.
- The backup job itself is constrained by ADR-0002's WAL mode: it must
  use SQLite's online backup (`VACUUM INTO` or the backup API), never a
  file copy, or a restore can land mid-checkpoint. The archive includes
  `ATTACHMENTS_DIR`.
- With the default `BACKUPS_DIR`, a backup protects against mistakes,
  not against the volume's disk failing; that is stated in the README
  beside the setting, and the mount is the fix, not code.
- Keep-last-N is applied inside the handler after the new archive is
  written, so the invariant "at least the N most recent successful
  archives exist" holds even across a run of failures.
- The `jobs` table now carries work no user asked for, which sharpens
  ADR-0018's acknowledged gap: operators still have no page for it.
  `/admin/schedules` shows each schedule's last run and outcome, which
  is the minimum visibility this ADR adds; a page for the `jobs` table
  itself remains open and would sit beside it.
- The backup ships disabled. An install that never visits the page
  never backs up, which is the same posture as today; enabling it is
  one click and the README's backup section points at it.
- Single-node holds. Two app containers sharing a volume would each
  run a scheduler; the dedupe key makes that safe for enqueueing but
  ADR-0002 already rules the deployment out.
- `users.time_zone` is a new column and a new profile field, added
  by this work rather than by a display feature, because the schedules
  page is the first place a UTC value would otherwise be shown raw. The
  card and history views keep whatever formatting they have today until
  a session adopts the setting there; when one does, it uses this
  column and does not add a project-level zone.
- Operator cron is not forbidden — the backup handler is reachable as
  a CLI entry point for operators who want their own schedule — but
  the app's schedule is the documented default.

## Session

- Decided during session 952c08 (2026-08-28), while reviewing
  `docs/proposals/post-parity-deferrals.md` item P-14; summary
  `docs/context/session-20260828-*-main.md` for that session.
