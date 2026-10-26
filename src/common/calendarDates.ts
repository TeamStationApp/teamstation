/**
 * Calendar dates, "YYYY-MM-DD", stepped and read at noon UTC, so no zone or
 * daylight-saving change can move one to another day. The module imports
 * nothing, so any model can use it without an import cycle.
 */

function noonOf(date: string): Date {
  return new Date(`${date}T12:00:00Z`)
}

/** The calendar date `days` after `date`; before it when negative. */
export function addDays(date: string, days: number): string {
  const next = noonOf(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/** The days from one calendar date to another; negative when it is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (noonOf(to).getTime() - noonOf(from).getTime()) / 86_400_000
  )
}

/** "2027-03-01" as "Mar 1", or as "Mar 1, 2027" with its year. */
export function monthDay(date: string, withYear = false): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {})
  }).format(noonOf(date))
}
