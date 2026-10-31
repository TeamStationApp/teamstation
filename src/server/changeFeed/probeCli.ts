import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

import { scoreboardPrefix } from '../scoreboard/scoreboardStore'
import {
  requestDatabaseUrl,
  type ServerConfig,
  serverConfig
} from '../serverConfig'
import { ValkeyFeed } from './valkeyFeed'

/**
 * Proves the whole path a change takes across nodes: a `pg_notify` sent the way
 * request traffic goes, through the elected relay, and back from Valkey.
 *
 *   npm run feedProbe
 *
 * Prints the round trip and the leader. Exits non-zero without an echo in time.
 */

export interface FeedProbeIo {
  print: (line: string) => void
  timeoutMs?: number
}

export async function runFeedProbe(
  config: Pick<ServerConfig, 'databaseUrl' | 'databasePoolUrl' | 'redis'>,
  io: FeedProbeIo
): Promise<number> {
  const timeoutMs = io.timeoutMs ?? 5000
  const token = randomBytes(8).toString('hex')
  const feed = new ValkeyFeed({
    url: config.redis.url,
    caFile: config.redis.caFile,
    prefix: scoreboardPrefix(config.redis.prefix, config.databaseUrl),
    log: io.print
  })
  let echoed: () => void = () => undefined
  const echo = new Promise<void>(resolve => {
    echoed = resolve
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const silence = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
  })
  let heard = false
  const subscription = feed.subscribe('feed_probe', {
    onPayload: payload => {
      if (payload !== token) return
      heard = true
      echoed()
    }
  })
  try {
    await Promise.race([subscription.listening, silence])
    const startedAt = Date.now()
    await sendProbe(requestDatabaseUrl(config), token)
    await Promise.race([echo, silence])
    const leader = await Promise.race([
      feed.leader().catch(() => null),
      new Promise<null>(resolve => setTimeout(resolve, 1000, null))
    ])
    if (!heard) {
      io.print(`no echo within ${timeoutMs} ms; leader ${leader ?? '(none)'}`)
      return 1
    }
    io.print(
      `round trip ${Date.now() - startedAt} ms; leader ${leader ?? '(none)'}`
    )
    return 0
  } catch (error) {
    io.print(`the probe failed: ${String(error)}`)
    return 1
  } finally {
    clearTimeout(timer)
    subscription.stop()
    await feed.close()
  }
}

async function sendProbe(url: string, token: string): Promise<void> {
  const client = new Client({
    connectionString: url,
    application_name: 'teamstation-feed-probe'
  })
  try {
    await client.connect()
    await client.query(`select pg_notify('feed_probe', $1)`, [token])
  } finally {
    await client.end().catch(() => undefined)
  }
}

if (require.main === module) {
  runFeedProbe(serverConfig, {
    print: line => {
      console.log(line)
    }
  }).then(
    code => process.exit(code),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    }
  )
}
