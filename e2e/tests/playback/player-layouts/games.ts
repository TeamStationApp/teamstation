import { expect } from 'chai'
import WebSocket from 'ws'

import {
  startingSetup,
  teamsOf
} from '../../../../src/app/scoring/developmentSession'
import { TeamStationClient } from '../../../../src/common/api'
import { HttpError } from '../../../../src/common/errors'
import { makeId } from '../../../../src/common/ids'
import { NO_OVERRIDES } from '../../../../src/common/scoreboard'
import type { ScoringAction } from '../../../../src/common/scoring/actions'
import { fieldingSide } from '../../../../src/common/scoring/lineup'
import { nextDecision } from '../../../../src/common/scoring/rules'
import { ScoringSession } from '../../../../src/common/scoring/session'
import type { GameState } from '../../../../src/common/scoring/state'
import type { FixtureAccount, FixtureManifest } from '../../../core/fixtures'
import type { HarnessContext } from '../../../core/spec'
import type { Page } from '../../../core/web'
import { clearSignInLimits, stackSql } from '../../../rigs/coach/coachApp'
import { type EventWeb, openEventWeb, tokenOf } from '../../../rigs/eventWeb'
import {
  type BroadcastStretch,
  stackControl,
  type StackMedia,
  stackMedia,
  untilBroadcast
} from '../../../rigs/media/stackSpace'

/**
 * What the player-layouts, playback-controls and live-angles scenarios
 * share: the `player-layouts` world's games, their media made on the stack
 * itself (each angle a camera of the game, published into the stack's own
 * ingest by the fake broadcaster with the wall clock burned into its
 * picture, and scored through the app's own `ScoringSession` while it
 * records), and this run's browser on them. Each scenario makes its own:
 * nothing is shared between scenarios.
 */

export type GameName = 'S' | 'L' | 'N' | 'N0' | 'U' | 'V'

export interface PlayerGame {
  id: string
  videos: string[]
}

export interface PlayerWorld {
  ctx: HarnessContext
  world: FixtureManifest
  admin: FixtureAccount
  /** The stack's API, `${origin}/api/v1`. */
  api: string
  token: string
  client: TeamStationClient
  media: StackMedia
  say: (what: string, detail?: unknown) => void
}

export async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

/** The world on this run's stack, its administrator signed in to the API. */
export async function playerWorld(ctx: HarnessContext): Promise<PlayerWorld> {
  const world = await ctx.fixture('player-layouts')
  const admin = world.accounts.admin
  await clearSignInLimits(ctx)
  const token = await tokenOf(ctx, admin)
  const api = `${ctx.stack.origin.replace(/\/+$/, '')}/api/v1`
  const started = Date.now()
  return {
    ctx,
    world,
    admin,
    api,
    token,
    client: new TeamStationClient({ baseUrl: api, token }),
    media: stackMedia(stackControl(ctx)),
    say: (what, detail) => {
      const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
      console.log(
        `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
      )
    }
  }
}

async function ask(
  pw: PlayerWorld,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${pw.api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${pw.token}`,
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
  streamId: string
  videoId: string
  /** The camera's `rtmp://` URL as the API answered it. */
  url: string
}

/** A camera for a game. */
export async function camera(
  pw: PlayerWorld,
  gameId: string,
  label: string
): Promise<Camera> {
  const made = await ask(pw, `/games/${gameId}/live-streams`, {
    method: 'POST',
    body: JSON.stringify({ label })
  })
  expect(made.status, `a camera for ${gameId}`).equals(201)
  const body = made.json as { id: string; videoId: string; url: string }
  return { streamId: body.id, videoId: body.videoId, url: body.url }
}

export async function endCamera(
  pw: PlayerWorld,
  gameId: string,
  streamId: string
): Promise<void> {
  const ended = await ask(pw, `/games/${gameId}/live-streams/${streamId}/end`, {
    method: 'POST'
  })
  expect(ended.status, `${streamId} ended`).equals(200)
}

/** Removes an ended camera, which still holds one of the four a person may have. */
export async function removeCamera(
  pw: PlayerWorld,
  gameId: string,
  streamId: string
): Promise<void> {
  await ask(pw, `/games/${gameId}/live-streams/${streamId}`, {
    method: 'DELETE'
  })
}

/** Waits for a camera's recording to be packed up. */
async function ready(
  pw: PlayerWorld,
  gameId: string,
  videoId: string
): Promise<void> {
  for (let tries = 0; tries < 720; tries++) {
    const game = await pw.client.game(gameId)
    const video = game.videos.find(one => one.id === videoId)
    if (video?.status === 'ready' && video.width != null) return
    await pause(500)
  }
  throw new Error(`${videoId} was never packed up`)
}

/**
 * The plays the player-layouts scenarios score into their games, half by half:
 * a home run, a single and an error on a fixed pattern, then three
 * strikeouts. Both halves of an inning are the same, so the game stays tied
 * into extra innings, until the top of `innings` scores and the bottom does
 * not: the line score then has innings past nine, runs, hits and an error
 * for both sides.
 */
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const swing: ScoringAction = { type: 'ballInPlay', contact: 'swing' }

/** The batting events of one inning, before its three strikeouts. */
function events(inning: number): ScoringAction[][] {
  const out: ScoringAction[][] = []
  if (inning % 3 === 1)
    out.push([swing, { type: 'result', eventType: 'home_run' }])
  if (inning % 4 === 2)
    out.push([swing, { type: 'result', eventType: 'single' }])
  if (inning % 5 === 3)
    out.push([swing, { type: 'result', eventType: 'field_error' }])
  return out
}

/**
 * The plays of one half: each is the actions of one batter, which the
 * caller applies one at a time, saying what the play waits on first
 * (`decide`).
 */
export function halfPlays(
  inning: number,
  top: boolean,
  innings: number
): ScoringAction[][] {
  const homeRun: ScoringAction = { type: 'result', eventType: 'home_run' }
  const batters =
    inning === innings ? (top ? [[swing, homeRun]] : []) : events(inning)
  return [
    ...batters,
    [strike, strike, strike],
    [strike, strike, strike],
    [strike, strike, strike]
  ]
}

/**
 * What the scorer says before the next action when the play in front of
 * them waits on it: the shortstop charged with an error, or the play closed
 * once it is decided. Null when nothing is waiting.
 */
export function decide(state: GameState): ScoringAction | null {
  const decision = nextDecision(state)
  if (decision === 'close') return close
  if (decision === 'errorAttribution') {
    const shortstop =
      state.liveData.boxscore.teams[fieldingSide(state)].defense.SS
    if (shortstop == null) throw new Error('Nobody is at shortstop')
    return { type: 'fieldingPlay', fielders: [shortstop], error: shortstop }
  }
  return null
}

/** The scorer: the app's own scoring session, posting through the API. */
async function scorer(
  pw: PlayerWorld,
  gameId: string
): Promise<ScoringSession> {
  const { client } = pw
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

/**
 * Scores `innings` innings of `scoringPlan.ts` into the game, one action
 * every `spacingMs`, saving as it goes: each action's time is when it was
 * applied, inside the recording.
 */
export async function scoreGame(
  pw: PlayerWorld,
  gameId: string,
  innings: number,
  spacingMs: number
): Promise<{ first: number; last: number }> {
  const session = await scorer(pw, gameId)
  let first = 0
  let last = 0
  const begun = Date.now()
  let applied = 0
  const apply = async (action: ScoringAction): Promise<void> => {
    const problems = session.apply(action).problems
    if (problems.length > 0)
      throw new Error(`${JSON.stringify(action)}: ${problems[0].message}`)
    last = Date.now()
    if (first === 0) first = last
    await session.flush()
    // On a schedule, so the time each save takes does not add up.
    applied += 1
    await pause(begun + applied * spacingMs - Date.now())
  }
  for (let inning = 1; inning <= innings; inning++)
    for (const top of [true, false]) {
      for (const batter of halfPlays(inning, top, innings))
        for (const action of batter) {
          for (let waiting; (waiting = decide(session.state)) != null;)
            await apply(waiting)
          await apply(action)
        }
      pw.say(`scored ${top ? 'top' : 'bottom'} ${inning}`)
    }
  for (let waiting; (waiting = decide(session.state)) != null;)
    await apply(waiting)
  await session.flush()
  return { first, last }
}

/** The override dashboard, as the app's own dashboard screen talks to it. */
async function dashboard(pw: PlayerWorld, gameId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `${pw.api.replace(/^http/, 'ws')}/scoreboard/${encodeURIComponent(gameId)}/dashboard`,
    { headers: { authorization: `Bearer ${pw.token}` } }
  )
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

/**
 * Records `count` angles of a game for `seconds`, stamped, while `during`
 * runs from their start; answers their videos once each is packed up.
 */
export async function record(
  pw: PlayerWorld,
  gameId: string,
  count: number,
  seconds: number,
  during: (t0: number) => Promise<void> = async () => undefined
): Promise<string[]> {
  const cameras: Camera[] = []
  for (let index = 0; index < count; index++)
    cameras.push(await camera(pw, gameId, `Angle ${index + 1}`))
  // Every game's angles encode at once on the stack, so each is given long enough.
  const casts = await Promise.all(
    cameras.map(
      async one =>
        await pw.media.broadcast({
          url: one.url,
          stamped: true,
          duration: seconds,
          lead: 60 + seconds
        })
    )
  )
  const t0 = Math.max(...casts.map(cast => cast.t0))
  await pause(t0 - Date.now() + 2000)
  await during(t0)
  const ended = await Promise.all(
    casts.map(
      async cast =>
        await untilBroadcast(
          pw.media,
          cast.id,
          `the broadcast into ${gameId} ending`,
          status => status.exit != null,
          { timeoutMs: (seconds + 120) * 1000 }
        ).catch(async (error: unknown) => {
          const status = await pw.media.broadcastStatus(cast.id)
          if (status.exit != null) return status
          throw error
        })
    )
  )
  if (ended.some(status => status.exit !== 0))
    throw new Error(`a broadcast into ${gameId} failed`)
  for (const one of cameras) await endCamera(pw, gameId, one.streamId)
  for (const one of cameras) await ready(pw, gameId, one.videoId)
  pw.say(
    `recorded ${gameId}`,
    cameras.map(one => one.videoId)
  )
  return cameras.map(one => one.videoId)
}

export interface RecordedGames {
  games: Partial<Record<GameName, PlayerGame>>
  /** S's innings, and when its first and last plays were saved. */
  scored: { innings: number; firstPlayAt: number; lastPlayAt: number }
}

/**
 * The fixture's recorded games, as many as a scenario asks for. S is scored
 * through eleven innings over five minutes, or with `quick` (the fixture's
 * own smoke run) three innings over ninety seconds.
 */
export async function recordedGames(
  pw: PlayerWorld,
  wants: Array<Exclude<GameName, 'V'>>,
  options: { quick?: boolean } = {}
): Promise<RecordedGames> {
  const ids = pw.world.ids
  const games: RecordedGames['games'] = {}
  const innings = options.quick === true ? 3 : 11
  const length = options.quick === true ? 90 : 300
  // Every action of S's innings inside its recording, with room either
  // side: about 30 actions an inning.
  const spacing = Math.floor(((length - 40) * 1000) / (innings * 30))
  let scored = { first: 0, last: 0 }
  const jobs: Array<Promise<void>> = []
  if (wants.includes('S'))
    jobs.push(
      (async () => {
        games.S = {
          id: ids.S,
          videos: await record(pw, ids.S, 4, length, async () => {
            scored = await scoreGame(pw, ids.S, innings, spacing)
          })
        }
      })()
    )
  if (wants.includes('L'))
    jobs.push(
      (async () => {
        games.L = {
          id: ids.L,
          videos: await record(pw, ids.L, 2, 60, async t0 => {
            const desk = await dashboard(pw, ids.L)
            const on = {
              ...NO_OVERRIDES,
              overrideCountEnabled: true,
              overrideCount: { balls: 2, strikes: 1, outs: 1 },
              overrideScoreEnabled: true,
              overrideScore: { awayScore: 3, homeScore: 2 }
            }
            await pause(t0 + 10_000 - Date.now())
            desk.send(JSON.stringify({ type: 'overrides', data: on }))
            await pause(t0 + 30_000 - Date.now())
            desk.send(
              JSON.stringify({
                type: 'overrides',
                data: { ...on, overrideScore: { awayScore: 4, homeScore: 2 } }
              })
            )
            desk.close()
          })
        }
      })()
    )
  if (wants.includes('N'))
    jobs.push(
      (async () => {
        games.N = {
          id: ids.N,
          videos: await record(pw, ids.N, 1, 60, async () => {
            await scoreGame(pw, ids.N, 2, 600)
          })
        }
      })()
    )
  if (wants.includes('N0'))
    jobs.push(
      (async () => {
        games.N0 = { id: ids.N0, videos: await record(pw, ids.N0, 1, 60) }
      })()
    )
  if (wants.includes('U'))
    jobs.push(
      (async () => {
        games.U = { id: ids.U, videos: [await uploadWithNoStart(pw)] }
      })()
    )
  await Promise.all(jobs)
  return {
    games,
    scored: { innings, firstPlayAt: scored.first, lastPlayAt: scored.last }
  }
}

/** U's one angle: a two-minute upload, its start time then taken away. */
async function uploadWithNoStart(pw: PlayerWorld): Promise<string> {
  const videoId = makeId('video')
  await pw.media.singleFile({
    videoId,
    gameId: pw.world.ids.U,
    title: 'Upload',
    startAt: new Date().toISOString(),
    seconds: 120
  })
  await stackSql(
    pw.ctx,
    'update videos set start_at = null, start_at_source = null where id = $1',
    [videoId]
  )
  pw.say('made U', videoId)
  return videoId
}

/**
 * How long the stack's broadcaster is given to encode a live angle before it
 * publishes: every angle encodes at once, so the lead grows with them.
 */
export function liveLead(seconds: number, angles: number): number {
  // Measured: four encodes at once take more than twice as long as two.
  return Math.ceil(10 + (seconds / 4) * Math.max(1, angles / 2) ** 2)
}

export interface LiveGame extends PlayerGame {
  cameras: Camera[]
  broadcasts: Array<{ id: string; t0: number }>
  /** Stops every angle still publishing and ends its camera. */
  stop: () => Promise<void>
}

/**
 * V, live: `angles` angles at 1280×720 (so the burned-in clock fits),
 * publishing for `seconds` once encoded, each with the stalls given for it
 * (the broadcaster's `--stall`: its FFmpeg held on the same connection).
 * Answers once every angle has an address to play.
 */
export async function liveGame(
  pw: PlayerWorld,
  options: {
    angles?: number
    seconds?: number
    stalls?: Record<number, BroadcastStretch[]>
  } = {}
): Promise<LiveGame> {
  const V = pw.world.ids.V
  const angles = options.angles ?? 2
  const seconds = options.seconds ?? 600
  const lead = liveLead(seconds, angles)
  const cameras: Camera[] = []
  const broadcasts: LiveGame['broadcasts'] = []
  const stop = async (): Promise<void> => {
    for (const cast of broadcasts)
      await pw.media.broadcastStop(cast.id).catch(() => undefined)
    for (const one of cameras)
      await endCamera(pw, V, one.streamId).catch(() => undefined)
  }
  try {
    for (let index = 0; index < angles; index++) {
      const one = await camera(pw, V, `Angle ${index + 1}`)
      cameras.push(one)
      const cast = await pw.media.broadcast({
        url: one.url,
        stamped: true,
        duration: seconds,
        lead,
        size: '1280x720',
        stalls: options.stalls?.[index] ?? []
      })
      broadcasts.push({ id: cast.id, t0: cast.t0 })
    }
    await connected(
      pw,
      cameras.map(one => one.videoId),
      lead
    )
  } catch (error) {
    await stop()
    throw error
  }
  return {
    id: V,
    videos: cameras.map(one => one.videoId),
    cameras,
    broadcasts,
    stop
  }
}

/**
 * Waits for V's angles to be publishing. Until its publisher connects, a live
 * camera's video is a hidden placeholder, which playback answers as not
 * found, and each publisher first encodes for its lead; until its first
 * segment is written, playback answers with no address.
 */
async function connected(
  pw: PlayerWorld,
  videoIds: string[],
  lead: number
): Promise<void> {
  const end = Date.now() + (lead + 300) * 1000
  for (const videoId of videoIds) {
    for (;;) {
      try {
        if ((await pw.client.playback(videoId)).url != null) break
      } catch (error: unknown) {
        if (!(error instanceof HttpError) || error.code !== 'notFound')
          throw error
      }
      if (Date.now() > end) throw new Error(`${videoId} never began publishing`)
      await pause(2000)
    }
  }
  pw.say('the live angles are publishing', videoIds)
}

/** The grid's videos: it is portalled outside the app's root. */
export const GRID_VIDEOS = `[...document.querySelectorAll('video')].filter(one => one.closest('#root') == null)`

/**
 * Installed before the page's own scripts: every `<video>` counts its own
 * `seeking` events from the first document on, and (unless `fullScreen`) a
 * headless window's full screen stays the window, as the grid is laid out in
 * the window it was given: full screen itself is the phones' to test. With
 * `touchPointer`, the pointer's moves, presses and releases read as a
 * finger's, which is what maestro-d's web driver cannot send.
 */
export function playerBeforeLoad(
  options: { fullScreen?: boolean; touchPointer?: boolean; more?: string } = {}
): string {
  return [
    `(() => {
    const seeks = new WeakMap()
    document.addEventListener('seeking', event => {
      const list = seeks.get(event.target) || []
      list.push(performance.now())
      seeks.set(event.target, list)
    }, true)
    window.__seeks = seeks
  })()`,
    options.fullScreen === true
      ? ''
      : `(() => {
      Element.prototype.requestFullscreen = function () { return Promise.resolve() }
      Element.prototype.webkitRequestFullscreen = function () {}
    })()`,
    options.touchPointer === true
      ? `(() => {
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
        document.addEventListener(type, event => {
          if (window.__touchControls !== false) Object.defineProperty(event, 'pointerType', { value: 'touch' })
        }, true)
    })()`
      : '',
    options.more ?? ''
  ]
    .filter(one => one !== '')
    .join(';\n')
}

export interface PlayerWeb extends EventWeb {
  width: number
  height: number
}

/**
 * This run's browser, `width`×`height`, in Chrome for Testing (it plays the
 * stack's HEVC), signed in as the world's administrator.
 */
export async function playerWeb(
  pw: PlayerWorld,
  width: number,
  height: number,
  options: {
    touch?: boolean
    fullScreen?: boolean
    touchPointer?: boolean
    beforeLoad?: string
    observeNetwork?: boolean
  } = {}
): Promise<PlayerWeb> {
  const web = await openEventWeb(
    pw.ctx,
    pw.admin,
    { width, height },
    {
      h264: true,
      beforeLoad: playerBeforeLoad({
        ...(options.fullScreen == null
          ? {}
          : { fullScreen: options.fullScreen }),
        ...(options.touchPointer == null
          ? {}
          : { touchPointer: options.touchPointer }),
        ...(options.beforeLoad == null ? {} : { more: options.beforeLoad })
      }),
      ...(options.touch === true ? { touch: { width, height } } : {}),
      ...(options.observeNetwork === true ? { observeNetwork: true } : {})
    }
  )
  return Object.assign(web, { width, height })
}

/** Opens a path of the app and waits for its page to settle. */
export async function open(web: EventWeb, path: string): Promise<void> {
  await web.go(path)
  await web.page.waitForFunction(
    `(() => { const root = document.querySelector('#root'); return root != null && root.childElementCount > 0 })()`,
    { timeout: 30_000 }
  )
}

/** The screen, once fonts are in, kept in the run directory as `file`. */
export async function shot(web: EventWeb, file: string): Promise<void> {
  await web.page.evaluate(`(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  await pause(300)
  await web.shot(file)
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The middle of a box, or a point `x`, `y` of the way across it. */
export async function tapIn(
  web: EventWeb,
  box: Box,
  x = 0.5,
  y = 0.5
): Promise<void> {
  await web.m.tapOnPoint({
    x: Math.round(box.x + box.w * x),
    y: Math.round(box.y + box.h * y),
    waitToSettleTimeoutMs: 0
  })
}

/** The box of the first element matching `selector`, inside the app's root or out of it. */
export async function rectOf(
  page: Page,
  selector: string,
  options: { full?: boolean; last?: boolean } = {}
): Promise<Box> {
  const found = (await page.evaluate(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(node => ${options.full == null ? 'true' : `(node.closest('#root') == null) === ${String(options.full)}`})
    const node = ${options.last === true ? 'all.at(-1)' : 'all[0]'}
    if (node == null) return null
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()`)) as Box | null
  if (found == null) throw new Error(`nothing on the page matches ${selector}`)
  return found
}

/** The grid's geometry: the board, the box score and each tile. */
export async function gridState(page: Page): Promise<{
  window: { w: number; h: number }
  board: (Box & { at: number }) | null
  box: (Box & { innings: number[]; at: number }) | null
  tiles: Box[]
}> {
  return (await page.evaluate(`(() => {
    const box = node => { if (node == null) return null; const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
    const outside = node => node.closest('#root') == null
    const board = [...document.querySelectorAll('[data-testid="scoreboard-overlay"]')].find(outside)
    const line = [...document.querySelectorAll('[data-testid="line-score-box"]')].find(outside)
    const grid = ${GRID_VIDEOS}
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      board: board == null ? null : { ...box(board), at: Number(board.getAttribute('data-at')) },
      box: line == null ? null : {
        ...box(line),
        innings: JSON.parse(line.getAttribute('data-innings') ?? '[]'),
        at: Number(line.getAttribute('data-at'))
      },
      tiles: grid.map(v => box(v.parentElement))
    }
  })()`)) as Awaited<ReturnType<typeof gridState>>
}

export interface VideoReading {
  currentTime: number
  seekableEnd: number | null
  paused: boolean
  /** `seeking` events in the last `windowMs`, per second. */
  seekingPerSec: number
  /** The wall ms burned into the picture on screen, or null. */
  markerLow32: number | null
  /** `data-tile-state` on its tile, when it has one. */
  state: string | null
}

/**
 * Each video of the page, grid tiles first: its position, its seekable end,
 * how often it has sought lately, the clock burned into its picture, and
 * its tile's state.
 */
export async function videoReadings(
  page: Page,
  readMarkerSource: string,
  geometry: unknown,
  windowMs = 5000
): Promise<VideoReading[]> {
  return (await page.evaluate(`(() => {
    const readMarker = ${readMarkerSource}
    const seeks = window.__seeks
    const grid = ${GRID_VIDEOS}
    const all = [...grid, ...[...document.querySelectorAll('video')].filter(one => !grid.includes(one))]
    const now = performance.now()
    return all.map(v => ({
      currentTime: v.currentTime,
      seekableEnd: v.seekable.length > 0 ? v.seekable.end(v.seekable.length - 1) : null,
      paused: v.paused,
      seekingPerSec: ((seeks?.get(v) ?? []).filter(at => now - at < ${windowMs}).length * 1000) / ${windowMs},
      markerLow32: readMarker(v, ${JSON.stringify(geometry)}),
      state: v.closest('[data-tile-state]')?.getAttribute('data-tile-state') ?? null
    }))
  })()`)) as VideoReading[]
}

/** The grid of a game's first `count` angles at `t` seconds. */
export const gridPath = (game: PlayerGame, count: number, t?: number): string =>
  `/games/${game.id}?angles=${game.videos.slice(0, count).join(',')}&audio=${game.videos[0]}${t == null ? '' : `&t=${t}`}`

const PLAY_PAUSE =
  '[data-testid="zoneIcon-play_arrow"], [data-testid="zoneIcon-pause"]'

/**
 * Starts or holds the first video (of the grid with `full`, else the page's
 * own) the way a viewer does: a tap on the play or pause control on top of
 * it. A first tap on hidden controls only shows them, so it taps again.
 */
export async function setPlaying(
  web: EventWeb,
  full: boolean,
  playing: boolean
): Promise<void> {
  const videos = full
    ? GRID_VIDEOS
    : `[...document.querySelectorAll('#root video')]`
  const isPaused = async (): Promise<boolean> =>
    (await web.page.evaluate(`${videos}[0].paused`)) as boolean
  for (let tries = 0; tries < 3; tries++) {
    if ((await isPaused()) !== playing) return
    await tapIn(web, await rectOf(web.page, PLAY_PAUSE, { full }))
    await pause(400)
  }
  if ((await isPaused()) === playing)
    throw new Error(
      `the ${full ? 'grid' : 'page'}'s picture never ${playing ? 'played' : 'paused'}`
    )
}

/** The rows of a recorded game's angles, for a spec to name what it plays. */
export function summary(
  games: RecordedGames['games']
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(games).map(([name, game]) => [name, game.videos])
  )
}
