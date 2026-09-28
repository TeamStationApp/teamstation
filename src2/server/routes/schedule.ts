import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { asFenceDistanceBody } from '../../common/fenceDistance'
import { asScheduleGamesBody } from '../../common/scheduleGames'
import { canSeeGame, canSeeTeam, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { gameHasPlays, resolvedFenceDistance } from '../games/fenceDistance'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  mayScheduleIn,
  scheduleGames,
  scheduleRights
} from '../schedule/scheduleGames'

/**
 * A team's schedule, and a game's field, written through the API.
 *
 * Only an admin of the team, of a season it plays in, or of that season's
 * league — or a site admin — may write it. A team the caller can neither see
 * nor administer answers 404, so probing cannot reveal it exists. Admin
 * rights stand on their own: a season admin with no membership anywhere
 * still passes.
 */
export function scheduleRoutes(db: Kysely<Database>): Router {
  const router = Router()

  router.post(
    '/teams/:teamId/games',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)

      const team = await db
        .selectFrom('teams')
        .select(['id', 'kind'])
        .where('id', '=', teamId)
        .executeTakeFirst()
      if (team == null) throw notFound()

      const rights = await scheduleRights(db, actor.userId, actor.isAdmin)
      let administers = rights.siteAdmin || rights.teamAdminIds.has(teamId)
      if (!administers && rights.seasonIds.size > 0) {
        const inSeason = await db
          .selectFrom('season_teams')
          .select(['season_id'])
          .where('team_id', '=', teamId)
          .where('season_id', 'in', [...rights.seasonIds])
          .executeTakeFirst()
        administers = inSeason != null
      }
      if (!administers) {
        const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
        if (!canSeeTeam(scopes, teamId)) throw notFound()
        throw forbidden(
          'Only an admin of this team, its season or its league may schedule its games'
        )
      }

      if (team.kind === 'external') {
        throw badRequest(
          'An opponent from outside a season has no schedule of its own'
        )
      }
      let body: { games: unknown[] }
      try {
        body = asScheduleGamesBody(req.body)
      } catch (error) {
        throw badRequest(
          error instanceof Error ? error.message : 'Malformed request body'
        )
      }

      res.json(await scheduleGames(db, { teamId, rows: body.games, rights }))
    })
  )

  /**
   * How far the fence stands for one game, or `null` to play it to its
   * season's or league's. A site admin, an admin of either team, or of the
   * game's season or league may set it; a game the caller cannot see answers
   * 404, and one they see but do not administer 403.
   */
  router.put(
    '/games/:gameId/field',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const gameId = pathParam(req.params.gameId)

      const game = await db
        .selectFrom('games')
        .select([
          'home_team_id',
          'away_team_id',
          'season_id',
          'fence_distance_ft'
        ])
        .where('id', '=', gameId)
        .executeTakeFirst()
      if (game == null) throw notFound()

      const rights = await scheduleRights(db, actor.userId, actor.isAdmin)
      if (
        !mayScheduleIn(rights, game.home_team_id, game.season_id) &&
        !mayScheduleIn(rights, game.away_team_id, game.season_id)
      ) {
        const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
        const seen = canSeeGame(scopes, {
          homeTeamId: game.home_team_id,
          awayTeamId: game.away_team_id,
          seasonId: game.season_id
        })
        if (!seen) throw notFound()
        throw forbidden(
          'Only an admin of its teams, its season or its league may set a game’s field'
        )
      }

      const body = cleanBody(asFenceDistanceBody, req.body)
      // Only a game without plays: posting its first fixes its fence, in the
      // same transaction that stores them. The game row is locked first, as
      // a post locks it, and its plays read after, so a post that stored
      // some while this waited is seen.
      const updated = await db.transaction().execute(async trx => {
        const locked = await trx
          .selectFrom('games')
          .select('id')
          .where('id', '=', gameId)
          .forUpdate()
          .executeTakeFirst()
        if (locked == null) throw notFound()
        if (await gameHasPlays(trx, gameId))
          throw conflict('The fence is fixed once a game has plays')
        return await trx
          .updateTable('games')
          .set({
            fence_distance_ft: body.fenceDistanceFt,
            updated_at: new Date()
          })
          .where('id', '=', gameId)
          .returning(resolvedFenceDistance.as('resolved'))
          .executeTakeFirstOrThrow()
      })

      setAudit(res.locals, {
        entityType: 'game',
        entityId: gameId,
        before: { fenceDistanceFt: game.fence_distance_ft },
        after: { fenceDistanceFt: body.fenceDistanceFt }
      })
      res.json({
        gameId,
        fenceDistanceFt: body.fenceDistanceFt,
        resolvedFenceDistanceFt: Number(updated.resolved)
      })
    })
  )

  return router
}

/** A path segment, or 404 for one Express could not give as one string. */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
