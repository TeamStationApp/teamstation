import type { Kysely } from 'kysely'

import type { Stoppable } from '../backgroundJobs'
import { skipWhileRunning } from '../backgroundJobs'
import type { Database } from '../db/database'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import {
  makeScoreboardClient,
  makeScoreboardStore,
  scoreboardPrefix,
  type ScoreboardStore
} from '../scoreboard/scoreboardStore'
import { LOGO_SETTLE_MS, settleGameLogos } from './logos'
import { sweepSponsorMedia } from './media'

/** How often uploads nothing used are looked for. */
export const MEDIA_SWEEP_MS = 60 * 60 * 1000

export interface SponsorSweepOptions {
  db: Kysely<Database>
  space: SpaceSettings
  redis: { url: string; prefix: string; caFile?: string }
  databaseUrl: string
  log: (message: string) => void
  now?: () => Date
  /** For a test: the store the sweeps tell live players through. */
  makeStore?: () => { store: ScoreboardStore; close: () => Promise<void> }
}

/**
 * The sponsor sweeps, run once a node from `startBackgroundJobs`: every
 * minute the game logos not yet settled are charged or settled free
 * (`settleGameLogos`), and every hour the uploads nothing used are swept,
 * each on the way up and then on its period. They tell
 * live players of a change through a scoreboard store of their own, on its
 * own Valkey connection, which is started and not waited for, as a worker's
 * is. Answers how to stop: the timers, and that connection.
 */
export function startSponsorSweeps(options: SponsorSweepOptions): Stoppable & {
  store: ScoreboardStore
} {
  const { db, space, log } = options
  const now = options.now ?? (() => new Date())
  const { store, close } = (options.makeStore ?? defaultStore(options))()
  const timers: Array<ReturnType<typeof setInterval>> = []
  const every = (ms: number, sweep: () => Promise<void>): void => {
    const run = skipWhileRunning(async () => {
      await sweep().catch((error: unknown) => {
        log(`sponsor sweeps: ${String(error)}`)
      })
    })
    run()
    const timer = setInterval(run, ms)
    timer.unref?.()
    timers.push(timer)
  }
  every(LOGO_SETTLE_MS, async () => {
    const settled = await settleGameLogos(db, now())
    if (settled.charged + settled.free > 0)
      log(
        `settled ${settled.charged + settled.free} game logo(s), ${settled.charged} charged`
      )
  })
  if (spaceConfigured(space))
    every(MEDIA_SWEEP_MS, async () => {
      const gone = await sweepSponsorMedia(db, space, now(), log)
      if (gone > 0) log(`swept ${gone} unused sponsor upload(s)`)
    })
  return {
    store,
    stop: async () => {
      for (const timer of timers) clearInterval(timer)
      await close()
    }
  }
}

function defaultStore(
  options: SponsorSweepOptions
): () => { store: ScoreboardStore; close: () => Promise<void> } {
  return () => {
    const client = makeScoreboardClient(
      options.redis.url,
      options.log,
      'sponsor sweeps',
      options.redis.caFile
    )
    client.connect().catch((error: unknown) => {
      options.log(`redis sponsor sweeps: ${String(error)}`)
    })
    return {
      store: makeScoreboardStore({
        client,
        prefix: scoreboardPrefix(options.redis.prefix, options.databaseUrl)
      }),
      // At once when Valkey is away: a graceful close would wait for it.
      close: async () => {
        if (client.isReady) await client.close().catch(() => undefined)
        else if (client.isOpen) client.destroy()
      }
    }
  }
}
