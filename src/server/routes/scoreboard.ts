import { type ErrorRequestHandler, type RequestHandler, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  membersOnly,
  notFound,
  unauthorized,
  unavailable
} from '../../common/errors'
import {
  composeScoreboard,
  type DashboardOverrides,
  NO_OVERRIDES,
  scoreboardOpen,
  type ScoreboardState
} from '../../common/scoreboard'
import { adminScopes, canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { mayRunGame } from '../director/runGames'
import { requireActor } from '../middleware/withAuth'
import { sendError, withAsync } from '../middleware/withErrors'
import { scoreboardOverlayFor } from '../nodeSettings'
import { boardTimeline, stepsInWindow } from '../scoreboard/boardTimeline'
import { type GameRecord, gameRecord } from '../scoreboard/gameRecord'
import {
  type ScoreboardStore,
  ScoreboardUnavailable
} from '../scoreboard/scoreboardStore'
import { lineStepsFor, lineTimeline } from '../scoring/lineTimeline'
import { isSpoken } from '../users/readerNames'

/**
 * A game's scoreboard over HTTP. Its sockets, which carry every change as it
 * happens, are in `scoreboard/scoreboardHub.ts`.
 *
 * Anybody may read a board: it is drawn in OBS and on a programme, where
 * nobody signs in. The games to publish to are `GET /events`. Reading the
 * override dashboard's state is for the people who run the game.
 *
 * With Redis away every route here answers 503, and nothing else in the API
 * notices, except the board timeline, which is read from Postgres alone.
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

  /**
   * A game the caller may read the board of, by the same rule as
   * `/videos/:videoId/playback`: a game that is not there is 404, and
   * somebody signed in who cannot see it is told it is for members.
   */
  const visibleGame = async (
    actor: { userId: string; isAdmin: boolean },
    gameId: string
  ): Promise<{ startAt: Date }> => {
    const game = await db
      .selectFrom('games')
      .select([
        'home_team_id as homeTeamId',
        'away_team_id as awayTeamId',
        'season_id as seasonId',
        'start_at as startAt'
      ])
      .where('id', '=', gameId)
      .executeTakeFirst()
    if (game == null) throw notFound()
    const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
    if (!canSeeGame(scopes, game)) throw membersOnly()
    return { startAt: new Date(game.startAt) }
  }

  /**
   * Whether a game's board shows over its videos, and where, as the node's
   * settings say (`scoreboardOverlayFor`). It is the game's to read.
   */
  router.get(
    '/games/:gameId/scoreboard-overlay',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const game = await visibleGame(actor, pathParam(req.params.gameId))
      res.json(await scoreboardOverlayFor(db, game.startAt))
    })
  )

  /**
   * The board at every moment of a game, for a player that draws it over a
   * video at the wall time of the frame on screen. It is the game's to read.
   */
  router.get(
    '/games/:gameId/scoreboard-timeline',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const from = msParam(req.query.from, 'from')
      const to = msParam(req.query.to, 'to')
      if (from != null && to != null && to < from)
        throw badRequest('to must not be before from')
      await visibleGame(actor, gameId)
      const timeline = await boardTimeline(db, gameId, message => {
        console.error(message)
      })
      if (timeline == null) throw notFound()
      res.json({
        version: timeline.version,
        steps: stepsInWindow(timeline.steps, from, to)
      })
    })
  )

  /**
   * The game's line score at every moment, from its events alone, for the
   * box score a player draws at the wall time of the frame on screen: or at
   * one instant (`at`), or in a window (`from`, `to`). A game with no events
   * has no steps. It is the game's to read.
   */
  router.get(
    '/games/:gameId/line-score',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const at = msParam(req.query.at, 'at')
      const from = msParam(req.query.from, 'from')
      const to = msParam(req.query.to, 'to')
      if (at != null && (from != null || to != null))
        throw badRequest('at is one instant: give it without from or to')
      if (from != null && to != null && to < from)
        throw badRequest('to must not be before from')
      await visibleGame(actor, gameId)
      const timeline = await lineTimeline(db, gameId, message => {
        console.error(message)
      })
      if (timeline == null) throw notFound()
      res.json({
        version: timeline.version,
        teams: timeline.teams,
        steps: lineStepsFor(timeline.steps, { at, from, to })
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

/**
 * A board as this reader may have it. The hash holds the public names, and no
 * read formats them: a model gets the score and the situation, and its names
 * from the timeline.
 */
function readable(board: ScoreboardState): ScoreboardState {
  return isSpoken() ? { ...board, batterName: '', pitcherName: '' } : board
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
  const composed = composeScoreboard({
    baseline: record,
    game: hash?.game,
    watcher: hash?.watcher,
    overrides
  })
  return {
    automated: readable(composed.automated),
    final: readable(composed.final),
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

/** An optional epoch-milliseconds query parameter; 400 when it is not one. */
function msParam(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value))
    throw badRequest(`${name} must be epoch milliseconds`)
  return Number(value)
}
