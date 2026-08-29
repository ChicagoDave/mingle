/**
 * Cron expressions — parsing and next-occurrence computation, in UTC
 * (ADR-0023 Decision 6).
 *
 * Purpose: the five-field form (`minute hour day-of-month month
 * day-of-week`) with `*`, lists (`1,15`), ranges (`1-5`), and steps
 * (`*​/15`, `1-10/2`); names are not accepted (`MON`, `JAN`) — numbers
 * only, so a stored expression reads one way. Day-of-month and
 * day-of-week combine as classic cron does: when both are restricted,
 * a day matches either. Occurrences are minute-aligned UTC instants.
 *
 * Invariant: `nextOccurrence` returns an instant strictly after the
 * one given, at most four years ahead (an expression that never fires,
 * such as February 30th, is reported rather than searched forever).
 *
 * Public interface: `parseCron`, `nextOccurrence`, `CronExpression`,
 * `CronError`.
 *
 * Owner context: infrastructure (job queue); pure.
 */

export class CronError extends Error {}

/** A parsed expression: the allowed values of each field. */
export interface CronExpression {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the day-of-month field was `*` (so day-of-week alone restricts days), and vice versa. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const FIELDS: { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

/** Expands one field (`*`, `a`, `a-b`, `a-b/n`, `*​/n`, comma lists) into its values. */
function expand(field: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`${name}: '${part}' is not a cron field`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (step < 1) throw new CronError(`${name}: step must be at least 1`);
    let from: number;
    let to: number;
    if (match[1] === "*") {
      from = min;
      to = max;
    } else {
      from = Number(match[2]);
      to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
    }
    if (from < min || to > max || from > to) throw new CronError(`${name}: '${part}' is outside ${min}-${max}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/**
 * Parses a five-field cron expression.
 *
 * @throws CronError naming the field that is wrong
 */
export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("a cron expression has five fields: minute hour day-of-month month day-of-week");
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = fields.map((field, index) =>
    expand(field, FIELDS[index].min, FIELDS[index].max, FIELDS[index].name),
  );
  // 7 is Sunday too.
  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => (day === 7 ? 0 : day)));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: fields[2] === "*",
    anyDayOfWeek: fields[4] === "*",
  };
}

/** Whether a UTC instant's day matches the expression's day fields. */
function dayMatches(cron: CronExpression, date: Date): boolean {
  const dom = cron.daysOfMonth.has(date.getUTCDate());
  const dow = cron.daysOfWeek.has(date.getUTCDay());
  if (cron.anyDayOfMonth && cron.anyDayOfWeek) return true;
  if (cron.anyDayOfMonth) return dow;
  if (cron.anyDayOfWeek) return dom;
  return dom || dow;
}

/**
 * The first occurrence strictly after `after`, in UTC.
 *
 * @param cron - a parsed expression
 * @param after - the instant to search from
 * @throws CronError when no occurrence exists within four years
 */
export function nextOccurrence(cron: CronExpression, after: Date): Date {
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= limit) {
    if (!cron.months.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, candidate)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }
  throw new CronError("the expression never fires within four years");
}
