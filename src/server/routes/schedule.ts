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
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { gameHasPlays, resolvedFenceDistance } from '../games/fenceDistance'
import { canAdminister, currentActor } from '../groups/rights'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  mayScheduleIn,
  scheduleGames,
  scheduleRights
} from '../schedule/scheduleGames'
import { noteScopeChange } from '../socket/syncRevision'
import { tellGameWritten } from './gameWritten'

/**
 * A team's schedule, and a game's field, written through the API.
 *
 * Only an admin of the team, of a season it plays in, or of that season's
 * league — or a site admin — may write it. A team the caller can neither see
 * nor administer answers 404, so probing cannot reveal it exists. Admin
 * rights stand on their own: a season admin with no membership anywhere
 * still passes.
 */
export interface ScheduleRouteOptions {
  /**
   * Told each game an import row updated, as `lineupRoutes`' hook is, so its
   * scoreboard follows a moved time or a side flip. Fire and forget.
   */
  onGameWritten?: (gameId: string) => void
}

export function scheduleRoutes(
  db: Kysely<Database>,
  options: ScheduleRouteOptions = {}
): Router {
  const router = Router()

  router.post(
    '/teams/:teamId/games',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor == null ? null : await currentActor(db, req.actor)
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)

      const team = await db
        .selectFrom('teams')
        .select(['id', 'kind'])
        .where('id', '=', teamId)
        .executeTakeFirst()
      if (team == null) throw notFound()

      const administers = await canAdminister(db, actor, {
        kind: 'team',
        id: teamId
      })
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

      const scheduled = await scheduleGames(db, {
        teamId,
        rows: body.games,
        actor
      })
      res.json(scheduled)
      for (const row of scheduled.results)
        if (row.result === 'updated' && row.gameId != null)
          tellGameWritten(options.onGameWritten, row.gameId)
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
      // `atomic`: its last statements tell the game's screens.
      const updated = await atomic(db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        const current = await trx
          .selectFrom('users')
          .select(['is_admin', 'disabled_at', 'merged_into'])
          .where('id', '=', actor.userId)
          .executeTakeFirst()
        if (
          current == null ||
          current.disabled_at != null ||
          current.merged_into != null
        )
          throw unauthorized()
        const liveRights = await scheduleRights(
          trx,
          actor.userId,
          current.is_admin
        )
        const locked = await trx
          .selectFrom('games')
          .select(['id', 'home_team_id', 'away_team_id', 'season_id'])
          .where('id', '=', gameId)
          .forUpdate()
          .executeTakeFirst()
        if (locked == null) throw notFound()
        if (
          !mayScheduleIn(liveRights, locked.home_team_id, locked.season_id) &&
          !mayScheduleIn(liveRights, locked.away_team_id, locked.season_id)
        )
          throw forbidden(
            'Administrator authority changed. Reload before changing the field.'
          )
        if (await gameHasPlays(trx, gameId))
          throw conflict('The fence is fixed once a game has plays')
        const set = await trx
          .updateTable('games')
          .set({
            fence_distance_ft: body.fenceDistanceFt,
            updated_at: new Date()
          })
          .where('id', '=', gameId)
          .returning(resolvedFenceDistance.as('resolved'))
          .executeTakeFirstOrThrow()
        noteScopeChange(trx, { gameId })
        return set
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
