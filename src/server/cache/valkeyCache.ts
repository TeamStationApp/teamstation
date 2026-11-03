import { createClient } from 'redis'

import {
  redisSocketOptions,
  scoreboardPrefix
} from '../scoreboard/scoreboardStore'

/** How often a cache that keeps failing says so, at most. */
const LOG_EVERY_MS = 60_000

/**
 * How long a command may wait for its answer. A partition that drops packets
 * leaves the client ready and its commands unanswered until TCP gives up, and
 * a post awaits its `set` holding the game's row: past this a `get` is a miss
 * and a `set` is skipped.
 */
export const COMMAND_TIMEOUT_MS = 200

/** How long the client waits for Valkey to accept a connection. */
const CONNECT_TIMEOUT_MS = 1000

/**
 * A cache in Valkey that is never needed: `get` answers null and `set` does
 * nothing while the client is not ready, offline, failing or slower than
 * `COMMAND_TIMEOUT_MS`, so whatever reads through it reads Postgres instead,
 * and the server starts and serves without Valkey, as it always has. Every key
 * starts with the deployment's prefix.
 */
export interface ValkeyCache {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ttlMs: number) => Promise<void>
  close: () => Promise<void>
  /**
   * Says a problem with what it answered, as often as its own failures. The
   * command was still answered, so `answering` stays as it was.
   */
  report?: (problem: unknown) => void
  /**
   * False while the client is not ready or its last command failed or went
   * unanswered: a read that may only warm the cache need not run.
   */
  answering?: () => boolean
}

/**
 * The cache on one node-redis client of its own, built from the server's
 * `redis` settings. The client fails a command at once rather than queueing
 * it while Valkey is away, gives up on one unanswered after
 * `COMMAND_TIMEOUT_MS`, and node-redis keeps reconnecting on its own.
 * Failures, a timeout among them, are logged once a minute at most.
 */
export function makeValkeyCache(options: {
  redis: { url: string; prefix: string; caFile?: string }
  databaseUrl: string
  log: (message: string) => void
  now?: () => number
}): ValkeyCache {
  const { log } = options
  const prefix = scoreboardPrefix(options.redis.prefix, options.databaseUrl)
  const socket = redisSocketOptions(options.redis.caFile ?? '')
  const client = createClient({
    url: options.redis.url,
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, ...socket },
    disableOfflineQueue: true
  })
  let lastAnswered = false
  const limited = onceAMinute(log, options.now)
  const say = (error: unknown): void => {
    limited(
      `redis cache: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const failed = (error: unknown): void => {
    lastAnswered = false
    say(error)
  }
  // An unheard `error` would end the worker.
  client.on('error', failed)
  client.connect().catch(failed)

  return {
    get: async key => {
      if (!client.isReady) return null
      try {
        const held = await answered(client.get(`${prefix}:${key}`))
        lastAnswered = true
        return held
      } catch (error) {
        failed(error)
        return null
      }
    },
    set: async (key, value, ttlMs) => {
      if (!client.isReady) return
      try {
        await answered(client.set(`${prefix}:${key}`, value, { PX: ttlMs }))
        lastAnswered = true
      } catch (error) {
        failed(error)
      }
    },
    // At once when Valkey is away or silent: a graceful close would wait for
    // it, so one that is not done in a command's time is cut short.
    close: async () => {
      if (client.isReady)
        await answered(client.close()).catch(() => {
          if (client.isOpen) client.destroy()
        })
      else if (client.isOpen) client.destroy()
    },
    report: say,
    answering: () => client.isReady && lastAnswered
  }
}

/**
 * `log`, saying a message only when it has said none in the last
 * `LOG_EVERY_MS`; each call makes a limit of its own.
 */
export function onceAMinute(
  log: (message: string) => void,
  now: () => number = Date.now
): (message: string) => void {
  let loggedAt: number | undefined
  return message => {
    const at = now()
    if (loggedAt != null && at - loggedAt < LOG_EVERY_MS) return
    loggedAt = at
    log(message)
  }
}

/**
 * A command's answer, or a failure once it has waited `COMMAND_TIMEOUT_MS`.
 * The command itself is left to finish or fail unheard.
 */
async function answered<T>(command: Promise<T>): Promise<T> {
  command.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      command,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer in ${COMMAND_TIMEOUT_MS} ms`))
        }, COMMAND_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
