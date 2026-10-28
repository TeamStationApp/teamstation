import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, Socket } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { type LiveFixture, liveFixture } from '../../test/liveFixture'
import { streamUrlFor } from '../live/streamKeys'
import { asServerConfig } from '../serverConfig'

/**
 * The live ingest as a process of its own, against the real API process.
 *
 *   node src/migrate/requirePostgres18.js && npx mocha --timeout 180000 \
 *     --exit -r sucrase/register --extension ts \
 *     --spec src/server/ingest/survive.e2e.ts
 *
 * Needs the Postgres 18 cluster, Redis and `ffmpeg` (with libx265) on PATH.
 * Every process is started from a temporary directory holding its own
 * `serverConfig.json`, a scratch database, and free ports.
 */
const register = require.resolve('sucrase/register')
const INGEST = resolve('src/server/ingest/main.ts')
const API = resolve('src/server/index.ts')
const QUIET = resolve('src/server/live/ingestQuiet.ts')
const SECRET = 's'.repeat(32)
const MEDIA_SECRET = 'm'.repeat(32)

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>(resolve =>
    probe.close(() => {
      resolve()
    })
  )
  if (address == null || typeof address !== 'object') throw new Error('no port')
  return address.port
}

async function accepts(port: number, host = '127.0.0.1'): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = new Socket()
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
    socket.connect(port, host)
  })
}

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A process under test, with everything it printed. */
export interface Proc {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
  exitCode: () => number | null
}

export function startProcess(
  entry: string,
  cwd: string,
  options: { detached?: boolean; args?: string[] } = {}
): Proc {
  const child = spawn(
    process.execPath,
    ['-r', register, entry, ...(options.args ?? [])],
    {
      cwd,
      detached: options.detached === true,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let text = ''
  child.stdout.on('data', chunk => {
    text += String(chunk)
  })
  child.stderr.on('data', chunk => {
    text += String(chunk)
  })
  let code: number | null = null
  let gone = false
  const exited = new Promise<number | null>(resolve => {
    child.on('exit', exit => {
      code = exit
      gone = true
      resolve(exit)
    })
  })
  return {
    child,
    output: () => text,
    exited,
    exitCode: () => (gone ? code : null)
  }
}

/** The settings every process here shares; each test adds its own ports. */
export function baseConfig(
  folder: string,
  databaseUrl: string,
  ports: { listen: number; live: number }
): Record<string, unknown> {
  return {
    databaseUrl,
    listenHost: '127.0.0.1',
    listenPort: ports.listen,
    clusterWorkers: 1,
    statsBuilder: false,
    workDir: join(folder, 'work'),
    mediaDir: join(folder, 'media'),
    ffmpegPath: 'ffmpeg',
    sessionSecret: SECRET,
    mediaSecret: MEDIA_SECRET,
    serveMediaLocally: true,
    logRequests: false,
    live: {
      enabled: true,
      bindHost: '127.0.0.1',
      port: ports.live,
      healthPort: 0,
      freeDiskFloorGb: 0
    }
  }
}

export async function writeConfig(
  folder: string,
  config: Record<string, unknown>
): Promise<void> {
  await mkdir(join(folder, 'work'), { recursive: true })
  await mkdir(join(folder, 'media'), { recursive: true })
  await writeFile(join(folder, 'serverConfig.json'), JSON.stringify(config))
}

/** The port the ingest says its health listener took. */
export async function healthPortOf(ingest: Proc): Promise<number> {
  let port = 0
  await until('the ingest health line', () => {
    const match = /ingest health on 127\.0\.0\.1:(\d+)/.exec(ingest.output())
    if (match != null) port = Number(match[1])
    if (ingest.exitCode() != null) {
      throw new Error(`the ingest exited:\n${ingest.output()}`)
    }
    return port > 0
  })
  return port
}

export async function apiListening(api: Proc): Promise<void> {
  await until(
    'the API to listen',
    () => {
      if (api.exitCode() != null) {
        throw new Error(`the API exited:\n${api.output()}`)
      }
      return api.output().includes('listening on')
    },
    60_000
  )
}

async function stop(proc: Proc | undefined): Promise<void> {
  if (proc == null || proc.exitCode() != null) return
  proc.child.kill('SIGTERM')
  const late = setTimeout(() => proc.child.kill('SIGKILL'), 15_000)
  await proc.exited
  clearTimeout(late)
}

/** The first IPv4 address of this machine that is not loopback. */
function otherAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

describe('the ingest as a process of its own', function () {
  this.timeout(180_000)
  let fixture: LiveFixture | undefined
  let folder = ''
  let config: Record<string, unknown> = {}
  let livePort = 0
  const running: Proc[] = []

  function run(entry: string, options: { args?: string[] } = {}): Proc {
    const proc = startProcess(entry, folder, options)
    running.push(proc)
    return proc
  }

  before(async function () {
    fixture = await liveFixture('survive')
    if (fixture == null) throw new Error('no Postgres for the ingest e2e')
    folder = await mkdtemp(join(tmpdir(), 'tsSurvive-'))
    livePort = await freePort()
    config = baseConfig(folder, fixture.url, {
      listen: await freePort(),
      live: livePort
    })
    await writeConfig(folder, config)
  })

  afterEach(async function () {
    for (const proc of running.splice(0)) await stop(proc)
    await writeConfig(folder, config)
  })

  after(async function () {
    await fixture?.drop()
    if (folder !== '') await rm(folder, { recursive: true, force: true })
  })

  async function setPublishing(id: string): Promise<void> {
    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'publishing' })
      .where('id', '=', id)
      .execute()
  }

  it('E1 exits 0 and binds nothing with live switched off', async function () {
    await writeConfig(folder, {
      ...config,
      live: { ...(config.live as object), enabled: false }
    })
    const ingest = run(INGEST)
    expect(await ingest.exited).equals(0)
    expect(ingest.output()).includes(
      'live ingest is switched off (live.enabled is false)'
    )
    expect(await accepts(livePort)).equals(false)
  })

  it('E2 exits 1 with no session secret', async function () {
    await writeConfig(folder, { ...config, sessionSecret: '' })
    const ingest = run(INGEST)
    expect(await ingest.exited).equals(1)
    expect(ingest.output()).includes(
      'live ingest disabled: sessionSecret is not set'
    )
  })

  it('E3 answers health on loopback alone while RTMP listens', async function () {
    const ingest = run(INGEST)
    const port = await healthPortOf(ingest)
    expect(await accepts(livePort)).equals(true)
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).equals(200)
    expect(await health.json()).deep.equals({ ingest: true })
    const other = otherAddress()
    if (other == null) {
      console.log(
        '      (no non-loopback IPv4 here: the off-loopback check is skipped)'
      )
    } else {
      expect(await accepts(port, other)).equals(false)
    }
  })

  it('E4 runs the controller shutdown on SIGTERM and lets go of both ports', async function () {
    const ingest = run(INGEST)
    const port = await healthPortOf(ingest)
    ingest.child.kill('SIGTERM')
    expect(await ingest.exited).equals(0)
    expect(ingest.output()).includes('SIGTERM: stopping live ingest')
    expect(await accepts(port)).equals(false)
    expect(await accepts(livePort)).equals(false)
  })

  it('E5 ingestQuiet exits 0 with nothing publishing and 1 with a stream publishing', async function () {
    const quiet = run(QUIET)
    expect(await quiet.exited).equals(0)
    expect(quiet.output()).includes('ingest quiet: 0 publishing')
    const stream = await fixture!.addStream(asServerConfig(config).live, SECRET)
    await setPublishing(stream.id)
    const busy = run(QUIET)
    expect(await busy.exited).equals(1)
    expect(busy.output()).includes('ingest busy: 1 publishing')
    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'idle' })
      .where('id', '=', stream.id)
      .execute()
  })

  it('E6 an API start leaves a publishing row publishing and binds no RTMP; E7 the ingest start resets it', async function () {
    const stream = await fixture!.addStream(asServerConfig(config).live, SECRET)
    await setPublishing(stream.id)
    const api = run(API)
    await apiListening(api)
    // Longer than the controller's one-second tick, had the API started one.
    await new Promise(resolve => setTimeout(resolve, 2500))
    expect(await fixture!.stateOf(stream.id)).equals('publishing')
    expect(await accepts(livePort)).equals(false)

    // E7 The ingest's own cold start is what resets it.
    const ingest = run(INGEST)
    await healthPortOf(ingest)
    await until(
      'the leftover row to be reset',
      async () => (await fixture!.stateOf(stream.id)) === 'idle',
      5000
    )
  })

  it('E8 the publish URL is still rtmp://host:port/app/key', function () {
    const live = asServerConfig(config).live
    expect(streamUrlFor(live, 'live.example.test', 'ts_abc')).equals(
      `rtmp://live.example.test:${livePort}/live/ts_abc`
    )
  })

  it('E9 exits 1 without touching rows when another process holds the port', async function () {
    const holder: Server = createServer()
    await new Promise<void>(resolve =>
      holder.listen(livePort, '127.0.0.1', resolve)
    )
    try {
      const stream = await fixture!.addStream(
        asServerConfig(config).live,
        SECRET
      )
      await setPublishing(stream.id)
      const ingest = run(INGEST)
      expect(await ingest.exited).equals(1)
      expect(ingest.output()).includes(
        `live ingest did not bind 127.0.0.1:${livePort}`
      )
      expect(ingest.output()).not.includes('Uncaught')
      expect(ingest.output()).not.includes('Unhandled')
      expect(await fixture!.stateOf(stream.id)).equals('publishing')
      await fixture!.db
        .updateTable('live_streams')
        .set({ state: 'idle' })
        .where('id', '=', stream.id)
        .execute()
    } finally {
      await new Promise<void>(resolve =>
        holder.close(() => {
          resolve()
        })
      )
    }
  })
})
