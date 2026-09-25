import {
  asArray,
  asBoolean,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import { type GumboEventType, isGumboEventType } from './gumboEventTypes'
import { asUserIdNumber } from './userIdNumber'

/** The largest `integer` Postgres stores. */
const MAX_INT4 = 2147483647

/** `YYYY-MM-DD`, then optionally a time and a zone, as ISO 8601 writes it. */
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** A count Postgres can hold in an `integer`: 0 up to `MAX_INT4`. */
function asCount(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > MAX_INT4
  ) {
    throw new TypeError(
      `Expected an integer from 0 to ${MAX_INT4}, got ${JSON.stringify(raw)}`
    )
  }
  return raw
}

/**
 * An ISO-8601 time Postgres accepts. `Date.parse` rolls an impossible date
 * such as 31 February over into March, so the date is checked on its own.
 */
function asIsoTime(raw: unknown): string {
  const match = typeof raw === 'string' ? ISO_TIME.exec(raw) : null
  if (match == null || Number.isNaN(Date.parse(match[0]))) {
    throw new TypeError(`Expected an ISO-8601 time, got ${JSON.stringify(raw)}`)
  }
  const [year, month, day] = [match[1], match[2], match[3]].map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`Expected an ISO-8601 time, got ${match[0]}`)
  }
  return match[0]
}

function asEventType(raw: unknown): GumboEventType {
  if (typeof raw !== 'string') {
    throw new TypeError(`Expected an event type, got ${JSON.stringify(raw)}`)
  }
  if (!isGumboEventType(raw)) {
    throw new TypeError(`Expected a known event type, got ${raw}`)
  }
  return raw
}

/** Absent passes; anything else, `null` included, has to pass `cleaner`. */
function asAbsentOr<T>(cleaner: Cleaner<T>): Cleaner<T | undefined> {
  return raw => (raw === undefined ? undefined : cleaner(raw))
}

/**
 * Absent stays absent and `null` stays `null`, so the document is stored as it
 * was sent. Anything else has to pass `cleaner`.
 */
function asNullable<T>(cleaner: Cleaner<T>): Cleaner<T | null | undefined> {
  return raw => (raw == null ? raw : cleaner(raw))
}

/** A player named by a play, whose id the `events` trigger copies out. */
const asPlayer = asAbsentOr(
  asObject({ id: asNullable(asUserIdNumber) }).withRest
)

/**
 * Who a credit names. A credit names people by `creditUserId` alone, so a
 * credit that carries any service's player id — a key ending `PlayerId` — is
 * refused rather than stored beside it.
 */
function asCreditPerson(raw: unknown): unknown {
  if (isRecord(raw) && Object.keys(raw).some(key => key.endsWith('PlayerId'))) {
    throw new TypeError('credits name people by creditUserId')
  }
  return raw
}

/**
 * Who sent a post: `gamestation`, `manual`, or an outside system's own short
 * name, spelled as an external id's system is.
 */
function asSourceSystem(raw: unknown): string {
  const system = asString(raw)
  if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(system)) {
    throw new TypeError(`Not a system name: ${system}`)
  }
  return system
}

/**
 * One Gumbo play. Extra keys stay, at every level, because the document is
 * stored whole. `score_correction` and `final_score` are accepted event types.
 *
 * Every field the `events` table casts in a generated column, or its trigger
 * copies into a typed column, is checked here. A value Postgres cannot cast
 * would otherwise fail inside the write as a 500 rather than a 400 that names
 * the play.
 */
const asGumboPlayShape = asObject({
  about: asObject({
    atBatIndex: asCount,
    inning: asNullable(asCount),
    halfInning: asNullable(asValue('top', 'bottom')),
    halfOuts: asAbsentOr(asCount),
    isScoringPlay: asAbsentOr(asBoolean),
    startTime: asNullable(asIsoTime),
    endTime: asNullable(asIsoTime)
  }).withRest,
  result: asObject({
    eventType: asEventType,
    awayScore: asNullable(asCount),
    homeScore: asNullable(asCount),
    rbi: asNullable(asCount),
    description: asAbsentOr(asString)
  }).withRest,
  count: asAbsentOr(
    asObject({
      outs: asNullable(asCount),
      balls: asNullable(asCount),
      strikes: asNullable(asCount)
    }).withRest
  ),
  credits: asAbsentOr(
    asArray(
      asObject({
        teamId: asNullable(asString),
        creditUserId: asNullable(asUserIdNumber),
        credit: asCreditPerson
      }).withRest
    )
  ),
  matchup: asAbsentOr(
    asObject({ batter: asPlayer, pitcher: asPlayer }).withRest
  ),
  runners: asAbsentOr(
    asArray(
      asObject({
        details: asAbsentOr(asObject({ runner: asPlayer }).withRest)
      }).withRest
    )
  )
}).withRest

/** The checked fields, and whatever else the sender put in the document. */
export type GumboPlay = ReturnType<typeof asGumboPlayShape> &
  Record<string, unknown>

/** Checks one play, and names it by its `about.atBatIndex` when it fails. */
export function asGumboPlay(raw: unknown): GumboPlay {
  try {
    return asGumboPlayShape(raw)
  } catch (error) {
    const about = isRecord(raw) ? raw.about : undefined
    const index = isRecord(about) ? about.atBatIndex : undefined
    const name =
      typeof index === 'number' && Number.isInteger(index)
        ? `play ${index}`
        : 'a play'
    const why = error instanceof Error ? error.message : String(error)
    throw new TypeError(`${name}: ${why}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The at-bat still in progress: a Gumbo play with no outcome yet. It is stored
 * on the game, never as an `events` row, so every row is a completed play.
 * Only its place in the game is checked; the rest is kept as sent.
 */
const asCurrentPlayShape = asObject({
  about: asObject({
    atBatIndex: asCount,
    inning: asNullable(asCount),
    halfInning: asNullable(asValue('top', 'bottom')),
    isComplete: asValue(false)
  }).withRest
}).withRest

export type CurrentPlay = ReturnType<typeof asCurrentPlayShape> &
  Record<string, unknown>

export function asCurrentPlay(raw: unknown): CurrentPlay {
  try {
    return asCurrentPlayShape(raw)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new TypeError(`the current play: ${why}`)
  }
}

export const asPostEventsBody = asObject({
  plays: asArray(asGumboPlay),
  source: asOptional(
    asObject({
      system: asOptional(asSourceSystem)
    })
  )
})
