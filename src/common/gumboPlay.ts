import {
  asArray,
  asBoolean,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import { isFenceDistance } from './fenceDistance'
import {
  type GumboEventType,
  isGumboEventType,
  isLegacyEventType,
  LEGACY_EVENT_TYPES,
  type LegacyEventType
} from './gumboEventTypes'
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

/**
 * A listed event type, or a legacy code the scoring engine and older imports
 * still send. `asPostEventsBody` stores a legacy code as the listed one.
 */
function asEventType(raw: unknown): GumboEventType | LegacyEventType {
  if (typeof raw !== 'string') {
    throw new TypeError(`Expected an event type, got ${JSON.stringify(raw)}`)
  }
  if (!isGumboEventType(raw) && !isLegacyEventType(raw)) {
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
 * Who sent a post: `teamstation`, `manual`, or an outside system's own short
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
 * stored whole. The event type is one on the list in `gumboEventTypes.ts`, or
 * a legacy code that list names.
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

const asPostEventsShape = asObject({
  plays: asArray(asGumboPlay),
  source: asOptional(
    asObject({
      system: asOptional(asSourceSystem)
    })
  ),
  /**
   * `replace`, the default, is a finished game arriving whole: every stored
   * play the body does not name is deleted. `live` is a game being scored:
   * the plays sent are written in place, and only the indexes in `remove`
   * are deleted.
   */
  mode: asOptional(asValue('replace', 'live'), 'replace'),
  remove: asOptional(asArray(asCount)),
  /** On a live post: the at-bat in progress, or null when there is none. */
  currentPlay: (raw: unknown): CurrentPlay | null | undefined =>
    raw === undefined ? undefined : raw === null ? null : asCurrentPlay(raw),
  /**
   * The fence, in feet, the plays' distances were sized by: the game's
   * `gameData.venue.fieldInfo.center`, which the plays do not carry. The
   * game's first plays fix its fence at this one. Anything but whole feet
   * from 1 to 600 is left out, and the game's own fence is fixed instead.
   */
  fenceDistanceFt: (raw: unknown): number | undefined =>
    isFenceDistance(raw) ? raw : undefined
})

export type PostEventsBody = ReturnType<typeof asPostEventsShape>

/**
 * `holder` with a legacy `eventType` renamed to its listed code, or `holder`
 * itself when there is nothing to rename.
 */
function listedIn(holder: Record<string, unknown>): Record<string, unknown> {
  const eventType = holder.eventType
  return typeof eventType === 'string' && isLegacyEventType(eventType)
    ? { ...holder, eventType: LEGACY_EVENT_TYPES[eventType] }
    : holder
}

/**
 * The document with a legacy event type renamed to its listed code in its
 * result and in each runner's details, or the document itself when there is
 * nothing to rename. Only those fields change: the `teamStation` record keeps
 * the engine's own vocabulary, and the credits keep theirs.
 */
function withListedEventType<T extends Record<string, unknown>>(play: T): T {
  let renamed = play
  const result = play.result
  if (isRecord(result) && listedIn(result) !== result)
    renamed = { ...renamed, result: listedIn(result) }
  const runners = play.runners
  if (Array.isArray(runners)) {
    const listed = runners.map((runner: unknown) =>
      isRecord(runner) &&
      isRecord(runner.details) &&
      listedIn(runner.details) !== runner.details
        ? { ...runner, details: listedIn(runner.details) }
        : runner
    )
    if (listed.some((runner, i) => runner !== runners[i]))
      renamed = { ...renamed, runners: listed }
  }
  return renamed
}

/**
 * Checks a post, and renames the legacy event types in it, so every play and
 * current play stored carries a listed code.
 */
export function asPostEventsBody(raw: unknown): PostEventsBody {
  const body = withListedEventTypes(
    asPostEventsShape(withTeamStationNames(raw))
  )
  if (body.mode === 'replace') {
    if (body.remove !== undefined)
      throw new TypeError('remove is for a live post')
    if (body.currentPlay !== undefined)
      throw new TypeError('currentPlay is for a live post')
  }
  const posted = new Set(body.plays.map(play => play.about.atBatIndex))
  if ((body.remove ?? []).some(index => posted.has(index)))
    throw new TypeError('A play is both posted and removed')
  return body
}

/**
 * A post from an app built before TeamStation, in TeamStation's words: the
 * three extension codes as `ts_`, the engine's record as `teamStation`, and
 * the scoring system as `teamstation`, wherever in the post they appear. It
 * is the same rewrite migration 047 made to the plays already stored, so a
 * play from an old app is stored exactly as a migrated one is.
 */
export function withTeamStationNames(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw
  const text = JSON.stringify(raw)
  if (
    !/"(gs_manual_placement|gs_batter_out|gs_batting_order|gameStation|gamestation)"/.test(
      text
    )
  )
    return raw
  return JSON.parse(
    text
      .replace(/"gs_(manual_placement|batter_out|batting_order)"/g, '"ts_$1"')
      .replace(/"gameStation"/g, '"teamStation"')
      .replace(/"gamestation"/g, '"teamstation"')
  ) as unknown
}

function withListedEventTypes(body: PostEventsBody): PostEventsBody {
  return {
    ...body,
    plays: body.plays.map(withListedEventType),
    ...(body.currentPlay == null
      ? {}
      : { currentPlay: withListedEventType(body.currentPlay) })
  }
}
