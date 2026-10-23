import express, { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, HttpError, unavailable } from '../../common/errors'
import { RateLimit } from '../../common/observability/rateLimit'
import type { Database } from '../db/database'
import { setAudit } from '../middleware/withAudit'
import { requireActor, requireAdmin } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { analyticsBatch, storeAnalytics } from './analytics'
import type { AnalyticsReader } from './query'

export function analyticsRoutes(
  db: Kysely<Database>,
  reader?: AnalyticsReader
): Router {
  const router = Router()
  const rate = new RateLimit()
  router.post(
    '/analytics/events',
    (req, _res, next) => {
      next(
        rate.allow(req.actor?.userId ?? req.ip ?? 'unknown')
          ? undefined
          : new HttpError('rateLimited', 'Analytics rate limit reached')
      )
    },
    express.text({ type: 'application/x-ndjson', limit: '64kb' }),
    withAsync(async (req, res) => {
      await storeAnalytics(db, analyticsBatch(req.body), req.actor)
      res.status(202).json({ accepted: true })
    })
  )
  router.post(
    '/admin/analytics/query',
    requireActor,
    requireAdmin,
    withAsync(async (req, res) => {
      if (reader == null)
        throw unavailable('Analytics reader is not configured')
      const body: unknown = req.body
      if (
        body == null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(k => !['sql', 'parameters'].includes(k))
      )
        throw badRequest('Invalid analytics query')
      const { sql, parameters } = body as {
        sql?: unknown
        parameters?: unknown
      }
      const started = Date.now()
      const result = await reader.query(sql, parameters)
      setAudit(res.locals, {
        entityType: 'analytics_query',
        after: {
          status: 200,
          durationMs: Date.now() - started,
          rows: result.rows.length
        }
      })
      res.json(result)
    })
  )
  return router
}
