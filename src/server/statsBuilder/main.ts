import { captureException, flush } from '@sentry/node'
import { Client } from 'pg'

import { makeDatabase } from '../db/database'
import {
  requestDatabaseUrl,
  type ServerConfig,
  serverConfig
} from '../serverConfig'
import {
  type AfterReadHook,
  type Clock,
  drain,
  earliestRetryAt
} from './builder'

const MAX_TIMER_MS = 60_000

export interface RunStatsBuilderOptions {
  /** Where the `LISTEN` connection goes: the database's own address. */
  databaseUrl: string
  /** Where its queries go. The same address unless a pooler is in front. */
  requestUrl?: string
  clock?: Clock
  /** When set, used instead of wiring process signals (tests). */
  signals?: NodeJS.EventEmitter
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  /** Test seam: called after a game is read, before the result is written. */
  afterRead?: AfterReadHook | null
  /**
   * Sends a failure that stops the builder to crash reporting before the
   * process exits; the default does nothing unless Sentry was started.
   */
  report?: (error: unknown) => Promise<void>
  /** Flush the process's operational queue before exiting. */
  onStopped?: () => Promise<void>
}

/** Reports a failure to Sentry and waits, briefly, for it to leave. */
export async function reportFailure(error: unknown): Promise<void> {
  captureException(error)
  await flush(2000)
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
  const report = options.report ?? reportFailure
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimerFn = options.clearTimeout ?? clearTimeout
  const db = makeDatabase(options.requestUrl ?? options.databaseUrl, {
    role: 'statsBuilder'
  })
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
    listen.end().catch(() => undefined)
    db.destroy().catch(() => undefined)
    // The failure is caught here, so Sentry's own handlers never see it.
    report(error)
      .catch(() => undefined)
      .then(() => {
        /* c8 ignore next */
        if (options.signals == null) process.exit(1)
      })
      .catch(() => undefined)
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
      runDrain().catch((error: unknown) => {
        failHard('drain error', error)
      })
    }, waitMs)
    if (typeof timer === 'object' && timer != null && 'unref' in timer) {
      timer.unref()
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
        // eslint-disable-next-line no-unmodified-loop-condition -- stop() sets it while drain() is awaited
      } while (pokedDuringDrain && !stopped)
    } finally {
      draining = false
    }
    if (!stopped) await scheduleTimer()
  }

  listen.on('notification', () => {
    runDrain().catch((error: unknown) => {
      failHard('drain error', error)
    })
  })
  listen.on('error', error => {
    failHard('listen error', error)
  })

  const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (stopping != null) {
      await stopping
      return
    }
    stopping = (async () => {
      stopped = true
      clearTimer()
      // Wait out the game in hand. drain() returns once that game commits
      // because it checks stopped between games.
      // eslint-disable-next-line no-unmodified-loop-condition -- runDrain() clears it when the game in hand commits
      while (draining) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      try {
        await listen.end()
      } finally {
        await db.destroy()
        await options.onStopped?.()
      }
      console.log(`stats builder: stopped on ${signal}`)
    })()
    await stopping
  }

  const bus = options.signals ?? process
  const onSignal = (signal: NodeJS.Signals) => (): void => {
    stop(signal)
      .then(() => {
        /* c8 ignore next */
        if (options.signals == null) process.exit(0)
      })
      .catch(async (error: unknown) => {
        console.error('stats builder: stop failed', error)
        process.exitCode = 1
        await report(error)
        /* c8 ignore next */
        if (options.signals == null) process.exit(1)
      })
  }
  const onTerm = onSignal('SIGTERM')
  const onInt = onSignal('SIGINT')
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
  config: Pick<ServerConfig, 'databaseUrl' | 'databasePoolUrl'> = serverConfig,
  onStopped?: () => Promise<void>
): Promise<StatsBuilderHandle> {
  return await runStatsBuilder({
    databaseUrl: config.databaseUrl,
    requestUrl: requestDatabaseUrl(config),
    onStopped
  })
}
