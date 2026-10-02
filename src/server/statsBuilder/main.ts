import { Client } from 'pg'

import { makeDatabase } from '../db/database'
import { serverConfig } from '../serverConfig'
import {
  type AfterReadHook,
  type Clock,
  drain,
  earliestRetryAt
} from './builder'

const MAX_TIMER_MS = 60_000

export interface RunStatsBuilderOptions {
  databaseUrl: string
  clock?: Clock
  /** When set, used instead of wiring process signals (tests). */
  signals?: NodeJS.EventEmitter
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  /** Test seam: called after a game is read, before the result is written. */
  afterRead?: AfterReadHook | null
}

export interface StatsBuilderHandle {
  stop: (signal?: NodeJS.Signals) => Promise<void>
  /** Most recent timer delay in ms; null before the first schedule. */
  lastTimerMs: () => number | null
  /** Test access to the LISTEN client. */
  listenClient: () => Client
}

/**
 * Open the database, LISTEN for pokes, drain on start and on every notify,
 * and schedule retries from `retry_at`.
 */
export async function runStatsBuilder(
  options: RunStatsBuilderOptions
): Promise<StatsBuilderHandle> {
  const clock: Clock = options.clock ?? (() => new Date())
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimerFn = options.clearTimeout ?? clearTimeout
  const db = makeDatabase(options.databaseUrl)
  const listen = new Client({ connectionString: options.databaseUrl })
  await listen.connect()
  await listen.query('listen game_stats')

  let draining = false
  let pokedDuringDrain = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopping: Promise<void> | null = null
  let stopped = false
  /** Only the latest scheduleTimer may arm a timeout. */
  let scheduleGen = 0
  /** Last delay passed to setTimeout; tests read this. */
  let lastTimerMs: number | null = null

  const clearTimer = (): void => {
    if (timer != null) {
      clearTimerFn(timer)
      timer = null
    }
  }

  const failHard = (label: string, error: unknown): void => {
    console.error(`stats builder: ${label}`, error)
    if (stopped) return
    stopped = true
    clearTimer()
    process.exitCode = 1
    void listen.end().catch(() => undefined)
    void db.destroy().catch(() => undefined)
    /* c8 ignore next */
    if (options.signals == null) process.exit(1)
  }

  const scheduleTimer = async (): Promise<void> => {
    const mine = ++scheduleGen
    clearTimer()
    if (stopped) return
    const next = await earliestRetryAt(db, clock)
    // A newer schedule, or stop(), won while we awaited.
    if (stopped || mine !== scheduleGen) return
    clearTimer()
    const now = clock().getTime()
    let waitMs = MAX_TIMER_MS
    if (next != null) {
      waitMs = Math.min(MAX_TIMER_MS, Math.max(0, next.getTime() - now))
    }
    lastTimerMs = waitMs
    timer = setTimer(() => {
      void runDrain().catch(error => {
        failHard('drain error', error)
      })
    }, waitMs) as ReturnType<typeof setTimeout>
    if (typeof timer === 'object' && timer != null && 'unref' in timer) {
      ;(timer as NodeJS.Timeout).unref()
    }
  }

  const runDrain = async (): Promise<void> => {
    if (stopped) return
    if (draining) {
      pokedDuringDrain = true
      return
    }
    draining = true
    try {
      do {
        pokedDuringDrain = false
        await drain(db, clock, options.afterRead, () => stopped)
      } while (pokedDuringDrain && !stopped)
    } finally {
      draining = false
    }
    if (!stopped) await scheduleTimer()
  }

  listen.on('notification', () => {
    void runDrain().catch(error => {
      failHard('drain error', error)
    })
  })
  listen.on('error', error => {
    failHard('listen error', error)
  })

  const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (stopping != null) return await stopping
    stopping = (async () => {
      stopped = true
      clearTimer()
      // Wait out the game in hand. drain() returns once that game commits
      // because it checks stopped between games.
      while (draining) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      try {
        await listen.end()
      } finally {
        await db.destroy()
      }
      console.log(`stats builder: stopped on ${signal}`)
    })()
    return await stopping
  }

  const bus = options.signals ?? process
  const onTerm = (): void => {
    void stop('SIGTERM')
      .then(() => {
        /* c8 ignore next */
        if (options.signals == null) process.exit(0)
      })
      .catch(error => {
        console.error('stats builder: stop failed', error)
        process.exitCode = 1
        /* c8 ignore next */
        if (options.signals == null) process.exit(1)
      })
  }
  const onInt = (): void => {
    void stop('SIGINT')
      .then(() => {
        /* c8 ignore next */
        if (options.signals == null) process.exit(0)
      })
      .catch(error => {
        console.error('stats builder: stop failed', error)
        process.exitCode = 1
        /* c8 ignore next */
        if (options.signals == null) process.exit(1)
      })
  }
  bus.on('SIGTERM', onTerm)
  bus.on('SIGINT', onInt)

  await runDrain()

  return {
    stop: async signal => {
      bus.off('SIGTERM', onTerm)
      bus.off('SIGINT', onInt)
      await stop(signal)
    },
    lastTimerMs: () => lastTimerMs,
    listenClient: () => listen
  }
}

export async function runMain(
  databaseUrl: string = serverConfig.databaseUrl
): Promise<StatsBuilderHandle> {
  return await runStatsBuilder({ databaseUrl })
}

/* c8 ignore start */
if (require.main === module) {
  runMain().catch(error => {
    console.error('stats builder:', error)
    process.exit(1)
  })
}
/* c8 ignore stop */
