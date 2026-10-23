import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'
import { withAsync } from '../middleware/withErrors'

export interface HealthBody {
  status: 'ok' | 'degraded'
  version: string
  database: 'ok' | 'unreachable'
  migrations: number
  uptimeSec: number
  pid: number
  /** Whether dictation is configured. Never the key. */
  dictation: boolean
  /** The LLMs dictation has a key for. */
  dictationModels: string[]
  /** Whether the replay's announcer can speak. Never the key. */
  narration: boolean
  /** Whether Tess, the assistant, has a key. Never the key. */
  tess: boolean
}

/**
 * Answers without authentication, because a load balancer has no token. It
 * reports what the process can see and never leaks a connection string.
 */
export function healthRoutes(
  db: Kysely<Database>,
  version: string,
  options: {
    dictation?: boolean
    dictationModels?: readonly string[]
    narration?: boolean
    tess?: boolean
  } = {}
): Router {
  const router = Router()

  router.get(
    '/health',
    withAsync(async (req, res) => {
      let database: 'ok' | 'unreachable' = 'unreachable'
      let migrations = 0
      try {
        const result = await sql<{ count: string }>`
          select count(*)::text as count from schema_migrations
        `.execute(db)
        migrations = Number(result.rows[0]?.count ?? 0)
        database = 'ok'
      } catch (error) {
        console.error('health: database unreachable', error)
      }

      const body: HealthBody = {
        status: database === 'ok' ? 'ok' : 'degraded',
        version,
        database,
        migrations,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        dictation: options.dictation ?? false,
        dictationModels: [...(options.dictationModels ?? [])],
        narration: options.narration ?? false,
        tess: options.tess ?? false
      }
      res.status(database === 'ok' ? 200 : 503).json(body)
    })
  )

  return router
}
