import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import pg from 'pg'

import { TeamStationClient } from '../../common/api'
import { serverConfig } from '../../server/serverConfig'
import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * E20: live viewers ride through a publisher's outage. Real server, real RTMP
 * from the fake broadcaster, real FFmpeg, and a Chromium-family browser
 * through maestro-d.
 *
 *   E20_BROWSER=<Chromium-family binary> MAESTRO_D=<daemon> \
 *   MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *   TS_API_TEST_URL=<API on this machine> TS_SCORING_TEST_URL=<web app> \
 *   [TS_E2E_ARTIFACT_DIR=<where the video goes>] [E20_FRAMES_DIR=<frame logs>] \
 *     npx mocha -r sucrase/register --extension ts --timeout 1800000 \
 *     src/app/player/liveOutage.e2e.ts
 *
 * Needs the API on this machine with live ingest and a `sessionSecret`, its
 * media served locally (`serveMediaLocally`), the fake Space when recordings
 * go there (`npm run fake-space`), and the web app built against the API. It
 * makes its own administrator and game, with a password it draws and never
 * prints.
 *
 * The broadcaster publishes 150 s with a 20 s outage at 60 s. Three pages:
 * - **A** watches live from the start and is never reloaded. It must pick
 *   the stream up again on its own soon after the publisher comes back.
 * - **B** opens a second after the publisher comes back, before the new
 *   writer has written anything: it holds the playlist across the respawn.
 * - **C** opens twenty seconds after, a fresh load with the break behind it.
 *
 * Every page logs each frame it presents: its own position and the wall
 * clock burned into the picture. A frame is in step when that clock is the
 * one the live playlist puts at that position (`playlistClock.ts`). After the
 * stream is ended, C reloads the recording and seeks either side of the
 * break, judged against the same playlist.
 *
 * The video and camera it made are deleted at the end; the game stays.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9100/api/v1'
for (const url of [APP, API, serverConfig.databaseUrl]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
    throw new Error(`${url} is not on this machine`)
}
const artifacts = process.env.TS_E2E_ARTIFACT_DIR
const framesDir = process.env.E20_FRAMES_DIR

/** The broadcaster's picture runs at 30 frames a second. */
const FRAME_MS = 1000 / 30
const DURATION_SEC = 150
const OUTAGE_AT_SEC = 60
const OUTAGE_SEC = 20
const RETURN_SEC = OUTAGE_AT_SEC + OUTAGE_SEC
/** "About ten seconds" from the publisher's return to pictures again. */
const RESUME_WITHIN_MS = 10_000
/** The share of frames after the break that must be in step. */
const IN_STEP_SHARE = 0.99

const kit = createRequire(__filename)
const marker = kit('../../../scripts/e2e/liveOutage/readMarker.ts') as {
  markerGeometry: (height: number) => unknown
  readMarkerSource: () => string
  unwrapMarker: (low32: number, nearMs: number) => number
}
interface Segment {
  uri: string
  sequence: number
  durationSec: number
  startSec: number
  discontinuity: boolean
  programDateTime: number | null
}
const clock = kit('../../../scripts/e2e/liveOutage/playlistClock.ts') as {
  parsePlaylist: (text: string) => {
    mediaSequence: number
    ended: boolean
    segments: Segment[]
  }
  firstMarkers: (
    ffmpegPath: string,
    dir: string,
    segments: readonly Segment[],
    nearMs: number
  ) => Array<number | null>
  wallAtPosition: (
    segments: readonly Segment[],
    markers: ReadonlyArray<number | null>,
    atSec: number
  ) => number | null
}

const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')
type Daemon = Awaited<ReturnType<typeof MaestroD.connect>>
type Page = Awaited<ReturnType<Daemon['attach']>>

const started = Date.now()
function print(what: string, detail?: unknown): void {
  const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
  console.log(
    `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  )
}
const iso = (ms: number): string => new Date(ms).toISOString()
async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

const stamp = Date.now().toString(36)
const ADMIN = {
  email: `outage.${stamp}@example.test`,
  password: randomBytes(18).toString('base64url')
}
const VIEWER = {
  email: `outage.viewer.${stamp}@example.test`,
  password: randomBytes(18).toString('base64url')
}

let token = ''
let daemon: Daemon | undefined
const cameras: Array<{ gameId: string; streamId: string; videoId: string }> = []

function dev(script: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    ['-r', 'sucrase/register', `src/server/dev/${script}.ts`, ...args],
    { encoding: 'utf8' }
  )
}

async function ask(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text)
  }
}

/** A camera for a game, with its key on this machine's ingest. */
async function camera(
  gameId: string,
  label: string
): Promise<{ videoId: string; streamId: string; url: string }> {
  const made = await ask(`/games/${gameId}/live-streams`, {
    method: 'POST',
    body: JSON.stringify({ label })
  })
  const body = made.json as { id: string; videoId: string; url: string }
  if (made.status !== 201) throw new Error(`no camera: ${made.status}`)
  cameras.push({ gameId, streamId: body.id, videoId: body.videoId })
  const key = new URL(body.url.replace(/^rtmp:/, 'http:')).pathname
    .split('/')
    .pop()!
  const { live } = serverConfig
  return {
    videoId: body.videoId,
    streamId: body.id,
    url: `rtmp://127.0.0.1:${live.port}/${live.app}/${key}`
  }
}

interface BroadcastEvent {
  at: number
  event: string
  t0?: number
  fromSec?: number
}

/** The fake broadcaster publishing into `url`, and what it says it did. */
function broadcast(
  url: string,
  args: string[]
): { t0: Promise<number>; done: Promise<number>; events: BroadcastEvent[] } {
  const child = spawn(
    process.execPath,
    ['scripts/e2e/liveOutage/fakeBroadcaster.mjs', '--url', url, ...args],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const events: BroadcastEvent[] = []
  let buffer = ''
  const t0 = new Promise<number>(resolve => {
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, at)) as BroadcastEvent
        buffer = buffer.slice(at + 1)
        events.push(event)
        if (event.event === 'planned') resolve(event.t0!)
      }
    })
  })
  const done = new Promise<number>(resolve =>
    child.on('exit', code => {
      resolve(code ?? 1)
    })
  )
  return { t0, done, events }
}

/** A browser signed in as the administrator. */
async function browser(name: string): Promise<Page> {
  const page = await daemon!.attach({
    device: `liveOutage-${name}-${stamp}`,
    platform: 'web',
    appId: APP,
    stepDelay: 0,
    artifacts: 'on-failure',
    extra: {
      browser: process.env.E20_BROWSER ?? 'chrome',
      windowSize: '1280x720'
    }
  })
  await page.blockNetwork({
    patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
  })
  await page.setCookies({
    cookies: [
      {
        name: 'ts_session',
        value: encodeURIComponent(token),
        domain: new URL(API).hostname,
        path: '/'
      }
    ]
  })
  return page
}

async function probe<T>(page: Page, script: string): Promise<T> {
  await page.evalBrowserScript({
    script: `return JSON.stringify(await (async () => { ${script} })())`,
    output: 'probe'
  })
  return JSON.parse((await page.vars()).probe) as T
}

async function until(
  page: Page,
  script: string,
  what: string,
  ms = 90_000
): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await probe<boolean>(page, script)) return
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await pause(500)
  }
}

const PICTURE_READY = `const v = document.querySelector('video'); return v != null && v.readyState >= 2 && v.videoWidth > 0`

/**
 * Logs every frame the page's player presents: the page's clock, the low
 * bits of the wall clock burned into the picture, and the frame's position.
 * The log lives on the window, so a page that reloaded has lost it.
 */
const FRAME_LOGGER = `
  const readMarker = ${marker.readMarkerSource()}
  const geometry = ${JSON.stringify(marker.markerGeometry(720))}
  const v = document.querySelector('video')
  window.__e20 = { frames: [], stop: false }
  const log = (now, meta) => {
    if (window.__e20.stop) return
    window.__e20.frames.push([Date.now(), readMarker(v, geometry), meta.mediaTime])
    v.requestVideoFrameCallback(log)
  }
  v.muted = true
  v.play().catch(() => undefined)
  v.requestVideoFrameCallback(log)
  return true
`

interface Frame {
  now: number
  wall: number | null
  mediaSec: number
}

async function frames(
  page: Page,
  nearMs: number,
  label: string
): Promise<Frame[]> {
  const raw = await probe<Array<[number, number | null, number]> | null>(
    page,
    `if (window.__e20 == null) return null; window.__e20.stop = true; return window.__e20.frames`
  )
  if (raw == null) throw new Error(`${label}: the page lost its frame log`)
  if (framesDir != null)
    writeFileSync(join(framesDir, `${label}.json`), JSON.stringify(raw))
  return raw.map(([now, low, mediaSec]) => ({
    now,
    wall: low == null ? null : marker.unwrapMarker(low, nearMs),
    mediaSec
  }))
}

/**
 * Screenshots the page as fast as the browser hands them over, between two
 * moments, and makes them into a video at the pace they were taken.
 */
async function film(
  page: Page,
  fromMs: number,
  toMs: number,
  out: string
): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'tsOutageFilm-'))
  try {
    // A camera's address carries its stream key: painted over for as long as
    // the page lives, whatever the page redraws.
    await probe(
      page,
      `const style = document.createElement('style')
      style.textContent = '[aria-label^="Copy the URL for"] { position: relative !important; background: #e8ebe2 !important } [aria-label^="Copy the URL for"] * { visibility: hidden !important } [aria-label^="Copy the URL for"]::after { content: "stream key hidden"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #555; font: 16px sans-serif }'
      document.head.appendChild(style)
      return true`
    )
    await pause(fromMs - Date.now())
    const shots: Array<{ file: string; at: number }> = []
    while (Date.now() < toMs) {
      const at = Date.now()
      const file = join(
        work,
        `shot${String(shots.length).padStart(5, '0')}.png`
      )
      writeFileSync(file, await page.screenshot())
      shots.push({ file, at })
    }
    const list = shots
      .map((shot, i) => {
        const next = shots[i + 1]?.at ?? toMs
        return `file '${shot.file}'\nduration ${((next - shot.at) / 1000).toFixed(3)}`
      })
      .join('\n')
    writeFileSync(
      join(work, 'list.txt'),
      `${list}\nfile '${shots[shots.length - 1].file}'\n`
    )
    execFileSync(serverConfig.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(work, 'list.txt'),
      '-vf',
      'fps=10,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v',
      'libx264',
      '-crf',
      '26',
      out
    ])
    print(`filmed ${shots.length} screenshots into ${out}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * The frames whose picture is not the one the playlist puts at their
 * position, out of those whose marker could be read.
 */
function judge(
  log: Frame[],
  segments: readonly Segment[],
  markers: ReadonlyArray<number | null>
): { read: number; wrong: Array<Frame & { expected: number | null }> } {
  const read = log.filter(frame => frame.wall != null)
  const wrong = []
  for (const frame of read) {
    const expected = clock.wallAtPosition(segments, markers, frame.mediaSec)
    if (expected != null && Math.abs(frame.wall! - expected) <= FRAME_MS)
      continue
    wrong.push({ ...frame, expected })
  }
  return { read: read.length, wrong }
}

describe('E20: live viewers through a publisher outage', function () {
  let gameId = ''
  const failures: string[] = []
  const check = (ok: boolean, what: string): void => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}`)
    if (!ok) failures.push(what)
  }

  before(async function () {
    const name = process.env.MAESTRO_D
    if (name == null || name === '') throw new Error('MAESTRO_D is required')
    if (artifacts != null) mkdirSync(artifacts, { recursive: true })
    if (framesDir != null) mkdirSync(framesDir, { recursive: true })
    dev('seed', ADMIN.email, ADMIN.password)
    const made = dev('scoringGame', VIEWER.email, VIEWER.password)
    gameId = /^GAME_ID=(.+)$/m.exec(made)![1]
    token = await signInTestAccount(API, ADMIN)
    daemon = await MaestroD.connect({ name })
    print('game', gameId)
  })

  after(async function () {
    print('cleaning up the video and camera')
    // The stand-in Space lists and deletes nothing, so the API cannot delete
    // a recording kept there. Then, on this machine only, the rows go from
    // the database and the files from the disk.
    const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
    try {
      for (const one of cameras) {
        const gone = await ask(`/videos/${one.videoId}`, { method: 'DELETE' })
        await ask(`/games/${one.gameId}/live-streams/${one.streamId}`, {
          method: 'DELETE'
        })
        if (gone.status < 300) continue
        await pool.query('delete from live_streams where id = $1', [
          one.streamId
        ])
        await pool.query('delete from videos where id = $1', [one.videoId])
        for (const root of [
          join(serverConfig.mediaDir, 'work', 'videos'),
          join(serverConfig.workDir, 'space', 'videos')
        ])
          rmSync(join(root, one.videoId), { recursive: true, force: true })
        print(`removed ${one.videoId} from this machine directly`)
      }
    } finally {
      await pool.end()
    }
    await daemon?.shutdown()
  })

  it('A page watching live picks the stream up again, in step, and so does a fresh one', async function () {
    const angle = await camera(gameId, 'E20 outage')
    const show = broadcast(angle.url, [
      '--duration',
      String(DURATION_SEC),
      '--outage',
      `${OUTAGE_AT_SEC}:${OUTAGE_SEC}`
    ])
    const t0 = await show.t0
    print('T0', iso(t0))
    const at = async (sec: number): Promise<void> => {
      await pause(t0 + sec * 1000 - Date.now())
    }
    const watch = `${APP}/games/${gameId}?video=${angle.videoId}`
    const pages: Record<'A' | 'B' | 'C', Page> = {
      A: await browser('A'),
      B: await browser('B'),
      C: await browser('C')
    }

    await at(8)
    await pages.A.openBrowser({ url: watch })
    await until(pages.A, PICTURE_READY, 'page A showed the live picture')
    await probe(pages.A, FRAME_LOGGER)
    print('A: watching live, logging every frame')
    const filming =
      artifacts == null
        ? Promise.resolve()
        : film(
            pages.A,
            t0 + (OUTAGE_AT_SEC - 10) * 1000,
            t0 + (RETURN_SEC + 25) * 1000,
            join(artifacts, 'live-outage-viewer.mp4')
          )

    await at(RETURN_SEC + 1)
    await pages.B.openBrowser({ url: watch })
    await until(pages.B, PICTURE_READY, 'page B showed a picture')
    await probe(pages.B, FRAME_LOGGER)
    print('B: opened just after the publisher came back')

    await at(RETURN_SEC + 20)
    await pages.C.openBrowser({ url: watch })
    await until(pages.C, PICTURE_READY, 'page C showed a picture')
    await probe(pages.C, FRAME_LOGGER)
    print('C: opened fresh after the break')

    check((await show.done) === 0, 'the broadcaster published every part')
    await filming
    // The viewers are some seconds behind the publisher.
    await pause(20_000)
    const back = show.events.find(
      event => event.event === 'publish' && event.fromSec === RETURN_SEC
    )!.at
    print('the publisher came back', iso(back))

    const dir = join(serverConfig.mediaDir, 'work', 'videos', angle.videoId)
    const livePlaylist = readFileSync(join(dir, 'master.m3u8'), 'utf8')
    if (framesDir != null)
      cpSync(dir, join(framesDir, 'live'), { recursive: true })
    const { segments, mediaSequence, ended } = clock.parsePlaylist(livePlaylist)
    const markers = clock.firstMarkers(
      serverConfig.ffmpegPath,
      dir,
      segments,
      t0
    )
    print('the live playlist', {
      mediaSequence,
      ended,
      segments: segments.length,
      discontinuities: segments.filter(one => one.discontinuity).length,
      firstNumbers: segments.slice(0, 3).map(one => one.uri)
    })
    check(
      markers.every(one => one != null),
      `every segment's first frame was read (${markers.filter(one => one != null).length} of ${markers.length})`
    )
    check(
      segments.every(
        (one, i) =>
          one.uri === `seg${String(mediaSequence + i).padStart(6, '0')}.m4s`
      ),
      'every segment is named for its media sequence number'
    )
    check(
      segments.every(one => one.programDateTime != null),
      'every segment carries EXT-X-PROGRAM-DATE-TIME'
    )
    const breakAt = segments.findIndex(
      one => one.discontinuity && one.startSec > 0
    )
    if (breakAt > 0)
      print('the break', {
        atSec: segments[breakAt].startSec,
        before: iso(markers[breakAt - 1]!),
        after: iso(markers[breakAt]!)
      })

    for (const name of ['A', 'B', 'C'] as const) {
      const log = await frames(pages[name], t0, `page-${name}`)
      const afterBreak = log.filter(
        frame =>
          frame.wall != null && frame.wall >= t0 + RETURN_SEC * 1000 - 1000
      )
      const judged = judge(afterBreak, segments, markers)
      const share =
        judged.read === 0 ? 0 : 1 - judged.wrong.length / judged.read
      for (const frame of judged.wrong.slice(0, 5))
        print(`${name}: out of step`, {
          now: iso(frame.now),
          picture: iso(frame.wall!),
          positionSec: frame.mediaSec,
          playlistPuts: frame.expected == null ? null : iso(frame.expected)
        })
      check(
        judged.read > 300 && share >= IN_STEP_SHARE,
        `${name}: ${judged.read - judged.wrong.length} of ${judged.read} frames after the break in step (${(share * 100).toFixed(2)}%)`
      )
      const before = judge(
        log.filter(
          frame => frame.wall != null && frame.wall < t0 + OUTAGE_AT_SEC * 1000
        ),
        segments,
        markers
      )
      if (before.read > 0)
        print(
          `${name}: before the break, ${before.read - before.wrong.length} of ${before.read} in step`
        )
      if (name !== 'A') continue
      const lastBefore = log.filter(
        frame => frame.wall != null && frame.wall < t0 + OUTAGE_AT_SEC * 1000
      )
      const firstAfter = afterBreak[0]
      const stalledAt = lastBefore[lastBefore.length - 1]?.now
      check(
        firstAfter != null && firstAfter.now - back <= RESUME_WITHIN_MS,
        `A picked the stream up again ${firstAfter == null ? 'never' : `${((firstAfter.now - back) / 1000).toFixed(1)} s after the publisher came back`} (its last picture before the break was at ${stalledAt == null ? '-' : iso(stalledAt)}), without a reload`
      )
    }

    // The end: the recording, at moments either side of the break.
    const ended200 = await ask(
      `/games/${gameId}/live-streams/${angle.streamId}/end`,
      { method: 'POST' }
    )
    expect(ended200.status).equals(200)
    const client = new TeamStationClient({ baseUrl: API, token })
    for (let tries = 0; ; tries++) {
      const game = await client.game(gameId)
      const video = game.videos.find(one => one.id === angle.videoId)
      if (video?.status === 'ready' && video.width != null) break
      if (tries > 360) throw new Error('the recording was never packed up')
      await pause(500)
    }
    print('recorded')
    await pages.C.openBrowser({ url: watch })
    await until(pages.C, PICTURE_READY, 'page C showed the recording')
    const total =
      segments[segments.length - 1].startSec +
      segments[segments.length - 1].durationSec
    const seeks = [
      10,
      35,
      OUTAGE_AT_SEC - 3,
      OUTAGE_AT_SEC + 2,
      OUTAGE_AT_SEC + 20,
      total - 10
    ]
    let inStep = 0
    for (const atSec of seeks) {
      const read = await probe<{ low: number | null; frameSec: number | null }>(
        pages.C,
        `
        const readMarker = ${marker.readMarkerSource()}
        const v = document.querySelector('video')
        v.pause()
        await new Promise(resolve => {
          const late = setTimeout(resolve, 5000)
          v.addEventListener('seeked', () => { clearTimeout(late); resolve() }, { once: true })
          v.currentTime = ${atSec}
        })
        const frameSec = await new Promise(resolve => {
          const late = setTimeout(() => resolve(null), 3000)
          v.requestVideoFrameCallback((now, meta) => { clearTimeout(late); resolve(meta.mediaTime) })
        })
        return { low: readMarker(v, ${JSON.stringify(marker.markerGeometry(720))}), frameSec: frameSec ?? v.currentTime }
      `
      )
      const picture =
        read.low == null ? null : marker.unwrapMarker(read.low, t0)
      const expected =
        read.frameSec == null
          ? null
          : clock.wallAtPosition(segments, markers, read.frameSec)
      const ok =
        picture != null &&
        expected != null &&
        Math.abs(picture - expected) <= FRAME_MS
      if (ok) inStep++
      console.log(
        `    seek ${atSec.toFixed(1)} s  frame ${read.frameSec?.toFixed(3) ?? '-'}  picture ${picture == null ? '-' : iso(picture)}  playlist ${expected == null ? '-' : iso(expected)}  ${ok ? 'in step' : 'OUT'}`
      )
    }
    check(
      inStep === seeks.length,
      `the recording is in step at ${inStep} of ${seeks.length} seeks`
    )

    for (const page of Object.values(pages)) await page.detach()
    expect(failures).deep.equals([])
  })
})
