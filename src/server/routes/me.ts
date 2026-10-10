import { Router } from 'express'
import type { Kysely } from 'kysely'

import { unauthorized } from '../../common/errors'
import { type Role, ROLES } from '../../common/roles'
import { roleScopes, rolesOnTeam } from '../access'
import type { Database } from '../db/database'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
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
 */
export function meRoutes(db: Kysely<Database>, buildsUrl?: string): Router {
  const router = Router()

  router.get(
    '/me/builds',
    requireActor,
    withAsync(async (req, res) => {
      if ((await activeHuman(db, req.actor)) == null) throw unauthorized()
      res.set('Cache-Control', 'no-store').json({ url: buildsUrl })
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
      res.json({ teams })
    })
  )

  return router
}
