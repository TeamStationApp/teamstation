import { writeFileSync } from 'node:fs'

import { expect } from 'chai'
import WebSocket from 'ws'

import { boardAt } from '../../src/app/player/scoreboardOverlay/boardAt'
import {
  startingSetup,
  teamsOf
} from '../../src/app/scoring/developmentSession'
import { type BoardStep, TeamStationClient } from '../../src/common/api'
import {
  type DashboardOverrides,
  NO_OVERRIDES
} from '../../src/common/scoreboard'
import { ScoringSession } from '../../src/common/scoring/session'
import {
  type WallAnchor,
  wallAt,
  type WallTimeline
} from '../../src/common/wallTimeline'
import type { HarnessContext, WebSession } from '../core/spec'
import {
  markerGeometry,
  readMarkerSource,
  unwrapMarker
} from './media/readMarker'
import { apiToken } from './media/recordingSeek'
import {
  type BroadcastOptions,
  stackApi,
  stackControl,
  type StackMedia,
  stackMedia,
  untilBroadcast
} from './media/stackSpace'

/**
 * What the board's browser scenarios share (`playback/board-overlay/*` and
 * `playback/wall-clock/display-lag`): the `scoring-game` world's
 * administrator and games on the stack, cameras the stack's own fake
 * broadcaster publishes into, the app's own scoring session and override
 * dashboard over the stack's API, a page in this machine's browser through
 * maestro-d, and the reads of the page those scenarios make. It describes no
 * tests, and starts nothing on this machine.
 */

export const LONG_AWAY =
  'Port Kestrel Lighthouse Keepers of the Northern League'
export const LONG_HOME = 'Cedar Hollow Owls'
/** One frame of the fake broadcaster's 30 frames a second. */
export const FRAME_MS = 1000 / 30
/** The ingest's segment length when the stack's settings leave it out (`serverConfigSchema.ts`). */
export const DEFAULT_SEGMENT_SECONDS = 4

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

/** The stack, as the scoring world's administrator sees it. */
export interface BoardStack {
  origin: string
  api: string
  token: string
  client: TeamStationClient
  media: StackMedia
}

/** Seeds the `scoring-game` world and signs its administrator in: answers the stack and its two games. */
export async function boardStack(
  ctx: Pick<HarnessContext, 'stack' | 'fixture'>,
  signIn: typeof apiToken = apiToken
): Promise<{ stack: BoardStack; games: string[] }> {
  const media = stackMedia(stackControl(ctx as HarnessContext))
  const world = await ctx.fixture('scoring-game')
  const api = stackApi(ctx as HarnessContext)
  const token = await signIn(api, world.accounts.scorer)
  return {
    stack: {
      origin: ctx.stack.origin.replace(/\/+$/, ''),
      api,
      token,
      client: new TeamStationClient({ baseUrl: api, token }),
      media
    },
    games: world.ids.games.split(',')
  }
}

/** One request to the stack's API as the administrator. */
export async function ask(
  stack: BoardStack,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${stack.api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${stack.token}`,
      'content-type': 'application/json'
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text)
  }
}

export interface Camera {
  gameId: string
  streamId: string
  videoId: string
  /** The `rtmp://` URL the API answered, key and all: it goes to the stack alone. */
  url: string
}

/** A camera for a game. */
export async function camera(
  stack: BoardStack,
  gameId: string,
  label: string
): Promise<Camera> {
  const made = await ask(stack, `/games/${gameId}/live-streams`, {
    method: 'POST',
    body: JSON.stringify({ label })
  })
  const body = made.json as { id: string; videoId: string; url: string }
  if (made.status !== 201) throw new Error(`no camera: ${made.status}`)
  return { gameId, streamId: body.id, videoId: body.videoId, url: body.url }
}

export interface Show {
  id: string
  /** The wall time the picture's clock starts at. */
  t0: number
  /** The broadcaster's exit code, once it has published every part. */
  done: () => Promise<number>
}

/** The stack's fake broadcaster publishing into a camera. */
export async function broadcast(
  stack: BoardStack,
  into: Camera,
  options: Omit<BroadcastOptions, 'url'>,
  everyMs = 2000
): Promise<Show> {
  const started = await stack.media.broadcast({ url: into.url, ...options })
  return {
    id: started.id,
    t0: started.t0,
    done: async () =>
      (
        await untilBroadcast(
          stack.media,
          started.id,
          'it ended',
          status => status.exit != null,
          { timeoutMs: (options.duration + 900) * 1000, everyMs }
        )
      ).exit!
  }
}

/** Waits until `sec` seconds after `t0`. */
export function clock(t0: number): (sec: number) => Promise<void> {
  return async sec => {
    await pause(t0 + sec * 1000 - Date.now())
  }
}

/** Waits for a camera's recording to be packed up. */
export async function ready(
  stack: BoardStack,
  gameId: string,
  videoId: string,
  tries = 360,
  everyMs = 500
): Promise<void> {
  for (let n = 0; n < tries; n++) {
    const game = await stack.client.game(gameId)
    const video = game.videos.find(one => one.id === videoId)
    if (video?.status === 'ready' && video.width != null) return
    await pause(everyMs)
  }
  throw new Error(`${videoId} was never packed up`)
}

export async function endCamera(
  stack: BoardStack,
  held: Camera
): Promise<void> {
  const ended = await ask(
    stack,
    `/games/${held.gameId}/live-streams/${held.streamId}/end`,
    { method: 'POST' }
  )
  expect(ended.status).equals(200)
}

/** The ingest's segment length on this stack, in ms. */
export async function segmentMs(
  stack: BoardStack,
  videoId: string
): Promise<number> {
  const { live } = await stack.media.ingestFiles(videoId)
  const seconds = live.segmentSeconds
  return (
    (typeof seconds === 'number' ? seconds : DEFAULT_SEGMENT_SECONDS) * 1000
  )
}

/** A recorded video's wall timeline, and where the video ends. */
export interface VideoTimeline extends WallTimeline {
  /** The video's length, in ms of its own time. */
  endMs: number
}

export async function videoTimeline(
  stack: BoardStack,
  videoId: string
): Promise<VideoTimeline> {
  const [timeline, playback] = await Promise.all([
    stack.client.wallTimeline(videoId),
    stack.client.playback(videoId)
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

/** The scorer: the app's own scoring session, posting through the stack's API. */
export async function scorer(
  stack: BoardStack,
  gameId: string
): Promise<ScoringSession> {
  const { client } = stack
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
  session: Pick<ScoringSession, 'apply'>,
  call: 'B' | 'C' | 'S' | 'F'
): number {
  const at = Date.now()
  const problems = session.apply({ type: 'pitch', call }).problems
  if (problems.length > 0) throw new Error(problems[0].message)
  return at
}

/** The override dashboard, as the app's own dashboard screen talks to it. */
export async function dashboard(
  stack: BoardStack,
  gameId: string
): Promise<WebSocket> {
  const base = stack.api.replace(/^http/, 'ws')
  const socket = new WebSocket(
    `${base}/scoreboard/${encodeURIComponent(gameId)}/dashboard`,
    { headers: { authorization: `Bearer ${stack.token}` } }
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

/** The window sizes these scenarios name as `<width>x<height>`. */
export function sizeOf(size: string): { width: number; height: number } {
  const [width, height] = size.split('x').map(Number)
  return { width, height }
}

/**
 * A page in this machine's Chrome, which plays the stack's HEVC, at one
 * window size, signed in as the administrator.
 */
export async function boardBrowser(
  ctx: Pick<HarnessContext, 'browser'>,
  stack: BoardStack,
  size: string
): Promise<WebSession> {
  const session = await ctx.browser(sizeOf(size), { h264: true })
  await session.m.setCookies({
    cookies: [
      {
        name: 'ts_session',
        value: encodeURIComponent(stack.token),
        domain: new URL(stack.origin).hostname,
        path: '/'
      }
    ]
  })
  return session
}

/** Runs `script` in the page through maestro-d and answers what it returned. */
export async function probe<T>(m: any, script: string): Promise<T> {
  await m.evalBrowserScript({
    script: `return JSON.stringify(await (async () => { ${script} })())`,
    output: 'probe'
  })
  return JSON.parse((await m.vars()).probe) as T
}

export async function until(
  m: any,
  script: string,
  what: string,
  ms = 90_000,
  everyMs = 500
): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await probe<boolean>(m, script)) return
    if (Date.now() > deadline) throw new Error(`never: ${what}`)
    await pause(everyMs)
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

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface SeekRead {
  wall: number
  marker: number | null
  at: number | null
  /** The board is the step at the wall clock burned into the picture. */
  ok: boolean
  /** The board is the step at the player's own time for the frame. */
  okByFrame: boolean
  board: Box | null
  video: Box
}

/**
 * Seeks the page's first video to each wall time and reads the marker and
 * the board: in step when the board is the step in effect at the marker. A
 * wall time the video does not hold is a read that fails, not a seek to the
 * nearest frame it has.
 */
export async function seekReads(
  m: any,
  timeline: VideoTimeline,
  steps: BoardStep[],
  walls: number[],
  videoIndex = 0
): Promise<SeekRead[]> {
  const out: SeekRead[] = []
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
      board: Box | null
      video: Box
    }>(
      m,
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
export async function gridState(m: any): Promise<{
  window: { w: number; h: number }
  boards: Array<Box & { at: number }>
  tiles: Box[]
  masterSec: number
}> {
  return await probe(
    m,
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
 * Any of these angles' names drawn as text on the grid, outside the page's
 * own root. The grid draws none now: a scenario checks this finds nothing.
 */
export async function nameTexts(m: any, titles: string[]): Promise<string[]> {
  return await probe(
    m,
    `const titles = ${JSON.stringify(titles)}
    return [...document.querySelectorAll('div')]
      .filter(node => node.closest('#root') == null && node.childElementCount === 0 && titles.includes((node.textContent ?? '').replace(/^🔊 /, '')))
      .map(node => node.textContent)`
  )
}

/**
 * Each of these angles' tiles, found by its `<title> angle` label, where it
 * is, and whether it is the one the grid hears (`data-heard`). Null for an
 * angle with no labelled tile.
 */
export async function angleTiles(
  m: any,
  titles: string[]
): Promise<Array<(Box & { title: string; heard: boolean }) | null>> {
  return await probe(
    m,
    `${RECTS}
    return ${JSON.stringify(titles)}.map(title => {
      const tile = document.querySelector('[aria-label="' + title + ' angle"]')
      if (tile == null) return null
      return { title, ...box(tile), heard: tile.getAttribute('data-heard') === 'true' }
    })`
  )
}

/** The families the app draws with, which a picture waits for. */
const FAMILIES = ['Material Symbols Outlined', 'Space Grotesk', 'Inter']

/** Covers every camera address that shows: it carries the stream key. */
export const COVER_KEYS = `for (const box of document.querySelectorAll('[aria-label^="Copy the URL for"]')) {
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

/**
 * Saves a screenshot of the page at `file`, once its fonts have loaded, with
 * its first player scrolled whole into the window and every stream key
 * covered.
 */
export async function picture(m: any, file: string): Promise<void> {
  // The fonts come from the network: until they arrive, icons are their
  // names in the fallback font. `document.fonts.check` says yes to a family
  // it has never heard of, so each family must have a face loaded.
  const fonts = await probe<boolean>(
    m,
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
  if (!fonts) throw new Error(`${file}: the page's fonts never loaded`)
  await probe(
    m,
    `const v = document.querySelector('video')
    const r = v?.getBoundingClientRect()
    if (r != null && (r.top < 0 || r.bottom > window.innerHeight)) v.scrollIntoView({ block: 'nearest' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise(resolve => setTimeout(resolve, 300))
    return true`
  )
  await probe(m, COVER_KEYS)
  writeFileSync(file, await m.screenshot())
  await probe(
    m,
    `for (const cover of document.querySelectorAll('[data-cover="stream-key"]')) cover.remove(); return true`
  )
  print(`saved ${file}`)
}

/**
 * The frame logger: logs every frame the page's single player presents (or
 * the grid's tile at `gridIndex`, or the player `videoExpr` names): the
 * page's clock, the low bits of the wall clock burned into it, the board's
 * `data-at`, and its own time. `readFrames` collects the log.
 */
export function frameLogger(target?: number | string): string {
  const video =
    target == null
      ? `document.querySelector('video')`
      : typeof target === 'number'
        ? `${GRID_VIDEOS}[${target}]`
        : target
  return `
    const readMarker = ${readMarkerSource()}
    const geometry = ${JSON.stringify(markerGeometry(720))}
    const v = ${video}
    if (window.__frames != null) window.__frames.stop = true
    const log = { frames: [], stop: false }
    window.__frames = log
    const step = (now, meta) => {
      if (log.stop) return
      const board = document.querySelector('[data-testid="scoreboard-overlay"]')
      log.frames.push([Date.now(), readMarker(v, geometry), board == null ? null : Number(board.getAttribute('data-at')), meta.mediaTime])
      v.requestVideoFrameCallback(step)
    }
    v.muted = true
    v.play().catch(() => undefined)
    v.requestVideoFrameCallback(step)
    return true
  `
}

export interface Frame {
  now: number
  wall: number | null
  at: number | null
  mediaSec: number
}

/** Stops the frame logger and answers what it logged, each marker made whole near `nearMs`. */
export async function readFrames(m: any, nearMs: number): Promise<Frame[]> {
  const raw = await probe<
    Array<[number, number | null, number | null, number]>
  >(
    m,
    `if (window.__frames == null) return []; window.__frames.stop = true; return window.__frames.frames`
  )
  return raw.map(([now, marker, at, mediaSec]) => ({
    now,
    wall: marker == null ? null : unwrapMarker(marker, nearMs),
    at,
    mediaSec
  }))
}
