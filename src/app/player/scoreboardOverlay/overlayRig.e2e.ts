import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import pg from 'pg'
import WebSocket from 'ws'

import { type BoardStep, TeamStationClient } from '../../../common/api'
import {
  type DashboardOverrides,
  NO_OVERRIDES
} from '../../../common/scoreboard'
import { ScoringSession } from '../../../common/scoring/session'
import {
  type WallAnchor,
  wallAt,
  type WallTimeline
} from '../../../common/wallTimeline'
import { serverConfig } from '../../../server/serverConfig'
import { signInTestAccount } from '../../../test/passwordFixtures'
import { startingSetup, teamsOf } from '../../scoring/developmentSession'
import { boardAt } from './boardAt'

/**
 * What the board's browser scenarios share (E8 in `overlay.e2e.ts`, E9 in
 * `overlayPhone.e2e.ts`): an administrator and games made on this machine,
 * cameras published into by the fake broadcaster, the app's own scoring
 * session and override dashboard, a Chromium-family browser through
 * maestro-d, and the reads of the page those scenarios make. Not a scenario
 * itself: it describes no tests.
 *
 * The API, the web app and the database must be on this machine.
 */
export const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8090'
export const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9140/api/v1'

/** Refuses an address that is not on this machine. */
export function onThisMachine(url: string | undefined): void {
  if (
    url != null &&
    !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)
  )
    throw new Error(`${url} is not on this machine`)
}
for (const url of [APP, API, serverConfig.databaseUrl]) onThisMachine(url)

export const artifacts = process.env.TS_E2E_ARTIFACT_DIR
const stamp = Date.now().toString(36)
const ADMIN = {
  email: `overlay.${stamp}@example.test`,
  password: randomBytes(18).toString('base64url')
}
const VIEWER = {
  email: `overlay.viewer.${stamp}@example.test`,
  password: randomBytes(18).toString('base64url')
}
export const LONG_AWAY =
  'Port Kestrel Lighthouse Keepers of the Northern League'
export const LONG_HOME = 'Cedar Hollow Owls'

/**
 * The marker reader the fake broadcaster's tests share
 * (`scripts/e2e/scoreboardLog/readMarker.ts`), loaded at run time: it lives
 * outside `src`, where the app's type check does not reach.
 */
const marker = createRequire(__filename)(
  '../../../../scripts/e2e/scoreboardLog/readMarker.ts'
) as {
  markerGeometry: (height: number) => unknown
  readMarkerSource: () => string
  unwrapMarker: (low32: number, nearMs: number) => number
}
export const markerGeometry = marker.markerGeometry
export const readMarkerSource = marker.readMarkerSource
export const unwrapMarker = marker.unwrapMarker

const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')
type Daemon = Awaited<ReturnType<typeof MaestroD.connect>>
export type Page = Awaited<ReturnType<Daemon['attach']>>

const started = Date.now()
export function print(what: string, detail?: unknown): void {
  const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
  console.log(
    `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  )
}
export const iso = (ms: number): string => new Date(ms).toISOString()
export async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function npm(...args: string[]): string {
  return execFileSync('npm', ['run', '--silent', ...args], { encoding: 'utf8' })
}

let token = ''
let client: TeamStationClient
let daemon: Daemon | undefined
/** What each browser's device name starts with: the scenario's name. */
let prefix = 'overlay'
let browserBinary = 'chrome'
const cameras: Array<{ gameId: string; streamId: string; videoId: string }> = []

/** The API, as the administrator. */
export function api(): TeamStationClient {
  return client
}

/**
 * Makes the administrator (`npm run seed`) and `games` games with a viewer
 * (`npm run scoring-game`), with passwords it draws and never prints, signs
 * in, and connects to the maestro-d daemon `MAESTRO_D`. Answers the games.
 */
export async function setUp(options: {
  /** The scenario's name, which starts every browser's device name. */
  name: string
  /** The Chromium-family browser maestro-d drives. */
  browser: string
  games: number
}): Promise<string[]> {
  const name = process.env.MAESTRO_D
  if (name == null || name === '') throw new Error('MAESTRO_D is required')
  prefix = options.name
  browserBinary = options.browser
  if (artifacts != null) mkdirSync(artifacts, { recursive: true })
  npm('seed', '--', ADMIN.email, ADMIN.password)
  const made = npm(
    'scoring-game',
    '--',
    VIEWER.email,
    VIEWER.password,
    '--games',
    String(options.games)
  )
  const games = [...made.matchAll(/^GAME_ID=(.+)$/gm)].map(m => m[1])
  token = await signInTestAccount(API, ADMIN)
  client = new TeamStationClient({ baseUrl: API, token })
  daemon = await MaestroD.connect({ name })
  return games
}

/**
 * Deletes every video and camera it made, and lets go of the daemon. The
 * games stay.
 */
export async function tearDown(): Promise<void> {
  print('cleaning up the videos and cameras')
  // The stand-in Space (`npm run fake-space`) lists and deletes nothing,
  // so the API cannot delete a recording kept there. Then, on this machine
  // only, the rows go from the database and the files from the disk.
  const pool = new pg.Pool({ connectionString: serverConfig.databaseUrl })
  try {
    for (const one of cameras) {
      const gone = await ask(`/videos/${one.videoId}`, { method: 'DELETE' })
      await ask(`/games/${one.gameId}/live-streams/${one.streamId}`, {
        method: 'DELETE'
      })
      if (gone.status < 300) continue
      await pool.query('delete from live_streams where id = $1', [one.streamId])
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
}

/** One request to the API as the administrator. */
export async function ask(
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
export async function camera(
  gameId: string,
  label: string
): Promise<{ videoId: string; url: string }> {
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
    url: `rtmp://127.0.0.1:${live.port}/${live.app}/${key}`
  }
}

/**
 * The fake broadcaster publishing into `url`: its planned start, once it is
 * known, and its exit.
 */
export function broadcast(
  url: string,
  args: string[]
): { t0: Promise<number>; done: Promise<number> } {
  const child = spawn(
    process.execPath,
    ['scripts/e2e/scoreboardLog/fakeBroadcaster.mjs', '--url', url, ...args],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  let buffer = ''
  const t0 = new Promise<number>(resolve => {
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, at)) as {
          event: string
          t0?: number
        }
        buffer = buffer.slice(at + 1)
        if (event.event === 'planned') resolve(event.t0!)
      }
    })
  })
  const done = new Promise<number>(resolve =>
    child.on('exit', code => {
      resolve(code ?? 1)
    })
  )
  return { t0, done }
}

/** Waits for a camera's recording to be packed up. */
export async function ready(gameId: string, videoId: string): Promise<void> {
  for (let tries = 0; tries < 360; tries++) {
    const game = await client.game(gameId)
    const video = game.videos.find(one => one.id === videoId)
    if (video?.status === 'ready' && video.width != null) return
    await pause(500)
  }
  throw new Error(`${videoId} was never packed up`)
}

export async function endCamera(
  gameId: string,
  videoId: string
): Promise<void> {
  const held = cameras.find(one => one.videoId === videoId)!
  const ended = await ask(
    `/games/${gameId}/live-streams/${held.streamId}/end`,
    { method: 'POST' }
  )
  expect(ended.status).equals(200)
}

/** A recorded video's wall timeline, and where the video ends. */
export interface VideoTimeline extends WallTimeline {
  /** The video's length, in ms of its own time. */
  endMs: number
}

/** The wall timeline of a recorded video, with its length. */
export async function videoTimeline(videoId: string): Promise<VideoTimeline> {
  const [timeline, playback] = await Promise.all([
    api().wallTimeline(videoId),
    api().playback(videoId)
  ])
  if (playback.durationSec == null) throw new Error(`${videoId} has no length`)
  return { ...timeline, endMs: playback.durationSec * 1000 }
}

/**
 * The position in a video of a wall-clock instant: null in an outage, before
 * the video starts and after it ends, which a seek there would not show.
 */
export function mediaAt(
  anchors: readonly WallAnchor[],
  wallMs: number,
  endMs: number
): number | null {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const [mediaMs, anchorWall] = anchors[i]
    if (anchorWall > wallMs) continue
    const at = mediaMs + (wallMs - anchorWall)
    const next = anchors[i + 1]
    if (next != null && at >= next[0]) return null
    return at < endMs ? at : null
  }
  return null
}

/** The scorer: the app's own scoring session, posting through the API. */
export async function scorer(gameId: string): Promise<ScoringSession> {
  const game = await client.game(gameId)
  const [away, home] = await Promise.all([
    client.roster(game.awayTeamId),
    client.roster(game.homeTeamId)
  ])
  return await ScoringSession.open(
    {
      load: async id => await client.gameEvents(id),
      save: async (id, change) => await client.saveGameEvents(id, change)
    },
    gameId,
    {
      gamePk: gameId,
      teams: teamsOf(game),
      setup: startingSetup(game, away, home)
    },
    { setTimer: () => null, clearTimer: () => undefined }
  )
}

export function pitch(
  session: ScoringSession,
  call: 'B' | 'C' | 'S' | 'F'
): number {
  const at = Date.now()
  const problems = session.apply({ type: 'pitch', call }).problems
  if (problems.length > 0) throw new Error(problems[0].message)
  return at
}

/** The override dashboard, as the app's own dashboard screen talks to it. */
export async function dashboard(gameId: string): Promise<WebSocket> {
  const base = API.replace(/^http/, 'ws')
  const socket = new WebSocket(
    `${base}/scoreboard/${encodeURIComponent(gameId)}/dashboard`,
    { headers: { authorization: `Bearer ${token}` } }
  )
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

export function overrides(on: boolean): DashboardOverrides {
  return on
    ? {
        ...NO_OVERRIDES,
        overrideCountEnabled: true,
        overrideCount: { balls: 3, strikes: 2, outs: 1 },
        overrideTeamEnabled: true,
        overrideTeam: { awayTeam: LONG_AWAY, homeTeam: LONG_HOME }
      }
    : NO_OVERRIDES
}

/** A browser at one window size, signed in as the administrator. */
export async function browser(
  name: string,
  windowSize: string,
  /**
   * The web app the page opens. A page attached for one origin and opened
   * on another gets no web fonts, so a base build's page is attached for
   * the base build.
   */
  app: string = APP
): Promise<Page> {
  const page = await daemon!.attach({
    device: `${prefix}-${name}-${stamp}`,
    platform: 'web',
    appId: app,
    stepDelay: 0,
    artifacts: 'on-failure',
    extra: { browser: browserBinary, windowSize }
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

/** Runs `script` in the page and answers what it returned. */
export async function probe<T>(page: Page, script: string): Promise<T> {
  await page.evalBrowserScript({
    script: `return JSON.stringify(await (async () => { ${script} })())`,
    output: 'probe'
  })
  return JSON.parse((await page.vars()).probe) as T
}

export async function until(
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

export const PICTURE_READY = `const v = document.querySelector('video'); return v != null && v.readyState >= 2 && v.videoWidth > 0`

/**
 * The grid's own players: it is portalled into the body, outside the app's
 * root, where the single player it suspends is still mounted.
 */
export const GRID_VIDEOS = `[...document.querySelectorAll('video')].filter(one => one.closest('#root') == null)`

/** Every tile of the grid has a picture. */
export function gridReady(count: number): string {
  return `const v = ${GRID_VIDEOS}; return v.length === ${count} && v.every(one => one.readyState >= 2)`
}

/** Where things are on the page, for the checks on geometry. */
export const RECTS = `
  const box = node => { if (node == null) return null; const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  const boards = [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')]
  const videos = [...document.querySelectorAll('video')]
  const grid = ${GRID_VIDEOS}
`

/**
 * Seeks the page's first video to each wall time and reads the marker and
 * the board: in step when the board is the step in effect at the marker. A
 * wall time the video does not hold is a read that fails, not a seek to the
 * nearest frame it has.
 */
export async function seekReads(
  page: Page,
  timeline: VideoTimeline,
  steps: BoardStep[],
  walls: number[],
  videoIndex = 0
): Promise<
  Array<{
    wall: number
    marker: number | null
    at: number | null
    /** The board is the step at the wall clock burned into the picture. */
    ok: boolean
    /** The board is the step at the player's own time for the frame. */
    okByFrame: boolean
    board: { x: number; y: number; w: number; h: number } | null
    video: { x: number; y: number; w: number; h: number }
  }>
> {
  const out = []
  for (const wall of walls) {
    const media = mediaAt(timeline.anchors, wall, timeline.endMs)
    if (media == null) {
      console.log(`    seek ${iso(wall)}  not in the video: FAIL`)
      out.push({
        wall,
        marker: null,
        at: null,
        ok: false,
        okByFrame: false,
        board: null,
        video: { x: 0, y: 0, w: 0, h: 0 }
      })
      continue
    }
    const read = await probe<{
      marker: number | null
      frameSec: number | null
      at: string | null
      board: { x: number; y: number; w: number; h: number } | null
      video: { x: number; y: number; w: number; h: number }
    }>(
      page,
      `
      const readMarker = ${readMarkerSource()}
      ${RECTS}
      const v = videos[${videoIndex}]
      v.pause()
      await new Promise(resolve => {
        const late = setTimeout(resolve, 5000)
        v.addEventListener('seeked', () => { clearTimeout(late); resolve() }, { once: true })
        v.currentTime = ${media / 1000}
      })
      const frameSec = await new Promise(resolve => {
        const late = setTimeout(() => resolve(null), 3000)
        v.requestVideoFrameCallback((now, meta) => { clearTimeout(late); resolve(meta.mediaTime) })
      })
      // A few display frames for the board to follow the seek.
      await new Promise(resolve => setTimeout(resolve, 300))
      const o = document.querySelector('[data-testid="scoreboard-overlay"]')
      return {
        marker: readMarker(v, ${JSON.stringify(markerGeometry(720))}),
        frameSec: frameSec ?? v.currentTime,
        at: o?.getAttribute('data-at') ?? null,
        board: box(o),
        video: box(v)
      }
    `
    )
    const marker = read.marker == null ? null : unwrapMarker(read.marker, wall)
    const at = read.at == null ? null : Number(read.at)
    const expected =
      marker == null ? undefined : (boardAt(steps, marker)?.at ?? null)
    const ok = marker != null && at === expected
    const frameWall =
      read.frameSec == null
        ? null
        : wallAt(timeline.anchors, read.frameSec * 1000)
    const byFrame = boardAt(steps, frameWall)?.at ?? null
    const okByFrame = frameWall != null && at === byFrame
    console.log(
      `    seek ${iso(wall)}  marker ${marker == null ? '-' : iso(marker)}  frame ${frameWall == null ? '-' : iso(frameWall)}  board ${at == null ? '-' : iso(at)}  ${ok ? 'in step' : `expected ${expected == null ? '-' : iso(expected)}`}`
    )
    out.push({
      wall,
      marker,
      at,
      ok,
      okByFrame,
      board: read.board,
      video: read.video
    })
  }
  return out
}

/** The grid's geometry, its board and what the master tile shows. */
export async function gridState(page: Page): Promise<{
  window: { w: number; h: number }
  boards: Array<{ x: number; y: number; w: number; h: number; at: number }>
  tiles: Array<{ x: number; y: number; w: number; h: number }>
  masterSec: number
}> {
  return await probe(
    page,
    `${RECTS}
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      boards: boards.map(node => ({ ...box(node), at: Number(node.getAttribute('data-at')) })),
      tiles: grid.map(v => box(v.parentElement)),
      masterSec: grid[0]?.currentTime ?? 0
    }`
  )
}

/**
 * The name on each angle of the grid, which outside the page's own root is
 * the grid's, and whether the board covers any of it: the name says which
 * angle a tile is, and its 🔊 which one is heard.
 */
export async function nameChips(
  page: Page,
  titles: string[]
): Promise<
  Array<{
    text: string
    x: number
    y: number
    w: number
    h: number
    covered: boolean
  }>
> {
  return await probe(
    page,
    `${RECTS}
    const titles = ${JSON.stringify(titles)}
    const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    return [...document.querySelectorAll('div')]
      .filter(node => node.closest('#root') == null && node.childElementCount === 0 && titles.includes((node.textContent ?? '').replace(/^🔊 /, '')))
      .map(node => {
        const chip = box(node.parentElement)
        return { text: node.textContent, ...chip, covered: boards.some(board => meets(chip, box(board))) }
      })
      .filter(chip => chip.w > 0 && chip.h > 0)`
  )
}

/** The families the app draws with, which a picture waits for. */
const FAMILIES = ['Material Symbols Outlined', 'Space Grotesk', 'Inter']

/**
 * Saves a screenshot of the page into the artifacts directory, once its fonts
 * have loaded, with its first player scrolled whole into the window.
 */
export async function picture(page: Page, path: string): Promise<void> {
  if (artifacts == null) return
  // The fonts come from the network: until they arrive, icons are their
  // names in the fallback font. Until the stylesheet naming them has arrived
  // there is no face to wait on, and `document.fonts.check` says yes to a
  // family it has never heard of, so each family must have a face loaded.
  const fonts = await probe<boolean>(
    page,
    `const families = ${JSON.stringify(FAMILIES)}
    const name = face => face.family.replace(/^["']|["']$/g, '')
    const deadline = Date.now() + 30000
    for (;;) {
      const faces = [...document.fonts].filter(face => families.includes(name(face)))
      await Promise.all(faces.map(face => face.load().catch(() => undefined)))
      await document.fonts.ready
      if (families.every(family => faces.some(face => name(face) === family && face.status === 'loaded'))) return true
      if (Date.now() > deadline) return false
      await new Promise(resolve => setTimeout(resolve, 250))
    }`
  )
  if (!fonts) throw new Error(`${path}: the page's fonts never loaded`)
  await probe(
    page,
    `const v = document.querySelector('video')
    const r = v?.getBoundingClientRect()
    if (r != null && (r.top < 0 || r.bottom > window.innerHeight)) v.scrollIntoView({ block: 'nearest' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise(resolve => setTimeout(resolve, 300))
    return true`
  )
  // Painted over first: a camera's address carries its stream key. Only an
  // address that shows, and inside it, so the cover is never drawn over
  // something on top of it, such as the full-window grid.
  await probe(
    page,
    `for (const box of document.querySelectorAll('[aria-label^="Copy the URL for"]')) {
      const r = box.getBoundingClientRect()
      const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]
      const shows = points.some(([fx, fy]) => {
        const x = r.left + fx * r.width
        const y = r.top + fy * r.height
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
        const hit = document.elementFromPoint(x, y)
        return hit != null && (box === hit || box.contains(hit))
      })
      if (r.width <= 0 || r.height <= 0 || !shows) continue
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative'
      const cover = document.createElement('div')
      cover.textContent = 'stream key hidden'
      cover.dataset.cover = 'stream-key'
      Object.assign(cover.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', background: '#e8ebe2', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '18px sans-serif', zIndex: 2147483647 })
      box.appendChild(cover)
    }
    return true`
  )
  writeFileSync(join(artifacts, path), await page.screenshot())
  await probe(
    page,
    `for (const cover of document.querySelectorAll('[data-cover="stream-key"]')) cover.remove(); return true`
  )
  print(`saved ${path}`)
}
