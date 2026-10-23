import type express from 'express'
import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { pruneAnalytics } from './analytics'
import { AnalyticsReader } from './query'
import { analyticsRoutes } from './routes'

/** Own the reader pool and maintenance timer for this server's lifetime. */
export function startAnalytics(
  app: express.Express,
  db: Kysely<Database>,
  readerUrl?: string,
  intervalMs = 3600000
): () => Promise<void> {
  const reader = readerUrl == null ? undefined : new AnalyticsReader(readerUrl)
  app.use('/api/v1', analyticsRoutes(db, reader))
  const timer = setInterval(() => {
    pruneAnalytics(db).catch(() => {})
  }, intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await reader?.close()
  }
}
