import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { requireGroupAdmin } from '../groups/rights'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export function umpireRoutes(db: Kysely<Database>): Router {
  const router = Router()
  router.get(
    '/leagues/:leagueId/umpire-settings',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const leagueId = String(req.params.leagueId)
      await requireGroupAdmin(db, req.actor, { kind: 'league', id: leagueId })
      const row = await db
        .selectFrom('leagues')
        .select([
          'umpire_management as management',
          'umpire_credits as credits'
        ])
        .where('id', '=', leagueId)
        .executeTakeFirstOrThrow()
      res.json(row)
    })
  )
  router.put(
    '/leagues/:leagueId/umpire-settings',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const leagueId = String(req.params.leagueId)
      const body = req.body
      if (body == null || typeof body !== 'object' || Array.isArray(body))
        throw badRequest('Supply umpire settings')
      for (const key of Object.keys(body)) {
        if (
          !['management', 'credits'].includes(key) ||
          typeof body[key] !== 'boolean'
        )
          throw badRequest('Umpire settings must be booleans')
      }
      const settings = await db.transaction().execute(async trx => {
        await lockKeys(trx, ['creation:parent-graph', `umpires:${leagueId}`])
        await requireGroupAdmin(trx, actor, { kind: 'league', id: leagueId })
        const row = await trx
          .selectFrom('leagues')
          .selectAll()
          .where('id', '=', leagueId)
          .forUpdate()
          .executeTakeFirstOrThrow()
        const management = body.management ?? row.umpire_management
        const credits = body.credits ?? row.umpire_credits
        await trx
          .updateTable('leagues')
          .set({ umpire_management: management, umpire_credits: credits })
          .where('id', '=', leagueId)
          .execute()
        return { management, credits }
      })
      res.json(settings)
    })
  )
  return router
}
