import { type Kysely, sql } from 'kysely'

import { DEFAULT_EVENT_DURATION_MS } from '../../common/eventTime'
import type { GameRequestTerms } from '../../common/gameApprovals'
import type { Database } from '../db/database'
import type { Clock } from '../groups/requests'

/**
 * One thing holding a field or a team for a while: a game, or a proposal
 * still waiting for consent.
 */
export interface Booking {
  /**
   * The game it is or will be: a game row's id, or the id a pending
   * proposal reserves for its game. It stays the same once the proposal is
   * accepted.
   */
  key: string
  /** Whether it is a proposal still waiting for consent. */
  pending: boolean
  fieldId: string | null
  size: string | null
  homeTeamId: string
  awayTeamId: string
  seasonId: string | null
  start: number
  end: number
}

/** Where to look: some fields, some teams, or both. */
export interface OccupancyQuery {
  fieldIds?: string[]
  teamIds?: string[]
  /** Leave out bookings that end before this instant. */
  from?: Date
}

function endOf(start: Date, end: Date | null): number {
  return end == null
    ? start.getTime() + DEFAULT_EVENT_DURATION_MS
    : end.getTime()
}

/**
 * Every booking on the fields, or of the teams, asked for: game rows that
 * are not cancelled, and pending, unexpired game proposals. A pending
 * change to a game stands in for that game's row, unless it cancels the
 * game, which holds its place until the cancellation is accepted.
 */
export async function occupancy(
  db: Kysely<Database>,
  query: OccupancyQuery,
  clock: Clock
): Promise<Booking[]> {
  const fieldIds = query.fieldIds ?? []
  const teamIds = query.teamIds ?? []
  if (fieldIds.length === 0 && teamIds.length === 0) return []
  const from = query.from?.getTime() ?? Number.NEGATIVE_INFINITY
  // Only the bookings that end at `from` or later; a game with no end runs
  // the default length.
  const rows = await db
    .selectFrom('games')
    .select([
      'id',
      'field_id',
      'field_size',
      'home_team_id',
      'away_team_id',
      'season_id',
      'start_at',
      'end_at'
    ])
    .where('status', '!=', 'cancelled')
    .where(eb =>
      eb.or([
        ...(fieldIds.length === 0 ? [] : [eb('field_id', 'in', fieldIds)]),
        ...(teamIds.length === 0
          ? []
          : [
              eb('home_team_id', 'in', teamIds),
              eb('away_team_id', 'in', teamIds)
            ])
      ])
    )
    .$if(query.from != null, qb =>
      qb.where(eb =>
        eb.or([
          eb('end_at', '>=', query.from!),
          eb.and([
            eb('end_at', 'is', null),
            eb('start_at', '>=', new Date(from - DEFAULT_EVENT_DURATION_MS))
          ])
        ])
      )
    )
    .execute()
  const bookings = new Map<string, Booking>()
  for (const row of rows) {
    const end = endOf(row.start_at, row.end_at)
    bookings.set(row.id, {
      key: row.id,
      pending: false,
      fieldId: row.field_id,
      size: row.field_size,
      homeTeamId: row.home_team_id,
      awayTeamId: row.away_team_id,
      seasonId: row.season_id,
      start: row.start_at.getTime(),
      end
    })
  }
  // The proposals on the fields or of the teams, and the changes to a game
  // found above, which may move it away.
  const gameIds = [...bookings.keys()]
  const requests = await db
    .selectFrom('group_requests')
    .select(['terms'])
    .where('kind', '=', 'game')
    .where('status', '=', 'pending')
    .where('expires_at', '>', clock.now())
    .where(eb =>
      eb.or([
        ...(fieldIds.length === 0
          ? []
          : [eb(sql<string>`terms->'game'->>'fieldId'`, 'in', fieldIds)]),
        ...(teamIds.length === 0
          ? []
          : [
              eb(sql<string>`terms->'game'->>'homeTeamId'`, 'in', teamIds),
              eb(sql<string>`terms->'game'->>'awayTeamId'`, 'in', teamIds)
            ]),
        ...(gameIds.length === 0
          ? []
          : [eb(sql<string>`terms->>'gameId'`, 'in', gameIds)])
      ])
    )
    .execute()
  for (const request of requests) {
    const terms = request.terms as GameRequestTerms
    const game = terms.game
    const key = terms.gameId ?? terms.proposedGameId
    if (key == null) continue
    if (game.status === 'cancelled') continue
    const onField = game.fieldId != null && fieldIds.includes(game.fieldId)
    const ofTeam =
      teamIds.includes(game.homeTeamId) || teamIds.includes(game.awayTeamId)
    if (!onField && !ofTeam) {
      // A change moving the game away frees what its row held here.
      if (terms.gameId != null) bookings.delete(terms.gameId)
      continue
    }
    const start = new Date(game.startAt)
    const end = endOf(start, game.endAt == null ? null : new Date(game.endAt))
    if (end < from) continue
    bookings.set(key, {
      key,
      pending: true,
      fieldId: game.fieldId ?? null,
      size: game.fieldSize ?? null,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      seasonId: game.seasonId,
      start: start.getTime(),
      end
    })
  }
  return [...bookings.values()].sort((a, b) => a.start - b.start)
}

/**
 * Whether two bookings of one field run into each other: they overlap, or
 * are closer than the field's size switch time when their sizes differ.
 */
export function collides(
  a: Pick<Booking, 'start' | 'end' | 'size'>,
  b: Pick<Booking, 'start' | 'end' | 'size'>,
  switchMs: number
): boolean {
  const gap =
    a.size != null && b.size != null && a.size !== b.size ? switchMs : 0
  return a.start < b.end + gap && b.start < a.end + gap
}
