import { type Kysely, sql } from 'kysely'

import { badRequest, HttpError, notFound } from '../../common/errors'
import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'
import { asUmpireAvailability } from '../../common/umpireCleaners'
import type { UmpireAvailability } from '../../common/umpires'
import { availabilityAllows, umpireFilterError } from '../../common/umpireTime'
import { adminScopes } from '../access'
import { onePeople, onePerson } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { canAdminister, currentActor } from '../groups/rights'
import { umpireAccess } from './schedule'

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
 * person with none.
 */
export async function readAvailability(
  db: Kysely<Database>,
  leagueId: string,
  userIds: readonly string[]
): Promise<Map<string, UmpireAvailability | null>> {
  const found = new Map<string, UmpireAvailability | null>()
  if (userIds.length === 0) return found
  const people = await onePeople(db, userIds)
  const accounts = [...new Set([...people.values()].flatMap(p => p.userIds))]
  const rows = await db
    .selectFrom('umpire_availability')
    .selectAll()
    .where('league_id', '=', leagueId)
    .where('user_id', 'in', accounts)
    .orderBy('updated_at', 'desc')
    .execute()
  const levels = new Set(
    (
      await db
        .selectFrom('umpire_levels')
        .select('id')
        .where('league_id', '=', leagueId)
        .execute()
    ).map(row => row.id)
  )
  for (const userId of userIds) {
    const ids = people.get(userId)?.userIds ?? [userId]
    const row = rows.find(r => ids.includes(r.user_id))
    found.set(
      userId,
      row == null
        ? null
        : {
            levels: row.levels.filter(level => levels.has(level)),
            days: row.days,
            from: row.from_time,
            to: row.to_time,
            timezone: row.timezone
          }
    )
  }
  return found
}

/**
 * Saves a person's filter for the league, under the account that survives
 * their merges, and answers it as a read would. A null filter, or one with
 * no levels, days or range, deletes the rows of every merged account.
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
    filter = body == null ? null : asUmpireAvailability(body)
  } catch {
    throw badRequest('Choose a valid filter.')
  }
  if (
    filter == null ||
    (filter.levels.length === 0 &&
      filter.days.length === 0 &&
      filter.from == null &&
      filter.to == null)
  ) {
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
  const levels = [...new Set(filter.levels)]
  if (levels.length > 0) {
    const known = await db
      .selectFrom('umpire_levels')
      .select('id')
      .where('league_id', '=', leagueId)
      .where('id', 'in', levels)
      .execute()
    if (known.length !== levels.length)
      throw badRequest('Choose a valid level.')
  }
  const days = [...new Set(filter.days)].sort((a, b) => a - b)
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
  return (await readAvailability(db, leagueId, [userId])).get(userId) ?? null
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

/** Whether `userId`, through any merged account, holds the league's umpire role. */
async function holdsUmpireRole(
  db: Kysely<Database>,
  leagueId: string,
  userId: string
): Promise<boolean> {
  const person = await onePerson(db, userId)
  return (
    (await db
      .selectFrom('league_umpires')
      .select('user_id')
      .where('league_id', '=', leagueId)
      .where('user_id', 'in', person.userIds)
      .executeTakeFirst()) != null
  )
}

/**
 * Whether the actor may read the target's filter for the league: the target
 * is the actor (any merged account), or the actor administers the league
 * and the target holds its umpire role.
 */
export async function mayReadAvailability(
  db: Kysely<Database>,
  actor: Actor,
  leagueId: string,
  targetUserId: string
): Promise<boolean> {
  if ((await onePerson(db, actor.userId)).userIds.includes(targetUserId))
    return true
  return (
    (await canAdminister(db, actor, { kind: 'league', id: leagueId })) &&
    (await holdsUmpireRole(db, leagueId, targetUserId))
  )
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
  if (
    [availableAt, durationMinutes, day, time, level, strict].every(
      value => value == null
    )
  )
    return undefined
  const one = (name: string, value: unknown): string | undefined => {
    if (value == null) return undefined
    if (typeof value !== 'string') throw badRequest(`Supply one ${name}`)
    return value
  }
  const whole = (
    name: string,
    value: unknown,
    least: number,
    most: number
  ): number | undefined => {
    const text = one(name, value)
    if (text == null) return undefined
    const number = /^\d+$/.test(text) ? Number(text) : NaN
    if (!Number.isSafeInteger(number) || number < least || number > most)
      throw badRequest(`Supply ${name} from ${least} to ${most}`)
    return number
  }
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
    const start = Date.parse(at)
    if (Number.isNaN(start))
      throw badRequest('Supply availableAt as an ISO time')
    parsed.at = {
      start: new Date(start),
      ...(minutes == null ? {} : { durationMinutes: minutes })
    }
  } else if (weekday != null || clock != null) {
    if (weekday == null || clock == null)
      throw badRequest('Supply day and time together')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock))
      throw badRequest('Supply time as HH:mm')
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
 * The weekday, date and time of day of `availableAt` in each time zone the
 * saved filters use, as the match reads them, so a reader names the day the
 * filters were matched on rather than working it out.
 */
export function matchedAt(
  start: Date,
  saved: Iterable<UmpireAvailability | null>
): MatchedAt[] {
  const zones = new Set<string>()
  for (const availability of saved)
    if (availability != null) zones.add(availability.timezone)
  return [...zones].sort().map(timezone => ({
    timezone,
    weekday: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long'
    }).format(start),
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(start),
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(start)
  }))
}

/** Whether a person's saved filter (or none) passes an availability query. */
export function availabilityPasses(
  availability: UmpireAvailability | null,
  query: AvailabilityQuery
): boolean {
  if (availability == null) return !query.strict
  return query.at == null
    ? availabilityAllows(
        { ...availability, days: [], from: null, to: null },
        { day: 0, time: '00:00' },
        query.level
      )
    : availabilityAllows(availability, query.at, query.level)
}

/** A commitments window from its query, at most 31 days long. */
export function commitmentWindow(
  from: unknown,
  to: unknown
): { from: Date; to: Date } {
  const parse = (value: unknown): Date => {
    const time = typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isNaN(time)) throw badRequest('Supply from and to as ISO times')
    return new Date(time)
  }
  const window = { from: parse(from), to: parse(to) }
  const span = window.to.getTime() - window.from.getTime()
  if (span < 0) throw badRequest('to must not be before from')
  if (span > COMMITMENT_WINDOW_DAYS * 86400000)
    throw badRequest(`Ask for at most ${COMMITMENT_WINDOW_DAYS} days`)
  return window
}

/**
 * The games an umpire of the league is held for that start in the window:
 * those they are assigned to umpire and those they play in, read through
 * every merged account. Only games in leagues the actor administers count;
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
  if (!(await holdsUmpireRole(db, leagueId, userId)))
    throw notFound('No such umpire')
  const fresh = await currentActor(db, actor)
  const scopes = await adminScopes(db, fresh.userId, fresh.isAdmin)
  // The route lets only the league's administrators in, so this holds it.
  const leagues = [...scopes.leagueIds, leagueId]
  const ids = (await onePerson(db, userId)).userIds
  const games = db
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .where('games.start_at', '>=', from)
    .where('games.start_at', '<=', to)
    .where('games.status', '!=', 'cancelled')
    .where('games.withdrawn_at', 'is', null)
    .where('seasons.league_id', 'is not', null)
    .$if(!scopes.isAdmin, qb => qb.where('seasons.league_id', 'in', leagues))
    .select([
      'games.id as gameId',
      'seasons.league_id as leagueId',
      'games.start_at as startAt',
      'games.end_at as endAt',
      'home.name as home',
      'away.name as away'
    ])
  const umpiring = await games
    .innerJoin('umpire_assignments as a', 'a.game_id', 'games.id')
    .where('a.user_id', 'in', ids)
    .select('a.slot')
    .execute()
  const teams = db
    .selectFrom('memberships')
    .select('team_id')
    .where('user_id', 'in', ids)
    .where('is_player', '=', true)
  const playing = await games
    .where(eb =>
      eb.or([
        eb('games.home_team_id', 'in', teams),
        eb('games.away_team_id', 'in', teams)
      ])
    )
    .execute()
  const shape = (
    row: (typeof playing)[number],
    role: UmpireCommitment['role'],
    slot?: string
  ): UmpireCommitment => {
    const start = new Date(row.startAt)
    return {
      gameId: row.gameId,
      leagueId: row.leagueId!,
      startAt: start.toISOString(),
      endAt: (row.endAt == null
        ? new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS)
        : new Date(row.endAt)
      ).toISOString(),
      home: row.home,
      away: row.away,
      role,
      ...(slot == null ? {} : { slot })
    }
  }
  return [
    ...umpiring.map(row => shape(row, 'umpire', row.slot)),
    ...playing.map(row => shape(row, 'player'))
  ].sort((a, b) =>
    a.startAt !== b.startAt
      ? a.startAt.localeCompare(b.startAt)
      : a.gameId !== b.gameId
        ? a.gameId.localeCompare(b.gameId)
        : a.role.localeCompare(b.role)
  )
}
