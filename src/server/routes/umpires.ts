import { type Request, Router } from 'express'
import type { Kysely, Transaction } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import type { UmpirePerson } from '../../common/umpires'
import {
  UMPIRE_LEADERBOARD_MAX_PAGE,
  type UmpireLeaderboardQuery
} from '../../common/umpireSchedule'
import {
  parseUmpireSortArray,
  storedUmpireSort,
  umpireSortError
} from '../../common/umpireSort'
import { visibleScopes } from '../access'
import { now } from '../clock'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { parseUmpirePageQuery } from '../events/eventListQuery'
import { requireGroupAdmin } from '../groups/rights'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { noteScopeChange } from '../socket/syncRevision'
import * as admin from '../umpires/admin'
import { deleteSlot, leaderboard, saveSlot } from '../umpires/assignments'
import {
  availabilityPasses,
  type AvailabilityQuery,
  commitmentWindow,
  type MatchedAt,
  matchedAt,
  parseAvailabilityQuery,
  readAvailability,
  requireOwnAvailability,
  saveAvailability,
  umpireCommitments
} from '../umpires/availability'
import {
  addNoteType,
  noteTypes,
  removeNoteType,
  saveNote
} from '../umpires/notes'
import { queryInteger } from '../umpires/queryInteger'
import { savePeople } from '../umpires/savePeople'
import {
  parseUmpireFilters,
  parseUmpireSortQuery,
  schedule,
  umpireLeagues,
  umpireSchedulePage
} from '../umpires/schedule'
import { addType, removeType, types } from '../umpires/types'
import { readerOf } from '../users/readerNames'

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

/** The page a leaderboard request asks for; none when it names no parameter. */
function leaderboardQueryOf(
  query: Request['query']
): UmpireLeaderboardQuery | undefined {
  const { order, limit, offset } = query
  if (order == null && limit == null && offset == null) return undefined
  if (order != null && order !== 'asc' && order !== 'desc')
    throw badRequest('Order the leaderboard asc or desc')
  const whole = (
    name: string,
    value: unknown,
    least: number,
    most: number
  ): number | undefined =>
    queryInteger(
      value,
      least,
      most,
      `Supply one ${name} from ${least} to ${most}`
    )
  return {
    order: order ?? undefined,
    limit: whole('limit', limit, 1, UMPIRE_LEADERBOARD_MAX_PAGE),
    offset: whole('offset', offset, 0, Number.MAX_SAFE_INTEGER)
  }
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
          'umpire_credits as credits',
          'umpire_sort as sort'
        ])
        .where('id', '=', leagueId)
        .executeTakeFirstOrThrow()
      res.json({ ...row, sort: storedUmpireSort(row.sort) })
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
        if (key === 'sort') {
          // null is the built-in default; [] the empty sort.
          if (body.sort !== null && parseUmpireSortArray(body.sort) == null)
            throw badRequest(umpireSortError('body'))
        } else if (
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
        // A save without `sort` leaves the stored one as it is, even one this
        // build cannot wholly read (a newer build's key after a rollback), and
        // answers it as this build reads it.
        const sort =
          body.sort === undefined
            ? storedUmpireSort(row.umpire_sort)
            : parseUmpireSortArray(body.sort)
        await trx
          .updateTable('leagues')
          .set({
            umpire_management: management,
            umpire_credits: credits,
            ...(body.sort === undefined ? {} : { umpire_sort: sort })
          })
          .where('id', '=', leagueId)
          .execute()
        if (management !== row.umpire_management)
          await noteLeagueGames(trx, leagueId)
        return { management, credits, sort }
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
  // The league's season order, written whole: the requirements screen's
  // seasons first to last. The league's other seasons lose their position,
  // so a season of the list that ended since it was read is left out of it.
  manage(
    'put',
    '/leagues/:leagueId/umpire-season-priority',
    async (trx, league, req) => {
      const refused = badRequest(
        'Choose this league’s current and upcoming seasons'
      )
      const ids: unknown = req.body?.seasonIds
      if (
        !Array.isArray(ids) ||
        ids.length > 500 ||
        new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string')
      )
        throw refused
      const { current, ended } = await admin.leagueSeasons(trx, league, now())
      if ((ids as string[]).some(id => !current.has(id) && !ended.has(id)))
        throw refused
      const kept = (ids as string[]).filter(id => current.has(id))
      if (kept.length === 0) throw refused
      await admin.savePriority(trx, league, kept)
      return { seasons: await admin.requirements(trx, league, now(), media) }
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
          media,
          readerOf(req.actor),
          await visibleScopes(trx, req.actor!.userId, req.actor!.isAdmin)
        )
      }
    }
  )
  // The league's umpires, each carrying their saved filter for the league;
  // the availability parameters, when given, keep only the people it leaves
  // in. GET and PUT answer through it, so both answer one shape.
  const umpireList = async (
    trx: Kysely<Database>,
    league: string,
    req: Request,
    query: AvailabilityQuery | undefined
  ): Promise<{ people: UmpirePerson[]; matchedAt?: MatchedAt[] }> => {
    const { people, accounts } = await admin.peopleWithAccounts(
      trx,
      league,
      undefined,
      media,
      readerOf(req.actor),
      await visibleScopes(trx, req.actor!.userId, req.actor!.isAdmin)
    )
    // The list already resolved each person's merged accounts.
    const saved = await readAvailability(
      trx,
      league,
      people.map(person => person.id),
      accounts
    )
    return {
      people: people
        .map(person => ({
          ...person,
          umpireAvailability: saved.get(person.id) ?? null
        }))
        .filter(
          person =>
            query == null ||
            availabilityPasses(person.umpireAvailability, query)
        ),
      ...(query?.at != null && 'start' in query.at
        ? {
            matchedAt: await matchedAt(
              trx,
              league,
              query.at.start,
              saved.values()
            )
          }
        : {})
    }
  }
  manage(
    'get',
    '/leagues/:leagueId/umpires',
    async (trx, league, req) =>
      await umpireList(trx, league, req, parseAvailabilityQuery(req.query))
  )
  manage(
    'get',
    '/leagues/:leagueId/umpires/:userId/commitments',
    async (trx, league, req) => {
      const window = commitmentWindow(req.query.from, req.query.to)
      return {
        commitments: await umpireCommitments(
          trx,
          req.actor!,
          league,
          String(req.params.userId),
          window.from,
          window.to
        )
      }
    }
  )
  manage('put', '/leagues/:leagueId/umpires', async (trx, league, req) => {
    await savePeople(trx, league, req.actor!.userId, req.body)
    return await umpireList(trx, league, req, undefined)
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

  // The signed-in person's own saved filter for a league, for whoever may
  // open its umpire schedule; anybody else is answered 404.
  router.get(
    '/leagues/:leagueId/me/umpire-availability',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const leagueId = String(req.params.leagueId)
      await requireOwnAvailability(db, actor, leagueId)
      const saved = await readAvailability(db, leagueId, [actor.userId])
      res.json({ availability: saved.get(actor.userId) ?? null })
    })
  )
  router.put(
    '/leagues/:leagueId/me/umpire-availability',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const leagueId = String(req.params.leagueId)
      const body = req.body
      if (
        body == null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !('availability' in body)
      )
        throw badRequest('Choose a valid filter.')
      const availability = await atomic(db, async trx => {
        await lockKeys(trx, [
          'creation:parent-graph',
          `umpires:${leagueId}`,
          'users.closeInto'
        ])
        await requireOwnAvailability(trx, actor, leagueId)
        return await saveAvailability(
          trx,
          leagueId,
          actor.userId,
          body.availability
        )
      })
      res.json({ availability })
    })
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
      const leagueId = String(req.params.leagueId)
      const filters = parseUmpireFilters(req.query)
      const sort = parseUmpireSortQuery(req.query)
      const page = parseUmpirePageQuery(req.query)
      if (page.paged) {
        if (view === 'league')
          throw badRequest('paged does not apply with view=league')
        res.json(
          await umpireSchedulePage(
            db,
            req.actor,
            leagueId,
            view,
            filters,
            page,
            readerOf(req.actor),
            sort
          )
        )
        return
      }
      res.json(
        await schedule(
          db,
          req.actor,
          leagueId,
          view,
          filters,
          readerOf(req.actor),
          sort
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
      res.json(
        await leaderboard(
          db,
          req.actor,
          String(req.params.leagueId),
          leaderboardQueryOf(req.query)
        )
      )
    })
  )
  return router
}
