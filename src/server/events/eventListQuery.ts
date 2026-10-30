import { badRequest } from '../../common/errors'
import { externalIdsAsked } from '../routes/seasons'
import {
  decodeScheduleCursor,
  type ScheduleCursor
} from '../schedule/scheduleCursor'

/**
 * `GET /api/v1/events`.
 *
 * One list. Season, who may score a game, and how the list is cut are query
 * parameters. `scope=visible` (the default) is every game the account may
 * see. `scope=run` is every game it may score, with cancelled games left
 * out. `scope=film` is every game it may film, with cancelled games left out.
 */

const HOUR_MS = 3_600_000
const PAGE_LIMIT_DEFAULT = 50
const PAGE_LIMIT_MOST = 100
const WHENS = [
  'all',
  'upcoming',
  'past',
  'future',
  'finished',
  'recent'
] as const

export type EventWhen = (typeof WHENS)[number]
export type EventScope = 'visible' | 'run' | 'film'

export interface ParsedEventList {
  scope: EventScope
  seasonIds?: string[]
  when: EventWhen
  lookbackHours?: number
  since?: Date
  until?: Date
  limit?: number
  order?: 'asc' | 'desc'
  externalIds?: string[]
  played: boolean
  scoreboardOpen: boolean
  /** Answer `Page<Event>` rather than the bare array. */
  paged: boolean
  cursor?: ScheduleCursor
  /** Open a first page on the list's next game. */
  around: boolean
  hasVideo: boolean
}

/** A `paged` read of a schedule. */
export interface SchedulePageAsk {
  limit: number
  cursor?: ScheduleCursor
  around: boolean
  /** The window `counts` read: the list's, leaving out `when`. */
  whole: EventWindow
}

/** The time cut `scheduleOf` can apply, after `when` and `lookbackHours`. */
export interface EventWindow {
  since?: Date
  until?: Date
  /** `recent` includes a game that starts at this instant. Every other end is exclusive. */
  untilInclusive: boolean
  order: 'asc' | 'desc'
  upcoming: boolean
  past: boolean
  future: boolean
  omitCancelled: boolean
  played: boolean
}

function scalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') {
    throw badRequest(`${name} must be a non-empty string`)
  }
  return value
}

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  const values = Array.isArray(value) ? value : [value]
  if (
    values.length === 0 ||
    values.some(one => typeof one !== 'string' || one === '')
  ) {
    throw badRequest(`${name} must be a non-empty string`)
  }
  return values as string[]
}

function dateOf(value: string, name: string): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`${name} must be a date`)
  }
  return parsed
}

function flag(value: unknown, name: string): boolean {
  const raw = scalar(value, name)
  if (raw != null && raw !== '1' && raw !== 'true') {
    throw badRequest(`${name} must be 1 or true`)
  }
  return raw != null
}

/** What the query string asked for. A bad value is a 400, not a silent default. */
export function parseEventListQuery(
  query: Record<string, unknown>
): ParsedEventList {
  const scopeRaw = scalar(query.scope, 'scope') ?? 'visible'
  if (scopeRaw !== 'visible' && scopeRaw !== 'run' && scopeRaw !== 'film') {
    throw badRequest('scope must be visible, run, or film')
  }
  const whenRaw = scalar(query.when, 'when') ?? 'all'
  if (!WHENS.includes(whenRaw as EventWhen)) {
    throw badRequest(
      'when must be all, upcoming, past, future, finished, or recent'
    )
  }
  const when = whenRaw as EventWhen

  const lookbackRaw = scalar(query.lookbackHours, 'lookbackHours')
  const lookbackHours = lookbackRaw == null ? undefined : Number(lookbackRaw)
  if (
    lookbackHours != null &&
    (!Number.isFinite(lookbackHours) || lookbackHours <= 0)
  ) {
    throw badRequest('lookbackHours must be a positive number')
  }

  const sinceRaw = scalar(query.since, 'since')
  const untilRaw = scalar(query.until, 'until')
  const since = sinceRaw == null ? undefined : dateOf(sinceRaw, 'since')
  const until = untilRaw == null ? undefined : dateOf(untilRaw, 'until')

  const limitRaw = scalar(query.limit, 'limit')
  if (limitRaw != null && !/^[1-9]\d*$/.test(limitRaw)) {
    throw badRequest('limit must be a whole number of at least 1')
  }

  const orderRaw = scalar(query.order, 'order')
  if (orderRaw != null && orderRaw !== 'asc' && orderRaw !== 'desc') {
    throw badRequest('order must be asc or desc')
  }

  const played = flag(query.played, 'played')

  const scoreboardRaw = scalar(query.scoreboard, 'scoreboard')
  if (scoreboardRaw != null && scoreboardRaw !== 'open') {
    throw badRequest('scoreboard must be open')
  }

  const paged = flag(query.paged, 'paged')
  const hasVideo = flag(query.hasVideo, 'hasVideo')
  const cursorRaw = scalar(query.cursor, 'cursor')
  const aroundRaw = scalar(query.around, 'around')
  if (aroundRaw != null && aroundRaw !== 'next') {
    throw badRequest('around must be next')
  }
  if (cursorRaw != null && !paged) throw badRequest('cursor needs paged')
  if (aroundRaw != null && !paged) throw badRequest('around needs paged')
  if (aroundRaw != null && cursorRaw != null) {
    throw badRequest('around does not apply with cursor')
  }
  const cursor = cursorRaw == null ? undefined : decodeScheduleCursor(cursorRaw)
  if (cursor != null && orderRaw != null && orderRaw !== cursor.order) {
    throw badRequest(`order must be ${cursor.order} with this cursor`)
  }
  // A page around the next game runs forward, and its cursors with it.
  if (aroundRaw != null && orderRaw === 'desc') {
    throw badRequest('around reads order=asc')
  }
  if (paged && scoreboardRaw != null) {
    throw badRequest('paged does not apply with scoreboard=open')
  }
  if (paged && limitRaw != null && Number(limitRaw) > PAGE_LIMIT_MOST) {
    throw badRequest(`limit must be at most ${PAGE_LIMIT_MOST} with paged`)
  }

  const lookbackApplies =
    when === 'all' || when === 'finished' || when === 'recent'
  if (lookbackHours != null && !lookbackApplies) {
    throw badRequest(
      'lookbackHours applies to when=all, when=finished, or when=recent'
    )
  }
  if (when !== 'all' && since != null) {
    throw badRequest('since does not apply with this when')
  }
  if (when !== 'all' && until != null) {
    throw badRequest('until does not apply with this when')
  }
  if (lookbackHours != null && since != null) {
    throw badRequest('since and lookbackHours cannot both be set')
  }

  return {
    scope: scopeRaw,
    seasonIds: strings(query.season, 'season'),
    when,
    lookbackHours,
    since,
    until,
    limit:
      limitRaw != null
        ? Number(limitRaw)
        : paged
          ? PAGE_LIMIT_DEFAULT
          : undefined,
    order: cursor?.order ?? orderRaw,
    externalIds: externalIdsAsked(query.externalId),
    played,
    scoreboardOpen: scoreboardRaw != null,
    paged,
    cursor,
    around: aroundRaw != null,
    hasVideo
  }
}

/**
 * `GET /teams/:teamId/games`: the parameters of the list above that a team's
 * own list takes. `limit` waits for `paged`, because this list has never
 * taken one without it.
 */
export function parseTeamGamesQuery(
  query: Record<string, unknown>
): ParsedEventList {
  const { when, order, paged, cursor, around, hasVideo, limit } = query
  return parseEventListQuery({
    when,
    order,
    paged,
    cursor,
    around,
    hasVideo,
    limit: paged == null ? undefined : limit
  })
}

/** How a `paged` read cuts the list, for `schedulePage`. */
export function schedulePageAsk(
  query: ParsedEventList,
  now: Date
): SchedulePageAsk {
  return {
    // `paged` always has one.
    limit: query.limit!,
    cursor: query.cursor,
    around: query.around,
    whole: eventWindow({ ...query, when: 'all', lookbackHours: undefined }, now)
  }
}

/**
 * The window a `when` names.
 *
 * `upcoming` is a game with no score whose start is still ahead. `past` is
 * every other game. `future` is a start still ahead, scored or not.
 * `finished` is a start older than the look-back (two hours when unset).
 * `recent` is a start inside the look-back (three hours when unset), up to
 * and including now. `lookbackHours` on `when=all` is the picker: from that
 * long ago, soonest first.
 */
export function eventWindow(query: ParsedEventList, now: Date): EventWindow {
  let since = query.since
  let until = query.until
  let untilInclusive = false
  let order: 'asc' | 'desc' = query.order ?? 'desc'

  if (query.when === 'upcoming' || query.when === 'future') {
    order = query.order ?? 'asc'
  } else if (query.when === 'finished') {
    const lookback = query.lookbackHours ?? 2
    until = new Date(now.getTime() - lookback * HOUR_MS)
    order = query.order ?? 'desc'
  } else if (query.when === 'recent') {
    const lookback = query.lookbackHours ?? 3
    since = new Date(now.getTime() - lookback * HOUR_MS)
    until = now
    untilInclusive = true
    order = query.order ?? 'desc'
  } else if (query.when === 'all' && query.lookbackHours != null) {
    since = new Date(now.getTime() - query.lookbackHours * HOUR_MS)
    order = query.order ?? 'asc'
  }

  return {
    since,
    until,
    untilInclusive,
    order: query.around ? 'asc' : order,
    upcoming: query.when === 'upcoming',
    past: query.when === 'past',
    future: query.when === 'future',
    omitCancelled: query.scope === 'run' || query.scope === 'film',
    played: query.played
  }
}
