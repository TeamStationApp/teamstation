import { type Kysely, sql } from 'kysely'

import { badRequest, HttpError, notFound } from '../../common/errors'
import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'
import { OPEN_SIDE_NAME } from '../../common/openSides'
import { asUmpireAvailability } from '../../common/umpireCleaners'
import type { UmpireAvailability } from '../../common/umpires'
import {
  availabilityAllows,
  availabilityIsEmpty,
  CLOCK_PATTERN,
  levelAllows,
  localClock,
  localDate,
  normalAvailability,
  umpireFilterError
} from '../../common/umpireTime'
import { adminScopes } from '../access'
import { onePeople, type OnePerson, onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { currentActor } from '../groups/rights'
import { umpireIdentity, umpireIsPlaying } from './context'
import { queryInteger } from './queryInteger'
import { leagueUmpire, umpireAccess } from './schedule'

/**
 * An ISO 8601 date-time with seconds optional and a `Z` or an explicit
 * offset, so no time is read in the server's own zone. A single space stands
 * for the `+` of an offset: an unencoded `+` in a query string decodes to one.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(\.\d+)?)?(Z|([+ -])(\d{2}):(\d{2}))$/

/**
 * An ISO 8601 date-time with a zone, as a Date; undefined for anything else,
 * an impossible date or time among them: `Date.parse` rolls
 * `2026-02-30T00:00Z` over to March 2, so the instant is read back in the
 * input's own offset and must give the date and time it was written with.
 */
export function isoInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const parts = ISO_INSTANT.exec(value)
  if (parts == null) return undefined
  // The space a decoded `+` became is read back as that `+`.
  const time = Date.parse(
    parts[9] === ' ' ? `${value.slice(0, -6)}+${value.slice(-5)}` : value
  )
  if (Number.isNaN(time)) return undefined
  const [, year, month, day, hour, minute] = parts
  const sign = parts[9] === '-' ? -1 : 1
  const offsetMinutes =
    parts[8] === 'Z' ? 0 : sign * (Number(parts[10]) * 60 + Number(parts[11]))
  const local = new Date(time + offsetMinutes * 60000)
  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() + 1 !== Number(month) ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute)
  )
    return undefined
  return new Date(time)
}

/** The longest window a commitments read covers. */
export const COMMITMENT_WINDOW_DAYS = 31

/** One game an umpire is held for: umpiring it or playing in it. */
export interface UmpireCommitment {
  gameId: string
  leagueId: string
  startAt: string
  endAt: string
  home: string
  away: string
  role: 'umpire' | 'player'
  slot?: string
}

/**
 * Each person's saved filter for the league, read through every account
 * merged into theirs, the newest row kept. Levels no longer in the league
 * are dropped, so a deleted level never filters anyone out. Null for a
 * person with none, and for one whose row is empty once those levels are
 * dropped.
 */
export async function readAvailability(
  db: Kysely<Database>,
  leagueId: string,
  userIds: readonly string[],
  /** Each of `userIds` already resolved, to skip resolving them again. */
  resolved?: ReadonlyMap<string, OnePerson>
): Promise<Map<string, UmpireAvailability | null>> {
  const found = new Map<string, UmpireAvailability | null>()
  if (userIds.length === 0) return found
  const people =
    resolved != null && userIds.every(id => resolved.has(id))
      ? resolved
      : await onePeople(db, userIds)
  const accounts = [...new Set([...people.values()].flatMap(p => p.userIds))]
  const rows = await db
    .selectFrom('umpire_availability')
    .selectAll()
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', accounts)
    .orderBy('updated_at', 'desc')
    .execute()
  const levels =
    rows.length === 0 ? new Set<string>() : await leagueLevels(db, leagueId)
  // Where each account's row is in the rows, newest first: one per account,
  // as the league and the account are its key.
  const rank = new Map(rows.map((row, at) => [row.user_id, at]))
  for (const userId of userIds) {
    const ids = people.get(userId)?.userIds ?? [userId]
    // The newest row of any of the person's accounts.
    let at: number | undefined
    for (const id of ids) {
      const held = rank.get(id)
      if (held != null && (at == null || held < at)) at = held
    }
    const row = at == null ? undefined : rows[at]
    if (row == null) {
      found.set(userId, null)
      continue
    }
    const filter: UmpireAvailability = {
      levels: row.levels.filter(level => levels.has(level)),
      days: row.days,
      from: row.from_time,
      to: row.to_time,
      timezone: row.timezone
    }
    // A row whose levels have all been deleted, with no days or range, is
    // read as none, as saving that filter would store it.
    found.set(userId, availabilityIsEmpty(filter) ? null : filter)
  }
  return found
}

/** The ids of the league's umpire levels. */
async function leagueLevels(
  db: Kysely<Database>,
  leagueId: string
): Promise<Set<string>> {
  return new Set(
    (
      await db
        .selectFrom('umpire_levels')
        .select('id')
        .where('league_id', '=', leagueId)
        .execute()
    ).map(row => row.id)
  )
}

/**
 * Saves a person's filter for the league, under the account that survives
 * their merges, and answers it as a read would. Levels no longer in the
 * league are dropped, as a read drops them, so a stale link still saves. A
 * null filter, or one with no levels, days or range once they are dropped,
 * deletes the rows of every merged account.
 */
export async function saveAvailability(
  db: Kysely<Database>,
  leagueId: string,
  userId: string,
  body: unknown
): Promise<UmpireAvailability | null> {
  const person = await onePerson(db, userId)
  let filter: UmpireAvailability | null
  try {
    filter =
      body == null ? null : normalAvailability(asUmpireAvailability(body))
  } catch {
    throw badRequest('Choose a valid filter.')
  }
  if (filter != null && filter.levels.length > 0) {
    const known = await leagueLevels(db, leagueId)
    filter = { ...filter, levels: filter.levels.filter(l => known.has(l)) }
  }
  if (filter == null || availabilityIsEmpty(filter)) {
    await db
      .deleteFrom('umpire_availability')
      .where('league_id', '=', leagueId)
      .where('user_id', 'in', person.userIds)
      .execute()
    return null
  }
  const error = umpireFilterError({
    timezone: filter.timezone,
    days: filter.days,
    from: filter.from ?? undefined,
    to: filter.to ?? undefined
  })
  if (error != null) throw badRequest(error)
  if ((filter.from == null) !== (filter.to == null))
    throw badRequest('Choose both a start and an end time.')
  const { levels, days } = filter
  await db
    .deleteFrom('umpire_availability')
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', person.userIds)
    .where('user_id', '!=', person.userId)
    .execute()
  const values = {
    levels,
    days,
    from_time: filter.from,
    to_time: filter.to,
    timezone: filter.timezone,
    updated_at: sql<Date>`now()`
  }
  await db
    .insertInto('umpire_availability')
    .values({ user_id: person.userId, league_id: leagueId, ...values })
    .onConflict(oc => oc.columns(['user_id', 'league_id']).doUpdateSet(values))
    .execute()
  return {
    levels,
    days,
    from: filter.from,
    to: filter.to,
    timezone: filter.timezone
  }
}

/**
 * Who may read and save their own filter for a league: whoever may open its
 * umpire schedule (a league administrator, or a holder of its umpire role).
 * Anyone else, and a league that does not manage umpires, is answered 404.
 */
export async function requireOwnAvailability(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string
): Promise<void> {
  try {
    await umpireAccess(db, actor, leagueId, 'schedule')
  } catch (error) {
    if (error instanceof HttpError && error.code === 'forbidden')
      throw notFound('No league')
    throw error
  }
}

/** What an admin's umpire list is narrowed by. */
export interface AvailabilityQuery {
  at?: { start: Date; durationMinutes?: number } | { day: number; time: string }
  level?: string
  strict: boolean
}

/**
 * The availability parameters of the umpire list, or undefined when it names
 * none. A bad value is 400, as is `day` without `time` or the reverse, and
 * `durationMinutes` without `availableAt`.
 */
export function parseAvailabilityQuery(
  query: Record<string, unknown>
): AvailabilityQuery | undefined {
  const { availableAt, durationMinutes, day, time, level, strict } = query
  // An empty value is absent, as the schedule's own parameters read it.
  if (
    [availableAt, durationMinutes, day, time, level, strict].every(
      value => value == null || value === ''
    )
  )
    return undefined
  const one = (name: string, value: unknown): string | undefined => {
    if (value == null || value === '') return undefined
    if (typeof value !== 'string') throw badRequest(`Supply one ${name}`)
    return value
  }
  const whole = (
    name: string,
    value: unknown,
    least: number,
    most: number
  ): number | undefined =>
    queryInteger(
      one(name, value),
      least,
      most,
      `Supply ${name} from ${least} to ${most}`
    )
  const strictText = one('strict', strict)
  if (strictText != null && strictText !== 'true' && strictText !== 'false')
    throw badRequest('Supply strict as true or false')
  const parsed: AvailabilityQuery = {
    level: one('level', level),
    strict: strictText === 'true'
  }
  const at = one('availableAt', availableAt)
  const minutes = whole('durationMinutes', durationMinutes, 1, 1440)
  const weekday = whole('day', day, 0, 6)
  const clock = one('time', time)
  if (at != null && (weekday != null || clock != null))
    throw badRequest('Supply availableAt or day and time, not both')
  if (minutes != null && at == null)
    throw badRequest('durationMinutes goes with availableAt')
  if (at != null) {
    const start = isoInstant(at)
    if (start == null) throw badRequest('Supply availableAt as an ISO time')
    parsed.at = {
      start,
      ...(minutes == null ? {} : { durationMinutes: minutes })
    }
  } else if (weekday != null || clock != null) {
    if (weekday == null || clock == null)
      throw badRequest('Supply day and time together')
    if (!CLOCK_PATTERN.test(clock)) throw badRequest('Supply time as HH:mm')
    parsed.at = { day: weekday, time: clock }
  }
  return parsed
}

/** Where `availableAt` falls in one saved filter's time zone. */
export interface MatchedAt {
  timezone: string
  /** `Monday` … `Sunday`. */
  weekday: string
  /** `YYYY-MM-DD`. */
  date: string
  /** `HH:mm`. */
  time: string
}

/**
 * The weekday, date and time of day of `availableAt` in the time zone of each
 * league game starting then and of each saved filter, as the match reads
 * them, so a reader names the day rather than working it out. Empty when no
 * game starts then and nobody has saved a filter.
 */
export async function matchedAt(
  db: Kysely<Database>,
  leagueId: string,
  start: Date,
  saved: Iterable<UmpireAvailability | null>
): Promise<MatchedAt[]> {
  const zones = new Set<string>(
    (
      await db
        .selectFrom('games')
        .innerJoin('seasons', 'seasons.id', 'games.season_id')
        .select('games.timezone')
        .distinct()
        .where('seasons.league_id', '=', leagueId)
        .where('games.start_at', '=', start)
        .execute()
    ).map(game => game.timezone)
  )
  for (const availability of saved)
    if (availability != null) zones.add(availability.timezone)
  return [...zones].sort().map(timezone => ({
    timezone,
    weekday: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long'
    }).format(start),
    date: localDate(start, timezone),
    time: localClock(start, timezone)
  }))
}

/** Whether a person's saved filter (or none) passes an availability query. */
export function availabilityPasses(
  availability: UmpireAvailability | null,
  query: AvailabilityQuery
): boolean {
  if (availability == null) return !query.strict
  return query.at == null
    ? levelAllows(availability, query.level)
    : availabilityAllows(availability, query.at, query.level)
}

/** A commitments window from its query, at most 31 days long. */
export function commitmentWindow(
  from: unknown,
  to: unknown
): { from: Date; to: Date } {
  const parse = (value: unknown): Date => {
    const time = isoInstant(value)
    if (time == null) throw badRequest('Supply from and to as ISO times')
    return time
  }
  const window = { from: parse(from), to: parse(to) }
  const span = window.to.getTime() - window.from.getTime()
  if (span < 0) throw badRequest('to must not be before from')
  if (span > COMMITMENT_WINDOW_DAYS * 86400000)
    throw badRequest(`Ask for at most ${COMMITMENT_WINDOW_DAYS} days`)
  return window
}

/**
 * The games an umpire of the league is held for that overlap the window
 * (start by `to` and end at or after `from`, a game with no end lasting the
 * default event length), so a game already under way at `from` counts:
 * those they are assigned to umpire and those they play in (as a rostered
 * player or a guest, not where they are unrostered), read through every
 * merged account. Only games in leagues the actor administers count;
 * a site administrator sees every league. Cancelled and withdrawn games
 * hold nobody, as they make no schedule conflict. Sorted by start.
 */
export async function umpireCommitments(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string,
  userId: string,
  from: Date,
  to: Date
): Promise<UmpireCommitment[]> {
  const umpire = await leagueUmpire(db, leagueId, userId)
  if (umpire == null) throw notFound('No such umpire')
  const fresh = await currentActor(db, actor)
  const scopes = await adminScopes(db, fresh.userId, fresh.isAdmin)
  // The route lets only the league's administrators in, so this holds it.
  const leagues = [...scopes.leagueIds, leagueId]
  const ids = umpire.userIds
  const identity = await umpireIdentity(db, umpire.userId)
  // Only the umpire's own games are read: those of a team they play on,
  // those naming them a guest, and those they are assigned to. Whether they
  // play in one is then decided as the schedule's conflicts decide it
  // (`umpireIsPlaying`), so a game they are unrostered from does not count.
  const games = await db
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.id',
      'games.start_at',
      'games.end_at',
      'games.home_team_id',
      'games.away_team_id',
      'games.guests',
      'games.unrostered',
      'seasons.league_id as leagueId',
      sql<string>`coalesce(home.name, ${OPEN_SIDE_NAME})`.as('home'),
      sql<string>`coalesce(away.name, ${OPEN_SIDE_NAME})`.as('away')
    ])
    .where('games.start_at', '<=', to)
    .where(
      sql<Date>`coalesce(games.end_at, games.start_at + ${`${DEFAULT_EVENT_DURATION_MS} milliseconds`}::interval)`,
      '>=',
      from
    )
    .where('games.status', '!=', 'cancelled')
    .where('games.withdrawn_at', 'is', null)
    .where('seasons.league_id', 'is not', null)
    .$if(!scopes.isAdmin, qb => qb.where('seasons.league_id', 'in', leagues))
    .where(eb =>
      eb.or([
        eb(
          'games.id',
          'in',
          eb
            .selectFrom('umpire_assignments')
            .select('umpire_assignments.game_id')
            .where('umpire_assignments.user_id', 'in', ids)
        ),
        ...(identity.teamIds.length === 0
          ? []
          : [
              eb('games.home_team_id', 'in', identity.teamIds),
              eb('games.away_team_id', 'in', identity.teamIds)
            ]),
        ...(identity.gumboIds.length === 0
          ? []
          : [
              eb.exists(
                sql`(select 1 from jsonb_each(case when jsonb_typeof(games.guests) = 'object' then games.guests else '{}'::jsonb end) as side(team, ids) cross join lateral jsonb_array_elements(case when jsonb_typeof(side.ids) = 'array' then side.ids else '[]'::jsonb end) as guest(id) where guest.id in (${sql.join(identity.gumboIds.map(id => sql`to_jsonb(${id}::bigint)`))}))`
              )
            ])
      ])
    )
    .execute()
  const assignments =
    games.length === 0
      ? []
      : await db
          .selectFrom('umpire_assignments')
          .select(['game_id', 'slot'])
          .where('user_id', 'in', ids)
          .where(
            'game_id',
            'in',
            games.map(game => game.id)
          )
          .execute()
  const byId = new Map(games.map(game => [game.id, game]))
  const umpiring = assignments.flatMap(a => {
    const game = byId.get(a.game_id)
    return game == null ? [] : [{ game, slot: a.slot }]
  })
  const playing = games.filter(game => umpireIsPlaying(identity, game))
  const shape = (
    row: (typeof games)[number],
    role: UmpireCommitment['role'],
    slot?: string
  ): UmpireCommitment => {
    const start = new Date(row.start_at)
    return {
      gameId: row.id,
      leagueId: row.leagueId!,
      startAt: start.toISOString(),
      endAt: (row.end_at == null
        ? new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS)
        : new Date(row.end_at)
      ).toISOString(),
      home: row.home,
      away: row.away,
      role,
      ...(slot == null ? {} : { slot })
    }
  }
  return [
    ...umpiring.map(({ game, slot }) => shape(game, 'umpire', slot)),
    ...playing.map(game => shape(game, 'player'))
  ].sort((a, b) =>
    a.startAt !== b.startAt
      ? a.startAt.localeCompare(b.startAt)
      : a.gameId !== b.gameId
        ? a.gameId.localeCompare(b.gameId)
        : a.role.localeCompare(b.role)
  )
}
