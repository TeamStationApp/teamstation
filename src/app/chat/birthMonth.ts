import { EARLIEST_BIRTH_YEAR } from '../../common/age'

/**
 * A year and a month of birth, or undefined while they are not both valid:
 * a four-digit year from `EARLIEST_BIRTH_YEAR`, a month of 1 to 12, and a
 * month not after `today`'s. The age modal's web fields and the native
 * wheels both check with it; it lives apart from them because, in the app,
 * `./AgeEntry` is the native file itself.
 */
export function birthOf(
  year: string,
  month: string,
  today: Date
): { year: number; month: number } | undefined {
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month)) return undefined
  const y = Number(year)
  const m = Number(month)
  if (m < 1 || m > 12 || y < EARLIEST_BIRTH_YEAR) return undefined
  const now = today.getUTCFullYear() * 12 + today.getUTCMonth()
  if (y * 12 + m - 1 > now) return undefined
  return { year: y, month: m }
}
