import { createServer, type Server } from 'node:http'

import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import type { LiveControllerOptions } from '../live/controller'
import type { ServerConfig } from '../serverConfig'

/**
 * The live ingest, as a process of its own.
 *
 * It owns the RTMP port and the ffmpeg children writing each game's HLS, and
 * nothing else. The API never calls it: an endpoint writes the `live_streams`
 * row and this process's controller acts on it within the second, so an API
 * that crashes or is restarted for a deploy leaves every publisher connected
 * and every recording growing. See CONTRIBUTING.md, "Live streaming".
 */

/** How long a stop may wait on the database before it is taken. */
const STOP_TIMEOUT_MS = 10_000

/** How far the health port sits above `listenPort` when none is set. */
const HEALTH_PORT_OFFSET = 1000

export type IngestSignal = 'SIGTERM' | 'SIGINT'

export interface IngestDeps {
  config: ServerConfig
  makeDatabase: (url: string) => Kysely<Database>
  startLiveController: (options: LiveControllerOptions) => Promise<boolean>
  stopLiveController: () => void
  /** What the stopped controller still has in hand, before the pool goes. */
  drainLiveController: () => Promise<void>
  /** Whether this process's own RTMP listener is accepting. */
  rtmpBound: () => boolean
  log: (message: string) => void
  logError: (message: string) => void
  exit: (code: number) => void
  onSignal: (signal: IngestSignal, handler: () => void) => void
  stopTimeoutMs?: number
}

export interface IngestHandle {
  healthPort: number
  stop: (signal: IngestSignal) => void
}

/** Where the health listener goes: `live.healthPort`, or `listenPort + 1000`. */
export function ingestHealthPort(config: ServerConfig): number {
  return config.live.healthPort ?? config.listenPort + HEALTH_PORT_OFFSET
}

/**
 * Starts the ingest, or exits saying why not.
 *
 * Resolves the running handle, or `undefined` once `exit` has been called.
 */
export async function runIngest(
  deps: IngestDeps
): Promise<IngestHandle | undefined> {
  const { config, log, logError, exit } = deps
  if (!config.live.enabled) {
    log('live ingest is switched off (live.enabled is false)')
    exit(0)
    return undefined
  }
  if (config.sessionSecret === '') {
    logError('live ingest disabled: sessionSecret is not set')
    exit(1)
    return undefined
  }

  const db = deps.makeDatabase(config.databaseUrl)
  const started = await deps.startLiveController({
    db,
    live: config.live,
    ffmpegPath: config.ffmpegPath,
    mediaRoot: config.mediaDir,
    workDir: config.workDir,
    sessionSecret: config.sessionSecret,
    space: config.space
  })
  if (!started) {
    logError('live ingest did not start')
    await db.destroy().catch(() => undefined)
    exit(1)
    return undefined
  }

  let health: Server
  try {
    health = await listenForHealth(ingestHealthPort(config), deps.rtmpBound)
  } catch (error) {
    logError(`ingest health did not start: ${String(error)}`)
    deps.stopLiveController()
    await deps.drainLiveController().catch(() => undefined)
    await db.destroy().catch(() => undefined)
    exit(1)
    return undefined
  }
  const address = health.address()
  const healthPort =
    address != null && typeof address === 'object' ? address.port : 0
  log(`ingest health on 127.0.0.1:${healthPort}`)

  let stopping = false
  const stop = (signal: IngestSignal): void => {
    if (stopping) return
    stopping = true
    log(`${signal}: stopping live ingest`)
    // Ends each publisher's readers, so every ffmpeg closes its playlist the
    // way it does when a publisher leaves.
    deps.stopLiveController()
    health.close()
    const forced = setTimeout(() => {
      logError(
        `${signal}: live work and the database did not finish in time, forcing`
      )
      exit(1)
    }, deps.stopTimeoutMs ?? STOP_TIMEOUT_MS)
    forced.unref?.()
    const finish = (): void => {
      clearTimeout(forced)
      exit(0)
    }
    deps
      .drainLiveController()
      .catch((error: unknown) => {
        logError(`finishing live work: ${String(error)}`)
      })
      .then(async () => {
        await db.destroy()
      })
      .then(finish, (error: unknown) => {
        logError(`closing the database: ${String(error)}`)
        finish()
      })
  }
  deps.onSignal('SIGTERM', () => {
    stop('SIGTERM')
  })
  deps.onSignal('SIGINT', () => {
    stop('SIGINT')
  })
  return { healthPort, stop }
}

/**
 * `GET /health` on loopback alone: `200 {"ingest":true}` while this process's
 * RTMP listener is accepting, `503 {"ingest":false}` while it is not.
 *
 * Never on `live.bindHost`, which faces the world for publishers: whether a
 * machine's ingest is up is the deploy's question, not the internet's.
 */
async function listenForHealth(
  port: number,
  rtmpBound: () => boolean
): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end()
      return
    }
    const up = rtmpBound()
    res
      .writeHead(up ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ingest: up }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}
