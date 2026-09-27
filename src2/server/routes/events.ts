import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { asPostEventsBody } from '../../common/gumboPlay'
import { halfOutcomes } from '../../common/scoring/linescore'
import {
  adminScopes,
  canManageTeam,
  canSeeGame,
  visibleScopes
} from '../access'
import type { Database } from '../db/database'
import {
  documentOf,
  playJson,
  postGamePlays,
  readPlays
} from '../events/postPlays'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

/**
 * Post, read, and summarise a game's plays.
 *
 * A post is one of two modes. A `replace` post, the default, is a finished
 * game arriving whole: a stored play whose index the body does not name is
 * deleted, even after `scoringOwner` is `gamestation`. That includes a
 * legacy line-score-only `final_score` play, stored for a game whose sender
 * had nothing but a line score and turned into Gumbo by migration 031. It
 * sits at index 9999 after a game's other plays, or at index 0 in a game that
 * has nothing else.
 *
 * `source.system` is `gamestation`, `manual`, or an outside system spelled as
 * an external id's system is, stored as `external`. A post that names none
 * counts as an outside one, so that a sender has to say it is GameStation's
 * own before it may write a game
 * GameStation scores or have its play text kept.
 *
 * A replace post whose plays carry both teams' scores sets the game `final`,
 * with the last score each side's plays carry, and a final game refuses every
 * later post with 409. Any other replace post keeps the stored status, except
 * that a scheduled game with plays is `inProgress`. A cancelled game stays
 * cancelled.
 *
 * A `live` post is a game being scored in GameStation, a play at a time. Its
 * plays are written in place at their index, keeping each row's id; exactly
 * the indexes in `remove` are deleted; and `currentPlay`, when the body has
 * the key, is the at-bat in progress, kept on the game rather than as a row.
 * The game is `final` when a stored play is its `final_score`, `inProgress`
 * while it has plays or an at-bat in progress, and a cancelled game stays
 * cancelled. The scorer is the record, so a live post never marks a score
 * mismatch. The owning GameStation scorer may post to a final game to
 * correct it; nobody else may.
 *
 * The write itself is `postGamePlays` in `events/postPlays.ts`, which the
 * refold script calls too.
 */
export function eventRoutes(db: Kysely<Database>): Router {
  const router = Router()

  router.post(
    '/games/:gameId/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      const body = cleanBody(asPostEventsBody, req.body)
      // Only whether the game can be seen is settled here. Everything the
      // write depends on is read from the locked row.
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      const response = await postGamePlays(
        db,
        gameId,
        body,
        async (trx, game) => {
          const editors = await adminScopes(trx, actor.userId, actor.isAdmin)
          if (
            !canManageTeam(editors, game.home_team_id) &&
            !canManageTeam(editors, game.away_team_id)
          ) {
            throw forbidden(
              'Only someone who can score this game may change its plays'
            )
          }
        }
      )
      res.json(response)
    })
  )

  router.get(
    '/games/:gameId/events',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      const stored = await readPlays(db, gameId)
      const game = await db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', gameId)
        .executeTakeFirst()
      res.json({
        plays: stored.map(playJson),
        currentPlay: game?.currentPlay ?? null
      })
    })
  )

  router.get(
    '/games/:gameId/halves',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)
      await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      const stored = await readPlays(db, gameId)
      res.json({ halves: halfOutcomes(stored.map(documentOf)) })
    })
  )

  return router
}

/** Throws 404 unless the game exists and this person can see it. */
async function requireVisibleGame(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean,
  gameId: string
): Promise<void> {
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'season_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) throw notFound()
  const scopes = await visibleScopes(db, userId, isAdmin)
  if (
    !canSeeGame(scopes, {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      seasonId: game.season_id
    })
  ) {
    throw notFound()
  }
}

function cleanBody<T>(cleaner: (raw: unknown) => T, raw: unknown): T {
  try {
    return cleaner(raw)
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : 'Malformed request body'
    )
  }
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

export {
  readPlays,
  statusAfterLivePost,
  statusAfterPost,
  unknownUser
} from '../events/postPlays'
