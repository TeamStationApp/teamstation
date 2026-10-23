import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { isRecord } from '../../common/groupCreation'
import {
  asScheduleSettings,
  asScheduleSetupChoice
} from '../../common/seasonScheduling'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { requireGroupAdmin } from '../groups/rights'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  saveScheduleSetup,
  saveSeasonScheduleSettings,
  scheduleSetup,
  seasonLeagueId,
  seasonScheduleSettings,
  setExhibition
} from '../scheduler/setup'

function actor(req: Request): Actor {
  if (req.actor == null) throw unauthorized()
  return req.actor
}
function clean<T>(fn: (value: unknown) => T, value: unknown): T {
  try {
    return fn(value)
  } catch (error) {
    if (error instanceof TypeError) throw badRequest(error.message)
    throw error
  }
}
const param = (value: unknown): string => {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

/**
 * What the Auto-Scheduler is set up with: a season's exhibition teams and
 * scheduling settings, and the seasons and fields of a league's next run.
 * A season's settings are its league admins' to read and change; the
 * exhibition flag is its season admins'.
 */
export function schedulingSetupRoutes(
  db: Kysely<Database>,
  options: { clock?: Clock } = {}
): Router {
  const router = Router()
  const clock = options.clock ?? realClock
  const requireLeagueAdminOf = async (
    req: Request,
    seasonId: string
  ): Promise<void> => {
    const leagueId = await seasonLeagueId(db, seasonId)
    await requireGroupAdmin(db, actor(req), { kind: 'league', id: leagueId })
  }
  router.put(
    '/seasons/:seasonId/memberships/:teamId',
    requireActor,
    withAsync(async (req, res) => {
      const seasonId = param(req.params.seasonId)
      const teamId = param(req.params.teamId)
      await requireGroupAdmin(db, actor(req), { kind: 'season', id: seasonId })
      const body: unknown = req.body
      if (!isRecord(body) || typeof body.exhibition !== 'boolean')
        throw badRequest('Choose whether the team is an exhibition team')
      await setExhibition(db, seasonId, teamId, body.exhibition)
      res.json({ seasonId, teamId, exhibition: body.exhibition })
    })
  )
  router.get(
    '/seasons/:seasonId/schedule-settings',
    requireActor,
    withAsync(async (req, res) => {
      const seasonId = param(req.params.seasonId)
      await requireLeagueAdminOf(req, seasonId)
      res.json(await seasonScheduleSettings(db, seasonId))
    })
  )
  router.put(
    '/seasons/:seasonId/schedule-settings',
    requireActor,
    withAsync(async (req, res) => {
      const seasonId = param(req.params.seasonId)
      await requireLeagueAdminOf(req, seasonId)
      const settings = clean(asScheduleSettings, req.body)
      res.json(await saveSeasonScheduleSettings(db, seasonId, settings))
    })
  )
  router.get(
    '/leagues/:leagueId/schedule-setup',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = param(req.params.leagueId)
      await requireGroupAdmin(db, actor(req), { kind: 'league', id: leagueId })
      res.json(await scheduleSetup(db, leagueId, clock))
    })
  )
  router.put(
    '/leagues/:leagueId/schedule-setup',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = param(req.params.leagueId)
      await requireGroupAdmin(db, actor(req), { kind: 'league', id: leagueId })
      const choice = clean(asScheduleSetupChoice, req.body)
      res.json(await saveScheduleSetup(db, leagueId, choice, clock))
    })
  )
  return router
}
