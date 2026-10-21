import { type Request, Router } from 'express'
import type { Kysely, Transaction } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { now } from '../clock'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { requireGroupAdmin } from '../groups/rights'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import * as admin from '../umpires/admin'
import {
  parseUmpireFilters,
  schedule,
  umpireLeagues
} from '../umpires/schedule'

export function umpireRoutes(
  db: Kysely<Database>,
  media?: MediaContext
): Router {
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

  const manage = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    action: (
      trx: Transaction<Database>,
      league: string,
      req: Request
    ) => Promise<unknown>
  ): void => {
    router[method](
      path,
      requireActor,
      withAsync(async (req, res) => {
        const actor = req.actor
        if (actor == null) throw unauthorized()
        const league = String(req.params.leagueId)
        const result = await db
          .transaction()
          .setIsolationLevel(
            method === 'get' ? 'repeatable read' : 'read committed'
          )
          .execute(async trx => {
            if (method !== 'get')
              await lockKeys(trx, [
                'creation:parent-graph',
                `umpires:${league}`,
                'users.closeInto'
              ])
            await requireGroupAdmin(trx, actor, { kind: 'league', id: league })
            return await action(trx, league, req)
          })
        res.json(result ?? { ok: true })
      })
    )
  }
  manage('get', '/leagues/:leagueId/umpire-levels', async (trx, league) => ({
    levels: await admin.levels(trx, league)
  }))
  manage(
    'post',
    '/leagues/:leagueId/umpire-levels',
    async (trx, league, req) =>
      await admin.addLevel(trx, league, req.body?.name)
  )
  manage(
    'delete',
    '/leagues/:leagueId/umpire-levels/:levelId',
    async (trx, league, req) => {
      await admin.removeLevel(trx, league, String(req.params.levelId))
    }
  )
  manage(
    'get',
    '/leagues/:leagueId/umpire-requirements',
    async (trx, league) => ({
      seasons: await admin.requirements(trx, league, now(), media)
    })
  )
  manage(
    'put',
    '/leagues/:leagueId/umpire-requirements',
    async (trx, league, req) => {
      await admin.applyRequirements(trx, league, req.body, now())
    }
  )
  manage(
    'get',
    '/leagues/:leagueId/umpire-candidates',
    async (trx, league, req) => {
      if (req.query.q != null && typeof req.query.q !== 'string')
        throw badRequest('Supply one search query')
      return {
        people: await admin.people(
          trx,
          league,
          String(req.query.q ?? ''),
          media
        )
      }
    }
  )
  manage('get', '/leagues/:leagueId/umpires', async (trx, league) => ({
    people: await admin.people(trx, league, undefined, media)
  }))
  manage('post', '/leagues/:leagueId/umpires', async (trx, league, req) => {
    if (typeof req.body?.userId !== 'string')
      throw badRequest('Choose a person')
    await admin.grant(trx, league, req.body.userId, req.actor!.userId)
  })
  manage(
    'delete',
    '/leagues/:leagueId/umpires/:userId',
    async (trx, league, req) => {
      await admin.revoke(trx, league, String(req.params.userId))
    }
  )
  manage(
    'put',
    '/leagues/:leagueId/umpires/:userId/certifications',
    async (trx, league, req) => {
      await admin.certify(trx, league, String(req.params.userId), req.body)
    }
  )

  router.get(
    '/me/umpire-leagues',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json({ leagues: await umpireLeagues(db, req.actor, media) })
    })
  )
  router.get(
    '/leagues/:leagueId/umpire-schedule',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const view = req.query.view ?? 'umpire'
      if (view !== 'umpire' && view !== 'league')
        throw badRequest('Choose umpire or league view')
      res.json(
        await schedule(
          db,
          req.actor,
          String(req.params.leagueId),
          view,
          parseUmpireFilters(req.query)
        )
      )
    })
  )
  return router
}
