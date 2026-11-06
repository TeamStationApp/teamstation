import { createServer, type Server } from 'node:net'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { afterEach, describe, it } from 'mocha'

import type { Database } from '../db/database'
import type { LiveControllerOptions } from '../live/controller'
import { asServerConfig, type ServerConfig } from '../serverConfig'
import {
  type IngestDeps,
  type IngestHandle,
  ingestHealthPort,
  type IngestSignal,
  runIngest
} from './run'

/**
 * The ingest process's start and stop, with everything it talks to replaced:
 * no database, no RTMP, only the loopback health listener it opens itself.
 */

function configWith(overrides: Record<string, unknown> = {}): ServerConfig {
  const live = (overrides.live as Record<string, unknown> | undefined) ?? {}
  return asServerConfig({
    listenPort: 9100,
    sessionSecret: 's'.repeat(32),
    databaseUrl: 'postgres://nowhere.invalid/none',
    ...overrides,
    live: { bindHost: '127.0.0.1', port: 19_999, healthPort: 0, ...live }
  })
}

interface Fake {
  deps: IngestDeps
  logs: string[]
  errors: string[]
  exits: number[]
  started: LiveControllerOptions[]
  stops: number
  destroyed: number
  /** What happened, in order, during a stop. */
  order: string[]
  databases: string[]
  roles: Array<string | undefined>
  signals: Map<IngestSignal, () => void>
  bound: { value: boolean }
}

function fake(
  config: ServerConfig,
  options: {
    starts?: boolean
    destroy?: () => Promise<void>
    drain?: () => Promise<void>
    stopTimeoutMs?: number
  } = {}
): Fake {
  const f: Fake = {
    logs: [],
    errors: [],
    exits: [],
    started: [],
    stops: 0,
    destroyed: 0,
    order: [],
    databases: [],
    roles: [],
    signals: new Map(),
    bound: { value: true },
    deps: undefined as unknown as IngestDeps
  }
  f.deps = {
    config,
    makeDatabase: (url, poolOptions) => {
      f.databases.push(url)
      f.roles.push(poolOptions.role)
      return {
        destroy: async () => {
          f.order.push('destroy')
          f.destroyed++
          await (options.destroy ?? (async () => undefined))()
        }
      } as unknown as Kysely<Database>
    },
    startLiveController: async next => {
      f.started.push(next)
      return options.starts ?? true
    },
    stopLiveController: () => {
      f.order.push('stop')
      f.stops++
    },
    drainLiveController: async () => {
      await (options.drain ?? (async () => undefined))()
      f.order.push('drained')
    },
    rtmpBound: () => f.bound.value,
    log: message => f.logs.push(message),
    logError: message => f.errors.push(message),
    exit: code => f.exits.push(code),
    onSignal: (signal, handler) => f.signals.set(signal, handler),
    stopTimeoutMs: options.stopTimeoutMs
  }
  return f
}

async function untilExited(f: Fake): Promise<void> {
  for (let i = 0; i < 200 && f.exits.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function refused(port: number): Promise<boolean> {
  return await fetch(`http://127.0.0.1:${port}/health`).then(
    () => false,
    () => true
  )
}

describe('the ingest process', function () {
  let running: IngestHandle | undefined
  let blocker: Server | undefined

  afterEach(function () {
    running?.stop('SIGTERM')
    running = undefined
    blocker?.close()
    blocker = undefined
  })

  describe('its health port', function () {
    it('is live.healthPort when that is set', function () {
      expect(
        ingestHealthPort(configWith({ live: { healthPort: 12345 } }))
      ).equals(12345)
    })

    it('is listenPort + 1000 when it is not', function () {
      const config = asServerConfig({ listenPort: 9205 })
      expect(ingestHealthPort(config)).equals(10205)
    })

    it('keeps 0, which picks a free port', function () {
      expect(ingestHealthPort(configWith())).equals(0)
    })
  })

  it('opens its pool as the ingest role, at the pool address when there is one', async function () {
    const direct = fake(
      configWith({ databaseUrl: 'postgres://db.example.test/x' })
    )
    const stopDirect = await runIngest(direct.deps)
    expect(direct.databases).deep.equals(['postgres://db.example.test/x'])
    expect(direct.roles).deep.equals(['ingest'])
    stopDirect?.stop('SIGTERM')
    await untilExited(direct)

    const pooled = fake(
      configWith({
        databaseUrl: 'postgres://db.example.test/x',
        databasePoolUrl: 'postgres://pool.example.test/pool'
      })
    )
    const stopPooled = await runIngest(pooled.deps)
    expect(pooled.databases).deep.equals(['postgres://pool.example.test/pool'])
    stopPooled?.stop('SIGTERM')
    await untilExited(pooled)
  })

  it('exits 0 and starts nothing when live is switched off', async function () {
    const f = fake(configWith({ live: { enabled: false } }))
    expect(await runIngest(f.deps)).equals(undefined)
    expect(f.exits).deep.equals([0])
    expect(f.logs).deep.equals([
      'live ingest is switched off (live.enabled is false)'
    ])
    expect(f.databases).deep.equals([])
    expect(f.started).deep.equals([])
  })

  it('exits 1 with no session secret', async function () {
    const f = fake(configWith({ sessionSecret: '' }))
    expect(await runIngest(f.deps)).equals(undefined)
    expect(f.exits).deep.equals([1])
    expect(f.errors).deep.equals([
      'live ingest disabled: sessionSecret is not set'
    ])
    expect(f.databases).deep.equals([])
    expect(f.started).deep.equals([])
  })

  it('exits 1 when the controller does not start, and listens for nothing', async function () {
    const f = fake(configWith(), { starts: false })
    expect(await runIngest(f.deps)).equals(undefined)
    expect(f.errors).deep.equals(['live ingest did not start'])
    expect(f.destroyed).equals(1)
    expect(f.exits).deep.equals([1])
    expect(f.logs.some(line => line.startsWith('ingest health on'))).equals(
      false
    )
    expect(f.signals.size).equals(0)
  })

  it('starts the controller from the config and answers health on loopback', async function () {
    const config = configWith({
      ffmpegPath: '/opt/ffmpeg',
      mediaDir: '/data/media',
      workDir: '/data/work'
    })
    const f = fake(config)
    running = await runIngest(f.deps)
    expect(running).not.equals(undefined)
    const port = running!.healthPort
    expect(port).greaterThan(0)
    expect(f.logs).includes(`ingest health on 127.0.0.1:${port}`)
    expect(f.databases).deep.equals([config.databaseUrl])
    const [options] = f.started
    expect(options.live).equals(config.live)
    expect(options.ffmpegPath).equals('/opt/ffmpeg')
    expect(options.mediaRoot).equals('/data/media')
    expect(options.workDir).equals('/data/work')
    expect(options.sessionSecret).equals(config.sessionSecret)
    expect(options.space).equals(config.space)

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).equals(200)
    expect(health.headers.get('content-type')).equals('application/json')
    expect(await health.json()).deep.equals({ ingest: true })
    const other = await fetch(`http://127.0.0.1:${port}/other`)
    expect(other.status).equals(404)
    const posted = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'POST'
    })
    expect(posted.status).equals(404)
  })

  it('answers 503 while its RTMP listener is not accepting', async function () {
    const f = fake(configWith())
    running = await runIngest(f.deps)
    f.bound.value = false
    const health = await fetch(`http://127.0.0.1:${running!.healthPort}/health`)
    expect(health.status).equals(503)
    expect(await health.json()).deep.equals({ ingest: false })
  })

  it('exits 1 when its health port is taken', async function () {
    blocker = createServer()
    await new Promise<void>(resolve => blocker!.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const taken =
      typeof address === 'object' && address != null ? address.port : 0
    const f = fake(configWith({ live: { healthPort: taken } }))
    expect(await runIngest(f.deps)).equals(undefined)
    expect(f.errors[0]).matches(/^ingest health did not start: .*EADDRINUSE/)
    expect(f.order).deep.equals(['stop', 'drained', 'destroy'])
    expect(f.stops).equals(1)
    expect(f.destroyed).equals(1)
    expect(f.exits).deep.equals([1])
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`stops the controller once on ${signal}, closes health and exits 0`, async function () {
      const f = fake(configWith())
      const handle = await runIngest(f.deps)
      const port = handle!.healthPort
      f.signals.get(signal)!()
      f.signals.get('SIGTERM')!()
      f.signals.get('SIGINT')!()
      await untilExited(f)
      expect(f.logs).includes(`${signal}: stopping live ingest`)
      expect(f.stops).equals(1)
      expect(f.destroyed).equals(1)
      expect(f.order).deep.equals(['stop', 'drained', 'destroy'])
      expect(f.exits).deep.equals([0])
      expect(await refused(port)).equals(true)
    })
  }

  it('still exits 0 when closing the database fails', async function () {
    const f = fake(configWith(), {
      destroy: async () => {
        throw new Error('gone already')
      }
    })
    await runIngest(f.deps)
    f.signals.get('SIGTERM')!()
    await untilExited(f)
    expect(f.errors).deep.equals(['closing the database: Error: gone already'])
    expect(f.exits).deep.equals([0])
  })

  it('closes the database only once the live work has finished, even when it failed', async function () {
    let finishWork: () => void = () => undefined
    const f = fake(configWith(), {
      drain: async () => {
        await new Promise<void>(resolve => {
          finishWork = resolve
        })
        throw new Error('a write failed')
      }
    })
    await runIngest(f.deps)
    f.signals.get('SIGTERM')!()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.destroyed).equals(0)
    finishWork()
    await untilExited(f)
    expect(f.errors).deep.equals(['finishing live work: Error: a write failed'])
    expect(f.order).deep.equals(['stop', 'destroy'])
    expect(f.exits).deep.equals([0])
  })

  it('forces exit 1 when the database will not close', async function () {
    const f = fake(configWith(), {
      destroy: async () => {
        await new Promise<void>(() => undefined)
      },
      stopTimeoutMs: 20
    })
    await runIngest(f.deps)
    f.signals.get('SIGTERM')!()
    await untilExited(f)
    expect(f.errors).deep.equals([
      'SIGTERM: live work and the database did not finish in time, forcing'
    ])
    expect(f.exits).deep.equals([1])
  })
})
