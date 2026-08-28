/**
 * Program Management calendar helpers — ISO date validation and month
 * arithmetic for plan windows and objective ranges (Phase 26).
 *
 * Purpose: the plan and its objectives are scheduled by calendar date
 * (legacy `date` columns), stored as ISO `YYYY-MM-DD` text. This module
 * keeps that representation in one place: what counts as a valid date,
 * how "a month before/after" is computed (legacy ActiveSupport month
 * arithmetic clamps the day to the target month's length), and what
 * "today" is for defaults.
 *
 * Public interface: `isoDateError`, `todayIso`, `addMonths`.
 *
 * Owner context: Program Management (pure; no infrastructure imports).
 */

const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates an ISO `YYYY-MM-DD` string as a real calendar date.
 *
 * @param value - the candidate, already trimmed
 * @returns an error message in legacy phrasing, or null when valid
 */
export function isoDateError(value: string): string | null {
  if (!value) return "can't be blank";
  if (!ISO_DATE_FORMAT.test(value)) return "is not a valid date";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return "is not a valid date";
  return null;
}

/**
 * Today as an ISO date (UTC), the reference point for plan defaults.
 *
 * @param now - injectable clock for tests
 */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Adds (or subtracts) whole months to an ISO date, clamping the day to
 * the target month's last day the way ActiveSupport's `1.month` does
 * (31 Jan + 1 month = 28/29 Feb).
 *
 * @param iso - a valid ISO date
 * @param months - positive or negative month count
 */
export function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
