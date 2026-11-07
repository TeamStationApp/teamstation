import { Router } from 'express'
import type { Kysely } from 'kysely'

import { unauthorized } from '../../common/errors'
import { type Role, ROLES } from '../../common/roles'
import { guardedPlayers, roleScopes, rolesOnTeam } from '../access'
import type { Database } from '../db/database'
import { homeLists } from '../home/homeLists'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { distributionSettings } from '../nodeSettings'
import { activeHuman } from '../oauth/provider'

/**
 * What the signed-in person may do, for the few buttons no other answer
 * already carries.
 *
 * `GET /me/roles` is every team on which they hold any role, with the roles
 * they hold there: the ones set on the team, the ones its season and league
 * carry down, every role on a team they administer, and `songkeeper` beside
 * `scorekeeper`, which holds everything a songkeeper does. An assistant is
 * listed as `assistant`. A team where they hold none is left out rather than
 * listed empty. A site administrator holds every role on every team.
 * `guardianOf` is the players they are a guardian of, by the row each signs
 * in as.
 */
export function meRoutes(
  db: Kysely<Database>,
  buildsUrl: string | undefined,
  media: MediaContext
): Router {
  const router = Router()

  router.get(
    '/me/builds',
    requireActor,
    withAsync(async (req, res) => {
      if ((await activeHuman(db, req.actor)) == null) throw unauthorized()
      const links = await distributionSettings(db)
      const beta = links.betaBuildsUrl !== '' ? links.betaBuildsUrl : buildsUrl
      const body: {
        url?: string
        betaBuildsUrl?: string
        appStoreUrl?: string
      } = {}
      if (beta != null && beta !== '') {
        body.url = beta
        body.betaBuildsUrl = beta
      }
      if (links.appStoreUrl !== '') body.appStoreUrl = links.appStoreUrl
      res.set('Cache-Control', 'no-store').json(body)
    })
  )

  router.get(
    '/me/roles',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const scopes = await roleScopes(db, actor.userId, actor.isAdmin)

      const teamIds = new Set<string>(
        scopes.isAdmin
          ? (await db.selectFrom('teams').select(['id']).execute()).map(
              row => row.id
            )
          : ROLES.flatMap(role => [...scopes[role].teamIds])
      )

      const teams: Record<string, Role[]> = {}
      for (const teamId of [...teamIds].sort()) {
        teams[teamId] = rolesOnTeam(scopes, teamId)
      }
      res.json({ teams, guardianOf: await guardedPlayers(db, actor.userId) })
    })
  )

  // Direct ties first, then a row reached only by inheritance or by being
  // an admin. The site-admin flag adds nothing here.
  router.get(
    '/me/home',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      res.json(await homeLists(db, actor.userId, media.space))
    })
  )

  return router
}
