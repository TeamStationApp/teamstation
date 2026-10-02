import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { gameWrittenHook } from './gameSource'
import { makeScoreboardHub, type ScoreboardHub } from './scoreboardHub'
import {
  makeScoreboardClient,
  makeScoreboardStore,
  makeScoreboardSubscriber,
  scoreboardPrefix,
  type ScoreboardStore
} from './scoreboardStore'

export interface ScoreboardService {
  store: ScoreboardStore
  hub: ScoreboardHub
  /** What `POST /games/:gameId/events` calls once a post has committed. */
  onGameWritten: (gameId: string) => void
}

/**
 * Everything one worker needs for scoreboards: two Redis connections, the
 * store, the hub and the play-post hook.
 *
 * The connections are started and not waited for, so the API comes up
 * whether or not Redis is there, and a lost connection is retried with
 * node-redis's own backoff and never ends the worker. While Redis is away the
 * scoreboard answers 503 and its sockets 1011; nothing else notices.
 */
export function startScoreboard(options: {
  db: Kysely<Database>
  redis: { url: string; prefix: string; caFile?: string }
  databaseUrl: string
  log: (message: string) => void
  now?: () => number
  checkMs?: number
  pingMs?: number
}): ScoreboardService {
  const { db, log } = options
  const client = makeScoreboardClient(
    options.redis.url,
    log,
    'scoreboard',
    options.redis.caFile
  )
  const subscriber = makeScoreboardSubscriber(client, log)
  const connect = (name: string, run: () => Promise<unknown>): void => {
    run().catch((error: unknown) => {
      log(
        `redis ${name}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
  connect('scoreboard', async () => await client.connect())
  connect('scoreboard subscriber', async () => await subscriber.connect())
  const store = makeScoreboardStore({
    client,
    prefix: scoreboardPrefix(options.redis.prefix, options.databaseUrl),
    now: options.now
  })
  const hub = makeScoreboardHub({
    db,
    store,
    subscriber,
    log,
    now: options.now,
    checkMs: options.checkMs,
    pingMs: options.pingMs
  })
  return { store, hub, onGameWritten: gameWrittenHook({ db, store, log }) }
}
