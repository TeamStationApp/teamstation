import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { createLiveHarness } from '../../../e2e/rigs/liveHarness'
import { signInTestAccount } from '../../test/passwordFixtures'
import { scratchDatabase } from '../../test/scoreboardKit'
import { startFakeSpace } from '../dev/fakeSpace'
import { videoPrefix } from '../media/videoPrefix'
import { parseMediaPlaylist } from '../media/wallClockScan'
import { liveVideoDir } from './controller'
import { isSegmentName } from './originPublish'

/**
 * E2E-2: the ingest keeps only the newest pieces of a live stream on its
 * disk, across a reconnect, while the Space gets the whole recording.
 *
 *   node src/migrate/requirePostgres18.js && npx mocha --timeout 600000 \
 *     --exit -r sucrase/register --extension ts \
 *     --spec src/server/live/localTail.e2e.ts
 *
 * Needs the Postgres 18 cluster, Redis and `ffmpeg` with libx265 on PATH.
 * The API and the ingest run as processes from a temporary directory with
 * their own `serverConfig.json`, a scratch database, free ports and an
 * in-process fake Space. The plan's run publishes 6 minutes with 60 s kept;
 * this one keeps `TAIL_SEC` (20 s) and publishes 100 s, drops the publisher
 * for 20 s, publishes 40 s more and ends the game, about four minutes.
 */
const TAIL_SEC = 20
const SEGMENT_SEC = 4
const FIRST_SEC = 100
const OUTAGE_SEC = 20
const SECOND_SEC = 40
const SAMPLE_MS = 15_000
const run = promisify(execFile)
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve =>
    server.close(() => {
      resolve()
    })
  )
  return port
}

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await pause(200)
  }
}

interface Proc {
  child: ChildProcess
  output: () => string
  gone: () => boolean
  exited: Promise<number | null>
}

function track(child: ChildProcess): Proc {
  let text = ''
  child.stdout?.on('data', chunk => (text += String(chunk)))
  child.stderr?.on('data', chunk => (text += String(chunk)))
  let gone = false
  const exited = new Promise<number | null>(resolve =>
    child.on('exit', code => {
      gone = true
      resolve(code)
    })
  )
  return { child, output: () => text, gone: () => gone, exited }
}

async function stop(
  proc: Proc,
  signal: NodeJS.Signals = 'SIGTERM'
): Promise<void> {
  if (proc.gone()) return
  proc.child.kill(signal)
  const late = setTimeout(() => proc.child.kill('SIGKILL'), 20_000)
  await proc.exited
  clearTimeout(late)
}

describe('E2E-2: sixty seconds on disk (M4)', function () {
  this.timeout(600_000)
  const root = resolve('.')
  const register = require.resolve('sucrase/register')
  const procs: Proc[] = []
  let scratch = ''
  let database: Awaited<ReturnType<typeof scratchDatabase>>
  let store: Awaited<ReturnType<typeof startFakeSpace>>
  let api = ''
  let livePort = 0
  let mediaRoot = ''
  let token = ''
  let sample = ''

  const start = (entry: string, cwd: string): Proc => {
    const proc = track(
      spawn(process.execPath, ['-r', register, join(root, entry)], {
        cwd,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
    procs.push(proc)
    return proc
  }

  before(async function () {
    scratch = await mkdtemp(join(tmpdir(), 'tsLocalTailE2e-'))
    database = await scratchDatabase('localtail')
    const space = {
      endpoint: '',
      region: 'test',
      bucket: 'localtail',
      accessKeyId: 'example',
      secretAccessKey: randomBytes(32).toString('hex'),
      pathStyle: true
    }
    store = await startFakeSpace({ space, dir: join(scratch, 'space') })
    space.endpoint = store.url
    const apiPort = await freePort()
    livePort = await freePort()
    api = `http://127.0.0.1:${apiPort}/api/v1`
    const secret = randomBytes(32).toString('hex')
    mediaRoot = join(scratch, 'shared', 'media')
    for (const name of ['api', 'ingest']) {
      const dir = join(scratch, name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: database.url,
          listenHost: '127.0.0.1',
          listenPort: apiPort,
          primaryUrlOverride: `127.0.0.1:${apiPort}`,
          clusterWorkers: 1,
          statsBuilder: false,
          sessionSecret: secret,
          mediaSecret: secret,
          workDir: join(scratch, 'shared', 'work'),
          mediaDir: mediaRoot,
          uploadsDir: join(dir, 'uploads'),
          ffmpegPath: 'ffmpeg',
          serveMediaLocally: true,
          sentry: { dsn: '' },
          logRequests: false,
          space,
          live: {
            enabled: true,
            bindHost: '127.0.0.1',
            port: livePort,
            healthPort: 0,
            freeDiskFloorGb: 0,
            segmentSeconds: SEGMENT_SEC,
            localTailSec: TAIL_SEC
          }
        })
      )
    }
    await mkdir(join(scratch, 'shared', 'work'), { recursive: true })
    await mkdir(mediaRoot, { recursive: true })
    const apiProc = start('src/server/index.ts', join(scratch, 'api'))
    const ingest = start('src/server/ingest/main.ts', join(scratch, 'ingest'))
    await until('the API and the ingest', () => {
      for (const proc of procs)
        if (proc.gone()) throw new Error(`a process exited:\n${proc.output()}`)
      return (
        apiProc.output().includes('listening on') &&
        ingest.output().includes('ingest health on')
      )
    })
    // Thirty seconds of 720p HEVC with sound, a keyframe every 2 s.
    sample = join(scratch, 'sample.mp4')
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '30',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-x265-params',
        'log-level=none:keyint=60:min-keyint=60:scenecut=0',
        '-tag:v',
        'hvc1',
        '-c:a',
        'aac',
        sample
      ],
      { maxBuffer: 1 << 22 }
    )
  })

  after(async function () {
    for (const proc of procs.reverse()) await stop(proc)
    await new Promise<void>(resolve =>
      store?.server.close(() => {
        resolve()
      })
    )
    await database?.drop()
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  })

  it('keeps the newest pieces on disk, reconnects, and leaves the whole recording in the Space', async function () {
    const helper = createLiveHarness({
      api,
      app: 'http://127.0.0.1:1',
      serverRoot: root,
      configDir: join(scratch, 'api'),
      token: () => token,
      live: { port: livePort, app: 'live' },
      daemon: () => undefined
    })
    const admin = {
      email: 'tail.admin@example.test',
      password: randomBytes(18).toString('base64url')
    }
    const watcher = {
      email: 'tail.viewer@example.test',
      password: randomBytes(18).toString('base64url')
    }
    helper.dev('seed', admin.email, admin.password)
    const seeded = helper.dev('scoringGame', watcher.email, watcher.password)
    const gameId = /^GAME_ID=(.+)$/m.exec(seeded)?.[1]
    if (gameId == null) throw new Error('No fixture game')
    token = await signInTestAccount(api, admin)
    const camera = await helper.camera(gameId, 'Tail')
    const dir = liveVideoDir(mediaRoot, camera.videoId)
    const { space_secret: spaceSecret } = await database.db
      .selectFrom('videos')
      .select('space_secret')
      .where('id', '=', camera.videoId)
      .executeTakeFirstOrThrow()
    const remote = join(
      scratch,
      'space',
      videoPrefix({ id: camera.videoId, spaceSecret })
    )
    // Stills stay under the id alone.
    const stillsDir = join(scratch, 'space', 'videos', camera.videoId, 'stills')

    const publish = (): Proc => {
      const proc = track(
        spawn(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-re',
            '-stream_loop',
            '-1',
            '-i',
            sample,
            '-c',
            'copy',
            '-f',
            'flv',
            camera.url
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
      )
      procs.push(proc)
      return proc
    }

    /** Seconds of pieces on disk, apart from the scan's placement piece. */
    const onDisk = async (): Promise<{
      pieces: string[]
      seconds: number
      oldest?: string
      remote: number
    }> => {
      const names = await readdir(dir).catch(() => [] as string[])
      const pieces = names.filter(isSegmentName).sort()
      const listed = parseMediaPlaylist(
        await readFile(join(dir, 'master.m3u8'), 'utf8').catch(() => '')
      ).segments
      const runStarts = new Set(
        listed
          .filter((segment, index) => index === 0 || segment.discontinuity)
          .map(segment => segment.uri)
      )
      const seconds = listed
        .filter(s => pieces.includes(s.uri) && !runStarts.has(s.uri))
        .reduce((sum, s) => sum + s.durationSec, 0)
      const held = await readdir(remote).catch(() => [] as string[])
      return {
        pieces,
        seconds,
        oldest: pieces[0],
        remote: held.filter(isSegmentName).length
      }
    }

    const samples: Array<{ at: number; seconds: number; pieces: number }> = []
    const began = Date.now()
    const watch = async (forMs: number): Promise<void> => {
      const end = Date.now() + forMs
      while (Date.now() < end) {
        await pause(Math.min(SAMPLE_MS, end - Date.now()))
        const seen = await onDisk()
        const at = Math.round((Date.now() - began) / 1000)
        samples.push({ at, seconds: seen.seconds, pieces: seen.pieces.length })
        console.log(
          `      t=${at} s: ${seen.pieces.length} pieces on disk (${seen.oldest ?? '-'}…), ${seen.seconds.toFixed(1)} s past the run starts, Space ${seen.remote}`
        )
      }
    }

    const first = publish()
    await watch(FIRST_SEC * 1000)
    first.child.kill('SIGKILL')
    await first.exited
    await watch(OUTAGE_SEC * 1000)
    const second = publish()
    await watch(SECOND_SEC * 1000)
    await stop(second)
    await pause(3000)

    // After the first stretch the disk never holds more than the tail and
    // the piece being written; the playlist, init.mp4 and each run's first
    // piece (which the wall clock scan reads again) stay too. The writer's
    // pieces run a few milliseconds over SEGMENT_SEC, hence the 1%.
    for (const seen of samples.filter(s => s.at >= TAIL_SEC + 20))
      expect(seen.seconds).at.most((TAIL_SEC + 2 * SEGMENT_SEC) * 1.01)
    expect(samples.at(-1)!.pieces).below(
      Math.ceil((FIRST_SEC + SECOND_SEC) / SEGMENT_SEC) / 2
    )

    const ended = await helper.ask(
      `/games/${gameId}/live-streams/${camera.streamId}/end`,
      { method: 'POST' }
    )
    expect(ended.status).equals(200)
    await until(
      'the recording to be verified in the Space',
      async () =>
        (
          await database.db
            .selectFrom('videos')
            .select('spaces_verified_at')
            .where('id', '=', camera.videoId)
            .executeTakeFirst()
        )?.spaces_verified_at != null,
      120_000
    )

    const closed = await readFile(join(remote, 'index.m3u8'), 'utf8')
    const listed = parseMediaPlaylist(closed)
    expect(listed.ended).equals(true)
    expect(listed.segments[0].uri).equals('seg000000.m4s')
    const held = new Set((await readdir(remote)).filter(isSegmentName))
    for (const segment of listed.segments)
      expect(held.has(segment.uri), segment.uri).equals(true)
    expect(listed.segments.map(s => s.uri)).deep.equals([...held].sort())

    const playback = (await helper.ask(`/videos/${camera.videoId}/playback`))
      .json as { url: string }
    const master = await fetch(playback.url)
    expect(master.status).equals(200)
    let served = await master.text()
    if (!served.includes('#EXTINF')) {
      const variant = served
        .split('\n')
        .find(line => line !== '' && !line.startsWith('#'))!
      served = await (await fetch(new URL(variant, playback.url))).text()
    }
    const servedNames = served
      .split('\n')
      .filter(line => line !== '' && !line.startsWith('#'))
      .map(line => basename(new URL(line, playback.url).pathname))
    expect(servedNames).deep.equals(listed.segments.map(s => s.uri))
    expect(served.match(/#EXT-X-DISCONTINUITY\n/g)).length(1)

    const stills = (await readdir(stillsDir)).filter(name =>
      name.endsWith('.jpg')
    )
    expect(stills.length).at.least(1)
    expect(await stat(dir).catch(() => undefined)).equals(undefined)
    const row = await database.db
      .selectFrom('videos')
      .select(['duration_sec', 'status'])
      .where('id', '=', camera.videoId)
      .executeTakeFirstOrThrow()
    expect(row.status).equals('ready')
    console.log(
      `      closed: ${listed.segments.length} pieces in the Space from ${listed.segments[0].uri}, one discontinuity, ${row.duration_sec} s, poster ${stills[0]}, local directory gone`
    )
  })
})
