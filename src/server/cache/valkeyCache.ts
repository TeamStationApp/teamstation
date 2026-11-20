import { createClient, DisconnectsClientError } from 'redis'

import { scoreboardPrefix } from '../scoreboard/scoreboardStore'
import {
  closeValkey,
  onceAMinute,
  reconnectWhenSilent,
  runValkey,
  type ValkeyClientOptions,
  valkeyClientOptions,
  valkeyConnection,
  ValkeyTimeout
} from '../valkey/client'

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
 * nothing while the client is offline, failing, or not answering or connected
 * within `COMMAND_TIMEOUT_MS` (a connection being made is waited on for that
 * long), so whatever reads through it reads Postgres instead,
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
  clientOptions?: ValkeyClientOptions
}): ValkeyCache {
  const { log } = options
  const prefix = scoreboardPrefix(options.redis.prefix, options.databaseUrl)
  const common = valkeyClientOptions(
    options.redis.url,
    'cache',
    options.redis.caFile,
    options.clientOptions
  )
  const client = createClient({
    ...common,
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, ...common.socket }
  })
  valkeyConnection(client)
  reconnectWhenSilent(client, options.clientOptions?.silenceGraceMs)
  let lastAnswered = false
  const limited = onceAMinute(log, options.now)
  const say = (error: unknown): void => {
    limited(
      `redis cache: ${error instanceof ValkeyTimeout && error.what === 'answer' ? `no answer in ${COMMAND_TIMEOUT_MS} ms` : error instanceof Error ? error.message : String(error)}`
    )
  }
  const failed = (error: unknown): void => {
    lastAnswered = false
    say(error)
  }
  // An unheard `error` would end the worker.
  client.on('error', error => {
    // Our own destroy() rejecting a keepalive in flight is no failure.
    if (!(error instanceof DisconnectsClientError)) failed(error)
  })
  client.connect().catch(failed)

  // A GET or a SET of the same value can be sent again after a lost connection.
  return {
    get: async key => {
      try {
        const held = await runValkey(
          client,
          async () => await client.get(`${prefix}:${key}`),
          COMMAND_TIMEOUT_MS,
          true
        )
        lastAnswered = true
        return held
      } catch (error) {
        failed(error)
        return null
      }
    },
    set: async (key, value, ttlMs) => {
      try {
        await runValkey(
          client,
          async () =>
            await client.set(`${prefix}:${key}`, value, { PX: ttlMs }),
          COMMAND_TIMEOUT_MS,
          true
        )
        lastAnswered = true
      } catch (error) {
        failed(error)
      }
    },
    // At once when Valkey is away or silent: a graceful close would wait for
    // it, so one that is not done in a command's time is cut short.
    close: async () => {
      await closeValkey(client, COMMAND_TIMEOUT_MS)
    },
    report: say,
    answering: () => client.isReady && lastAnswered
  }
}
