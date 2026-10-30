import { type Kysely, sql } from 'kysely'

import type { CurrentPlay, GumboPlay } from '../../common/gumboPlay'
import type { GameScoreboard } from '../../common/scoreboard'
import { replayPlays } from '../../common/scoring/gumbo'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import type { Database } from '../db/database'
import { atBatInProgress } from '../events/atBatInProgress'
import { readPlays } from '../events/postPlays'
import { resolveScoringGame } from '../scoring/openRow'
import { contextOf } from '../scoring/replayContext'
import { outsideSpoken } from '../users/readerNames'
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
          atBatInProgress().as('currentPlay'),
          'start_at',
          sql<string>`(extract(epoch from updated_at) * 1000000)::bigint`.as(
            'version'
          )
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) return undefined
      const stored = await resolveScoringGame(
        trx,
        {
          plays: (await readPlays(trx, gameId)).map(
            row => row.gumbo as GumboPlay
          ),
          currentPlay: game.currentPlay as CurrentPlay | null
        },
        { gameId }
      )
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
 * A game with no play, no at-bat in progress and no lineups, as a reset can
 * leave one: when and at which version to clear its board. Undefined for any
 * other game.
 */
async function blankGame(
  db: Kysely<Database>,
  gameId: string
): Promise<{ startAt: number; sourceVersion: number } | undefined> {
  const game = await db
    .selectFrom('games')
    .select([
      'start_at',
      sql<string>`(extract(epoch from updated_at) * 1000000)::bigint`.as(
        'version'
      )
    ])
    .where('id', '=', gameId)
    .where(atBatInProgress(), 'is', null)
    .where(
      sql<boolean>`not exists (select 1 from events e where e."gameId" = games.id)`
    )
    .executeTakeFirst()
  return game == null
    ? undefined
    : {
        startAt: new Date(game.start_at).getTime(),
        sourceVersion: Number(game.version)
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
  return await outsideSpoken(async () => await writeBoard())
  async function writeBoard(): Promise<WriteResult | undefined> {
    try {
      if (!store.isReady()) throw new ScoreboardUnavailable()
      const source = await scoreboardFromGame(db, gameId, log)
      if (source == null) {
        // A game reset to nothing loses the board its plays left.
        const blank = await blankGame(db, gameId)
        if (blank == null) return undefined
        const cleared = await store.clearGame(
          gameId,
          blank.startAt,
          blank.sourceVersion
        )
        return cleared.kind === 'closed' ? undefined : cleared
      }
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
}

/** The longest a game's board can live after its start. */
const DAY_MS = 24 * 60 * 60 * 1000
const LONGEST_BOARD_MS = 3 * DAY_MS

/** Games of these teams somebody could have open now: today's, give or take. */
export async function gamesAround(
  db: Kysely<Database>,
  teamIds: readonly string[],
  now: Date
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const games = await db
    .selectFrom('games')
    .select('id')
    .where(eb =>
      eb.or([
        eb('home_team_id', 'in', [...teamIds]),
        eb('away_team_id', 'in', [...teamIds])
      ])
    )
    .where('start_at', '>=', new Date(now.getTime() - LONGEST_BOARD_MS))
    .where('start_at', '<=', new Date(now.getTime() + DAY_MS))
    .execute()
  return games.map(game => game.id)
}

/**
 * Writes again every open board of these teams' games, and announces their
 * timelines: what a privacy change does, because the hash holds the names as
 * they were written. A board that has closed stays closed.
 */
export async function rewriteTeamBoards(
  options: {
    db: Kysely<Database>
    store: ScoreboardStore
    log: (message: string) => void
  },
  teamIds: readonly string[]
): Promise<void> {
  if (teamIds.length === 0) return
  const { db, store, log } = options
  const failed = (what: string, error: unknown): void => {
    log(
      `scoreboard: ${what} not rewritten: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    const games = await db
      .selectFrom('games')
      .select('id')
      .where(eb =>
        eb.or([
          eb('home_team_id', 'in', [...teamIds]),
          eb('away_team_id', 'in', [...teamIds])
        ])
      )
      .where('start_at', '>=', new Date(store.now() - LONGEST_BOARD_MS))
      .execute()
    for (const game of games) {
      // One board's failure costs one board.
      try {
        if (!(await store.exists(game.id))) continue
        await writeGameScoreboard(options, game.id)
        await store.announceTimeline(game.id)
      } catch (error) {
        failed(`game ${game.id}`, error)
      }
    }
  } catch (error) {
    failed('boards', error)
  }
}

/**
 * The hook `POST /games/:gameId/events` calls: fire and forget.
 *
 * It runs once the post has committed, so after the live board is written it
 * announces that the game's board timeline changed, whatever the write did:
 * written, refused as stale or closed, or not made at all, because the game
 * has nothing TeamStation scored or Redis is away. The timeline is read from
 * the plays, which have changed either way, and a viewer of a game whose live
 * board has closed still has to hear of it.
 */
export function gameWrittenHook(options: {
  db: Kysely<Database>
  store: ScoreboardStore
  log: (message: string) => void
}): (gameId: string) => void {
  const { store, log } = options
  return gameId => {
    writeGameScoreboard(options, gameId)
      .catch(() => undefined)
      .then(async () => {
        await store.announceTimeline(gameId)
      })
      .catch((error: unknown) => {
        log(
          `scoreboard: game ${gameId} timeline not announced: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  }
}
