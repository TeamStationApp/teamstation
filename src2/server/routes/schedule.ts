import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  forbidden,
  notFound,
  unauthorized
} from '../../common/errors'
import { asScheduleGamesBody } from '../../common/scheduleGames'
import { canSeeTeam, visibleScopes } from '../access'
import type { Database } from '../db/database'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { scheduleGames, scheduleRights } from '../schedule/scheduleGames'

/**
 * A team's schedule, written through the API.
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

  return router
}

/** A path segment, or 404 for one Express could not give as one string. */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
