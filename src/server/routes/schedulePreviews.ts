import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { isRecord } from '../../common/groupCreation'
import {
  asPreviewEditsBody,
  asPreviewRequest
} from '../../common/schedulePreviews'
import type { Actor } from '../auth/sessions'
import {
  buildPreview,
  editPreview,
  previewFor,
  previewView
} from '../autoScheduler/previews'
import { publishPreview } from '../autoScheduler/publish'
import { gamesToReschedule } from '../autoScheduler/reschedule'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { requireGroupAdmin } from '../groups/rights'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

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
 * The Auto-Scheduler's previews of a league's schedule: building one,
 * reading and editing it, publishing one of its options, and the league's
 * published games that need rescheduling. Every route is for an admin of
 * the league.
 */
export function schedulePreviewRoutes(
  db: Kysely<Database>,
  options: { clock?: Clock } = {}
): Router {
  const router = Router()
  const clock = options.clock ?? realClock
  router.post(
    '/leagues/:leagueId/schedule-previews',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = param(req.params.leagueId)
      const request = clean(asPreviewRequest, req.body)
      res
        .status(201)
        .json(await buildPreview(db, actor(req), leagueId, request, clock))
    })
  )
  router.get(
    '/leagues/:leagueId/games-to-reschedule',
    requireActor,
    withAsync(async (req, res) => {
      const leagueId = param(req.params.leagueId)
      await requireGroupAdmin(db, actor(req), { kind: 'league', id: leagueId })
      res.json({ items: await gamesToReschedule(db, leagueId, clock) })
    })
  )
  router.get(
    '/schedule-previews/:previewId',
    requireActor,
    withAsync(async (req, res) => {
      const row = await previewFor(db, actor(req), param(req.params.previewId))
      res.json(await previewView(db, row, clock))
    })
  )
  router.put(
    '/schedule-previews/:previewId',
    requireActor,
    withAsync(async (req, res) => {
      const body = clean(asPreviewEditsBody, req.body)
      res.json(
        await editPreview(
          db,
          actor(req),
          param(req.params.previewId),
          body,
          clock
        )
      )
    })
  )
  router.post(
    '/schedule-previews/:previewId/publications',
    requireActor,
    withAsync(async (req, res) => {
      const body: unknown = req.body
      const option =
        isRecord(body) &&
        typeof body.option === 'number' &&
        Number.isInteger(body.option)
          ? body.option
          : undefined
      if (option == null) throw badRequest('Choose the option to publish')
      res.json(
        await publishPreview(
          db,
          actor(req),
          param(req.params.previewId),
          option,
          clock
        )
      )
    })
  )
  return router
}
