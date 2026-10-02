import { type Kysely, sql } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { GameScoreboard } from '../../common/scoreboard'
import { replayPlays } from '../../common/scoring/gumbo'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import type { Database } from '../db/database'
import { readPlays } from '../events/postPlays'
import { contextOf } from '../scoring/replayContext'
import {
  type ScoreboardStore,
  ScoreboardUnavailable,
  type WriteResult
} from './scoreboardStore'

/** What the game's own scoring puts on its scoreboard, and when it was read. */
export interface GameSource {
  state: GameScoreboard
  /** The game's `updated_at` in epoch microseconds: the write's version. */
  sourceVersion: number
  /** Milliseconds. */
  startAt: number
}

/**
 * The scoreboard of a game scored in TeamStation, as its stored plays make
 * it.
 *
 * The plays, the at-bat in progress and the game's `updated_at` are read in
 * one repeatable-read transaction, so all three describe the same moment,
 * and the game is replayed as the scoring screen replays it. `updated_at` is
 * the version the write carries, so a hook that read an older game can never
 * overwrite a newer one, whichever worker finishes last.
 *
 * Undefined for a game with nothing TeamStation scored, and for one whose
 * plays no longer replay, which is logged.
 */
export async function scoreboardFromGame(
  db: Kysely<Database>,
  gameId: string,
  log: (message: string) => void
): Promise<GameSource | undefined> {
  const read = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async trx => {
      const game = await trx
        .selectFrom('games')
        .select([
          'home_team_id',
          'away_team_id',
          'currentPlay',
          'start_at',
          sql<string>`(extract(epoch from updated_at) * 1000000)::bigint`.as(
            'version'
          )
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) return undefined
      const stored = {
        plays: (await readPlays(trx, gameId)).map(
          row => row.gumbo as GumboPlay
        ),
        currentPlay: game.currentPlay as CurrentPlay | null
      }
      if (stored.plays.length === 0 && stored.currentPlay == null)
        return undefined
      const context = await contextOf(trx, gameId, game, stored)
      if (context == null) return undefined
      return { game, stored, context }
    })
  if (read == null) return undefined
  const replayed = replayPlays(read.stored, read.context)
  if (replayed.problems.length > 0) {
    log(
      `scoreboard: game ${gameId} does not replay: ${replayed.problems[0].message}`
    )
    return undefined
  }
  return {
    state: scoreboardOfGame(replayed.state),
    sourceVersion: Number(read.game.version),
    startAt: new Date(read.game.start_at).getTime()
  }
}

/**
 * Writes a game's scored state to its scoreboard, after a post has
 * committed. Undefined when there is nothing to write or Redis is away,
 * which is logged: a scoreboard is never a reason for a post to fail.
 */
export async function writeGameScoreboard(
  options: {
    db: Kysely<Database>
    store: ScoreboardStore
    log: (message: string) => void
  },
  gameId: string
): Promise<WriteResult | undefined> {
  const { db, store, log } = options
  try {
    if (!store.isReady()) throw new ScoreboardUnavailable()
    const source = await scoreboardFromGame(db, gameId, log)
    if (source == null) return undefined
    return await store.writeGame(
      gameId,
      source.state,
      source.startAt,
      source.sourceVersion
    )
  } catch (error) {
    log(
      `scoreboard: game ${gameId} not written: ${error instanceof Error ? error.message : String(error)}`
    )
    return undefined
  }
}

/** The hook `POST /games/:gameId/events` calls: fire and forget. */
export function gameWrittenHook(options: {
  db: Kysely<Database>
  store: ScoreboardStore
  log: (message: string) => void
}): (gameId: string) => void {
  return gameId => {
    writeGameScoreboard(options, gameId).catch(() => undefined)
  }
}
