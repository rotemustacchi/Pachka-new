/**
 * Business-day arithmetic on the Israeli working week.
 *
 * Two specs make this unavoidable rather than decorative. `artwork-listings`
 * states dispatch lead time in **business days**, and
 * `app_config."shipping.unshipped_grace_days"` is described as "business days
 * past the stated lead time". Counting those as calendar days would chase an
 * artist whose deadline has not actually passed -- and the flag goes to an
 * admin, so every wrong one costs an operator's attention.
 *
 * The working week is Sunday to Thursday: Friday and Saturday are the Israeli
 * weekend. The weekday is resolved in `Asia/Jerusalem`, not in UTC. Israel runs
 * two to three hours ahead, so a deadline computed at 22:00 UTC on a Thursday
 * falls on a Friday in Tel Aviv, and a UTC-based rule would treat that Friday
 * as a working day for every artist in the country.
 *
 * Public holidays are deliberately NOT modelled. There is no holiday calendar
 * in the MVP, and one that is wrong in either direction is worse than a rule
 * everybody can predict; the configured grace period is the slack that absorbs
 * them.
 */

const JERUSALEM_WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jerusalem",
  weekday: "short",
});

/** True when the instant falls on a Friday or Saturday in Israel. */
export function isIsraeliWeekend(date: Date): boolean {
  const weekday = JERUSALEM_WEEKDAY.format(date);
  return weekday === "Fri" || weekday === "Sat";
}

/**
 * `from` advanced by `days` business days.
 *
 * Zero returns the instant unchanged, weekend or not: "due immediately" is a
 * real answer, and rounding it forward would silently grant time nobody
 * configured. Fractions and negatives are rejected rather than interpreted.
 */
export function addBusinessDays(from: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`Business days must be a whole number of days, got ${days}`);
  }

  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isIsraeliWeekend(result)) remaining -= 1;
  }
  return result;
}

/**
 * `from` advanced by `days` calendar days.
 *
 * The statutory return window is counted in calendar days -- the buyer's
 * fourteen days do not pause for a weekend -- so it must not use the function
 * above.
 */
export function addCalendarDays(from: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`Calendar days must be a whole number of days, got ${days}`);
  }
  const result = new Date(from.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
