import type { Kysely } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import {
  type GameStatistics,
  type StatisticsQuery,
  statisticsWindow
} from '../../common/gameStatistics'
import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import { teamsOfRow } from '../../common/teamLists'
import type { Database } from '../db/database'
import { readSnapshot } from '../db/readSnapshot'
import { atBatOf } from '../events/atBatInProgress'
import { pregameFold } from '../events/currentPlay'
import { playForWire } from '../events/wireRecords'
import { computeBoardTimeline } from '../scoreboard/boardTimeline'
import { historicalStatistics } from './historicalStatistics'
import { computeLineTimeline } from './lineTimeline'
import { resolveScoringGame } from './openRow'

/** Playback readers share one resource, snapshot, naming policy and timeline. */
export async function gameStatistics(
  db: Kysely<Database>,
  gameId: string,
  query: StatisticsQuery = {}
): Promise<GameStatistics> {
  return await readSnapshot(db, async trx => {
    const game = await trx
      .selectFrom('games')
      .innerJoin('teams as away', 'away.id', 'games.away_team_id')
      .innerJoin('teams as home', 'home.id', 'games.home_team_id')
      .select([
        'games.id',
        'games.home_team_id',
        'games.away_team_id',
        'games.currentPlay',
        'games.pregame',
        'games.play_generation',
        'games.start_at',
        'away.name as awayTeamName',
        'home.name as homeTeamName'
      ])
      .where('games.id', '=', gameId)
      .executeTakeFirst()
    if (game === undefined) throw notFound()
    const rows = await trx
      .selectFrom('events')
      .select(['gumbo'])
      .where('gameId', '=', gameId)
      .orderBy('atBatIndex')
      .execute()
    const resolved = await resolveScoringGame(
      trx,
      {
        plays: rows.map(row => row.gumbo as GumboPlay),
        currentPlay: atBatOf(game, rows.length > 0) as CurrentPlay | null
      },
      { gameId }
    )
    const fold = await pregameFold(trx, gameId, game, resolved)
    const teams = teamsOfRow(game)
    const source = {
      plays: resolved.plays.map(play => playForWire(play, teams)),
      currentPlay: playForWire(await fold(), teams),
      generation: game.play_generation
    }
    const board = await computeBoardTimeline(trx, gameId)
    const line = await computeLineTimeline(trx, gameId)
    if (board === undefined || line === undefined) throw notFound()
    const stats = historicalStatistics(
      {
        id: gameId,
        awayTeamId: game.away_team_id,
        homeTeamId: game.home_team_id,
        awayTeamName: game.awayTeamName,
        homeTeamName: game.homeTeamName,
        startAt:
          game.start_at instanceof Date
            ? game.start_at.toISOString()
            : game.start_at
      },
      source
    )
    return {
      version: `${board.version}:${line.version}:${game.play_generation}`,
      board: { ...board, steps: statisticsWindow(board.steps, query) },
      line: { ...line, steps: statisticsWindow(line.steps, query) },
      initial: stats.initial,
      boxes: statisticsWindow(stats.boxes, query),
      source
    }
  })
}

/** Explicit playback queries never silently fall back to final-game totals. */
export function statisticsQuery(
  query: Record<string, unknown>
): StatisticsQuery | null {
  if (query.view === undefined) {
    if (
      query.at !== undefined ||
      query.from !== undefined ||
      query.to !== undefined
    )
      throw badRequest('Historical bounds require view=playback')
    return null
  }
  if (query.view !== 'playback') throw badRequest('view must be playback')
  const number = (key: string): number | undefined => {
    const raw = query[key]
    if (raw === undefined) return undefined
    if (
      typeof raw !== 'string' ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    )
      throw badRequest(`${key} must be a non-negative integer timestamp`)
    return Number(raw)
  }
  const at = number('at')
  const fromMs = number('from')
  const toMs = number('to')
  if (at !== undefined && (fromMs !== undefined || toMs !== undefined))
    throw badRequest('at cannot be combined with from or to')
  if (fromMs !== undefined && toMs !== undefined && toMs < fromMs)
    throw badRequest('to must not be before from')
  return { at, fromMs, toMs }
}
