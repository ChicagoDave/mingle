/**
 * /admin/schedules — the site's time-triggered work (ADR-0023).
 *
 * Purpose: the only writer of schedule rows. A site admin sees each
 * schedule's cron expression (UTC), whether it is enabled, its next and
 * last occurrence converted to the admin's own time zone, and the last
 * run's outcome; edits the expression or the flag (UpdateSchedule) and
 * can run one now (RunScheduleNow). Forms post to one action by
 * `intent`: "update" (`scheduleId`, `cron`, `enabled`) and "run-now"
 * (`scheduleId`).
 *
 * Public interface: `loader`, `action`, default component.
 * Owner context: infrastructure (job queue) — HTTP adapter.
 */
import { eq } from "drizzle-orm";
import { Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/admin.schedules";
import { ActionBar, ErrorLines, FlashBox } from "~/components/forms";
import type { FieldErrors, ScheduleView } from "~/shared/wire-types";
import { db } from "~/db/client.server";
import { users } from "~/db/schema/identity";
import { requireUserId } from "~/auth/session.server";
import { listSchedules, runScheduleNow, updateSchedule } from "~/jobs/scheduler.server";

/** Requires a logged-in site admin; 403 otherwise. Returns their time zone too. */
async function requireSiteAdmin(request: Request): Promise<{ userId: number; timeZone: string }> {
  const userId = await requireUserId(request);
  const user = db.select({ admin: users.admin, timeZone: users.timeZone }).from(users).where(eq(users.id, userId)).get();
  if (!user?.admin) throw new Response("Forbidden", { status: 403 });
  return { userId, timeZone: user.timeZone };
}

/** Loads every schedule and the viewing admin's time zone. */
export async function loader({ request }: Route.LoaderArgs) {
  const { timeZone } = await requireSiteAdmin(request);
  const schedules: ScheduleView[] = listSchedules(db).map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    jobType: row.jobType,
    cron: row.cron,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastOutcome: row.lastOutcome,
    lastError: row.lastError,
    lastFinishedAt: row.lastFinishedAt?.toISOString() ?? null,
  }));
  return { schedules, timeZone };
}

/** Dispatches by intent to UpdateSchedule or RunScheduleNow. */
export async function action({ request }: Route.ActionArgs) {
  const { userId } = await requireSiteAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scheduleId = Number(form.get("scheduleId") ?? 0);
  if (intent === "update") {
    const result = updateSchedule(db, { scheduleId, cron: String(form.get("cron") ?? ""), enabled: form.get("enabled") === "on", actorUserId: userId });
    return result.ok ? { saved: "update" as const, scheduleId } : { intent, scheduleId, errors: result.errors satisfies FieldErrors };
  }
  if (intent === "run-now") {
    const result = runScheduleNow(db, { scheduleId, actorUserId: userId });
    return result.ok ? { saved: "run-now" as const, scheduleId, jobId: result.value.jobId } : { intent, scheduleId, errors: result.errors satisfies FieldErrors };
  }
  throw new Response("Unknown intent", { status: 400 });
}

/** An ISO instant in the viewer's zone, or a dash. */
function inZone(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Schedules — no legacy counterpart (ADR-0023); reuses the legacy settings-page structure. */
export default function AdminSchedules() {
  const { schedules, timeZone } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const saved = actionData && "saved" in actionData ? actionData : null;
  const errorsFor = (scheduleId: number): FieldErrors =>
    actionData && "errors" in actionData && actionData.scheduleId === scheduleId ? (actionData.errors ?? {}) : {};

  return (
    <div id="admin-schedules">
      <h1>Schedules</h1>
      <p className="notes">
        Expressions are five-field cron, interpreted in UTC; times below are shown in your zone ({timeZone}, set on your
        profile). A schedule runs once per occurrence — a window missed while the site was down runs once on start.
      </p>
      {saved?.saved === "update" ? <FlashBox kind="success">Schedule was successfully updated.</FlashBox> : null}
      {saved?.saved === "run-now" ? (
        <FlashBox kind="success">
          {saved.jobId ? `Run requested (job #${saved.jobId}); it starts within a few seconds.` : "An identical run is already queued."}
        </FlashBox>
      ) : null}
      <table id="schedules" className="highlightable-table">
        <thead>
          <tr className="table-top">
            <th>Schedule</th>
            <th>Expression (UTC)</th>
            <th>Enabled</th>
            <th>Next run</th>
            <th>Last run</th>
            <th>Last outcome</th>
            <th className="align-right last">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((schedule, index) => (
            <tr key={schedule.id} id={`schedule-${schedule.key}`} className={index % 2 === 0 ? "odd" : "even"}>
              <td>
                {schedule.name}
                <div className="notes">{schedule.jobType}</div>
              </td>
              <td className="inline-forms" colSpan={2}>
                <Form method="post" id={`schedule-${schedule.key}-form`}>
                  <input type="hidden" name="intent" value="update" />
                  <input type="hidden" name="scheduleId" value={schedule.id} />
                  <ErrorLines field="cron" errors={errorsFor(schedule.id)} prefix="Expression" />
                  <ErrorLines field="authorization" errors={errorsFor(schedule.id)} />
                  <input name="cron" defaultValue={schedule.cron} className="cron" />{" "}
                  <label className="inline">
                    <input type="checkbox" name="enabled" defaultChecked={schedule.enabled} /> enabled
                  </label>{" "}
                  <button type="submit" className="inline save">
                    Save
                  </button>
                </Form>
              </td>
              <td>{inZone(schedule.nextRunAt, timeZone)}</td>
              <td>{inZone(schedule.lastRunAt, timeZone)}</td>
              <td>
                {schedule.lastOutcome ?? <span className="italic-light">never run</span>}
                {schedule.lastFinishedAt ? <div className="notes">{inZone(schedule.lastFinishedAt, timeZone)}</div> : null}
                {schedule.lastError ? <div className="field_error">{schedule.lastError}</div> : null}
              </td>
              <td className="align-right last inline-forms">
                <Form method="post">
                  <input type="hidden" name="intent" value="run-now" />
                  <input type="hidden" name="scheduleId" value={schedule.id} />
                  <button type="submit" className="inline primary">
                    Run now
                  </button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ActionBar>
        <span className="notes">Backups land in BACKUPS_DIR (the data volume's backups/ by default), newest BACKUP_KEEP kept.</span>
      </ActionBar>
    </div>
  );
}
