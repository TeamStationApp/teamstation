import { type ErrorRequestHandler, type RequestHandler, Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized, unavailable } from '../../common/errors'
import {
  composeScoreboard,
  type DashboardOverrides,
  NO_OVERRIDES,
  scoreboardOpen,
  type ScoreboardState
} from '../../common/scoreboard'
import { adminScopes } from '../access'
import type { Database } from '../db/database'
import { mayRunGame } from '../director/runGames'
import { requireActor } from '../middleware/withAuth'
import { sendError, withAsync } from '../middleware/withErrors'
import { type GameRecord, gameRecord } from '../scoreboard/gameRecord'
import {
  type ScoreboardStore,
  ScoreboardUnavailable
} from '../scoreboard/scoreboardStore'

/**
 * A game's scoreboard over HTTP. Its sockets, which carry every change as it
 * happens, are in `scoreboard/scoreboardHub.ts`.
 *
 * Anybody may read a board: it is drawn in OBS and on a programme, where
 * nobody signs in. The games to publish to are `GET /events`. Reading the
 * override dashboard's state is for the people who run the game.
 *
 * With Redis away every route here answers 503, and nothing else in the API
 * notices.
 */

export function scoreboardRoutes(
  db: Kysely<Database>,
  store: ScoreboardStore
): Router {
  const router = Router()

  /** The board as it is drawn, while it is open. */
  router.get(
    '/scoreboard/:gameId',
    withScoreboard(async (req, res) => {
      const board = await openBoard(db, store, pathParam(req.params.gameId))
      res.json({ state: board.final })
    })
  )

  /** What the override dashboard draws, for somebody who runs the game. */
  router.get(
    '/scoreboard/:gameId/dashboard',
    requireActor,
    withScoreboard(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const board = await openBoard(db, store, gameId)
      const scopes = await adminScopes(db, actor.userId, actor.isAdmin)
      if (!mayRunGame(scopes, board.record)) throw notFound()
      res.json({
        automated: board.automated,
        overrides: board.overrides,
        final: board.final,
        gameAt: board.gameAt ?? null,
        watcherAt: board.watcherAt ?? null
      })
    })
  )

  // A game id express cannot decode (`%E0%A4%A`) is no game's id either.
  const undecodable: ErrorRequestHandler = (error, req, res, next) => {
    if (error instanceof URIError) {
      sendError(res, notFound())
      return
    }
    next(error)
  }
  router.use('/scoreboard', undecodable)

  return router
}

interface OpenBoard {
  record: GameRecord
  automated: ScoreboardState
  overrides: DashboardOverrides
  final: ScoreboardState
  gameAt?: number
  watcherAt?: number
}

/** The game's board, or 404 when there is no game or its board has closed. */
async function openBoard(
  db: Kysely<Database>,
  store: ScoreboardStore,
  gameId: string
): Promise<OpenBoard> {
  const record = await gameRecord(db, gameId)
  if (record == null) throw notFound()
  const hash = await store.readScoreboard(gameId)
  if (!scoreboardOpen(record, hash != null, store.now())) throw notFound()
  const overrides = hash?.overrides ?? NO_OVERRIDES
  return {
    ...composeScoreboard({
      baseline: record,
      game: hash?.game,
      watcher: hash?.watcher,
      overrides
    }),
    record,
    overrides,
    gameAt: hash?.game?.receivedAt,
    watcherAt: hash?.watcher?.receivedAt
  }
}

/** `withAsync`, with Redis away answered as a 503 rather than a 500. */
function withScoreboard(
  handler: (...args: Parameters<RequestHandler>) => Promise<void>
): RequestHandler {
  return withAsync(async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      throw error instanceof ScoreboardUnavailable
        ? unavailable('The scoreboard is unavailable')
        : error
    }
  })
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
