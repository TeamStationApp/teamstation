import type { Kysely } from 'kysely'

import { badRequest } from '../../common/errors'
import type { SideLineups } from '../../common/scoring/lineupHistory'
import { asUserId } from '../../common/userId'
import { visibleGamesWhere, visibleScopes } from '../access'
import { onePerson, survivorsOf } from '../admin/people'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { gameLineups } from './teamLineups'

export interface VideoCollectionFilter {
  team?: string
  participant?: string
  q: string
  offset: number
  limit: number
  sort: 'date' | 'upload'
}
export function hasVideoFilter(query: Record<string, unknown>): boolean {
  if (query.hasVideo === undefined) {
    for (const key of ['team', 'participant', 'offset', 'sort']) {
      if (query[key] !== undefined) throw badRequest(`${key} requires hasVideo`)
    }
    return false
  }
  if (query.hasVideo !== '1' && query.hasVideo !== 'true')
    throw badRequest('hasVideo must be 1 or true')
  return true
}
export function videoCollectionFilter(
  query: Record<string, unknown>
): VideoCollectionFilter {
  for (const key of Object.keys(query)) {
    if (
      ![
        'hasVideo',
        'team',
        'participant',
        'q',
        'offset',
        'limit',
        'sort'
      ].includes(key)
    )
      throw badRequest(`${key} cannot be combined with hasVideo`)
  }
  const string = (key: string): string | undefined => {
    const value = query[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '')
      throw badRequest(`${key} must be a non-empty string`)
    return value.trim()
  }
  const integer = (key: string, fallback: number, max: number): number => {
    const value = string(key)
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value) || Number(value) > max)
      throw badRequest(`${key} must be a whole number at most ${max}`)
    return Number(value)
  }
  const participant = string('participant')
  if (participant !== undefined)
    try {
      asUserId(participant)
    } catch {
      throw badRequest('participant must be a user id')
    }
  const sort = string('sort') ?? 'date'
  if (sort !== 'date' && sort !== 'upload')
    throw badRequest('sort must be date or upload')
  const limit = integer('limit', 50, 100)
  if (limit === 0) throw badRequest('limit must be at least 1')
  return {
    team: string('team'),
    participant,
    q: string('q') ?? '',
    offset: integer('offset', 0, 1000000),
    limit,
    sort
  }
}

/** Select visibility before deriving identities; roster membership is never participation. */
export async function accessibleVideoGames(
  db: Kysely<Database>,
  actor: Actor,
  filter: Pick<VideoCollectionFilter, 'team' | 'participant'> = {}
): Promise<
  Array<{
    gameId: string
    homeTeamId: string
    awayTeamId: string
    startAt: Date
    videoId: string
    uploadedAt: Date
    durationSec: number | null
  }>
> {
  const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
  let query = db
    .selectFrom('videos')
    .innerJoin('games', 'games.id', 'videos.game_id')
    .select([
      'games.id as gameId',
      'games.home_team_id as homeTeamId',
      'games.away_team_id as awayTeamId',
      'games.start_at as startAt',
      'videos.id as videoId',
      'videos.created_at as uploadedAt',
      'videos.duration_sec as durationSec'
    ])
    .where('videos.hidden', '=', false)
    .where('videos.status', 'in', ['ready', 'live'])
    .where('videos.num_cameras', '<=', 1)
    .where(eb =>
      eb.or([
        eb('videos.duration_sec', 'is', null),
        eb('videos.duration_sec', '>', 0)
      ])
    )
    .where(eb =>
      eb.or([
        eb('games.cancellation_reason', 'is', null),
        eb('games.cancellation_reason', '!=', 'rescheduled')
      ])
    )
  const visible = visibleGamesWhere(scopes)
  if (visible !== undefined) query = query.where(visible)
  if (filter.team !== undefined)
    query = query.where(eb =>
      eb.or([
        eb('games.home_team_id', '=', filter.team!),
        eb('games.away_team_id', '=', filter.team!)
      ])
    )
  const rows = await query
    .orderBy('videos.created_at', 'desc')
    .orderBy('videos.id', 'desc')
    .execute()
  const byGame = new Map<string, (typeof rows)[number]>()
  for (const row of rows)
    if (!byGame.has(row.gameId)) byGame.set(row.gameId, row)
  const games = [...byGame.values()]
  if (filter.participant === undefined) return games
  const participants = await gameParticipants(
    db,
    games.map(game => game.gameId)
  )
  const participant = (await onePerson(db, filter.participant)).userId
  return games.filter(
    game => participants.get(game.gameId)?.has(participant) === true
  )
}

export async function participantsInGames(
  db: Kysely<Database>,
  gameIds: string[]
): Promise<string[]> {
  return [
    ...new Set(
      [...(await gameParticipants(db, gameIds)).values()].flatMap(ids => [
        ...ids
      ])
    )
  ]
}

/** Recorded starters and substitutions, including fielders without a batting appearance. */
export function lineupParticipantIds(sides: SideLineups[]): number[] {
  const ids = new Set<number>()
  for (const side of sides) {
    const people = [side.start, side.current].flatMap(lineup =>
      lineup === null
        ? []
        : [...lineup.batters, ...Object.values(lineup.defense)]
    )
    people.push(
      ...side.changes.flatMap(change => [change.player, change.replaced])
    )
    for (const person of people)
      if (person?.gumboId != null) ids.add(person.gumboId)
  }
  return [...ids]
}

async function gameParticipants(
  db: Kysely<Database>,
  gameIds: string[]
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  if (gameIds.length === 0) return result
  const [plays, stats, games] = await Promise.all([
    db
      .selectFrom('event_players')
      .innerJoin('events', 'events.id', 'event_players.event_id')
      .innerJoin('gumbo_ids', 'gumbo_ids.gumbo_id', 'event_players.gumbo_id')
      .select(['events.gameId as gameId', 'gumbo_ids.user_id as userId'])
      .where('events.gameId', 'in', gameIds)
      .where('events.hidden', '=', false)
      .distinct()
      .execute(),
    db
      .selectFrom('game_player_stats')
      .innerJoin(
        'gumbo_ids',
        'gumbo_ids.gumbo_id',
        'game_player_stats.gumbo_id'
      )
      .select([
        'game_player_stats.game_id as gameId',
        'gumbo_ids.user_id as userId'
      ])
      .where('game_player_stats.game_id', 'in', gameIds)
      .distinct()
      .execute(),
    db
      .selectFrom('games')
      .select(['id', 'home_team_id', 'away_team_id', 'currentPlay', 'pregame'])
      .where('id', 'in', gameIds)
      .execute()
  ])
  for (const row of [...plays, ...stats]) {
    if (!result.has(row.gameId)) result.set(row.gameId, new Set())
    result.get(row.gameId)!.add(row.userId)
  }
  for (const game of games) {
    const lineups = await gameLineups(db, game)
    const ids = lineupParticipantIds([lineups.away, lineups.home])
    if (ids.length === 0) continue
    const people = await db
      .selectFrom('gumbo_ids')
      .select('user_id')
      .where('gumbo_id', 'in', ids)
      .execute()
    if (!result.has(game.id)) result.set(game.id, new Set())
    for (const person of people) result.get(game.id)!.add(person.user_id)
  }
  const survivors = await survivorsOf(db, [
    ...new Set([...result.values()].flatMap(ids => [...ids]))
  ])
  return new Map(
    [...result].map(([gameId, ids]) => [
      gameId,
      new Set([...ids].map(id => survivors.get(id)!))
    ])
  )
}
