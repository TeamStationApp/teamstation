import { Router } from 'express'
import { type Kysely, sql } from 'kysely'

import { defaultReplaySettings } from '../../common/nodeSettings'
import type { Database } from '../db/database'
import { withAsync } from '../middleware/withErrors'
import { replayPitchSec } from '../nodeSettings'

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
  /** How long a replay holds each pitch, in seconds: the node's setting. */
  replayPitchSec: number
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

      // Read only once the database answered, and never failing: an outage
      // answers as it always has.
      const pitchSec =
        database === 'ok'
          ? await replayPitchSec(db)
          : defaultReplaySettings.pitchSec
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
        tess: options.tess ?? false,
        replayPitchSec: pitchSec
      }
      res.status(database === 'ok' ? 200 : 503).json(body)
    })
  )

  return router
}
