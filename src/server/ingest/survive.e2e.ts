import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync
} from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, Socket } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { type LiveFixture, liveFixture } from '../../test/liveFixture'
import { pathOfKey, startFakeSpace } from '../dev/fakeSpace'
import { liveVideoDir } from '../live/controller'
import { configurationOfInit } from '../live/decoderConfig'
import { LIVE_PLAYLIST_NAME } from '../live/splitter'
import { streamUrlFor } from '../live/streamKeys'
import { mediaUrlPath } from '../media/mediaTokens'
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
 *
 * The finished-server cases (F1, F2) stop the API for fifteen seconds in the
 * middle of a publish and judge the recording. With `TS_E2E_ARTIFACT_DIR` set
 * they leave there a frame either side of the outage and the remuxed
 * recording.
 *
 * G1 drops a camera and brings it back on the same key, with a stand-in Space
 * in this process, and looks at `init.mp4` every 10 ms, here and in the Space,
 * throughout. With `TS_E2E_ARTIFACT_DIR` set it leaves `init-window.log`
 * there, written before it asserts anything.
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

/** One segment of a live playlist. */
interface Segment {
  uri: string
  duration: number
  /** `EXT-X-PROGRAM-DATE-TIME`, ms. */
  at: number
}

function segmentsOf(playlist: string): Segment[] {
  const out: Segment[] = []
  let at: number | undefined
  let duration: number | undefined
  for (const line of playlist.split('\n')) {
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      at = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length))
    } else if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length))
    } else if (line !== '' && !line.startsWith('#')) {
      if (at == null || duration == null) throw new Error(`no time for ${line}`)
      out.push({ uri: line, duration, at })
      at += duration * 1000
      duration = undefined
    }
  }
  return out
}

function discontinuities(playlist: string): number {
  return playlist.split('\n').filter(l => l === '#EXT-X-DISCONTINUITY').length
}

function readIfThere(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line !== '')
      .map(Number)
  } catch {
    return []
  }
}

function probeSeconds(file: string): number {
  return Number(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file
      ],
      { encoding: 'utf8' }
    ).trim()
  )
}

const OUTAGE_MS = 15_000

for (const [name, how] of [
  ['F1', 'kill -9'],
  ['F2', 'SIGTERM']
] as const) {
  describe(`${name}: the API stopped by ${how} for 15 s in the middle of a publish`, function () {
    this.timeout(240_000)
    let fixture: LiveFixture | undefined
    let folder = ''
    const procs: Proc[] = []
    let publisher: ChildProcess | undefined

    before(async function () {
      fixture = await liveFixture(`survive${name.toLowerCase()}`)
      if (fixture == null) throw new Error('no Postgres for the ingest e2e')
      folder = await mkdtemp(join(tmpdir(), `tsSurvive${name}-`))
    })

    after(async function () {
      publisher?.kill('SIGKILL')
      for (const proc of procs) {
        if (proc.exitCode() == null) {
          try {
            process.kill(-proc.child.pid!, 'SIGKILL')
          } catch {
            proc.child.kill('SIGKILL')
          }
        }
      }
      await fixture?.drop()
      if (folder !== '') await rm(folder, { recursive: true, force: true })
    })

    it('keeps the publisher, ffmpeg and the recording going, and the outage is in the playlist', async function () {
      const ports = { listen: await freePort(), live: await freePort() }
      const config = {
        ...baseConfig(folder, fixture!.url, ports),
        clusterWorkers: 2
      }
      await writeConfig(folder, config)
      const settings = asServerConfig(config)
      const stream = await fixture!.addStream(settings.live, SECRET)
      const dir = liveVideoDir(settings.mediaDir, stream.videoId)
      const playlistFile = join(dir, LIVE_PLAYLIST_NAME)
      const say = (line: string): void => {
        console.log(`      ${name} ${line}`)
      }

      // 1. Ingest, then the API in a process group of its own.
      const ingest = startProcess(INGEST, folder)
      procs.push(ingest)
      await healthPortOf(ingest)
      let api = startProcess(API, folder, { detached: true })
      procs.push(api)
      await apiListening(api)

      // 2. testsrc2, its own pattern with the wall clock burned in, as HEVC:
      // the ingest turns H.264 away.
      const url = `rtmp://127.0.0.1:${ports.live}/live/${stream.key}`
      publisher = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          '-f',
          'lavfi',
          '-i',
          "testsrc2=size=640x360:rate=30,drawtext=text='%{localtime\\:%T} f%{eif\\:mod(n\\,30)\\:d\\:2}':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.7:x=12:y=48",
          '-c:v',
          'libx265',
          '-preset',
          'ultrafast',
          '-x265-params',
          'keyint=30:min-keyint=30:scenecut=0:bframes=0:log-level=error',
          '-pix_fmt',
          'yuv420p',
          '-f',
          'flv',
          url
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let publisherErrors = ''
      publisher.stderr!.on('data', chunk => {
        publisherErrors += String(chunk)
      })
      say(
        `publishing testsrc2 640x360 30 fps HEVC GOP 30 to rtmp://127.0.0.1:${ports.live}/live/<key>`
      )

      // 3. Two closed segments.
      await until(
        'two segments',
        () => segmentsOf(readIfThere(playlistFile)).length >= 2,
        60_000
      )
      const ingestPid = ingest.child.pid!
      let writers: number[] = []
      await until('the HLS writer', () => {
        writers = childPids(ingestPid)
        return writers.length > 0
      })
      const breaksBefore = discontinuities(readFileSync(playlistFile, 'utf8'))
      say(`ingest pid ${ingestPid}, ffmpeg pid ${writers.join(',')}`)
      say(
        `segments before the stop: ${segmentsOf(readFileSync(playlistFile, 'utf8')).length}`
      )

      // 4. The API stops for fifteen seconds; the publisher does not.
      const mediaPath = mediaUrlPath(
        MEDIA_SECRET,
        `work/videos/${stream.videoId}`,
        LIVE_PLAYLIST_NAME
      )
      const playlistUrl = `http://127.0.0.1:${ports.listen}${mediaPath}`
      // What was closed when the API stopped: anything listed later was
      // written while it was down, or after.
      const closedAtStop = segmentsOf(readFileSync(playlistFile, 'utf8')).map(
        s => s.uri
      )
      const stoppedAt = Date.now()
      if (how === 'kill -9') {
        process.kill(-api.child.pid!, 'SIGKILL')
        await api.exited
      } else {
        process.kill(api.child.pid!, 'SIGTERM')
        expect(await api.exited).equals(0)
      }
      say(`API stopped by ${how} at ${new Date(stoppedAt).toISOString()}`)
      const during = await fetch(playlistUrl).then(
        response => `answered ${response.status}`,
        (error: unknown) =>
          `failed (${String((error as Error).cause ?? error)})`
      )
      say(`media route during the outage: ${during}`)
      expect(during).matches(/^failed/)
      await new Promise(resolve =>
        setTimeout(resolve, OUTAGE_MS - (Date.now() - stoppedAt))
      )
      expect(ingest.exitCode()).equals(null)
      expect(childPids(ingestPid)).deep.equals(writers)

      // 5. The API back, and the playlist through media auth.
      api = startProcess(API, folder, { detached: true })
      procs.push(api)
      await apiListening(api)
      const backAt = Date.now()
      say(
        `API back at ${new Date(backAt).toISOString()}, ${backAt - stoppedAt} ms after it stopped`
      )
      const response = await fetch(playlistUrl)
      expect(response.status).equals(200)
      const served = await response.text()
      const servedSegments = segmentsOf(served)
      const writtenWhileDown = servedSegments.filter(
        s => !closedAtStop.includes(s.uri)
      )
      const datedInside = servedSegments.filter(
        s => s.at >= stoppedAt && s.at <= stoppedAt + OUTAGE_MS
      )
      say(
        `served playlist: ${servedSegments.length} segments; ${closedAtStop.length} were closed at the stop, ${writtenWhileDown.length} were written while the API was down`
      )
      for (const s of writtenWhileDown)
        say(
          `  ${s.uri}, EXT-X-PROGRAM-DATE-TIME ${new Date(s.at).toISOString()} (${s.duration}s)`
        )
      say(
        `segments whose EXT-X-PROGRAM-DATE-TIME falls inside the 15 s: ${datedInside.map(s => s.uri).join(', ')}`
      )
      // Fifteen seconds is at least three four-second segments.
      expect(writtenWhileDown.length).greaterThanOrEqual(
        Math.floor(OUTAGE_MS / 1000 / settings.live.segmentSeconds)
      )
      expect(datedInside.length).greaterThan(0)

      // A little more after it, then the publisher leaves.
      const count = servedSegments.length
      await until(
        'a segment after the API came back',
        () => segmentsOf(readIfThere(playlistFile)).length >= count + 2,
        30_000
      )
      expect(ingest.exitCode()).equals(null)
      expect(childPids(ingestPid)).deep.equals(writers)
      say(
        `ingest pid ${ingestPid} and ffmpeg pid ${writers.join(',')} unchanged across the outage`
      )
      publisher.kill('SIGINT')
      await new Promise(resolve => publisher!.once('exit', resolve))
      expect(publisherErrors).equals('')
      await until(
        'the writer to close the playlist',
        () => childPids(ingestPid).length === 0,
        20_000
      ).catch(() => undefined)

      const final = readFileSync(playlistFile, 'utf8')
      const segments = segmentsOf(final)
      expect(discontinuities(final)).equals(breaksBefore)
      say(
        `EXT-X-DISCONTINUITY: ${breaksBefore} before the stop, ${discontinuities(final)} at the end`
      )

      // The recording, remuxed, against the wall clock it covers.
      const recording = join(folder, 'recording.mp4')
      // The live playlist has no end (`omit_endlist`), and FFmpeg reads one
      // with no end as live: from near its edge, waiting for more. A closed
      // copy beside it is read whole.
      const closed = join(dir, 'closed.m3u8')
      await writeFile(closed, `${final.trimEnd()}\n#EXT-X-ENDLIST\n`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        closed,
        '-c',
        'copy',
        recording
      ])
      const seconds = probeSeconds(recording)
      const first = segments[0]
      const last = segments[segments.length - 1]
      const wall = (last.at + last.duration * 1000 - first.at) / 1000
      say(
        `remuxed: ${seconds.toFixed(3)} s; wall clock first to last segment: ${wall.toFixed(3)} s; one segment: ${settings.live.segmentSeconds} s`
      )
      expect(Math.abs(seconds - wall)).lessThanOrEqual(
        settings.live.segmentSeconds
      )

      // Either side of the outage — the last segment closed before the stop,
      // the first written after the API answered again: the media time
      // between them is the wall time between them.
      const before = segments.find(
        s => s.uri === closedAtStop[closedAtStop.length - 1]
      )!
      const afterGap = segments.find(
        s => !servedSegments.some(served => served.uri === s.uri)
      )!
      const between = segments
        .filter(s => s.at >= before.at && s.at < afterGap.at)
        .reduce((sum, s) => sum + s.duration, 0)
      const wallBetween = (afterGap.at - before.at) / 1000
      say(
        `${before.uri} → ${afterGap.uri}: ${between.toFixed(3)} s of media over ${wallBetween.toFixed(3)} s of wall clock`
      )
      expect(Math.abs(between - wallBetween)).lessThanOrEqual(
        settings.live.segmentSeconds
      )

      const artifacts = process.env.TS_E2E_ARTIFACT_DIR
      if (artifacts != null && artifacts !== '') {
        mkdirSync(artifacts, { recursive: true })
        for (const [segment, file] of [
          [before, `gap-before-${name}.png`],
          [afterGap, `gap-after-${name}.png`]
        ] as const) {
          const joined = join(folder, `${file}.mp4`)
          execFileSync('sh', [
            '-c',
            `cat "$0" "$1" > "$2"`,
            join(dir, 'init.mp4'),
            join(dir, segment.uri),
            joined
          ])
          execFileSync('ffmpeg', [
            '-v',
            'error',
            '-y',
            '-i',
            joined,
            '-frames:v',
            '1',
            join(artifacts, file)
          ])
          say(
            `frame of ${segment.uri} (written ${new Date(segment.at).toISOString()}) → ${file}`
          )
        }
        copyFileSync(recording, join(artifacts, `recording-${name}.mp4`))
      }
    })
  })
}

/** One look at an init segment: when, how big, and whether it parses. */
interface InitSample {
  atMs: number
  size: number | undefined
  parses?: boolean
}

/** The size of a file, or undefined when there is none. */
function sizeOf(file: string): number | undefined {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}

describe('G1: a camera that comes back keeps init.mp4 whole, locally and in the Space', function () {
  this.timeout(240_000)
  let fixture: LiveFixture | undefined
  let folder = ''
  const procs: Proc[] = []
  const publishers: ChildProcess[] = []
  let space: Awaited<ReturnType<typeof startFakeSpace>> | undefined

  before(async function () {
    fixture = await liveFixture('surviveg1')
    if (fixture == null) throw new Error('no Postgres for the ingest e2e')
    folder = await mkdtemp(join(tmpdir(), 'tsSurviveG1-'))
  })

  after(async function () {
    for (const publisher of publishers) publisher.kill('SIGKILL')
    for (const proc of procs) await stop(proc)
    await new Promise<void>(resolve => {
      if (space == null) resolve()
      else
        space.server.close(() => {
          resolve()
        })
    })
    await fixture?.drop()
    if (folder !== '') await rm(folder, { recursive: true, force: true })
  })

  it('never empties or half-writes init.mp4 while the publisher returns, and the join decodes', async function () {
    const ports = { listen: await freePort(), live: await freePort() }
    const spaceSettings = {
      endpoint: '',
      region: 'test',
      bucket: 'surviveg1',
      accessKeyId: 'surviveg1',
      secretAccessKey: randomBytes(32).toString('hex'),
      pathStyle: true
    }
    const spaceDir = join(folder, 'space')
    const spaceLog = join(folder, 'space.log')
    space = await startFakeSpace({
      space: spaceSettings,
      dir: spaceDir,
      log: spaceLog
    })
    spaceSettings.endpoint = space.url
    const config = {
      ...baseConfig(folder, fixture!.url, ports),
      space: spaceSettings
    }
    await writeConfig(folder, config)
    const settings = asServerConfig(config)
    const stream = await fixture!.addStream(settings.live, SECRET)
    const dir = liveVideoDir(settings.mediaDir, stream.videoId)
    const playlistFile = join(dir, LIVE_PLAYLIST_NAME)
    const initFile = join(dir, 'init.mp4')
    const spaceInit = pathOfKey(spaceDir, `videos/${stream.videoId}/init.mp4`)!
    const lines: string[] = []
    const say = (line: string): void => {
      lines.push(line)
      console.log(`      G1 ${line}`)
    }

    const ingest = startProcess(INGEST, folder)
    procs.push(ingest)
    await healthPortOf(ingest)
    const api = startProcess(API, folder)
    procs.push(api)
    await apiListening(api)

    // HEVC with a two-second GOP and AAC, as the phones and TS Director send.
    const url = `rtmp://127.0.0.1:${ports.live}/live/${stream.key}`
    const publish = (seconds?: number): ChildProcess => {
      const publisher = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=1280x720:rate=30',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          ...(seconds == null ? [] : ['-t', String(seconds)]),
          '-c:v',
          'libx265',
          '-preset',
          'ultrafast',
          '-x265-params',
          'keyint=60:min-keyint=60:scenecut=0:bframes=0:log-level=error',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-f',
          'flv',
          url
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      )
      publishers.push(publisher)
      return publisher
    }
    say(
      '$ the camera publishes testsrc2 1280x720 30 fps HEVC (GOP 60) + AAC 48 kHz stereo to rtmp://127.0.0.1:<port>/live/<key>'
    )

    // 1. The first publish, until two segments are listed.
    const first = publish()
    await until(
      'two segments',
      () => segmentsOf(readIfThere(playlistFile)).length >= 2,
      60_000
    )
    const listedBefore = segmentsOf(readFileSync(playlistFile, 'utf8')).length
    say(
      `first publish: ${listedBefore} segments listed, init.mp4 ${sizeOf(initFile)} bytes`
    )

    // 2. Look at init.mp4, here and in the Space, from before the camera
    // drops until its return has been written and its writer has gone.
    const started = Date.now()
    const local: InitSample[] = []
    const remote: InitSample[] = []
    const sampling = { on: true }
    const sampler = (async () => {
      let tick = 0
      while (sampling.on) {
        const atMs = Date.now() - started
        const size = sizeOf(initFile)
        const sample: InitSample = { atMs, size }
        if (tick % 5 === 0) {
          let bytes: Buffer | undefined
          try {
            bytes = readFileSync(initFile)
          } catch {
            bytes = undefined
          }
          sample.parses = bytes != null && configurationOfInit(bytes) != null
        }
        local.push(sample)
        if (tick % 5 === 0) {
          const held = sizeOf(spaceInit)
          if (held != null || remote.length > 0)
            remote.push({ atMs, size: held })
        }
        tick++
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    })()

    // 3. The camera drops, and is back three seconds later for ten seconds.
    await new Promise(resolve => setTimeout(resolve, 500))
    first.kill('SIGKILL')
    say(`+${Date.now() - started} ms the first publisher is killed`)
    await new Promise(resolve => setTimeout(resolve, 3000))
    const second = publish(10)
    say(`+${Date.now() - started} ms the same camera publishes again for 10 s`)
    await new Promise(resolve => second.once('exit', resolve))
    say(`+${Date.now() - started} ms the second publisher exits`)
    const finished = await until(
      'the writer to finish',
      () => childPids(ingest.child.pid!).length === 0,
      30_000
    ).then(
      () => true,
      () => false
    )
    say(
      `+${Date.now() - started} ms the writer ${finished ? 'has finished' : 'had not finished 30 s after the publisher left'}`
    )
    await new Promise(resolve => setTimeout(resolve, 4000))
    sampling.on = false
    await sampler

    // 4. What the live directory holds, before the camera is ended.
    const playlist = readFileSync(playlistFile, 'utf8')
    const segments = segmentsOf(playlist)
    const maps = playlist
      .split('\n')
      .filter(line => line.startsWith('#EXT-X-MAP:'))
    const joinAt = playlist.split('\n').indexOf('#EXT-X-DISCONTINUITY')
    const scratchLeft = existsSync(join(dir, '.writer-init.mp4'))
    const writerPlaylist = readIfThere(join(dir, '.writer.m3u8'))
    const writerOnly = segmentsOf(
      writerPlaylist
        .split('\n')
        .filter(line => !line.startsWith('#EXT-X-MAP'))
        .join('\n')
    )
      .map(s => s.uri)
      .filter(uri => !segments.some(s => s.uri === uri))
    const closed = join(dir, 'closed.m3u8')
    await writeFile(closed, `${playlist.trimEnd()}\n#EXT-X-ENDLIST\n`)
    const decode = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-v', 'error', '-i', closed, '-f', 'null', '-'],
      { encoding: 'utf8' }
    )
    const decodeErrors = (decode.stderr ?? '').trim()
    const numbers = segments.map(s => Number(s.uri.slice(3, -4)))
    const inOrder = numbers.every(
      (n, at) => at === 0 || n === numbers[at - 1] + 1
    )
    const putLines = readIfThere(spaceLog)
      .split('\n')
      .filter(line => / PUT \S+\/init\.mp4 /.test(line))
    const failedPuts = putLines.filter(line => !/ PUT \S+ 2\d\d /.test(line))

    const emptyLocal = local.filter(s => s.size == null || s.size === 0)
    const unparsed = local.filter(s => s.parses === false)
    const emptyRemote = remote.filter(s => s.size === 0)
    const sizes = (samples: InitSample[]): number[] =>
      samples.map(s => s.size ?? 0)
    const runs = (samples: InitSample[]): string[] => {
      const out: string[] = []
      let from: InitSample | undefined
      let last: InitSample | undefined
      for (const s of samples) {
        const bad = s.size == null || s.size === 0
        if (bad && from == null) from = s
        if (!bad && from != null) {
          out.push(
            `+${from.atMs}..+${last!.atMs} ms (${last!.atMs - from.atMs} ms)`
          )
          from = undefined
        }
        last = s
      }
      if (from != null)
        out.push(`+${from.atMs}..+${last!.atMs} ms (to the end)`)
      return out
    }
    say(
      `local init.mp4: ${local.length} samples every 10 ms, min ${Math.min(...sizes(local))} bytes, max ${Math.max(...sizes(local))} bytes; ${emptyLocal.length} empty or missing; ${local.filter(s => s.parses != null).length} parsed, ${unparsed.length} unparseable`
    )
    for (const run of runs(local))
      say(`  local init.mp4 empty or missing ${run}`)
    say(
      `Space init.mp4: ${remote.length} samples every 50 ms, min ${remote.length === 0 ? '-' : Math.min(...sizes(remote))} bytes; ${emptyRemote.length} empty; ${putLines.length} PUTs of init.mp4, ${failedPuts.length} not 2xx`
    )
    say(
      `master.m3u8: ${segments.length} segments (${segments[0]?.uri} .. ${segments.at(-1)?.uri}), in order with no gap: ${inOrder}; ${maps.length} EXT-X-MAP (${maps.join(' ')}); ${discontinuities(playlist)} EXT-X-DISCONTINUITY`
    )
    if (joinAt >= 0) {
      say('  the join:')
      for (const line of playlist
        .split('\n')
        .slice(Math.max(0, joinAt - 3), joinAt + 4))
        say(`    ${line}`)
    }
    say(
      `writer files: .writer-init.mp4 ${scratchLeft ? 'present' : 'absent'}; .writer.m3u8 ${writerPlaylist === '' ? 'absent' : 'present'}, segments only it lists: ${writerOnly.length === 0 ? 'none' : writerOnly.join(', ')}`
    )
    say(
      `$ ffmpeg -v error -i closed.m3u8 -f null -   (master.m3u8 + #EXT-X-ENDLIST)`
    )
    say(decodeErrors === '' ? '  (no output: decoded whole)' : decodeErrors)

    const artifacts = process.env.TS_E2E_ARTIFACT_DIR
    const writeLog = (): void => {
      if (artifacts == null || artifacts === '') return
      mkdirSync(artifacts, { recursive: true })
      writeFileSync(join(artifacts, 'init-window.log'), `${lines.join('\n')}\n`)
    }
    writeLog()

    // 5. The camera is ended, and the recording put away.
    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'ended' })
      .where('id', '=', stream.id)
      .execute()
    await until(
      'the camera to be finished',
      async () =>
        (
          await fixture!.db
            .selectFrom('live_streams')
            .select('ended_at')
            .where('id', '=', stream.id)
            .executeTakeFirstOrThrow()
        ).ended_at != null,
      60_000
    )
    await new Promise(resolve => setTimeout(resolve, 5000))
    const rangeErrors = ingest
      .output()
      .split('\n')
      .filter(line => line.includes('RangeError'))
    say(
      `ingest output through the End: ${rangeErrors.length === 0 ? 'no RangeError' : rangeErrors.join('\n')}`
    )
    writeLog()

    expect(finished, 'the writer finished after the publisher left').equals(
      true
    )
    expect(emptyLocal, 'local init.mp4 empty or missing').deep.equals([])
    expect(unparsed, 'local init.mp4 unparseable').deep.equals([])
    expect(emptyRemote, 'Space init.mp4 empty').deep.equals([])
    expect(failedPuts, 'init.mp4 PUTs not 2xx').deep.equals([])
    expect(segments.length).greaterThan(listedBefore)
    expect(inOrder, 'segments in order with no gap').equals(true)
    expect(maps).deep.equals(['#EXT-X-MAP:URI="init.mp4"'])
    expect(discontinuities(playlist)).equals(1)
    expect(decodeErrors).equals('')
    expect(scratchLeft, '.writer-init.mp4 left behind').equals(false)
    expect(writerOnly, 'segments only the writer playlist lists').deep.equals(
      []
    )
    expect(rangeErrors).deep.equals([])
  })
})
