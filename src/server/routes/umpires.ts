import { type Request, Router } from 'express'
import type { Kysely, Transaction } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { now } from '../clock'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { requireGroupAdmin } from '../groups/rights'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { noteScopeChange } from '../socket/syncRevision'
import * as admin from '../umpires/admin'
import { deleteSlot, leaderboard, saveSlot } from '../umpires/assignments'
import {
  addNoteType,
  noteTypes,
  removeNoteType,
  saveNote
} from '../umpires/notes'
import { savePeople } from '../umpires/savePeople'
import {
  parseUmpireFilters,
  schedule,
  umpireLeagues
} from '../umpires/schedule'
import { addType, removeType, types } from '../umpires/types'

/** League configuration can change every game's displayed slots or occupants. */
async function noteLeagueGames(
  trx: Transaction<Database>,
  leagueId: string
): Promise<void> {
  const games = await trx
    .selectFrom('games')
    .innerJoin('seasons', 'seasons.id', 'games.season_id')
    .select('games.id')
    .where('seasons.league_id', '=', leagueId)
    .execute()
  for (const game of games) noteScopeChange(trx, { gameId: game.id })
}

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
      const settings = await atomic(db, async trx => {
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
        if (management !== row.umpire_management)
          await noteLeagueGames(trx, leagueId)
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
        const run = async (trx: Transaction<Database>): Promise<unknown> => {
          if (method !== 'get')
            await lockKeys(trx, [
              'creation:parent-graph',
              `umpires:${league}`,
              'users.closeInto'
            ])
          await requireGroupAdmin(trx, actor, { kind: 'league', id: league })
          const result = await action(trx, league, req)
          if (method !== 'get') await noteLeagueGames(trx, league)
          return result
        }
        const result =
          method === 'get'
            ? await db
                .transaction()
                .setIsolationLevel('repeatable read')
                .execute(run)
            : await atomic(db, run)
        res.json(result ?? { ok: true })
      })
    )
  }
  manage(
    'get',
    '/leagues/:leagueId/umpire-note-types',
    async (trx, league) => ({ types: await noteTypes(trx, league) })
  )
  manage(
    'post',
    '/leagues/:leagueId/umpire-note-types',
    async (trx, league, req) => await addNoteType(trx, league, req.body?.name)
  )
  manage(
    'delete',
    '/leagues/:leagueId/umpire-note-types/:typeId',
    async (trx, league, req) => {
      await removeNoteType(trx, league, String(req.params.typeId))
    }
  )
  router.put(
    '/games/:gameId/umpire-notes/:typeId',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const result = await db.transaction().execute(async trx => {
        await lockKeys(trx, ['creation:parent-graph', 'users.closeInto'])
        return await saveNote(
          trx,
          actor,
          String(req.params.gameId),
          String(req.params.typeId),
          req.body
        )
      })
      res.json(result)
    })
  )
  manage('get', '/leagues/:leagueId/umpire-types', async (trx, league) => ({
    types: await types(trx, league)
  }))
  manage(
    'post',
    '/leagues/:leagueId/umpire-types',
    async (trx, league, req) => await addType(trx, league, req.body?.name)
  )
  manage(
    'delete',
    '/leagues/:leagueId/umpire-types/:typeId',
    async (trx, league, req) => {
      await removeType(trx, league, String(req.params.typeId))
    }
  )
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
  manage('put', '/leagues/:leagueId/umpires', async (trx, league, req) => {
    await savePeople(trx, league, req.actor!.userId, req.body)
    return { people: await admin.people(trx, league, undefined, media) }
  })
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
      if (view !== 'umpire' && view !== 'league' && view !== 'schedule')
        throw badRequest('Choose umpire, league or schedule view')
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

  for (const method of ['post', 'delete'] as const)
    router[method](
      '/games/:gameId/umpire-slots',
      requireActor,
      withAsync(async (req, res) => {
        const actor = req.actor
        if (actor == null) throw unauthorized()
        await atomic(db, async trx => {
          await lockKeys(trx, ['creation:parent-graph', 'users.closeInto'])
          if (method === 'post')
            await saveSlot(trx, actor, String(req.params.gameId), req.body)
          else
            await deleteSlot(
              trx,
              actor,
              String(req.params.gameId),
              req.body?.slot
            )
          noteScopeChange(trx, { gameId: String(req.params.gameId) })
        })
        res.json({ ok: true })
      })
    )
  router.get(
    '/leagues/:leagueId/umpire-leaderboard',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json(await leaderboard(db, req.actor, String(req.params.leagueId)))
    })
  )
  return router
}
