import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import {
  dismissNotification,
  inbox,
  markViewed,
  notificationDetail
} from '../notifications/inbox'

export function notificationRoutes(
  db: Kysely<Database>,
  clock: Clock = realClock
): Router {
  const router = Router()
  router.get(
    '/me/notifications',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      if (req.query.cursor != null && typeof req.query.cursor !== 'string')
        throw badRequest('Invalid cursor')
      if (
        (req.query.history != null && req.query.history !== '1') ||
        (req.query.sent != null && req.query.sent !== '1') ||
        (req.query.sent != null && req.query.history != null)
      )
        throw badRequest('Choose pending, sent or history notifications')
      const limit = req.query.limit == null ? 25 : Number(req.query.limit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw badRequest('Limit must be one to one hundred')
      res.json(
        await inbox(
          db,
          req.actor,
          {
            history: req.query.history === '1',
            sent: req.query.sent === '1',
            cursor: req.query.cursor,
            limit
          },
          clock
        )
      )
    })
  )
  router.get(
    '/me/notifications/summary',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json({
        hasPending: (await inbox(db, req.actor, {}, clock)).hasPending
      })
    })
  )
  router.get(
    '/me/notifications/:id',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res.json(
        await notificationDetail(db, req.actor, String(req.params.id), clock)
      )
    })
  )
  router.put(
    '/me/notifications/:id/viewed',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      await markViewed(db, req.actor, String(req.params.id), clock)
      res.json({ ok: true })
    })
  )
  router.put(
    '/me/notifications/:id/dismissed',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      await dismissNotification(db, req.actor, String(req.params.id), clock)
      res.status(204).end()
    })
  )
  return router
}
