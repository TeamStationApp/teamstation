import { asNumber } from 'cleaners'

/**
 * A person's age from their birth month, which is all TeamStation keeps.
 *
 * Without a day, somebody born in month M of year Y is taken to reach age N
 * on the first day of the month **after** M, in year Y + N, in UTC: never a
 * day early, whatever day of M they were born on. Until then they are N − 1.
 * Born March 2013, a player is 12 through 31 March 2026 and 13 from 1 April
 * 2026; born December 2013, they turn 13 on 1 January 2027.
 *
 * The one implementation, used by the server and the app alike.
 */
export function ageOn(
  birthYear: number,
  birthMonth: number,
  today: Date
): number {
  const month = today.getUTCMonth() + 1
  return today.getUTCFullYear() - birthYear - (month <= birthMonth ? 1 : 0)
}

/** The earliest birth year a form offers or the server accepts. */
export const EARLIEST_BIRTH_YEAR = 1900

/** A year and a month of birth, as `PUT /players/:userId/birth-month` takes them. */
export interface BirthMonth {
  year: number
  month: number
}

const asWhole =
  (low: number, high: () => number) =>
  (raw: unknown): number => {
    const value = asNumber(raw)
    if (!Number.isInteger(value) || value < low || value > high()) {
      throw new TypeError(`Expected a whole number from ${low} to ${high()}`)
    }
    return value
  }

/**
 * The body of `PUT /players/:userId/birth-month`: `{ year, month }` to set
 * it, and `{ year: null, month: null }` (or a bare `null`) to clear it.
 * Anything else on it — a day above all — is refused.
 *
 * The clearing body is an object because the server's JSON parser takes
 * objects and arrays only, so a bare `null` never reaches a route.
 */
export function asBirthMonthBody(raw: unknown): BirthMonth | null {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Expected { year, month }')
  }
  const extra = Object.keys(raw).filter(
    key => key !== 'year' && key !== 'month'
  )
  if (extra.length > 0) {
    throw new TypeError(`Only a year and a month, not ${extra.join(', ')}`)
  }
  const { year, month } = raw as { year?: unknown; month?: unknown }
  if (year === null && month === null) return null
  return {
    year: asWhole(EARLIEST_BIRTH_YEAR, () => new Date().getUTCFullYear())(year),
    month: asWhole(1, () => 12)(month)
  }
}

/** `YYYY-MM`, the way `GET /players/:userId` shows a birth month. */
export function birthMonthText(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

/** `YYYY-MM` read back, or undefined for anything else. */
export function parseBirthMonth(
  text: string | null | undefined
): BirthMonth | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(text ?? '')
  if (match == null) return undefined
  const month = Number(match[2])
  if (month < 1 || month > 12) return undefined
  return { year: Number(match[1]), month }
}
