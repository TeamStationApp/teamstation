import { asBoolean, asEither, asNumber, asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'
import { strictBody } from './strictBody'

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

/**
 * Whether somebody born in that month could be `low` to `high` years old
 * today. In their birth month they may have had their birthday already, so
 * they are `ageOn` or one more; in any other month, `ageOn` exactly.
 */
export function couldBeAged(
  birthYear: number,
  birthMonth: number,
  today: Date,
  low: number,
  high: number
): boolean {
  const least = ageOn(birthYear, birthMonth, today)
  const most = least + (today.getUTCMonth() + 1 === birthMonth ? 1 : 0)
  return most >= low && least <= high
}

/**
 * A person's age band, which every chat permission reads:
 *
 * - `unknown` — no birth month and not `isAdult`;
 * - `under13` — under 13 by birth month;
 * - `minor` — 13 to 17 by birth month;
 * - `adult` — 18 or older by birth month, or `isAdult` with no birth month.
 */
export type AgeBand = 'unknown' | 'under13' | 'minor' | 'adult'

/** The band of a person on `now`; a birth month always wins over `isAdult`. */
export function ageBandOf(
  person: {
    birthYear: number | null
    birthMonth: number | null
    isAdult: boolean
  },
  now: Date
): AgeBand {
  const { birthYear, birthMonth } = person
  if (birthYear == null || birthMonth == null)
    return person.isAdult ? 'adult' : 'unknown'
  const age = ageOn(birthYear, birthMonth, now)
  return age < 13 ? 'under13' : age < 18 ? 'minor' : 'adult'
}

/** The earliest birth year a form offers or the server accepts. */
export const EARLIEST_BIRTH_YEAR = 1900

/** A year and a month of birth, as the age routes take them. */
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

/** Apple's Declared Age Range, as the device reports it. */
export interface AppleRange {
  lowerBound: number
  upperBound?: number
}

/**
 * The body of `PUT /me/account/age`, a person's first answer: a birth month,
 * or 18 or older, either one with the device's Apple range; or the Apple
 * range alone when it says 18 or older.
 */
export type MyAgeBody =
  | { kind: 'month'; year: number; month: number; apple?: AppleRange }
  | { kind: 'adult'; apple?: AppleRange }
  | { kind: 'apple'; apple: AppleRange }

/**
 * The body of `PUT /people/:userId/age`, a guardian's or a site
 * administrator's change: a birth month, 18 or older, or `null` to clear.
 */
export type AgeBody =
  { kind: 'month'; year: number; month: number } | { kind: 'adult' } | null

const asBound = asWhole(0, () => 150)

function asAppleRange(raw: unknown): AppleRange {
  const { lowerBound, upperBound } = strictBody(
    raw,
    ['lowerBound', 'upperBound'],
    '{ lowerBound, upperBound }',
    'Only a lower and an upper bound'
  )
  const lower = asBound(lowerBound)
  if (upperBound == null) return { lowerBound: lower }
  const upper = asBound(upperBound)
  if (upper < lower) throw new TypeError('The upper bound is below the lower')
  return { lowerBound: lower, upperBound: upper }
}

/** A year and a month not after `now`'s, in UTC. */
function asPastMonth(
  rawYear: unknown,
  rawMonth: unknown,
  now: Date
): { year: number; month: number } {
  const year = asWhole(EARLIEST_BIRTH_YEAR, () => now.getUTCFullYear())(rawYear)
  const month = asWhole(1, () => 12)(rawMonth)
  if (year === now.getUTCFullYear() && month > now.getUTCMonth() + 1) {
    throw new TypeError('A birth month is not in the future')
  }
  return { year, month }
}

export function asMyAgeBody(raw: unknown, now: Date = new Date()): MyAgeBody {
  const body = strictBody(
    raw,
    ['year', 'month', 'adult', 'apple'],
    '{ year, month }, { adult: true } or { apple }',
    'Only a year and month, adult, and apple'
  )
  const apple = body.apple == null ? undefined : asAppleRange(body.apple)
  const withApple = apple == null ? {} : { apple }
  const hasMonth = body.year !== undefined || body.month !== undefined
  if (body.adult !== undefined) {
    if (body.adult !== true) throw new TypeError('adult is true')
    if (hasMonth) throw new TypeError('A birth month or adult, not both')
    return { kind: 'adult', ...withApple }
  }
  if (hasMonth) {
    return {
      kind: 'month',
      ...asPastMonth(body.year, body.month, now),
      ...withApple
    }
  }
  if (apple == null) throw new TypeError('A birth month, adult, or apple')
  if (apple.lowerBound < 18) {
    throw new TypeError('Apple alone answers only 18 or older')
  }
  return { kind: 'apple', apple }
}

export function asAgeBody(raw: unknown, now: Date = new Date()): AgeBody {
  if (raw === null) return null
  const body = strictBody(
    raw,
    ['year', 'month', 'adult'],
    '{ year, month } or { adult: true }',
    'Only a year and month, or adult'
  )
  if (body.adult !== undefined) {
    if (body.adult !== true) throw new TypeError('adult is true')
    if (body.year !== undefined || body.month !== undefined) {
      throw new TypeError('A birth month or adult, not both')
    }
    return { kind: 'adult' }
  }
  if (body.year === null && body.month === null) return null
  return { kind: 'month', ...asPastMonth(body.year, body.month, now) }
}

/**
 * The ages Apple's range allows today: from its lower bound to its upper,
 * which is 17 when a lower bound under 18 comes with none.
 */
export function appleAges(apple: AppleRange): { low: number; high: number } {
  return {
    low: apple.lowerBound,
    high:
      apple.upperBound ??
      (apple.lowerBound < 18 ? 17 : Number.POSITIVE_INFINITY)
  }
}

/** Whether an answer falls outside the Apple range sent with it. */
export function outsideAppleRange(body: MyAgeBody, now: Date): boolean {
  if (body.apple == null) return false
  const { low, high } = appleAges(body.apple)
  if (body.kind === 'month')
    return !couldBeAged(body.year, body.month, now, low, high)
  return high < 18
}

/** `GET` and `PUT /me/account/age`: a person's age as they hold it. */
export const asAgeView = asObject({
  band: asLiteral('unknown', 'under13', 'minor', 'adult'),
  birthYear: asEither(asLiteral(null), asNumber),
  birthMonth: asEither(asLiteral(null), asNumber),
  isAdult: asBoolean,
  ageSource: asLiteral('self', 'apple', 'guardian', 'admin', null),
  ageSetAt: asEither(asLiteral(null), asString)
})
export type AgeView = ReturnType<typeof asAgeView>

/** `PUT /people/:userId/age`'s answer. */
export const asPersonAge = asObject({
  userId: asString,
  band: asLiteral('unknown', 'under13', 'minor', 'adult'),
  birthMonth: asEither(asLiteral(null), asString),
  isAdult: asBoolean
})
export type PersonAge = ReturnType<typeof asPersonAge>
