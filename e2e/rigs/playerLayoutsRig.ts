/**
 * What the player-layouts scenarios share (`playerLayouts.e2e.ts`,
 * `liveMultiAngle.e2e.ts`, `playerLayoutsDevices.e2e.ts`): the fixture's
 * games, a browser through maestro-d with Puppeteer attached for its JS
 * coverage, and the reads of the page those scenarios make. It describes no
 * tests.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_BIN=~/git/maestro-d/maestro-d \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *   [TS_PLAYER_FIXTURE=<fixture.json>] [TS_PLAYER_APP=http://127.0.0.1:8091] \
 *   [TS_E2E_ARTIFACT_DIR=<pictures>] [TS_PLAYER_BROWSER_COVERAGE=<json>]
 *
 * The app is the production build served with the API on one origin
 * (`scripts/e2e/playerLayouts/serveDist.mjs`), so the browser's coverage maps
 * back to the sources; the games are `scripts/e2e/playerLayouts/fixture.ts`'s.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import puppeteer, { type Browser, type Page } from 'puppeteer'

import { recordBrowserCoverage } from './browserCoverage'

export const APP = process.env.TS_PLAYER_APP ?? 'http://127.0.0.1:8091'
export const API = `${APP}/api/v1`
export const artifacts = process.env.TS_E2E_ARTIFACT_DIR

export interface FixtureGame {
  id: string
  videos: string[]
}
export interface Fixture {
  api: string
  admin: { email: string; password: string }
  games: Record<'S' | 'L' | 'N' | 'N0' | 'U' | 'V', FixtureGame>
  scored: { innings: number; firstPlayAt: number; lastPlayAt: number }
  live: Array<{ pid: number; streamId: string; videoId: string; url: string }>
}

/** Where the fixture is: `TS_PLAYER_FIXTURE`, or the fixture's default. */
export function fixturePath(): string {
  return (
    process.env.TS_PLAYER_FIXTURE ??
    '/private/tmp/teamstation-playerLayouts/fixture.json'
  )
}

/** The fixture's games and its administrator. */
export function fixture(): Fixture {
  return JSON.parse(readFileSync(fixturePath(), 'utf8')) as Fixture
}

const started = Date.now()
export function print(what: string, detail?: unknown): void {
  const at = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
  console.log(
    `+${at}s  ${what}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`
  )
}
export async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

interface MaestroHandle {
  detach: () => Promise<void>
  [command: string]: unknown
}
interface MaestroDaemon {
  attach: (args: Record<string, unknown>) => Promise<MaestroHandle>
  shutdown: () => Promise<void>
}

let daemon: MaestroDaemon | undefined
/** The maestro-d daemon `MAESTRO_D`, after `maestro-d ps`. */
export async function maestro(): Promise<MaestroDaemon> {
  if (daemon != null) return daemon
  const name = process.env.MAESTRO_D
  if (name == null || name === '') throw new Error('MAESTRO_D is required')
  const bin = process.env.MAESTRO_D_BIN
  if (bin == null) throw new Error('MAESTRO_D_BIN is required')
  console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }))
  const require =
    process.env.MAESTRO_D_CLIENT_ROOT == null
      ? createRequire(__filename)
      : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
  const { MaestroD } = require('maestro-d')
  daemon = (await MaestroD.connect({
    name,
    bin,
    idleTimeout: 0
  })) as MaestroDaemon
  return daemon
}

/**
 * A session for the fixture's administrator. Kept beside the fixture, for
 * its owner alone, and used again while the server still takes it: the
 * sign-in is rate limited, and every tool and scenario of a run needs one.
 */
let token: string | undefined
export async function signedIn(): Promise<string> {
  if (token != null) return token
  const f = fixture()
  const kept = `${fixturePath()}.session`
  try {
    const held = JSON.parse(readFileSync(kept, 'utf8')) as {
      email: string
      token: string
    }
    if (held.email === f.admin.email) {
      const me = await fetch(`${API}/me/account`, {
        headers: { authorization: `Bearer ${held.token}` }
      })
      if (me.ok) {
        token = held.token
        return token
      }
    }
  } catch {
    // None kept yet, or it is no longer good: sign in.
  }
  const { signInTestAccount } = await import('../../src/test/passwordFixtures')
  token = await signInTestAccount(API, f.admin)
  writeFileSync(kept, JSON.stringify({ email: f.admin.email, token }), {
    mode: 0o600
  })
  return token
}

export interface WebSession {
  m: MaestroHandle
  browser: Browser
  page: Page
  width: number
  height: number
  /** The browser's own profile, removed when the session ends. */
  profile: string
}
const sessions: WebSession[] = []

/**
 * A browser window `width`×`height` through maestro-d, with Puppeteer on the
 * same browser for coverage and reads, signed in as the administrator. Every
 * `<video>` counts its own `seeking` events from the first document on.
 */
export async function webSession(
  name: string,
  width: number,
  height: number,
  options: { touch?: boolean; fullScreen?: boolean } = {}
): Promise<WebSession> {
  const d = await maestro()
  const device = `playerLayouts-${name}-${Date.now().toString(36)}`
  const profile = join(
    '/private/tmp/teamstation-playerLayouts/profiles',
    device
  )
  mkdirSync(profile, { recursive: true })
  const m = await d.attach({
    device,
    platform: 'web',
    url: `about:blank#${device}`,
    appId: `about:blank#${device}`,
    artifacts: 'on-failure',
    extra: {
      browser:
        process.env.TS_PLAYER_BROWSER ??
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      windowSize: `${width}x${height}`,
      headed: false,
      userDataDir: profile
    }
  })
  const [port, path] = (
    await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
  )
    .trim()
    .split('\n')
  const browser = await puppeteer.connect({
    browserWSEndpoint: `ws://127.0.0.1:${port}${path}`,
    defaultViewport: null
  })
  const page = (await browser.pages()).find(
    one => one.url() === `about:blank#${device}`
  )
  if (page == null) throw new Error('the maestro-d browser has no page')
  if (options.touch === true)
    await page.emulate({
      viewport: { width, height, hasTouch: true, isMobile: true },
      userAgent: await browser.userAgent()
    })
  await page.coverage.startJSCoverage({
    resetOnNavigation: false,
    includeRawScriptCoverage: true
  })
  // Page code is handed over as source text throughout: the test's own
  // transpiler turns `?.` and `??` into helpers the page does not have.
  await page.evaluateOnNewDocument(`(() => {
    const seeks = new WeakMap()
    document.addEventListener('seeking', event => {
      const list = seeks.get(event.target) || []
      list.push(performance.now())
      seeks.set(event.target, list)
    }, true)
    window.__seeks = seeks
  })()`)
  // A headless browser's full screen is a screen of its own size, not the
  // window's: the grid is laid out in the window it was given instead, and
  // full screen itself is the phones' to test.
  if (options.fullScreen !== true)
    await page.evaluateOnNewDocument(`(() => {
      Element.prototype.requestFullscreen = function () { return Promise.resolve() }
      Element.prototype.webkitRequestFullscreen = function () {}
    })()`)
  await browser.setCookie({
    name: 'ts_session',
    value: encodeURIComponent(await signedIn()),
    domain: new URL(APP).hostname,
    path: '/'
  })
  const session = { m, browser, page, width, height, profile }
  sessions.push(session)
  return session
}

/** Opens a path of the app and waits for its page to settle. */
export async function open(session: WebSession, path: string): Promise<void> {
  await session.page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' })
  await session.page.waitForFunction(
    `(() => { const root = document.querySelector('#root'); return root != null && root.childElementCount > 0 })()`,
    { timeout: 30_000 }
  )
}

/** Saves a screenshot into the artifacts directory, once fonts are in. */
export async function shot(session: WebSession, file: string): Promise<void> {
  if (artifacts == null) return
  mkdirSync(artifacts, { recursive: true })
  await session.page.evaluate(`(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  await pause(300)
  writeFileSync(join(artifacts, file), await session.page.screenshot())
  print(`saved ${file}`)
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** The grid's videos: it is portalled outside the app's root. */
export const GRID_VIDEOS = `[...document.querySelectorAll('video')].filter(one => one.closest('#root') == null)`

/** The grid's geometry: the board, the box score and each tile. */
export async function gridState(session: WebSession): Promise<{
  window: { w: number; h: number }
  board: (Box & { at: number }) | null
  box: (Box & { innings: number[]; at: number }) | null
  tiles: Box[]
}> {
  return (await session.page.evaluate(`(() => {
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
  session: WebSession,
  readMarkerSource: string,
  geometry: unknown,
  windowMs = 5000
): Promise<VideoReading[]> {
  return (await session.page.evaluate(`(() => {
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

/**
 * Writes the browsers' coverage (`TS_PLAYER_BROWSER_COVERAGE`), closes their
 * Puppeteer connections and detaches them from maestro-d.
 */
export async function finish(): Promise<void> {
  const out = process.env.TS_PLAYER_BROWSER_COVERAGE
  if (out != null && sessions.length > 0) {
    // Merged with what an earlier file of the same run wrote.
    let earlier: unknown = null
    try {
      earlier = JSON.parse(readFileSync(out, 'utf8'))
    } catch {
      earlier = null
    }
    await recordBrowserCoverage(
      sessions.map(one => one.page),
      APP,
      out
    )
    if (earlier != null) {
      const require = createRequire(__filename)
      const map = require('istanbul-lib-coverage').createCoverageMap(earlier)
      map.merge(JSON.parse(readFileSync(out, 'utf8')))
      writeFileSync(out, JSON.stringify(map.toJSON()))
    }
    print(`browser coverage in ${out}`)
  }
  for (const one of sessions.splice(0)) {
    await one.browser.disconnect()
    await one.m.detach()
    // A browser profile is a few dozen megabytes of cache, one per session:
    // kept, a few days of runs filled the disk past the floor the server
    // records above, and it refused every live publish.
    // The browser can still be writing to it as it goes; tidying is never a
    // reason for a run to fail.
    try {
      rmSync(one.profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200
      })
    } catch {
      // Left for the next tidy.
    }
  }
}
