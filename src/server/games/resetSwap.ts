import { type Kysely, type Selectable, sql, type Transaction } from 'kysely'

import { conflict } from '../../common/errors'
import { systemCancelled } from '../../common/gameApprovals'
import { makeId } from '../../common/ids'
import { storedRecordOf } from '../../common/scoring/gumbo'
import {
  type PlaysLost,
  playsLost,
  resetsPlays
} from '../../common/scoring/playsLost'
import type { Database, GamesTable } from '../db/database'
import { gamePlaysDigest, lineupsBefore } from '../events/postPlays'
import { notifyGameChange } from '../socket/gameChanges'
import { requestGameStats } from '../statsBuilder/request'
import { swapGameSides } from './swapSides'

export const PLAYS_CHANGED = "This game's plays changed. Open it again."
export const SCORED_ELSEWHERE =
  'This game was scored outside TeamStation and cannot be reset.'
export const WITHDRAWN_GAME = 'This canceled game cannot be changed.'

/** The players a scorer added to a play by hand, which a reset keeps too. */
const HAND_ADDED = ['fielder', 'catcher', 'scorer'] as const

/** The game row a reset reads, as the swap route locked it. */
type GameRow = Selectable<GamesTable>

async function lockedGame(
  trx: Kysely<Database>,
  gameId: string
): Promise<GameRow> {
  return await trx
    .selectFrom('games')
    .selectAll()
    .where('id', '=', gameId)
    .forUpdate()
    .executeTakeFirstOrThrow()
}

/**
 * Whether a game has begun: any stored play, an at-bat in progress, or a
 * status that says it started, as a game scored elsewhere does.
 */
export async function gameBegun(
  trx: Kysely<Database>,
  game: { id: string; currentPlay: unknown; status: string }
): Promise<boolean> {
  if (game.currentPlay != null) return true
  if (game.status === 'inProgress' || game.status === 'final') return true
  const play = await trx
    .selectFrom('events')
    .select('id')
    .where('gameId', '=', game.id)
    .limit(1)
    .executeTakeFirst()
  return play != null
}

/**
 * Deletes every play of a begun game and swaps its home and away, in the
 * caller's transaction (which holds the swap route's locks):
 *
 * - archives the game as it stood, its plays, the players added to them by
 *   hand and its tags in `game_play_archives`;
 * - deletes the plays (their credits and players go with them) and the tags;
 * - rewinds the game to its lineups at the first pitch: scheduled (a
 *   cancelled game stays cancelled), no scores, line score, fence or at-bat,
 *   and one more play generation, so every device still on the old plays
 *   is refused;
 * - swaps the sides (`swapGameSides`), queues the game's stats, tells every
 *   screen, and writes the audit row.
 *
 * Refused for a withdrawn game, for one scored outside TeamStation, whose
 * plays TeamStation could not score again, and unless `confirmed` names the
 * game's plays digest and generation as they stand. Answers what was
 * deleted.
 */
export async function resetAndSwap(
  trx: Transaction<Database>,
  gameId: string,
  actorUserId: string,
  confirmed: { playsDigest?: string; generation?: number }
): Promise<PlaysLost> {
  const game = await lockedGame(trx, gameId)
  if (systemCancelled(game.cancellation_reason)) throw conflict(WITHDRAWN_GAME)
  const plays = await trx
    .selectFrom('events')
    .select([
      'id',
      'atBatIndex',
      'gumbo',
      'hidden',
      'titleOverride',
      'timeNudgeSec',
      'source',
      'startTime',
      'endTime',
      'createdAt'
    ])
    .where('gameId', '=', gameId)
    .orderBy('atBatIndex')
    .execute()
  // Begun with nothing TeamStation scored here (no play, and no at-bat or
  // one of lineups only, as a game marked final elsewhere can hold), or
  // with plays or an at-bat it did not.
  if (
    (plays.length === 0 &&
      !resetsPlays({ plays: [], currentPlay: game.currentPlay })) ||
    plays.some(play => storedRecordOf(play.gumbo) == null) ||
    (game.currentPlay != null && storedRecordOf(game.currentPlay) == null)
  )
    throw conflict(SCORED_ELSEWHERE)
  // The scorer confirmed these very plays, on this generation.
  if (
    confirmed.playsDigest !== (await gamePlaysDigest(trx, game)) ||
    confirmed.generation !== game.play_generation
  )
    throw conflict(PLAYS_CHANGED)
  const lost = playsLost({
    plays: plays.map(play => play.gumbo),
    currentPlay: game.currentPlay
  })
  const players =
    plays.length === 0
      ? []
      : await trx
          .selectFrom('event_players')
          .selectAll()
          .where(
            'event_id',
            'in',
            plays.map(play => play.id)
          )
          .where('role', 'in', HAND_ADDED)
          .execute()
  const tags = await trx
    .selectFrom('event_tags')
    .selectAll()
    .where('game_id', '=', gameId)
    .execute()
  await archive(trx, game, actorUserId, plays, players, tags)

  await trx.deleteFrom('events').where('gameId', '=', gameId).execute()
  await trx.deleteFrom('event_tags').where('game_id', '=', gameId).execute()
  // The lineups the game began with: kept since the first pitch, or else,
  // for a game scored before they were, its first record's.
  const pregame =
    game.pregame ??
    lineupsBefore(
      [...plays.map(play => play.gumbo), game.currentPlay].find(
        play => storedRecordOf(play) != null
      )
    )
  await trx
    .updateTable('games')
    .set({
      currentPlay: null,
      pregame: pregame as never,
      status: game.status === 'cancelled' ? 'cancelled' : 'scheduled',
      home_score: null,
      away_score: null,
      linescore: null,
      lineup_started_at: null,
      fence_distance_ft: null,
      ingest_status: 'ok',
      ingest_message: null,
      // Worked out again from the lineups the game is rewound to.
      lineups_digest: null,
      play_generation: sql<number>`play_generation + 1`,
      updated_at: new Date()
    })
    .where('id', '=', gameId)
    .execute()
  await swapGameSides(trx, gameId)
  await requestGameStats(trx, gameId)
  // Sent even when no lineups move: every screen holding the plays reads
  // them again. A notice the swap sent too is delivered once.
  await notifyGameChange(trx, { game: gameId, kind: 'plays' })
  await notifyGameChange(trx, { game: gameId, kind: 'lineups' })

  const after = await trx
    .selectFrom('games')
    .select([
      'home_team_id',
      'away_team_id',
      'status',
      'home_score',
      'away_score',
      'play_generation'
    ])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  await trx
    .insertInto('audit_log')
    .values({
      id: makeId('audit'),
      actor_user_id: actorUserId,
      api_token_id: null,
      method: 'POST',
      path: '/games/:gameId/swap-sides',
      entity_type: 'game',
      entity_id: gameId,
      before: figures(game, plays.length),
      after: figures(after, 0)
    })
    .execute()
  return lost
}

/** What the audit row says of the game, before and after. */
function figures(
  game: Pick<
    GameRow,
    | 'home_team_id'
    | 'away_team_id'
    | 'status'
    | 'home_score'
    | 'away_score'
    | 'play_generation'
  >,
  plays: number
): Record<string, unknown> {
  return {
    teams: { home: game.home_team_id, away: game.away_team_id },
    status: game.status,
    scores: { home: game.home_score, away: game.away_score },
    plays,
    generation: game.play_generation
  }
}

async function archive(
  trx: Transaction<Database>,
  game: GameRow,
  actorUserId: string,
  plays: Array<Record<string, unknown> & { id: string; atBatIndex: number }>,
  players: unknown[],
  tags: unknown[]
): Promise<void> {
  await trx
    .insertInto('game_play_archives')
    .values({
      id: makeId('gamePlayArchive'),
      game_id: game.id,
      actor_user_id: actorUserId,
      reason: 'resetSwap',
      home_team_id: game.home_team_id,
      away_team_id: game.away_team_id,
      status: game.status,
      home_score: game.home_score,
      away_score: game.away_score,
      linescore: json(game.linescore),
      current_play: json(game.currentPlay),
      pregame: json(game.pregame),
      lineups_digest: game.lineups_digest,
      fence_distance_ft: game.fence_distance_ft,
      play_generation: game.play_generation,
      plays: json(plays),
      players: json(players),
      tags: json(tags)
    })
    .execute()
}

/** A value for a `jsonb` column: written as JSON, null kept as SQL null. */
function json(value: unknown): never {
  return (value == null ? null : JSON.stringify(value)) as never
}
