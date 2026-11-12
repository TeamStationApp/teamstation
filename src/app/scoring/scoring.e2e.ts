import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import {
  type Mesh,
  type MeshStandardMaterial,
  PerspectiveCamera,
  type Scene,
  Vector3
} from 'three'

import { browserCoverageCollector } from '../../../e2e/rigs/browserCoverage'
import {
  aimLanding,
  aimLandingAt,
  dropOfferedRunner,
  groundPoint,
  installSceneProbe,
  placeFielder,
  placeOffered,
  puppeteerDriver,
  setTrajectory,
  tapOffered
} from '../../../e2e/rigs/fieldPointer'
import { asGameDetail, type RosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { rosterEntryFromBody } from '../../test/mintedRosterEntry'
import { applyFieldCamera } from '../field/cameraModel'
import { BASES, createPlayers } from '../field/fieldModel'
import { initialHitTarget } from '../field/trajectoryGuide'
import { scoringSurface } from '../theme/scoringSurface'
import { ROSTER_CARD_GAP } from './rosterLayout'

const game = asGameDetail({
  nonMemberView: false,
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  canScore: true,
  // The reader keeps score for both teams.
  assignedRoles: { away: ['scorekeeper'], home: ['scorekeeper'] },
  videos: []
})
interface ProbeFiber {
  memoizedProps?: {
    value?: { getState?: () => { scene?: Scene; camera?: PerspectiveCamera } }
  }
  child?: ProbeFiber
  sibling?: ProbeFiber
}
interface SceneProbeWindow {
  qaRoots: Array<{ current: ProbeFiber }>
  qaScene?: Scene
  qaCamera?: PerspectiveCamera
  __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown
}
const base = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8080'
/**
 * With TS_BROWSER_COVERAGE_OUT, every page this file opens counts its JS
 * coverage, written there as istanbul JSON once the file's tests end. The
 * counts map back through `dist/`, so the run serves the production build
 * (`scripts/serveDist.mjs`).
 */
const coverageOut = process.env.TS_BROWSER_COVERAGE_OUT
const coverage =
  coverageOut == null || coverageOut === ''
    ? null
    : browserCoverageCollector(new URL(base).origin)
after(async function () {
  this.timeout(600000)
  if (coverage != null && coverageOut != null)
    await coverage.record(coverageOut)
})
let browser: Browser
/** Leaves every save unanswered, as a server that never replies would. */
let holdSaves = false
/** The away team's name in the mocked game, when a test needs another. */
let awayTeamName: string | undefined
async function open(
  path: string,
  scored: boolean | number = false,
  failed = false,
  failedRoster = false,
  bats: 'switch' | 'left' | 'right' = 'switch',
  probe = false,
  logos?: 'valid' | 'broken',
  uiAnimations = false
): Promise<{ page: Page; unexpected: string[] }> {
  const createdRoster: Record<string, RosterEntry[]> = {}
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await coverage?.track(page)
  page.once('close', () => {
    context.close().catch(() => undefined)
  })
  if (!probe) await installSceneProbe(page)
  else
    await page.evaluateOnNewDocument(() => {
      const host = window as unknown as SceneProbeWindow
      host.qaRoots = []
      host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject(): number {
          return 1
        },
        onCommitFiberRoot(_id: number, root: { current: ProbeFiber }): void {
          if (!host.qaRoots.includes(root)) host.qaRoots.push(root)
        },
        onCommitFiberUnmount(): void {}
      }
    })
  // What this page's server holds for the game: a save is kept and read back,
  // as the API does, so reading the game again returns what was scored.
  const held: {
    plays: Array<{
      id: string
      gameId: string
      gumbo: { about: { atBatIndex: number } }
    }>
    currentPlay: unknown
  } = { plays: [], currentPlay: null }
  const keep = (change: {
    plays?: Array<{ about: { atBatIndex: number } }>
    remove?: number[]
    currentPlay?: unknown
  }): void => {
    const kept = new Map(
      held.plays.map(row => [row.gumbo.about.atBatIndex, row])
    )
    for (const index of change.remove ?? []) kept.delete(index)
    for (const play of change.plays ?? [])
      kept.set(play.about.atBatIndex, {
        id: `evt_${play.about.atBatIndex}`,
        gameId: 'g1',
        gumbo: play
      })
    held.plays = [...kept.values()].sort(
      (a, b) => a.gumbo.about.atBatIndex - b.gumbo.about.atBatIndex
    )
    if (change.currentPlay !== undefined) held.currentPlay = change.currentPlay
  }
  const unexpected: string[] = []
  page.on('pageerror', error => {
    console.error('Browser error:', error)
  })
  page.setDefaultTimeout(8000)
  await page.setViewport({ width: 1200, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/qa-logo-')) {
      const away = url.pathname.includes('away')
      request
        .respond({
          status: logos === 'broken' ? 404 : 200,
          contentType: 'image/svg+xml',
          body:
            logos === 'broken'
              ? 'Missing image'
              : `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${away ? '#294c78' : '#b74242'}"/><path d="M64 8L98 45H78V74H50V45H30Z" fill="white"/><text x="64" y="115" text-anchor="middle" font-size="36" fill="white">${away ? 'A' : 'H'}</text></svg>`
        })
        .catch(() => undefined)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    let body: unknown
    let status = 200
    const shellRead = [
      '/api/v1/events',
      '/api/v1/live',
      '/api/v1/me/home',
      '/api/v1/users',
      '/api/v1/me/umpire-leagues',
      '/api/v1/chat/blocks',
      '/api/v1/chat/conversations',
      '/api/v1/chat/links'
    ].includes(url.pathname)
    if (shellRead || url.pathname === '/api/v1/analytics/events') {
      request
        .respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            url.pathname === '/api/v1/analytics/events' ? { ok: true } : []
          )
        })
        .catch(() => undefined)
      return
    }
    const saving =
      request.method() === 'POST' && url.pathname.endsWith('/events')
    if (saving && holdSaves) return
    // Placeholders are made for this game only, as guests.
    const creatingPlayer =
      request.method() === 'POST' &&
      (url.pathname.endsWith('/roster-players') ||
        url.pathname.endsWith('/guest-players'))
    if (request.method() !== 'GET' && !saving && !creatingPlayer)
      unexpected.push(`${request.method()} ${url.pathname}`)
    if (uiAnimations && url.pathname.endsWith('/playback')) {
      body = {
        videoId: 'fixture-live',
        storage: 'fixture',
        url: null,
        expiresAt: null,
        durationSec: null,
        unavailable: true
      }
    } else if (uiAnimations && url.pathname.endsWith('/highlights')) {
      body = { withheld: null, droppedCount: 0, highlights: [] }
    } else if (url.pathname === '/api/v1/auth/me')
      body = {
        id: userIdOfGumbo(100),
        gumboId: 100,
        displayName: 'Scorer',
        isAdmin: false
      }
    // What the app also asks of every server: who holds which team role, the
    // teams' saved default lineups (none here), and the server's health.
    // The reader keeps score for both teams.
    else if (url.pathname === '/api/v1/me/roles')
      body = {
        teams: { away: ['scorekeeper'], home: ['scorekeeper'] },
        guardianOf: []
      }
    else if (request.method() === 'GET' && url.pathname === '/api/v1/me/home')
      body = { teams: [], seasons: [], leagues: [] }
    else if (
      request.method() === 'GET' &&
      [
        '/api/v1/events',
        '/api/v1/live',
        '/api/v1/users',
        '/api/v1/me/umpire-leagues',
        '/api/v1/chat/blocks',
        '/api/v1/chat/links',
        '/api/v1/chat/conversations'
      ].includes(url.pathname)
    )
      body =
        url.searchParams.get('paged') === '1'
          ? {
              items: [],
              nextCursor: null,
              prevCursor: null,
              anchorId: null,
              counts: null
            }
          : []
    else if (url.pathname === '/api/v1/analytics/events') {
      status = 202
      body = {}
    } else if (url.pathname === '/api/v1/time') body = { now: Date.now() }
    else if (url.pathname === '/api/v1/me/notifications/summary')
      body = { hasPending: false }
    // Confirmed for chat, as the Shell reads on sign-in.
    else if (url.pathname === '/api/v1/me/account/chat-age')
      body = {
        confirmed: true,
        source: 'self',
        confirmedAt: '2027-04-10T12:00:00.000Z'
      }
    // No coach has planned this game: the scorer's inning ends move nobody.
    else if (url.pathname === '/api/v1/games/g1/plans')
      body = { away: null, home: null }
    else if (url.pathname === '/api/v1/games/g1/lineups') {
      status = 404
      body = { error: 'No saved lineup in this events-only fixture' }
    } else if (url.pathname.endsWith('/default-lineup'))
      body = { lineup: null, fromGameId: null, setAt: null }
    else if (url.pathname === '/api/v1/health')
      body = {
        status: 'ok',
        version: 'fixture',
        database: 'ok',
        migrations: 0
      }
    else if (url.pathname === '/api/v1/games/g1/events') {
      const answer = async (): Promise<void> => {
        if (saving) keep(JSON.parse((await request.fetchPostData()) ?? '{}'))
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(held)
        })
      }
      answer().catch(() => undefined)
      return
    } else if (url.pathname === '/api/v1/games/g1') {
      body =
        scored === false
          ? {
              ...game,
              ...(awayTeamName == null ? {} : { awayTeamName }),
              videos: uiAnimations
                ? [
                    {
                      id: 'fixture-live',
                      numCameras: 1,
                      kind: 'game',
                      title: 'Fixture live video',
                      status: 'live',
                      receiving: true,
                      storage: 'fixture',
                      startAt: null,
                      durationSec: null,
                      width: null,
                      height: null,
                      codecs: null
                    }
                  ]
                : [],
              awayLogoUrl: logos == null ? null : `${base}/qa-logo-away.svg`,
              homeLogoUrl: logos == null ? null : `${base}/qa-logo-home.svg`
            }
          : {
              ...game,
              awayScore: typeof scored === 'number' ? scored : 0,
              homeScore: 0
            }
      if (failed) {
        status = 404
        body = { error: 'Not found' }
      }
    } else if (url.pathname === '/api/v1/teams') body = []
    else if (creatingPlayer) {
      const answer = async (): Promise<void> => {
        let nextStatus = 201
        let nextBody: unknown
        try {
          const {
            side: _side,
            teamId: _teamId,
            ...input
          } = JSON.parse((await request.fetchPostData()) ?? '{}') as Record<
            string,
            unknown
          >
          const entry = rosterEntryFromBody(input)
          nextBody = entry
          ;(createdRoster[url.pathname.split('/')[4]] ??= []).push(entry)
        } catch (error) {
          nextStatus = 400
          nextBody = {
            error: error instanceof Error ? error.message : 'Bad request'
          }
        }
        await request.respond({
          status: nextStatus,
          contentType: 'application/json',
          body: JSON.stringify(nextBody)
        })
      }
      answer().catch(() => undefined)
      return
    } else if (url.pathname.endsWith('/roster')) {
      if (failedRoster) status = 503
      body = url.pathname.includes('/away/')
        ? [
            {
              userId: userIdOfGumbo(101),
              gumboId: 101,
              shortName: 'Jordan K.',
              jersey: '00',
              positions: ['P'],
              isPlayer: true,
              role: 'member',
              section: 'player',
              staffRoles: [],
              inheritedFrom: null,
              bats,
              throws: 'right'
            }
          ].concat(
            Array.from({ length: 8 }, (_, i) => ({
              userId: userIdOfGumbo(102 + i),
              gumboId: 102 + i,
              shortName: `Player ${i + 2}`,
              jersey: String(i + 2),
              positions: [createPlayers()[i + 1].id],
              isPlayer: true,
              role: 'member',
              section: 'player',
              staffRoles: [],
              inheritedFrom: null,
              bats: 'right' as const,
              throws: 'right'
            }))
          )
        : Array.from({ length: 9 }, (_, i) => ({
            userId: userIdOfGumbo(201 + i),
            gumboId: 201 + i,
            shortName: `Player ${i + 1}`,
            jersey: String(i + 1),
            positions: [createPlayers()[i].id],
            isPlayer: true,
            role: 'member',
            section: 'player',
            staffRoles: [],
            inheritedFrom: null,
            bats: 'right',
            throws: 'right'
          }))
      body = [
        ...(body as RosterEntry[]),
        ...(createdRoster[url.pathname.split('/')[4]] ?? [])
      ]
    } else if (url.pathname.endsWith('/live-streams'))
      body = { gameId: 'g1', mine: [], others: [], canAdd: 0, maxCameras: 3 }
    else if (url.pathname === '/api/v1/me/home')
      body = { teams: [], seasons: [], leagues: [] }
    else if (/^\/api\/v1\/events\/[^/]+\/info$/.test(url.pathname))
      // The game page's Info: the fixture game, with nobody to answer for.
      body = {
        id: url.pathname.split('/')[4],
        eventKind: 'game',
        title: null,
        teamId: 'home',
        teamName: 'Hawks',
        startAt: null,
        endAt: null,
        timezone: 'America/Los_Angeles',
        venue: null,
        address: null,
        latitude: null,
        longitude: null,
        status: 'scheduled',
        canManage: false,
        attendees: [],
        replyUserIds: []
      }
    else if (url.pathname === '/api/v1/me/umpire-leagues')
      body = { leagues: [] }
    else if (
      url.pathname === '/api/v1/events' ||
      url.pathname === '/api/v1/live' ||
      url.pathname === '/api/v1/users' ||
      url.pathname === '/api/v1/chat/blocks' ||
      url.pathname === '/api/v1/chat/links' ||
      url.pathname === '/api/v1/chat/conversations'
    )
      body = []
    else if (url.pathname === '/api/v1/analytics/events') {
      request.respond({ status: 204, body: '' }).catch(() => undefined)
      return
    } else {
      unexpected.push(url.pathname)
      status = 500
      body = {}
    }
    request
      .respond({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body)
      })
      .catch(() => undefined)
  })
  await page.goto(`${base}${path}`)
  return { page, unexpected }
}
/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers. */
async function captureScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as SceneProbeWindow
    const scan = (fiber?: ProbeFiber): void => {
      if (fiber == null) return
      const value =
        fiber.memoizedProps == null ? undefined : fiber.memoizedProps.value

      const state =
        value == null || value.getState == null ? undefined : value.getState()
      if (state != null && state.scene != null) {
        host.qaScene = state.scene
        host.qaCamera = state.camera
      }
      scan(fiber.child)
      scan(fiber.sibling)
    }
    for (const root of host.qaRoots) scan(root.current)
  })
}
async function readGuide(
  page: Page
): Promise<{ bearing: number; x: number; z: number }> {
  await captureScene(page)
  return await page.evaluate(() => {
    const arc = (
      window as unknown as SceneProbeWindow
    ).qaScene!.getObjectByName('ball-arc')!
    const target = arc.getObjectByName('destination-marker')!.position
    return { bearing: Number(arc.userData.bearing), x: target.x, z: target.z }
  })
}
/* eslint-enable @typescript-eslint/prefer-optional-chain */
/** The Score pill, then the Score screen's Full game scoring. */
async function startScoring(page: Page): Promise<void> {
  await click(page, 'Score')
  await page.waitForFunction(() => location.pathname.endsWith('/score-game'))
  await click(page, 'Full game scoring')
  await page.waitForFunction(() => location.pathname.endsWith('/score'))
}
async function openPlaceholderSheet(page: Page): Promise<void> {
  // Players are made on the roster tab; the other tabs stay drawn, hidden.
  const shown = async (label: string): Promise<boolean> =>
    (await (await page.$(`[aria-label="${label}"]`))?.isVisible()) === true
  if (!(await shown('First Name')) && !(await shown('Create Player')))
    await click(page, 'Roster')
  if ((await page.$('[aria-label="First Name"]')) == null)
    await click(page, 'Create Player')
  await click(page, 'Create Placeholder Player')
}
async function addPlaceholders(page: Page, count: 1 | 16): Promise<void> {
  await openPlaceholderSheet(page)
  // Let the slide-up Modal install its focus trap before keyboard input.
  await new Promise(resolve => setTimeout(resolve, 400))
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Number of placeholder players"]')!
        .closest('[role="dialog"]') != null
  )
  await page.focus('[aria-label="Number of placeholder players"]')
  await page.keyboard.press(count === 16 ? 'End' : 'Home')
  await page.waitForSelector(
    `[aria-label="Player count ${count}"][aria-selected="true"]`
  )
  await click(page, 'Create')
  await page.waitForSelector('[aria-label="Number of placeholder players"]', {
    hidden: true
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  // Making placeholders closes the player sheet; Escape is only for one
  // still open, since on the roster it would close the editor.
  if ((await page.$('[aria-label="First Name"]')) != null)
    await page.keyboard.press('Escape')
  await page.waitForSelector('[aria-label="First Name"]', { hidden: true })
}
async function click(page: Page, label: string): Promise<void> {
  const selector = `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`
  const opening =
    label === 'Create Player' &&
    (await page.$('[aria-label="First Name"]')) == null
  await page.waitForFunction(
    selector =>
      Array.from(document.querySelectorAll(selector)).some(node =>
        node.checkVisibility()
      ),
    {},
    selector
  )
  for (const match of (await page.$$(selector)).reverse()) {
    if (!(await match.isVisible())) continue
    await match.asLocator().click()
    // Let the sheet transition finish before targeting its next control.
    await new Promise(resolve => setTimeout(resolve, 350))
    break
  }
  if (opening) await page.waitForSelector('[aria-label="First Name"]')
}

async function chooseHit(page: Page, outcome: string): Promise<void> {
  await click(page, 'Swing in Play')
  if (outcome === 'Batter Interference') await click(page, 'Batter Out')
  await click(page, outcome)
  await page.waitForSelector('canvas[data-field-ready="true"]')
  await page.waitForSelector(
    outcome === 'Home Run'
      ? '[aria-label^="Drag where the ball was hit"]'
      : '[aria-label^="Tap or drag a player to where the ball was fielded"]'
  )
  const field = puppeteerDriver(page)
  // A home run lands in the stands beyond center; anything else is taken by
  // the first player the field offers, just where he stands.
  if (outcome === 'Home Run') await aimLanding(field, 0.5, 0.18)
  else await placeOffered(field)
  await setTrajectory(field)
}
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Ball"]')!
        .getAttribute('aria-disabled') !== 'true',
    { timeout: 30000 }
  )
}
/** Where a base's point at height `y` sits on the canvas, in the home view. */
async function projectBase(
  page: Page,
  base: number,
  y = 0
): Promise<[number, number]> {
  const rect = await page.$eval('canvas', canvas => {
    const r = canvas.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    width: rect.width,
    height: rect.height,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  const point = new Vector3(BASES[base].x, y, BASES[base].z).project(camera)
  return [
    rect.x + ((point.x + 1) * rect.width) / 2,
    rect.y + ((1 - point.y) * rect.height) / 2
  ]
}
/** A theme colour, `#rrggbb` or `#rrggbbaa`, as computed style reads it. */
function cssColor(hex: string): string {
  const [r, g, b, a] = [1, 3, 5, 7].map(i => parseInt(hex.slice(i, i + 2), 16))
  return Number.isNaN(a)
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`
}
/** Taps a sheet's control once the sheet has stopped sliding. */
async function tapSettled(page: Page, label: string): Promise<void> {
  await page
    .locator(`[aria-label="${label}"]:not([aria-disabled="true"])`)
    .click()
}
async function overrideBases(
  page: Page,
  bases: Array<['First base' | 'Second base' | 'Third base', string]>
): Promise<void> {
  if (bases.length === 0) return
  await tapSettled(page, 'Open scoring menu')
  await tapSettled(page, 'Overrides')
  for (const [base, player] of bases) {
    await tapSettled(page, base)
    const label = `Choose ${base} ${player}`
    // Empty and unnumbered players have no suffix; numbered players end in #N.
    await page
      .locator(
        `[aria-label="${label}"]:not([aria-disabled="true"]), [aria-label^="${label} #"]:not([aria-disabled="true"])`
      )
      .click()
  }
  await tapSettled(page, 'Apply Override')
}

async function dragRunner(
  page: Page,
  fromBase: number,
  toBase: number
): Promise<void> {
  const from = await projectBase(page, fromBase, 6)
  const to = await projectBase(page, toBase, 0)
  await page.touchscreen.touchStart(...from)
  await new Promise(resolve => setTimeout(resolve, 400))
  await page.touchscreen.touchMove(to[0], to[1])
}

async function runnerNearBase(page: Page, base: number): Promise<boolean> {
  await captureScene(page)
  const { x, z } = BASES[base]
  return await page.evaluate(
    (tx, tz) => {
      const scene = (window as unknown as SceneProbeWindow).qaScene
      if (scene == null) return false
      let best = Infinity
      scene.traverse(obj => {
        if (!obj.name.startsWith('player-offense-')) return
        const dx = obj.position.x - tx
        const dz = obj.position.z - tz
        best = Math.min(best, dx * dx + dz * dz)
      })
      return best < 36
    },
    x,
    z
  )
}

async function waitRunnerNearBase(page: Page, base: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await runnerNearBase(page, base)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  expect(await runnerNearBase(page, base), `runner near ${base}`).equals(true)
}

describe('scoring browser', function () {
  this.timeout(60000)
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })
  it('opens full-width undo history above its button and preserves a short undo', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 402, height: 874 })
      for (const pitch of [
        'Ball',
        'Called Strike',
        'Foul Ball',
        'Foul Ball',
        'Foul Ball',
        'Foul Ball'
      ]) {
        await click(page, pitch)
        await waitReady(page)
      }
      const undo = await page.$('[aria-label^="Undo "]')
      expect(undo).not.equals(null)
      const before = await undo!.evaluate(node =>
        node.getAttribute('aria-label')
      )
      await undo!.hover()
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 1100))
      await page.mouse.up()
      await page.waitForSelector('[data-testid="scoring-tag-history"]')
      await page.waitForFunction(() => {
        const panel = document
          .querySelector('[data-testid="scoring-tag-history"]')!
          .getBoundingClientRect()
        const button = document
          .querySelector('[aria-label^="Undo "]')!
          .getBoundingClientRect()
        return panel.bottom <= button.top - 3
      })
      const panel = await page.$eval(
        '[data-testid="scoring-tag-history"]',
        node => node.getBoundingClientRect().toJSON()
      )
      expect(panel.left).closeTo(12, 1)
      expect(panel.right).closeTo(390, 1)
      expect(await page.$$('[data-testid^="tag-history-"]')).length(6)
      await page.waitForSelector(
        '[aria-label*="1 balls 2 strikes 0 outs · Pitches 6"]'
      )
      // Click the visible backdrop margin, outside the full-width rows.
      await page.mouse.click(6, 100)
      await page.waitForSelector('[data-testid="scoring-tag-history"]', {
        hidden: true
      })
      expect(
        await undo!.evaluate(node => node.getAttribute('aria-label'))
      ).equals(before)
      await click(page, before!)
      await page.waitForSelector(
        '[aria-label*="1 balls 2 strikes 0 outs · Pitches 5"]'
      )
      await waitReady(page)
      expect(
        await page.$eval('[aria-label^="Undo "]', node =>
          node.getAttribute('aria-label')
        )
      ).equals(before)
      // One short press removes one pitch, even when the previous label repeats.
      await undo!.hover()
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 1100))
      await page.mouse.up()
      await page.waitForSelector('[data-testid="scoring-tag-history"]')
      // The history opens without taking back another pitch.
      await page.waitForSelector(
        '[aria-label*="1 balls 2 strikes 0 outs · Pitches 5"]'
      )
      await page.setViewport({ width: 844, height: 390 })
      await page.waitForSelector('[data-testid="scoring-tag-history"]', {
        hidden: true
      })
      // A larger heading shrinks the scroll viewport after content measurement.
      await page.addStyleTag({
        content:
          '[data-testid="scoring-tag-history"]>div:first-child{font-size:40px!important}'
      })
      const holdUndo = async (): Promise<void> => {
        await undo!.hover()
        await page.mouse.down()
        await new Promise(resolve => setTimeout(resolve, 1100))
        await page.mouse.up()
        await page.waitForSelector('[data-testid="scoring-tag-history"]')
      }
      const newestIsVisible = async (): Promise<void> => {
        await page.waitForFunction(() => {
          const scroll = document.querySelector(
            '[data-testid="scoring-history-older-scroll"]'
          )!
          const rows = document.querySelectorAll(
            '[data-testid^="tag-history-"]'
          )
          const newest = rows[rows.length - 1].getBoundingClientRect()
          const visible = scroll.getBoundingClientRect()
          return (
            newest.top >= visible.top &&
            newest.bottom <= visible.bottom + 1 &&
            Math.abs(
              scroll.scrollTop + scroll.clientHeight - scroll.scrollHeight
            ) < 1
          )
        })
      }
      // Scoring fills the screen on web, including the browser's unsafe strips.
      const cdp = await page.createCDPSession()
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { left: 44, right: 44, top: 30, bottom: 21 }
      })
      await holdUndo()
      await newestIsVisible()
      const safePanel = await page.$eval(
        '[data-testid="scoring-tag-history"]',
        node => node.getBoundingClientRect().toJSON()
      )
      expect(safePanel.left).closeTo(44, 1)
      expect(safePanel.right).closeTo(800, 1)
      expect(safePanel.top).at.least(29)
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { left: 0, right: 0, top: 0, bottom: 0 }
      })
      await page.keyboard.press('Escape')
      await page.waitForSelector('[data-testid="scoring-tag-history"]', {
        hidden: true
      })
      // Some modal hosts start at an offset while retaining the window width.
      await page.addStyleTag({
        content:
          '[role="dialog"]{left:62px!important;width:844px!important;right:auto!important}'
      })
      await holdUndo()
      await page.waitForFunction(() => {
        const panel = document
          .querySelector('[data-testid="scoring-tag-history"]')!
          .getBoundingClientRect()
        return panel.left >= 12 && panel.right <= innerWidth - 12
      })
      await newestIsVisible()
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  for (const loaded of [false, true])
    it(`advances and credits an Error with ${loaded ? 'loaded' : 'empty'} bases`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        if (loaded) {
          await overrideBases(page, [
            ['First base', 'Player 6'],
            ['Second base', 'Player 7'],
            ['Third base', 'Player 8']
          ])
        }
        await chooseHit(page, 'Error')
        await page.waitForSelector(
          '[aria-label^="Tap or drag another defender"]',
          { timeout: 30000 }
        )
        expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
        if (loaded) {
          await placeOffered(puppeteerDriver(page), 1)
          await page.waitForSelector(
            '[aria-label^="Tap or drag another defender"]',
            { timeout: 10000 }
          )
        }
        await click(page, 'Finish defensive play')
        await page.waitForSelector('[aria-label^="Error by "]')
        const credits = await page.$$eval('[aria-label^="Error by "]', nodes =>
          nodes.map(n => n.getAttribute('aria-label')!)
        )
        expect(credits).has.length(loaded ? 2 : 1)
        await click(page, 'Cancel')
        await click(page, 'Finish defensive play')
        await click(page, credits.at(-1)!)
        if (loaded) {
          await page.waitForSelector(
            '[aria-label="Home plate decision for Player 8"]'
          )
          await click(page, 'Safe')
        }
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await click(page, 'Finish at-bat')
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
        await page.waitForSelector(
          `[aria-label*="Owls ${loaded ? 1 : 0} · Hawks 0"]`
        )
      } finally {
        await page.close()
      }
    })
  it('hides empty-base fielder choice and clamps a stands home-run arc to Line Drive', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Swing in Play')
      expect(await page.$('[aria-label="Fielder\'s Choice"]')).equals(null)
      await click(page, 'Home Run')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      // Deep into the stands, then dragged as low as it goes: a ball over
      // the fence is a line drive at the least.
      const field = puppeteerDriver(page)
      await aimLanding(field, 0.5, 0.08)
      await setTrajectory(field, -45)
      await page.waitForSelector('[aria-label*="10° Line Drive"]')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await chooseHit(page, 'Single')
      await click(page, 'Finish at-bat')
      await click(page, 'Swing in Play')
      await page.waitForSelector('[aria-label="Fielder\'s Choice"]')
    } finally {
      await page.close()
    }
  })
  for (const defensive of [false, true])
    it(`keeps ${defensive ? 'defensive' : 'correction'} toast Done above controls in short landscape`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        if (defensive) {
          await click(page, 'Swing in Play')
          await click(page, 'Batter Out')
          await click(page, 'Ground Out')
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await placeOffered(puppeteerDriver(page))
          await setTrajectory(puppeteerDriver(page))
          await page.waitForSelector(
            '[aria-label^="Tap or drag the next defender"]'
          )
        } else {
          await chooseHit(page, 'Single')
          await page.waitForSelector('[aria-label="Time to edit play"]', {
            timeout: 30000
          })
        }
        await page.setViewport({ width: 874, height: 292 })
        const label = defensive ? 'Finish defensive play' : 'Finish at-bat'
        await page.waitForFunction(
          label => {
            const done = document.querySelector(`[aria-label="${label}"]`)
            const row = done == null ? null : done.parentElement
            const toast = row == null ? null : row.parentElement
            return toast != null && toast.getBoundingClientRect().width > 400
          },
          {},
          label
        )
        const measured = await page.evaluate(label => {
          const done = document
            .querySelector(`[aria-label="${label}"]`)!
            .getBoundingClientRect()
          const undo = document
            .querySelector('[aria-label^="Undo "]')!
            .getBoundingClientRect()
          const hit = document
            .elementFromPoint(
              done.x + done.width / 2,
              done.y + done.height / 2
            )!
            .closest('[aria-label]')!
          return {
            bottom: done.bottom,
            footerTop: undo.top,
            hit: hit.getAttribute('aria-label')
          }
        }, label)
        expect(measured.bottom).lessThan(measured.footerTop)
        expect(measured.hit).equals(label)
        const lower = await page.$eval(`[aria-label="Bottom ${label}"]`, n => {
          const r = n.getBoundingClientRect()
          const undo = document
            .querySelector('[aria-label^="Undo "]')!
            .getBoundingClientRect()
          return {
            bottom: r.bottom,
            top: undo.top,
            center: r.x + r.width / 2,
            undoCenter: undo.x + undo.width / 2
          }
        })
        expect(lower.bottom).closeTo(lower.top, 0.1)
        expect(lower.center).closeTo(lower.undoCenter, 0.1)
        await click(page, `Bottom ${label}`)
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        await page.waitForSelector(`[aria-label*="${defensive ? 1 : 0} outs"]`)
      } finally {
        await page.close()
      }
    })
  it('finishes coordinated hit flight before exposing correction or home decisions', async function () {
    for (const outcome of ['Single', 'Double', 'Triple', 'Home Run']) {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        await chooseHit(page, outcome)
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        if (outcome !== 'Home Run') {
          await page.waitForSelector('[aria-label="Time to edit play"]', {
            timeout: 30000
          })
          await click(page, 'Finish at-bat')
        }
        await waitReady(page)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    }
  })
  for (const assisted of [false, true])
    it(`completes a batter throw out with ${assisted ? 'a secondary throw' : 'an unassisted touch'} before retirement`, async function () {
      const { page, unexpected } = await open('/games/g1/score')
      let recorder: Awaited<ReturnType<Page['record']>> | undefined
      try {
        await click(page, 'Swing in Play')
        await click(page, 'Batter Out')
        await click(page, 'Ground Out')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await placeOffered(puppeteerDriver(page))
        if (process.env.TS_SCORING_ARTIFACT_DIR != null && assisted)
          recorder = await page.record({
            path: `${process.env.TS_SCORING_ARTIFACT_DIR}/20260923-scoring-hit-throw.mp4`,
            audio: true
          })
        await setTrajectory(puppeteerDriver(page))
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        if (assisted) await placeOffered(puppeteerDriver(page), 1)
        await click(page, 'Finish defensive play')
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        await page.waitForSelector('[aria-label*="1 outs"]')
        expect(unexpected).deep.equals([])
      } finally {
        await recorder?.stop()
        await page.close()
      }
    })
  for (const bats of ['right', 'left'] as const)
    for (const width of [390, 1200])
      it(`presents a camera-facing ${bats} foul at width ${width} and rewinds it`, async function () {
        const { page } = await open(
          '/games/g1/score',
          false,
          false,
          false,
          bats
        )
        try {
          await page.setViewport({ width, height: width === 390 ? 844 : 900 })
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await click(page, 'Foul Ball')
          if (process.env.TS_SCORING_ARTIFACT_DIR != null) {
            await new Promise(resolve => setTimeout(resolve, 900))
            for (let frame = 0; frame < 4; frame++) {
              await page.screenshot({
                path: `${process.env.TS_SCORING_ARTIFACT_DIR}/foul-${bats}-${width}-${frame}.png`
              })
              await new Promise(resolve => setTimeout(resolve, 70))
            }
          }
          await waitReady(page)
          await page.waitForSelector('[aria-label*="0 balls 1 strikes 0 outs"]')
          await page.locator('[aria-label^="Undo "]').click()
          await page.waitForSelector('[aria-label*="0 balls 0 strikes 0 outs"]')
        } finally {
          await page.close()
        }
      })
  it('routes batter interference through two taps and a dragged recipient before one out', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await chooseHit(page, 'Batter Interference')
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      const rect = await page.$eval('canvas', node => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        ...rect,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const project = (x: number, z: number): [number, number] => {
        const p = new Vector3(x, 6, z).project(camera)
        return [
          rect.x + ((p.x + 1) * rect.width) / 2,
          rect.y + ((1 - p.y) * rect.height) / 2
        ]
      }
      const spot = (id: string): { x: number; z: number } => {
        const player = createPlayers().find(item => item.id === id)
        if (player == null) throw new Error(id)
        return player.position
      }
      for (const [id, name] of [
        ['1B', 'Player 3'],
        ['2B', 'Player 4']
      ] as const) {
        const { x, z } = spot(id)
        await page.mouse.click(...project(x, z))
        await page.waitForSelector(`[aria-label="Undo Throw to ${name}"]`)
        await page.waitForSelector(
          '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
        )
        expect(await page.$('[aria-label*="Batter Jordan K"]')).not.equals(null)
      }
      const shortstop = spot('SS')
      await page.mouse.move(...project(shortstop.x, shortstop.z))
      await page.mouse.down()
      await page.mouse.move(...project(-10, -35), { steps: 10 })
      await page.mouse.up()
      await page.waitForSelector('[aria-label="Undo Throw to Player 5"]')
      await page.waitForSelector(
        '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
      )
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="1 outs"]')
      await page.locator('[aria-label^="Undo "]').click()
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      expect(await page.$('[aria-label*="Batter Player 2"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('chains three recipients with no intermediate out and finishes from the toast', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await dropOfferedRunner(page, 'Out', true)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      expect(await page.$('[aria-label^="Tap and Drag Thrower"]')).equals(null)
      for (let n = 0; n < 3; n++) {
        await placeOffered(puppeteerDriver(page), n % 2 === 0 ? 1 : 0)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]',
          { timeout: 30000 }
        )
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      }
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label*="1 outs"]', { timeout: 30000 })
      expect(await page.$('[aria-label="Done"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('recovers a lost WebGL context during a pitch without replaying the scoring action', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await click(page, 'Ball')
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas')!
        const gl = canvas.getContext('webgl2')!
        gl.getExtension('WEBGL_lose_context')!.loseContext()
      })
      await page.waitForSelector('canvas', { hidden: true })
      await page.locator('::-p-text(Try again)').click()
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="1 balls 0 strikes 0 outs · Pitches 1"]'
      )
      await click(page, 'Ball')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="2 balls 0 strikes 0 outs · Pitches 2"]'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('pauses a pitch while a menu or hidden document blocks the field', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      // A pitch's picture lasts 280 ms: the menu opens in the same task as
      // the tap, before it can end.
      await page.evaluate(() => {
        for (const label of ['Ball', 'Open scoring menu'])
          document
            .querySelector<HTMLElement>(`[aria-label="${label}"]`)!
            .click()
      })
      await new Promise(resolve => setTimeout(resolve, 1400))
      await page.keyboard.press('Escape')
      expect(
        await page.$eval('[aria-label="Ball"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await waitReady(page)
      // Hidden first, then the foul tapped: its 540 ms picture waits.
      const background = await page.browserContext().newPage()
      await background.bringToFront()
      await page.waitForFunction(() => document.hidden)
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[aria-label="Foul Ball"]')!.click()
      })
      await new Promise(resolve => setTimeout(resolve, 1700))
      expect(await page.evaluate(() => document.hidden)).equals(true)
      expect(
        await page.$eval('[aria-label="Ball"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await background.close()
      await page.bringToFront()
      await waitReady(page)
      await page.waitForSelector('[aria-label*="Pitches 2"]')
    } finally {
      await page.close()
    }
  })
  it('animates each pitch with real audio sources, gates rapid taps, mutes and cancels on Undo', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await page.evaluate(() => {
        const target = window as unknown as {
          pitchCues: Array<{ time: number; peak: number }>
        }
        target.pitchCues = []
        // Keep the original receiver when wrapping the browser audio factory.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const original = AudioContext.prototype.createBufferSource
        AudioContext.prototype.createBufferSource = function () {
          const source = original.call(this)
          const start = source.start.bind(source)
          source.start = (...args) => {
            const data =
              source.buffer == null ? [] : source.buffer.getChannelData(0)
            target.pitchCues.push({
              time: performance.now(),
              peak: Math.max(...Array.from(data).map(Math.abs))
            })
            start(...args)
          }
          return source
        }
      })
      let pitch = 0
      for (const label of [
        'Ball',
        'Called Strike',
        'Swing and Miss',
        'Foul Ball'
      ]) {
        await waitReady(page)
        // The pitch and two rapid taps in one task: a pitch's picture lasts
        // 280 ms, shorter than a puppeteer click's round trip.
        await page.evaluate(label => {
          const button = document.querySelector<HTMLElement>(
            `[aria-label="${label}"]`
          )!
          button.click()
          button.click()
          button.click()
        }, label)
        expect(
          await page.$eval('[aria-label="Ball"]', node =>
            node.getAttribute('aria-disabled')
          )
        ).equals('true')
        await waitReady(page)
        pitch++
        await page.waitForSelector(`[aria-label*="Pitches ${pitch}"]`)
      }
      const cues = await page.evaluate(
        () =>
          (
            window as unknown as {
              pitchCues: Array<{ time: number; peak: number }>
            }
          ).pitchCues
      )
      expect(cues).has.length(9)
      expect(cues.every(cue => cue.peak > 0.1)).equals(true)
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      await click(page, 'Toggle scoring sound')
      await click(page, 'Done')
      await click(page, 'Ball')
      await waitReady(page)
      expect(
        await page.evaluate(
          () => (window as unknown as { pitchCues: unknown[] }).pitchCues.length
        )
      ).equals(9)
      await click(page, 'Foul Ball')
      await click(page, 'Undo Foul Ball')
      await waitReady(page)
      await page.waitForSelector('[aria-label*="Pitches 5"]')
    } finally {
      await page.close()
    }
  })
  it('uses themed chrome and completes the toast with Done', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      expect(await page.$('[aria-label="Zoom in"]')).equals(null)
      await click(page, 'Open scoring menu')
      await click(page, 'Dismiss scoring menu')
      expect(await page.$('[aria-label="Settings"]')).equals(null)
      await click(page, 'Swing in Play')
      await click(page, 'Dismiss outcomes')
      expect(await page.$('[data-outcome]')).equals(null)
      const styles = await page.evaluate(() => {
        const play = document.querySelector('[aria-label="Swing in Play"]')!
        return {
          select: getComputedStyle(play.parentElement!).userSelect,
          dragUp: String(play.getAttribute('title')).includes('drag up')
        }
      })
      expect(styles).deep.equals({ select: 'none', dragUp: true })
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      expect(await page.evaluate(() => document.body.textContent)).includes(
        'Drag any other runners to advance them or have them called out'
      )
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]')
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      // The hit, at whatever angle the screen started it at.
      const hitUndo = await page.$eval('[aria-label^="Undo "]', n =>
        String(n.getAttribute('aria-label'))
      )
      expect(hitUndo).matches(/^Undo -?\d+° /)
      await click(page, hitUndo)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('opens an unscored game full screen and protects unsaved plays from browser Back', async function () {
    const { page, unexpected } = await open('/games/g1')
    try {
      await startScoring(page)
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      await page.waitForSelector('canvas')
      expect(await page.$('[aria-label="Schedule"]')).equals(null)
      const saved = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/games/g1/events')
      )
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label="Undo Ball"]')
      // Saved: Back leaves without asking.
      await saved
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save status"]') == null
      )
      // Back returns to the Score screen.
      await page.evaluate(() => {
        history.back()
      })
      await page.waitForSelector('[aria-label="Full game scoring"]')
      expect(new URL(page.url()).pathname).equals('/games/g1/score-game')
      expect(await page.$('[aria-label="Discard and Exit"]')).equals(null)
      holdSaves = true
      await click(page, 'Full game scoring')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      await page.waitForSelector('canvas')
      // Held back by the server: the ball has not reached it.
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label="Undo Ball"]')
      const length = await page.evaluate(() => history.length)
      await page.evaluate(() => {
        history.back()
      })
      await page.waitForFunction(() =>
        document.body.innerText.includes(
          '1 change has not reached the server yet and will be lost.'
        )
      )
      await click(page, 'Cancel')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      expect(await page.evaluate(() => history.length)).equals(length)
      await page.evaluate(() => {
        history.back()
      })
      await click(page, 'Discard and Exit')
      await page.waitForSelector('[aria-label="Full game scoring"]')
      expect(new URL(page.url()).pathname).equals('/games/g1/score-game')
      expect(unexpected).deep.equals([])
    } finally {
      holdSaves = false
      await page.close()
    }
  })
  it('excludes recorded zero scores and resolves direct scoring links', async function () {
    const scored = await open('/games/g1', true)
    try {
      await scored.page.waitForSelector('[aria-label="Box score"]')
      expect(await scored.page.$('[aria-label="Score"]')).equals(null)
      expect(scored.unexpected).deep.equals([])
    } finally {
      await scored.page.close()
    }
    const direct = await open('/games/g1/score')
    try {
      await click(direct.page, 'Open scoring menu')
      await click(direct.page, 'Exit Current Game')
      await direct.page.waitForSelector('[aria-label="Score"]')
      expect(new URL(direct.page.url()).pathname).equals('/games/g1')
      expect(direct.unexpected).deep.equals([])
    } finally {
      await direct.page.close()
    }
  })
  for (const bats of ['right', 'left'] as const)
    it(`drags a ${bats} batter across the plate before a pitch without switch help`, async function () {
      const { page } = await open('/games/g1/score', false, false, false, bats)
      try {
        await page.waitForSelector('canvas[data-field-ready="true"]')
        expect(await page.$('[aria-label="OK"]')).equals(null)
        const box = await page.$eval('canvas', n => {
          const r = n.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        const camera = new PerspectiveCamera()
        applyFieldCamera(camera, {
          width: box.width,
          height: box.height,
          view: 'home',
          zoom: 1.25,
          tilt: (-11 * Math.PI) / 180,
          heightOffset: 33,
          bottomExtension: 112
        })
        const project = (x: number): [number, number] => {
          const p = new Vector3(x, 6, 0).project(camera)
          return [
            box.x + ((p.x + 1) * box.width) / 2,
            box.y + ((1 - p.y) * box.height) / 2
          ]
        }
        const start = project(bats === 'right' ? -4 : 4)
        const end = project(bats === 'right' ? 7 : -7)
        await page.mouse.move(...start)
        await page.mouse.down()
        await page.mouse.move(...end, { steps: 12 })
        await page.mouse.up()
        const side = bats === 'right' ? 'left' : 'right'
        await page.waitForSelector(
          `[aria-label*="Batter Jordan K ${side} handed"]`
        )
        await click(page, 'Ball')
        await waitReady(page)
        await page.mouse.move(...end)
        await page.mouse.down()
        await page.mouse.move(...start, { steps: 12 })
        await page.mouse.up()
        expect(
          await page.$(`[aria-label*="Batter Jordan K ${side} handed"]`)
        ).not.equals(null)
        await click(page, 'Undo Ball')
      } finally {
        await page.close()
      }
    })
  for (const base of ['First', 'Second', 'Third'])
    it(`places batter directly on ${base} and hides placement while occupied`, async () => {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        await click(page, 'More')
        expect(await page.$('[aria-label="Wild Pitch"]')).equals(null)
        expect(await page.$('[aria-label="Passed Ball"]')).equals(null)
        await click(page, 'Put Batter on Base')
        await click(page, base)
        expect(await page.$('[aria-label="Confirm Placements"]')).equals(null)
        expect(await page.$('[aria-label="Batter base"]')).equals(null)
        await waitReady(page)
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
        expect(await page.$('[aria-label="Finish at-bat"]')).equals(null)
        await click(page, 'More')
        expect(await page.$('[aria-label="Put Batter on Base"]')).equals(null)
        await click(page, 'Dismiss More')
        await click(page, 'Undo Put Batter on Base')
        await page.waitForSelector('[aria-label*="Batter Jordan K"]')
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
  for (const scenario of ['loaded-safe', 'loaded-out', 'empty-out'])
    it(`automatically resolves dropped third strike ${scenario}`, async () => {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        await page.setViewport({ width: 390, height: 844 })
        if (scenario.startsWith('loaded'))
          await overrideBases(page, [
            ['First base', 'Player 6'],
            ['Second base', 'Player 7'],
            ['Third base', 'Player 8']
          ])
        await click(page, 'Open scoring menu')
        await click(page, 'Overrides')
        await click(page, 'Strikes 2')
        if (scenario.startsWith('loaded')) await click(page, 'Outs 2')
        await click(page, 'Apply Override')
        await click(page, 'More')
        await click(page, 'Dropped Third Strike')
        const decision = scenario.startsWith('loaded')
          ? 'Home plate decision for Player 8'
          : 'Runner decision for Jordan K.'
        await page.waitForSelector(`[aria-label="${decision}"]`, {
          timeout: 30000
        })
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        expect(await page.$('[aria-label="Back"]')).equals(null)
        expect(await page.$$('[aria-label="Safe"]')).has.length(1)
        for (const label of ['Safe', 'Out']) {
          const copy = await page.$eval(`[aria-label="${label}"]`, button => ({
            text: button.textContent,
            subtitleSize: getComputedStyle(button.lastElementChild!).fontSize,
            align: getComputedStyle(button.lastElementChild!).textAlign
          }))
          expect(copy.text).equals(
            label + (scenario.startsWith('loaded') ? '' : 'At First')
          )
          // Automatic home-queue decisions deliberately have no subtitle;
          // a runner-action destination uses At First (RunnerControls).
          if (!scenario.startsWith('loaded')) {
            expect(copy.subtitleSize).equals('10.5px')
            expect(copy.align).equals('center')
          }
        }
        await page.screenshot({
          path: join(
            process.env.TS_SCORING_ARTIFACT_DIR ?? '/tmp',
            `dropped-third-${scenario}.png`
          )
        })
        if (scenario.endsWith('safe')) {
          await click(page, 'Safe')
          await page.waitForSelector('[aria-label="Time to edit play"]', {
            timeout: 30000
          })
          await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
          expect(
            await page.$eval(
              '[aria-label="Bottom Finish at-bat"]',
              node => getComputedStyle(node.firstElementChild!).backgroundColor
            )
          ).equals('rgb(43, 66, 33)')
          await click(page, 'Bottom Finish at-bat')
          await page.waitForSelector('[aria-label*="Batter Player 2"]')
        } else {
          await click(page, 'Out')
          await placeOffered(puppeteerDriver(page))
          await click(page, 'Bottom Finish defensive play')
          await page.waitForSelector(
            scenario === 'loaded-out'
              ? '[aria-label*="Bottom 1st"]'
              : '[aria-label*="Batter Player 2"]',
            { timeout: 30000 }
          )
          await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
        }
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
  for (const action of [
    'Hit by Pitch',
    'Intentional Walk',
    "Catcher's Interference",
    'Walk',
    'Balk'
  ])
    it(`automatically scores a forced run for ${action} with no correction prompt`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        await overrideBases(page, [
          ['First base', 'Player 6'],
          ['Second base', 'Player 7'],
          ['Third base', 'Player 8']
        ])
        if (action === 'Walk')
          for (let i = 0; i < 4; i++) {
            await click(page, 'Ball')
            await waitReady(page)
          }
        else {
          await click(page, 'More')
          await click(page, action)
          await waitReady(page)
        }
        await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]', {
          timeout: 30000
        })
        await page.waitForSelector(
          `[aria-label*="Batter ${action === 'Balk' ? 'Jordan K' : 'Player 2'}"]`
        )
        expect(await page.$('[aria-label="Finish at-bat"]')).equals(null)
        expect(await page.$('[aria-label="Safe at home"]')).equals(null)
        await click(page, `Undo ${action === 'Walk' ? 'Ball' : action}`)
        await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
      } finally {
        await page.close()
      }
    })
  it('shows real identities, switches the hitter before a pitch, and repeatedly undoes pitches', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.evaluate(() => {
        localStorage.removeItem('teamstation:scoring:100:switch-hitter')
      })
      await page.reload()
      await page.waitForSelector('[aria-label*="Batter Jordan K right handed"]')
      await page.waitForSelector('[aria-label="OK"]')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const box = await page.$eval('canvas', canvas => {
        const rect = canvas.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      const camera = new PerspectiveCamera(
        43,
        box.width / box.height,
        0.1,
        1000
      )
      applyFieldCamera(camera, {
        width: box.width,
        height: box.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      camera.updateMatrixWorld()
      const project = (x: number, y: number, z: number): [number, number] => {
        const point = new Vector3(x, y, z).project(camera)
        return [
          box.x + ((point.x + 1) * box.width) / 2,
          box.y + ((1 - point.y) * box.height) / 2
        ]
      }
      const start = project(-4, 6, 0)
      const end = project(7, 6, 0)
      await page.mouse.move(...start)
      await page.mouse.down()
      await page.mouse.move(...end, { steps: 12 })
      await page.mouse.up()
      if (process.env.TS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.TS_SCORING_ARTIFACT_DIR}/field.png`
        })
      await page.waitForSelector('[aria-label*="Batter Jordan K left handed"]')
      expect(await page.$('[aria-label="OK"]')).equals(null)
      await click(page, 'Ball')
      await click(page, 'Called Strike')
      await click(page, 'Foul Ball')
      await page.waitForSelector(
        '[aria-label*="1 balls 2 strikes 0 outs · Pitches 3"]'
      )
      await page.mouse.move(...end)
      await page.mouse.down()
      await page.mouse.move(...start, { steps: 12 })
      await page.mouse.up()
      expect(
        await page.$('[aria-label*="Batter Jordan K left handed"]')
      ).not.equals(null)
      await click(page, 'Undo Foul Ball')
      await click(page, 'Undo Called Strike')
      await click(page, 'Undo Ball')
      await page.waitForSelector(
        '[aria-label*="0 balls 0 strikes 0 outs · Pitches 0"]'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('shows the whole defensive field with state colors and drops onto the visible position', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 500 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Defense')
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="Defensive field"]')!
            .getBoundingClientRect().height > 0
      )
      for (const viewport of [
        { width: 390, height: 500 },
        { width: 844, height: 390 },
        { width: 844, height: 360 },
        { width: 844, height: 238 }
      ]) {
        await page.setViewport(viewport)
        await page.waitForFunction(
          () => {
            // A card is 14% of the field's viewport, at most 46 points.
            const field = document
              .querySelector('[data-testid="Defensive field viewport"]')!
              .getBoundingClientRect()
            const expected = Math.min(46, field.height * 0.14)
            return Array.from(
              document.querySelectorAll('[data-roster-target^="defense-"]')
            ).every(
              node =>
                Math.abs(node.getBoundingClientRect().height - expected) < 1
            )
          },
          { timeout: 5000 }
        )
        const geometry = await page.evaluate(() => {
          const rect = (
            n: Element
          ): { x: number; y: number; width: number; height: number } => {
            const r = n.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          }
          const field = rect(
            document.querySelector('[data-testid="Defensive field"]')!
          )
          const targets = Array.from(
            document.querySelectorAll('[data-roster-target^="defense-"]')
          ).map(rect)
          const roster = rect(
            document.querySelector('[aria-label="Roster players"]')!
          )
          return {
            field,
            targets,
            roster,
            fieldScroll:
              document.querySelector('[aria-label="Defensive positions"]') !=
              null
          }
        })
        expect(geometry.fieldScroll).equals(false)
        expect(geometry.roster.height).at.least(48)
        expect(geometry.targets).length(9)
        for (const r of geometry.targets) {
          expect(r.x).at.least(geometry.field.x - 1)
          expect(r.y).at.least(geometry.field.y - 1)
          expect(r.x + r.width).at.most(
            geometry.field.x + geometry.field.width + 1
          )
          expect(r.y + r.height, JSON.stringify(geometry)).at.most(
            geometry.field.y + geometry.field.height + 1
          )
        }
        for (let i = 0; i < geometry.targets.length; i++)
          for (let j = i + 1; j < geometry.targets.length; j++) {
            const a = geometry.targets[i]
            const b = geometry.targets[j]
            expect(
              a.x + a.width <= b.x ||
                b.x + b.width <= a.x ||
                a.y + a.height <= b.y ||
                b.y + b.height <= a.y
            ).equals(true)
          }
      }
      const beforeScroll = await page.$eval(
        '[data-testid="Defensive field"]',
        node => node.getBoundingClientRect().y
      )
      await page.$eval('[aria-label="Roster players"]', node => {
        node.scrollTop = 80
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(
        await page.$eval(
          '[data-testid="Defensive field"]',
          node => node.getBoundingClientRect().y
        )
      ).equals(beforeScroll)
      await page.$eval('[aria-label="Roster players"]', node => {
        node.scrollTop = 0
      })
      const style = async (): Promise<{
        border: string
        color: string
        fill: string
      }> =>
        await page.$eval('[data-testid="Defense P card"]', node => {
          const s = getComputedStyle(node)
          return {
            border: s.borderTopStyle,
            color: s.borderTopColor,
            fill: s.backgroundColor
          }
        })
      // A filled position in the scoring surface's accent, an empty one in
      // its red badge.
      expect(await style()).deep.equals({
        border: 'solid',
        color: cssColor(scoringSurface.accent),
        fill: cssColor(scoringSurface.active)
      })
      await click(page, 'Clear P')
      expect(await style()).deep.equals({
        border: 'dashed',
        color: cssColor(scoringSurface.badges.red.border),
        fill: cssColor(scoringSurface.badges.red.background)
      })
      for (const viewport of [
        { width: 844, height: 390 },
        { width: 844, height: 360 },
        { width: 844, height: 238 }
      ]) {
        await page.setViewport(viewport)
        await page.waitForFunction(
          () => {
            // A card is 14% of the field's viewport, at most 46 points.
            const field = document
              .querySelector('[data-testid="Defensive field viewport"]')!
              .getBoundingClientRect()
            const expected = Math.min(46, field.height * 0.14)
            return Array.from(
              document.querySelectorAll('[data-roster-target^="defense-"]')
            ).every(
              node =>
                Math.abs(node.getBoundingClientRect().height - expected) < 1
            )
          },
          { timeout: 5000 }
        )
        const emptyGeometry = await page.evaluate(() => {
          const field = document
            .querySelector('[data-testid="Defensive field"]')!
            .getBoundingClientRect()
          return Array.from(
            document.querySelectorAll('[data-roster-target^="defense-"]')
          ).every(node => {
            const r = node.getBoundingClientRect()
            return r.y >= field.y && r.bottom <= field.bottom + 1
          })
        })
        expect(
          emptyGeometry,
          'all field targets fit while validation is visible'
        ).equals(true)
      }
      await click(page, 'Clear 2B')
      // The pitcher, back on the visitors' bench.
      const source = '[data-roster-target="roster"] [data-roster-player="101"]'
      const target = '[data-roster-target="defense-SS"]'
      const firstBase = await page.$eval(
        '[data-roster-target="defense-1B"]',
        node => node.textContent
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      const point = async (
        selector: string
      ): Promise<{ x: number; y: number }> =>
        await page.$eval(selector, node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
      const from = await point(source)
      const pitcher = await page.$eval(
        '[data-roster-target="defense-P"]',
        node => node.textContent
      )
      const to = await page.$eval(target, node => {
        const r = node.getBoundingClientRect()
        return { x: r.right - 24, y: r.bottom - 1 }
      })
      const clip = await page.$eval(
        '[data-testid="Defensive field viewport"]',
        node => {
          const r = node.getBoundingClientRect()
          return { top: r.top, height: r.height }
        }
      )
      expect(to.y).within(clip.top, clip.top + clip.height)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.waitForSelector('[data-testid="Roster dragged card"]', {
        timeout: 2000
      })

      await page.mouse.move(to.x, to.y)
      // Await the real hit preview before releasing, as a user sees the outlined position.
      await page.waitForFunction(
        selector =>
          document.querySelector<HTMLElement>(selector)!.style.outline !== '',
        {},
        target
      )
      await page.mouse.up()
      await new Promise(resolve => setTimeout(resolve, 300))
      // The pitcher now plays short.
      await page.waitForFunction(
        selector =>
          document
            .querySelector(selector)!
            .getAttribute('data-roster-player') === '101',
        {},
        target
      )
      expect(
        await page.$eval(
          '[data-testid="Defense SS card"]',
          node => getComputedStyle(node).borderTopStyle
        )
      ).equals('solid')
      expect(
        await page.$eval(
          '[data-testid="Defense SS card"]',
          node => getComputedStyle(node).backgroundColor
        )
      ).equals(cssColor(scoringSurface.active))
      expect(
        await page.$eval(
          '[data-roster-target="defense-1B"]',
          node => node.textContent
        )
      ).equals(firstBase)
      expect(
        await page.$eval(
          '[data-roster-target="defense-P"]',
          node => node.textContent
        )
      ).equals(pitcher)
      await page.$eval('[aria-label="Roster players"]', node => {
        node.scrollTop = 0
      })
      const available = await page.$eval(
        '[data-roster-target="roster"] [data-roster-player]',
        node => node.getAttribute('data-roster-player')!
      )
      const pitcherFrom = await point(
        `[data-roster-target="roster"] [data-roster-player="${available}"]`
      )
      const pitcherTo = await point('[data-roster-target="defense-P"]')
      await page.mouse.move(pitcherFrom.x, pitcherFrom.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.mouse.move(pitcherTo.x, pitcherTo.y)
      await page.waitForSelector('[data-testid="Roster dragged card"]')
      await page.mouse.up()
      await page.waitForSelector('[aria-label="Clear P"]')
      await click(page, 'Save Rosters')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Defense')
      // Saved and opened again, the pitcher still plays short.
      expect(
        await page.$eval(target, node =>
          node.getAttribute('data-roster-player')
        )
      ).equals('101')
      expect(
        await page.$eval(
          '[data-testid="Defense SS card"]',
          node => getComputedStyle(node).backgroundColor
        )
      ).equals(cssColor(scoringSurface.active))
    } finally {
      await page.close()
    }
  })
  it('pulses drag-ready rows and limits light feedback to valid entries', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Defense')
      await click(page, 'Clear P')
      const supported = await page.evaluate(() => {
        Reflect.set(window, 'gestureHaptics', [])
        const original =
          typeof navigator.vibrate === 'function'
            ? navigator.vibrate.bind(navigator)
            : undefined
        if (original == null) return false
        Object.defineProperty(navigator, 'vibrate', {
          configurable: true,
          value: (pattern: VibratePattern): boolean => {
            const calls = Reflect.get(
              window,
              'gestureHaptics'
            ) as VibratePattern[]
            calls.push(pattern)
            return original(pattern)
          }
        })
        return true
      })
      const calls = async (): Promise<number> =>
        await page.evaluate(
          () =>
            (Reflect.get(window, 'gestureHaptics') as VibratePattern[]).length
        )
      const point = async (
        selector: string
      ): Promise<{ x: number; y: number; width: number }> =>
        await page.$eval(selector, node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width }
        })
      const source = '[data-roster-target="roster"] [data-roster-player="101"]'
      const from = await point(source)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.waitForFunction(
        width => {
          const node = document.querySelector(
            '[data-testid="Roster dragged card"]'
          )
          const r = node == null ? null : node.getBoundingClientRect()
          return r != null && r.width > width * 1.025
        },
        { timeout: 3000 },
        from.width
      )
      const peak = await point('[data-testid="Roster dragged card"]')
      expect(peak.width / from.width).within(1.025, 1.061)
      if (supported) expect(await calls()).equals(1)
      await page.mouse.move(from.x + 20, from.y - 20)
      await page.waitForFunction(
        width =>
          Math.abs(
            document
              .querySelector('[data-testid="Roster dragged card"]')!
              .getBoundingClientRect().width - width
          ) < 1,
        {},
        from.width
      )
      const pitcher = await point('[data-roster-target="defense-P"]')
      const catcher = await point('[data-roster-target="defense-C"]')
      await page.mouse.move(pitcher.x, pitcher.y)
      await new Promise(resolve => setTimeout(resolve, 200))
      if (supported) expect(await calls()).equals(2)
      await page.mouse.move(pitcher.x + 1, pitcher.y)
      await page.mouse.move(pitcher.x + 2, pitcher.y)
      await new Promise(resolve => setTimeout(resolve, 250))
      if (supported) expect(await calls()).equals(2)
      await page.mouse.move(catcher.x, catcher.y)
      await new Promise(resolve => setTimeout(resolve, 200))
      if (supported) expect(await calls()).equals(3)
      await page.mouse.move(1, catcher.y)
      await new Promise(resolve => setTimeout(resolve, 200))
      if (supported) expect(await calls()).equals(3)
      await page.mouse.move(catcher.x, catcher.y)
      await new Promise(resolve => setTimeout(resolve, 200))
      if (supported) expect(await calls()).equals(4)
      await page.mouse.up()
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Roster dragged card"]') == null
      )
      expect(await page.$(source)).equals(null)
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Defense')
      await click(page, 'Clear P')
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ])
      await new Promise(resolve => setTimeout(resolve, 250))
      const reducedFrom = await point(source)
      const before = await calls()
      await page.mouse.move(reducedFrom.x, reducedFrom.y)
      await page.mouse.down()
      await page.waitForSelector('[data-testid="Roster dragged card"]')
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(
        (await point('[data-testid="Roster dragged card"]')).width /
          reducedFrom.width
      ).within(0.99, 1.01)
      if (supported) expect(await calls()).equals(before + 1)
      await page.mouse.up()
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Roster dragged card"]') == null
      )
      await click(page, 'Cancel')
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'no-preference' }
      ])
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      // Set Team Rosters opens on the roster; the order is on the lineup.
      await click(page, 'Lineup')
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(animation => animation.playState !== 'running')
      )
      const lineupSource = '[data-roster-target^="lineup-"][data-roster-player]'
      const lineupFrom = await point(lineupSource)
      const lineupBefore = await calls()
      await page.mouse.move(lineupFrom.x, lineupFrom.y)
      await page.mouse.down()
      await page.waitForFunction(
        width => {
          const node = document.querySelector(
            '[data-testid="Roster dragged card"]'
          )
          return (
            node != null && node.getBoundingClientRect().width > width * 1.025
          )
        },
        { timeout: 3000 },
        lineupFrom.width
      )
      if (supported) expect(await calls()).equals(lineupBefore + 1)
      await page.mouse.move(lineupFrom.x + 20, lineupFrom.y - 20)
      await page.mouse.up()
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Roster dragged card"]') == null
      )
    } finally {
      await page.close()
    }
  })
  it('fits narrow defense selectors and exposes the entire roster error', async function () {
    awayTeamName = 'Demo Northern Hawks'
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 320, height: 400 })
      await overrideBases(page, [['First base', 'Player 2']])
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      const removals = await page.$$eval('[aria-label^="Remove "]', nodes =>
        nodes
          .map(node => node.getAttribute('aria-label')!)
          .filter(label => label !== 'Remove Player 2')
      )
      for (const label of removals) await click(page, label)
      await click(page, 'Defense')
      await new Promise(resolve => setTimeout(resolve, 500))
      for (const width of [320, 390]) {
        await page.setViewport({ width, height: 400 })
        await new Promise(resolve => setTimeout(resolve, 500))
        const controls = await page.evaluate(() => {
          const r = (label: string): { x: number; right: number } => {
            const b = document
              .querySelector(`[aria-label="${label}"]`)!
              .getBoundingClientRect()
            return { x: b.x, right: b.right }
          }
          return ['Away Team', 'Home Team', 'Lineup', 'Defense'].map(r)
        })
        for (let i = 0; i < controls.length; i++) {
          expect(controls[i].x).at.least(16)
          expect(controls[i].right).at.most(width - 16 + 1)
          if (i > 0) expect(controls[i].x).at.least(controls[i - 1].right - 1)
        }
      }
      await click(page, 'Clear P')
      for (const viewport of [
        { width: 390, height: 400 },
        { width: 320, height: 238 }
      ]) {
        await page.setViewport(viewport)
        await page.waitForFunction(() => {
          const f = document
            .querySelector('[data-testid="Defensive field"]')!
            .getBoundingClientRect()
          return Array.from(
            document.querySelectorAll('[data-roster-target^="defense-"]')
          ).every(node => {
            const r = node.getBoundingClientRect()
            return r.y >= f.y && r.bottom <= f.bottom + 1
          })
        })
        const error = await page.$eval('[role="alert"]', node => ({
          text: node.textContent,
          width: node.clientWidth,
          scroll: node.scrollWidth,
          style: getComputedStyle(node).textOverflow
        }))
        expect(error.text).equals(
          'Choose a next batter in the lineup who is not already on base.'
        )
        expect(error.scroll).at.most(error.width + 1)
        expect(error.style).not.equals('ellipsis')
        expect(
          await page.$eval(
            '[aria-label="Cancel"]',
            node => node.getBoundingClientRect().bottom
          )
        ).at.most(viewport.height + 1)
      }
    } finally {
      awayTeamName = undefined
      await page.close()
    }
  })
  it('uses the compact defensive field and advances player input with Enter', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      expect(await page.$$('[aria-label="Cancel"]')).length(1)
      expect(await page.$('[aria-label="Create Placeholder Player"]')).equals(
        null
      )
      await click(page, 'Defense')
      expect(await page.$$('[data-roster-target^="defense-"]')).length(9)
      await click(page, 'Clear P')
      const source = '[data-roster-target="roster"] [data-roster-player="101"]'
      const target = '[data-roster-target="defense-P"]'
      const point = async (
        selector: string
      ): Promise<{ x: number; y: number }> =>
        await page.$eval(selector, node => {
          const box = node.getBoundingClientRect()
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        })
      const from = await point(source)
      const to = await point(target)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.mouse.move(to.x, to.y, { steps: 15 })
      await page.mouse.up()
      await page.waitForSelector('[aria-label="Clear P"]')
      expect(await page.$(source)).equals(null)
      await click(page, 'Clear P')
      await page.waitForSelector(source)
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Defense')
      await page.waitForSelector('[aria-label="Clear P"]')
      // Players are made on the roster.
      await click(page, 'Roster')
      await click(page, 'Create Player')
      // A new player's sheet opens with nothing focused: the scorer taps
      // First Name, and Enter takes him through the rest.
      await page.click('[aria-label="First Name"]')
      await page.waitForFunction(
        () =>
          document.activeElement!.getAttribute('aria-label') === 'First Name'
      )
      await page.keyboard.type('Alex')
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        () => document.activeElement!.getAttribute('aria-label') === 'Last Name'
      )
      await page.keyboard.type('Demo')
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        () =>
          document.activeElement!.getAttribute('aria-label') === 'Jersey Number'
      )
      await page.keyboard.type('42')
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        () =>
          document.activeElement!.getAttribute('aria-label') !== 'Jersey Number'
      )
      expect(
        await page.$('[aria-label="Create Placeholder Player"]')
      ).not.equals(null)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('keeps inline override runners reachable above the pinned Apply action on a small phone', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 1 })
      await tapSettled(page, 'Open scoring menu')
      await tapSettled(page, 'Overrides')
      expect(await page.$('[aria-label="Correct runners"]')).equals(null)
      const divider = await page.$eval('[aria-label="Inning"]', row => {
        const label = row.firstElementChild!.getBoundingClientRect()
        const value = row.lastElementChild!.getBoundingClientRect()
        const line = row.nextElementSibling!.getBoundingClientRect()
        return { left: line.left - label.left, right: line.right - value.right }
      })
      expect(Math.abs(divider.left)).lessThan(1)
      expect(Math.abs(divider.right)).lessThan(1)
      const apply = '[aria-label="Apply Override"]'
      await new Promise(resolve => setTimeout(resolve, 350))
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(animation => animation.playState !== 'running')
      )
      const before = await page.$eval(apply, n => n.getBoundingClientRect().top)
      await page.$eval('[data-testid="Scoring sheet content"]', n => {
        n.scrollTop = n.scrollHeight
      })
      await page.waitForFunction(() => {
        const content = document.querySelector(
          '[data-testid="Scoring sheet content"]'
        )!
        content.scrollTop = content.scrollHeight
        const row = document
          .querySelector('[aria-label="Third base"]')!
          .getBoundingClientRect()
        const footer = document
          .querySelector('[data-testid="Scoring sheet footer"]')!
          .getBoundingClientRect()
        return row.bottom <= footer.top && row.top > 0
      })
      const after = await page.$eval(apply, n => n.getBoundingClientRect().top)
      expect(Math.abs(after - before)).lessThan(1)
      expect(after).lessThan(667)
      await tapSettled(page, 'Third base')
      await tapSettled(page, 'Choose Third base Player 2 #2')
      expect(
        await page.$eval('[aria-label="Third base"]', n => n.textContent)
      ).includes('Player 2')
      const out = process.env.TS_SCORING_ARTIFACT_DIR
      if (out != null) {
        await mkdir(out, { recursive: true })
        await page.screenshot({ path: join(out, 'inline-runners-after.png') })
      }
      await tapSettled(page, 'Apply Override')
      await page.waitForSelector('[aria-label="Undo Override game state"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('fills the bottom safe area in every shared scoring modal', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
      const cdp = await page.createCDPSession()
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { bottom: 34 }
      })
      for (const label of [
        'Overrides',
        'Settings',
        'End Half Inning',
        'Swap Home and Away'
      ]) {
        await tapSettled(page, 'Open scoring menu')
        await tapSettled(page, label)
        await new Promise(resolve => setTimeout(resolve, 350))
        await page.waitForFunction(() =>
          document
            .getAnimations()
            .every(animation => animation.playState !== 'running')
        )
        await page.locator('[data-testid="Scoring sheet"]').hover()
        const geometry = await page.$eval(
          '[data-testid="Scoring sheet"]',
          n => {
            const rect = n.getBoundingClientRect()
            const style = getComputedStyle(n)
            return {
              bottom: rect.bottom,
              padding: parseFloat(style.paddingBottom),
              border: style.borderBottomWidth,
              left: style.borderLeftWidth,
              right: style.borderRightWidth
            }
          }
        )
        expect(geometry.bottom, label).equals(844)
        expect(geometry.padding, label).equals(50)
        expect(geometry.border, label).equals('0px')
        expect(geometry.left, label).equals('1px')
        expect(geometry.right, label).equals('1px')
        if (label === 'End Half Inning' || label === 'Swap Home and Away') {
          const gap = await page.$eval(
            '[data-testid="Scoring confirmation"]',
            n => {
              const description = n.firstElementChild!.getBoundingClientRect()
              const action = n.lastElementChild!.getBoundingClientRect()
              return action.top - description.bottom
            }
          )
          expect(gap, `${label} confirmation spacing`).at.least(12)
        }
        const out = process.env.TS_SCORING_ARTIFACT_DIR
        if (out != null)
          await page.screenshot({
            path: join(
              out,
              `${label.toLowerCase().replaceAll(' ', '-')}-safe-area-after.png`
            )
          })
        await tapSettled(page, label === 'Settings' ? 'Done' : 'Cancel')
        await page.waitForSelector('[data-testid="Scoring sheet"]', {
          hidden: true
        })
      }
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('edits rosters with a captured drag, validates overrides, and uses slide-up settings', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      await click(page, 'Remove Player 2')
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(animation => animation.playState !== 'running')
      )
      const source = '[aria-label="Add Player 2 to Lineup"]'
      const target = '[data-roster-target="lineup-0"]'
      await page.$eval(source, node => {
        node.scrollIntoView({ block: 'center' })
      })
      const from = await page.$eval(source, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      const to = await page.$eval(target, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 750))
      await page.waitForSelector('[data-testid="Roster dragged card"]')
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="lineup-0"]')!
          .textContent!.includes('Player 2')
      )
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      expect(await page.$('[aria-label="Balls 4"]')).equals(null)
      await click(page, 'Balls 2')
      await click(page, 'Apply Override')
      await page.waitForSelector('[aria-label*="2 balls 0 strikes"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      await click(page, 'Toggle switch-hitter help')
      await click(page, 'Reset shown count')
      await click(page, 'Done')
      await click(page, 'Undo Override game state')
      await click(page, 'Undo Set team roster')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('creates detailed players in a full-screen roster and cancels only the active sheet', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Create Player')
      await page.locator('[aria-label="First Name"]').fill('Mookie')
      await page.locator('[aria-label="Last Name"]').fill('Betts')
      await page.locator('[aria-label="Jersey Number"]').fill('07')
      await click(page, 'Throws L')
      await click(page, 'Bats S')
      await click(page, 'Player position P')
      await click(page, 'Player position DH')
      await click(page, 'Save and Create Another Player')
      await page.waitForFunction(
        () =>
          document.activeElement!.getAttribute('aria-label') === 'First Name' &&
          (document.activeElement as HTMLInputElement).value === ''
      )
      expect(
        await page.$eval('[aria-label="Bats R"]', n =>
          n.getAttribute('aria-selected')
        )
      ).equals('true')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="Create Player"]')
      expect(await page.$('[aria-label="First Name"]')).equals(null)
      expect(
        await page.$eval(
          '[aria-label="Add Mookie B to Lineup"]',
          n => n.textContent
        )
      ).includes('#07 Mookie B')
      await click(page, 'Home Team')
      expect(await page.$('[aria-label="Add Mookie B to Lineup"]')).equals(null)
      await click(page, 'Away Team')
      await click(page, 'Save Rosters')
      await click(page, 'Undo Set team roster')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      // Undo takes him out of the game's order; the team player remains
      // persisted, on the bench.
      await click(page, 'Lineup')
      expect(await page.$('[aria-label="Reorder Mookie B"]')).equals(null)
      expect(await page.$('[aria-label="Add Mookie B to Lineup"]')).not.equals(
        null
      )
      await click(page, 'Cancel')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('adds selected placeholder batches, cancels, isolates teams and supports Save/Undo', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await openPlaceholderSheet(page)
      await page.waitForSelector('[aria-label="Number of placeholder players"]')
      await new Promise(resolve => setTimeout(resolve, 400))
      const cancels = await page.$$('[aria-label="Cancel"]')
      const cancelBox = await cancels.at(-1)!.boundingBox()
      await page.mouse.click(
        cancelBox!.x + cancelBox!.width / 2,
        cancelBox!.y + cancelBox!.height / 2
      )
      await page.waitForSelector(
        '[aria-label="Number of placeholder players"]',
        { hidden: true }
      )
      await new Promise(resolve => setTimeout(resolve, 400))
      // Players are made on the roster; the bench is on the lineup.
      const add = async (count: 1 | 16): Promise<void> => {
        await click(page, 'Roster')
        await addPlaceholders(page, count)
        await click(page, 'Lineup')
      }
      await add(1)
      await add(16)
      expect(await page.$('[aria-label="Add OWLS Q to Lineup"]')).not.equals(
        null
      )
      expect(
        await page.$$('[data-roster-target="roster"] [data-roster-player]')
      ).length(17)
      await click(page, 'Home Team')
      expect(await page.$('[aria-label="Add OWLS A to Lineup"]')).equals(null)
      await add(1)
      expect(await page.$('[aria-label="Add HAWKS A to Lineup"]')).not.equals(
        null
      )
      await click(page, 'Save Rosters')
      await click(page, 'Undo Set team roster')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      expect(
        await page.$$('[data-roster-target="roster"] [data-roster-player]')
      ).length(0)
      await add(1)
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      expect(await page.$('[aria-label="Add OWLS A to Lineup"]')).equals(null)
      await click(page, 'Cancel')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('shows one lineup insertion line and numbered themed rows before dropping', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            animation =>
              animation.effect == null ||
              animation.effect.getComputedTiming().iterations === Infinity ||
              (!animation.pending && animation.playState !== 'running')
          )
      )
      await page.evaluate(() => {
        const trace: unknown[] = []
        ;(
          window as Window & { rosterAcceptanceTrace?: unknown[] }
        ).rosterAcceptanceTrace = trace
        for (const type of [
          'pointerdown',
          'pointermove',
          'pointerup',
          'pointercancel',
          'lostpointercapture'
        ])
          document.addEventListener(
            type,
            event => {
              const e = event as PointerEvent
              const row =
                e.target instanceof Element
                  ? e.target.closest('[data-roster-target]')
                  : null
              trace.push({
                type,
                at: performance.now(),
                x: e.clientX,
                y: e.clientY,
                buttons: e.buttons,
                row:
                  row == null ? null : row.getAttribute('data-roster-target'),
                bounds: Array.from(
                  document.querySelectorAll('[data-roster-target]')
                ).map(target => ({
                  target: target.getAttribute('data-roster-target'),
                  player: target.getAttribute('data-roster-player'),
                  bounds: target.getBoundingClientRect().toJSON()
                }))
              })
            },
            true
          )
      })
      const position = async (
        selector: string,
        bottom = false
      ): Promise<{ x: number; y: number }> =>
        await page.$eval(
          selector,
          (n, bottom) => {
            const r = n.getBoundingClientRect()
            return { x: r.x + 20, y: bottom ? r.bottom - 8 : r.top + 8 }
          },
          bottom
        )
      // Wait for the slide-up sheet to settle before measuring drag coordinates.
      await page.locator('[aria-label="Reorder Jordan K."]').hover()
      // Picked up by its grip; the row's start holds its red X.
      const a = await page.$eval(
        '[aria-label="Reorder Jordan K."] [data-roster-grip]',
        n => {
          const r = n.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }
      )
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await new Promise(resolve => setTimeout(resolve, 750))
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-0"]')!
            .getBoundingClientRect().height < 1
      )
      // Measure the destination only once source collapse completes.
      const b = await position('[data-roster-target="lineup-2"]', true)
      await page.mouse.move(b.x, b.y, { steps: 10 })
      await page.waitForFunction(
        () => {
          const line = document.querySelector<HTMLElement>(
            '[aria-label="Lineup insertion point"]'
          )
          if (line == null) return false
          const parent = line.parentElement
          if (parent == null) return false
          return (
            parent.getAttribute('data-roster-target') === 'lineup-2' &&
            line.style.bottom === '-2px'
          )
        },
        { timeout: 20000 }
      )
      expect(await page.$$('[aria-label="Lineup insertion point"]')).length(1)
      expect(
        await page.$eval(
          '[data-roster-target="lineup-2"]',
          n => getComputedStyle(n).outlineStyle
        )
      ).equals('none')
      await page.mouse.up()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-2"]')!
            .getAttribute('data-roster-player') === '1',
        { timeout: 20000 }
      )
      expect(
        await page.$eval('[data-roster-target="lineup-2"]', n => n.textContent)
      ).includes('#00 Jordan K.')
      await click(page, 'Cancel')
      await click(page, 'More')
      await click(page, 'Put Batter on Base')
      const alignment = await page.evaluate(() => ({
        parent: document
          .querySelector('[aria-label="Put Batter on Base"]')!
          .getBoundingClientRect().top,
        child: document
          .querySelector('[aria-label="First"]')!
          .getBoundingClientRect().top
      }))
      expect(alignment.child).closeTo(alignment.parent, 1)
    } catch (error) {
      const directory =
        process.env.TS_SCORING_ARTIFACT_DIR ??
        join(homedir(), '.cursor', 'logs')
      await mkdir(directory, { recursive: true })
      const stem = join(directory, `roster-insertion-failure-${Date.now()}`)
      const detail = await page.evaluate(() => ({
        trace: (window as Window & { rosterAcceptanceTrace?: unknown[] })
          .rosterAcceptanceTrace,
        rows: Array.from(document.querySelectorAll('[data-roster-target]')).map(
          row => ({
            target: row.getAttribute('data-roster-target'),
            player: row.getAttribute('data-roster-player'),
            bounds: row.getBoundingClientRect().toJSON(),
            text: row.textContent
          })
        ),
        animations: document.getAnimations().map(animation => ({
          state: animation.playState,
          pending: animation.pending
        })),
        lines: Array.from(
          document.querySelectorAll('[aria-label="Lineup insertion point"]')
        ).map(line => line.getBoundingClientRect().toJSON())
      }))
      await writeFile(stem + '.json', JSON.stringify(detail, null, 2))
      await page.screenshot({ path: stem + '.png' })
      console.error('Insertion failure diagnostics:', stem)
      throw error
    } finally {
      await page.close()
    }
  })
  it('appends tapped names, reorders after a hold, drags both selectors, and auto-scrolls the lineup', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 740,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      const center = async (
        selector: string
      ): Promise<{ x: number; y: number }> =>
        await page.$eval(selector, node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
      const swipe = async (from: string, to: string): Promise<void> => {
        const a = await center(from)
        const b = await center(to)
        await page.touchscreen.touchStart(a.x, a.y)
        await new Promise(resolve => setTimeout(resolve, 550))
        for (let i = 1; i <= 12; i++)
          await page.touchscreen.touchMove(
            a.x + ((b.x - a.x) * i) / 12,
            a.y + ((b.y - a.y) * i) / 12
          )
        await page.touchscreen.touchEnd()
      }
      await click(page, 'Remove Player 2')
      await click(page, 'Remove Player 3')
      await click(page, 'Add Player 3 to Lineup')
      await click(page, 'Add Player 2 to Lineup')
      expect(
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          nodes =>
            nodes.map(n => n.getAttribute('data-roster-player')).slice(-2)
        )
      ).deep.equals(['103', '102'])
      expect(await page.$$('[aria-label^="Move Player"]')).length(0)
      await swipe('[aria-label="Away Team"]', '[aria-label="Home Team"]')
      await page.waitForSelector(
        '[aria-label="Home Team"][aria-selected="true"]'
      )
      await swipe('[aria-label="Lineup"]', '[aria-label="Defense"]')
      await page.waitForSelector('[aria-label="Defense"][aria-selected="true"]')
      await click(page, 'Clear P')
      // A tap in defense never implies a slot; a direct drag replaces C.
      await click(page, 'Player 1')
      expect(
        await page.$eval('[data-roster-target="defense-P"]', n => n.textContent)
      ).includes('Unassigned')
      await swipe(
        '[data-roster-target="roster"] [data-roster-player="201"]',
        '[data-roster-target="defense-C"]'
      )
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="defense-C"]')!
          .textContent!.includes('Player 1')
      )
      expect(
        await page.$('[data-roster-target="roster"] [data-roster-player="202"]')
      ).not.equals(null)
      await swipe('[aria-label="Home Team"]', '[aria-label="Away Team"]')
      await swipe('[aria-label="Defense"]', '[aria-label="Lineup"]')
      await page.waitForSelector('[aria-label="Lineup"][aria-selected="true"]')
      await page.$eval('[aria-label="Batting lineup"]', n => {
        n.scrollTop = 0
      })
      const from = await center('[aria-label="Drag Jordan K."]')
      const edge = await page.$eval('[aria-label="Batting lineup"]', n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.bottom - 12 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-0"]')!
            .getBoundingClientRect().height < 1
      )
      await page.touchscreen.touchMove(edge.x, edge.y)
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Batting lineup"]')!.scrollTop >
          40
      )
      await page.touchscreen.touchEnd()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-0"]')!
            .getAttribute('data-roster-player') !== '1'
      )
      if (process.env.TS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.TS_SCORING_ARTIFACT_DIR}/roster-slider-drag.png`
        })
      await click(page, 'Cancel')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      expect(
        await page.$eval('[data-roster-target="lineup-0"]', n =>
          n.getAttribute('data-roster-player')
        )
      ).equals('101')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('cancels only the keyboard roster grab on Escape and retains prior draft edits', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      await click(page, 'Remove Player 2')
      await click(page, 'Remove Player 3')
      await click(page, 'Add Player 3 to Lineup')
      await click(page, 'Add Player 2 to Lineup')
      await page.focus('[aria-label="Reorder Jordan K."]')
      for (const key of ['Space', 'ArrowDown', 'ArrowDown', 'Enter'])
        await page.keyboard.press(key as 'Space' | 'ArrowDown' | 'Enter')
      const order = async (): Promise<Array<string | null>> =>
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          nodes => nodes.map(n => n.getAttribute('data-roster-player'))
        )
      const before = await order()
      expect(before.slice(0, 3)).deep.equals(['104', '105', '101'])
      expect(before.slice(-2)).deep.equals(['103', '102'])
      await page.keyboard.press('Space')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="Save Rosters"]')
      expect(await order()).deep.equals(before)
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      expect(await order()).deep.equals(before)
      await page.waitForSelector('[role="dialog"]')
      await page.focus('[aria-label="Reorder Jordan K."]')
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="Save Rosters"]', {
        hidden: true
      })
      expect(await page.$('[aria-label="Save Rosters"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('scrolls roster and lineup rows before the hold and adds only after a held drop', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 740,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      await click(page, 'Remove Player 2')
      await addPlaceholders(page, 16)
      await page.waitForSelector('[role="dialog"]')
      const order = async (): Promise<string[]> =>
        await page.$$eval(
          '[data-roster-target^="lineup-"][data-roster-player]',
          rows => rows.map(n => n.getAttribute('data-roster-player')!)
        )
      const before = await order()
      for (const [list, selector] of [
        [
          'Roster players',
          '[data-roster-target="roster"] [data-roster-player="102"]'
        ],
        ['Batting lineup', '[data-roster-target="lineup-1"]']
      ]) {
        const from = await page.$eval(selector, n => {
          const r = n.getBoundingClientRect()
          return { x: r.x + 20, y: r.y + r.height / 2 }
        })
        // Browser-timed touch input stays below the 500ms hold threshold even
        // when Node/CDP round trips are slow during a complete test batch.
        const input = await page.createCDPSession()
        await input.send('Input.synthesizeScrollGesture', {
          x: from.x,
          y: from.y,
          yDistance: -80,
          speed: 800,
          gestureSourceType: 'touch',
          preventFling: true
        })
        await input.detach()
        await page.waitForFunction(
          label =>
            document.querySelector(`[aria-label="${label}"]`)!.scrollTop > 20,
          {},
          list
        )
        expect(await order()).deep.equals(before)
      }
      await page.$$eval(
        '[aria-label="Roster players"], [aria-label="Batting lineup"]',
        rows => {
          rows.forEach(n => {
            n.scrollTop = 0
          })
        }
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      const from = await page.$eval(
        '[data-roster-target="roster"] [data-roster-player="102"]',
        n => {
          const r = n.getBoundingClientRect()
          return { x: r.x + 20, y: r.y + 20 }
        }
      )
      const to = await page.$eval('[data-roster-target="lineup-1"]', n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + 20, y: r.y + 6 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.waitForSelector('[data-testid="Roster dragged card"]')
      await page.touchscreen.touchMove(to.x, to.y)
      await page.touchscreen.touchEnd()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-1"]')!
            .getAttribute('data-roster-player') === '2'
      )
      expect(await order()).length(before.length + 1)
    } finally {
      await page.close()
    }
  })
  it('assigns a defender with a touch drag on a phone-sized sheet', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Defense')
      await click(page, 'Clear P')
      const source = '[data-roster-target="roster"] [data-roster-player="101"]'
      const target = '[data-roster-target="defense-P"]'
      const from = await page.$eval(source, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      const to = await page.$eval(target, node => {
        const rect = node.getBoundingClientRect()
        return { x: rect.x + 20, y: rect.y + 15 }
      })
      await page.touchscreen.touchStart(from.x, from.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      await page.touchscreen.touchMove(to.x, to.y)
      await page.touchscreen.touchEnd()
      await page.waitForFunction(() =>
        document
          .querySelector('[data-roster-target="defense-P"]')!
          .textContent!.includes('Jordan K.')
      )
      if (process.env.TS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.TS_SCORING_ARTIFACT_DIR}/rosters-phone.png`
        })
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  for (const out of ['Ball Caught', 'Ground Out'])
    it(`opens ${out} under one drag and returns to the right without a Back button`, async function () {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        const center = async (
          label: string
        ): Promise<{ x: number; y: number }> =>
          await page.$eval(`[aria-label="${label}"]`, node => {
            const r = node.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          })
        await page.waitForSelector('[aria-label="Swing in Play"]')
        const button = await center('Swing in Play')
        await page.mouse.move(button.x, button.y)
        await page.mouse.down()
        await page.mouse.move(button.x, button.y - 20, { steps: 3 })
        await page.waitForSelector('[aria-label="Batter Out"]')
        const parent = await center('Batter Out')
        await page.mouse.move(parent.x, parent.y, { steps: 3 })
        await page.waitForSelector('[aria-label="Ground Out"]')
        const right = await center('Single')
        await page.mouse.move(right.x, right.y, { steps: 3 })
        await page.waitForSelector('[aria-label="Ground Out"]', {
          hidden: true
        })
        await page.mouse.move(parent.x, parent.y, { steps: 3 })
        await page.waitForSelector('[aria-label="Ball Caught"]')
        const leaf = await center(out)
        await page.mouse.move(leaf.x, leaf.y, { steps: 8 })
        await page.mouse.up()
        await page.waitForSelector(
          '[aria-label^="Tap or drag a player to where the ball was fielded"]'
        )
        expect(await page.$('[aria-label="Back"]')).equals(null)
        await page.waitForSelector('canvas[data-field-ready="true"]')
        const field = puppeteerDriver(page)
        await placeOffered(field)
        // Dragged down to 5°: a caught ball goes no lower than a line drive.
        await setTrajectory(field, 5)
        const angle =
          out === 'Ball Caught' ? '10° Line Drive' : '5° Ground Ball'
        await page.waitForSelector(`[aria-label="Undo ${angle}"]`)
        await click(page, `Undo ${angle}`)
        await page.waitForSelector(
          '[aria-label^="Drag up and down for ball trajectory."]'
        )
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
  it('places a fielder on the rendered field and cancels then accepts a trajectory drag', async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Single')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const box = await page.$eval('canvas', canvas => {
        const r = canvas.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera(43, box.width / box.height, 2, 1100)
      applyFieldCamera(camera, {
        width: box.width,
        height: box.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const point = (x: number, z: number): [number, number] => {
        const p = new Vector3(x, 6, z).project(camera)
        return [
          box.x + ((p.x + 1) * box.width) / 2,
          box.y + ((1 - p.y) * box.height) / 2
        ]
      }
      await page.mouse.move(...point(0, -18.44))
      await page.mouse.down()
      await page.mouse.move(...point(12, -40), { steps: 12 })
      await page.mouse.up()
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      if (process.env.TS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.TS_SCORING_ARTIFACT_DIR}/fielder-trajectory.png`
        })
      await page.mouse.move(500, 500)
      await page.mouse.down()
      await page.mouse.move(500, 620, { steps: 12 })
      await page.$eval('[aria-label="Baseball field"]', node =>
        node.dispatchEvent(
          new PointerEvent('pointercancel', {
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: 500,
            clientY: 620
          })
        )
      )
      await page.mouse.up()
      await page.waitForSelector('[aria-label*="45° Fly Ball"]')
      await page.mouse.move(500, 500)
      await page.mouse.down()
      await page.mouse.move(500, 620, { steps: 12 })
      await page.mouse.up()
      await page.waitForSelector('[aria-label="Undo -15° Ground Ball"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('runs a real seven-second correction window, pauses it for Settings and closes once', async function () {
    this.timeout(90000)
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Settings')
      const seconds = await page.$eval(
        '[aria-label="Time to edit play"]',
        node => node.getAttribute('aria-valuenow')
      )
      expect(Number(seconds)).within(1, 7)
      await new Promise(resolve => setTimeout(resolve, 10500))
      expect(
        await page.$eval('[aria-label="Time to edit play"]', node =>
          node.getAttribute('aria-valuenow')
        )
      ).equals(seconds)
      await click(page, 'Done')
      const background = await page.browserContext().newPage()
      await background.bringToFront()
      expect(await page.evaluate(() => document.hidden)).equals(true)
      await new Promise(resolve => setTimeout(resolve, 10500))
      expect(
        await page.$eval('[aria-label="Time to edit play"]', node =>
          node.getAttribute('aria-valuenow')
        )
      ).equals(seconds)
      await background.close()
      await page.bringToFront()
      const resumed = Date.now()
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 20000
      })
      expect(Date.now() - resumed).greaterThan(
        (Number(seconds) - 1) * 1000 - 200
      )
      await click(page, 'Ball')
      await waitReady(page)
      await dropOfferedRunner(page, 'Safe')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="1 balls 0 strikes 0 outs · Pitches 2"]'
      )
      await dropOfferedRunner(page, 'Safe', true)
      await click(page, 'Steal')
      await waitReady(page)
      await page.waitForSelector(
        '[aria-label*="1 balls 0 strikes 0 outs · Pitches 2"]'
      )
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('requires every triple home arrival to be Safe or Out and credits a defender', async function () {
    this.timeout(90000)
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await overrideBases(page, [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ])
      await chooseHit(page, 'Triple')
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      expect(await page.$('[aria-label="Back"]')).equals(null)
      await click(page, 'Safe')
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 7"]',
        { timeout: 30000 }
      )
      await click(page, 'Out')
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      await click(page, 'Finish defensive play')
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 6"]',
        { timeout: 30000 }
      )
      await click(page, 'Safe')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="Owls 2 · Hawks 0"]')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('recovers a one-player lineup after timer expiry and can undo the repair', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      for (let i = 2; i <= 9; i++) await click(page, `Remove Player ${i}`)
      await click(page, 'Save Rosters')
      await click(page, 'Accept Lineup')
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label^="Next batter is on base."]', {
        timeout: 30000
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Roster')
      await click(page, 'Create Player')
      await page.locator('[aria-label="First Name"]').fill('Mike')
      await page.locator('[aria-label="Last Name"]').fill('Trout')
      await click(page, 'Create Player')
      await click(page, 'Lineup')
      await click(page, 'Add Mike T to Lineup')
      await click(page, 'Next batter Mike T')
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label*="Batter Mike T"]')
      await click(page, 'Undo Set team roster')
      await page.waitForSelector('[aria-label^="Next batter is on base."]')
      // The hit, whatever the history calls it here.
      await page.locator('[aria-label^="Undo "]').click()
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
    } finally {
      await page.close()
    }
  })
  for (const width of [320, 390, 844]) {
    it(`keeps More halves fixed and extends the field at ${width}px`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        await page.setViewport({ width, height: width === 844 ? 390 : 844 })
        await click(page, 'More')
        const bounds = async (
          label: string
        ): Promise<{
          x: number
          y: number
          right: number
          bottom: number
          width: number
        }> =>
          await page.$eval(`[aria-label="${label}"]`, node => {
            const r = node.getBoundingClientRect()
            return {
              x: r.x,
              y: r.y,
              right: r.right,
              bottom: r.bottom,
              width: r.width
            }
          })
        const parent = await bounds('More scoring actions')
        expect(parent.right).at.most(width / 2)
        const headingCount = await page.$eval(
          '[aria-label="More scoring actions"]',
          panel =>
            Array.from(panel.querySelectorAll('div')).filter(n =>
              ['Between pitches', "Didn't see it", 'This pitch'].includes(
                // Browser closures cannot reference Sucrase's nullish helper.
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                n.textContent == null ? '' : n.textContent
              )
            ).length
        )
        expect(headingCount).equals(0)

        expect(
          await page.$eval('[aria-label="Put Batter on Base"]', n => ({
            font: getComputedStyle(n).fontSize,
            weight: getComputedStyle(n).fontWeight
          }))
        ).deep.equals({ font: '13px', weight: '700' })
        await click(page, 'Put Batter on Base')
        expect(await bounds('More scoring actions')).deep.equals(parent)
        expect((await bounds('Batter base')).x).at.least(width / 2)
        await page.focus('[aria-label="First"]')
        expect(
          await page.$eval('[aria-label="First"]', node => ({
            bg: getComputedStyle(node).backgroundImage,
            text: getComputedStyle(node).color
          }))
        ).deep.equals({
          bg: 'linear-gradient(to right, rgb(29, 107, 66), rgb(22, 88, 53))',
          text: 'rgb(255, 255, 255)'
        })
        const child = await bounds('Batter base')
        expect(child.bottom).at.most(width === 844 ? 390 : 844)
        if (process.env.TS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: join(
              process.env.TS_SCORING_ARTIFACT_DIR,
              `menus-more-${width}.png`
            )
          })
        await page.keyboard.press('Escape')
        expect(await page.$('[aria-label="More scoring actions"]')).equals(null)
        await click(page, 'Swing in Play')
        await click(page, 'Batter Out')
        expect(
          await page.$eval('[aria-label="Ground Out"]', n => ({
            font: getComputedStyle(n).fontSize,
            weight: getComputedStyle(n).fontWeight
          }))
        ).deep.equals({ font: '13px', weight: '700' })
        for (const label of [
          'Ground Out',
          'Ball Caught',
          'Batter Interference'
        ]) {
          const row = await bounds(label)
          expect(row.y).at.least(0)
          expect(row.bottom).at.most(width === 844 ? 390 : 844)
        }
        if (process.env.TS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: join(
              process.env.TS_SCORING_ARTIFACT_DIR,
              `menus-outcome-${width}.png`
            )
          })
        await click(page, 'Dismiss outcomes')
        const geometry = await page.$eval('canvas', node => ({
          bottom: node.getBoundingClientRect().bottom,
          height: window.innerHeight
        }))
        expect(geometry.bottom).closeTo(geometry.height, 1)
      } finally {
        await page.close()
      }
    })
  }
  it('opens More on upward drag and releases an action or escapes right', async function () {
    const { page } = await open('/games/g1/score')
    try {
      const trigger = await page.$eval('[aria-label="More"]', node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await page.mouse.move(trigger.x, trigger.y)
      await page.mouse.down()
      await page.mouse.move(trigger.x, trigger.y - 20)
      await page.waitForSelector('[aria-label="Hit by Pitch"]')
      const row = await page.$eval('[aria-label="Hit by Pitch"]', node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await page.mouse.move(row.x, row.y)
      await page.mouse.up()
      await page.waitForSelector('[aria-label="Undo Hit by Pitch"]')
      await waitReady(page)
      expect(await page.$('[aria-label="Finish at-bat"]')).equals(null)
      await page.mouse.move(trigger.x, trigger.y)
      await page.mouse.down()
      await page.mouse.move(trigger.x, trigger.y - 20)
      await page.mouse.move(500, trigger.y - 100)
      await page.mouse.up()
      expect(await page.$('[aria-label="Hit by Pitch"]')).equals(null)
      await click(page, 'More')
      await page.waitForSelector('[aria-label="Hit by Pitch"]')
      await click(page, 'Dismiss More')
    } finally {
      await page.close()
    }
  })
  for (const action of [
    'Hit by Pitch',
    'Intentional Walk',
    "Catcher's Interference",
    // Field-based tiebreaker coverage is in scoringUiPolish.e2e.ts,
    // using the shared Maestro device/browser flow.
    'Put Batter on Base',
    'Balk',
    'Batter Out — Other',
    'Dropped Third Strike'
  ])
    it(`More executes ${action} locally`, async function () {
      const { page, unexpected } = await open('/games/g1/score')
      try {
        if (['Balk', 'Wild Pitch', 'Passed Ball'].includes(action)) {
          await overrideBases(page, [['First base', 'Player 6']])
        }
        if (action === 'Wild Pitch' || action === 'Passed Ball')
          await click(page, 'Ball')
        if (action === 'Dropped Third Strike') {
          await click(page, 'Called Strike')
          await click(page, 'Called Strike')
        }
        await click(page, 'More')
        await click(page, action)
        if (action === 'Put Batter on Base') {
          await click(page, 'Third')
        }
        if (action === 'Dropped Third Strike') {
          await page.waitForSelector(
            '[aria-label="Runner decision for Jordan K."]',
            { timeout: 30000 }
          )
          await click(page, 'Safe')
        }
        if (action === 'Batter Out — Other') {
          await placeOffered(puppeteerDriver(page))
          await click(page, 'Finish defensive play')
        }
        const windowExpected = ![
          'Put Batter on Base',
          'Hit by Pitch',
          'Intentional Walk',
          "Catcher's Interference",
          'Batter Out — Other',
          'Wild Pitch',
          'Passed Ball',
          'Balk'
        ].includes(action)
        if (windowExpected) {
          await page.waitForSelector('[aria-label="Finish at-bat"]', {
            timeout: 30000
          })
          await click(page, 'Finish at-bat')
          await page.waitForSelector('[aria-label*="Batter Player 2"]')
        } else await waitReady(page)
        const expected =
          action === 'Hit by Pitch'
            ? 1
            : action === 'Dropped Third Strike'
              ? 3
              : ['Wild Pitch', 'Passed Ball'].includes(action)
                ? 1
                : 0
        await page.waitForSelector(`[aria-label*="Pitches ${expected}"]`)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
  it('cancels an entire runner draft by button, outside or Escape and commits one edit', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await overrideBases(page, [['First base', 'Player 6']])
      await click(page, 'Ball')
      await waitReady(page)
      const propose = async (): Promise<void> => {
        await dropOfferedRunner(page, 'Safe', true)
        await page.waitForSelector('[aria-label="Steal"]')
        await page.waitForSelector('[role="dialog"]')
      }
      for (const how of ['Cancel', 'Dismiss sheet', 'Escape']) {
        await propose()
        if (how === 'Escape') await page.keyboard.press('Escape')
        else await click(page, how)
        await page.waitForSelector('[aria-label="Steal"]', { hidden: true })
        expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
        expect(await page.$('[aria-label="Safe"]')).equals(null)
        expect(await page.$('[aria-label="Undo Ball"]')).not.equals(null)
      }
      await propose()
      await click(page, 'Steal')
      await waitReady(page)
      await click(page, 'Undo Steal')
      expect(await page.$('[aria-label="Safe"]')).equals(null)
      expect(await page.$('[aria-label="Undo Ball"]')).not.equals(null)
    } finally {
      await page.close()
    }
  })
  it('requires a grab and cancels constrained drags at each base with only one target pair', async function () {
    for (const base of [1, 2, 3]) {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right',
        true
      )
      try {
        await click(page, 'Open scoring menu')
        await click(page, 'Overrides')
        const name = ['', 'First base', 'Second base', 'Third base'][base]
        await click(page, name)
        await click(page, `Choose ${name} Player 6 #6`)
        await click(page, 'Apply Override')
        await click(page, 'Ball')
        await waitReady(page)
        const before = await page.$eval('[aria-label^="Undo "]', node =>
          node.getAttribute('aria-label')
        )
        const rect = await page.$eval('canvas', node => {
          const r = node.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
        const camera = new PerspectiveCamera()
        applyFieldCamera(camera, {
          width: rect.width,
          height: rect.height,
          view: 'home',
          zoom: 1.25,
          tilt: (-11 * Math.PI) / 180,
          heightOffset: 33,
          bottomExtension: 112
        })
        const project = (x: number, y: number, z: number): [number, number] => {
          const p = new Vector3(x, y, z).project(camera)
          return [
            rect.x + ((p.x + 1) * rect.width) / 2,
            rect.y + ((1 - p.y) * rect.height) / 2
          ]
        }
        await page.mouse.click(...project(-60, 0.7, -60))
        expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
        await captureScene(page)
        const from = BASES[base]
        const to = BASES[(base + 1) % 4]
        await page.mouse.move(...project(from.x, 6, from.z))
        await page.mouse.down()
        const locations: number[] = []
        for (const progress of [0.25, 0.75, 0.25, 0]) {
          await page.mouse.move(
            ...project(
              from.x + (to.x - from.x) * progress + (to.z - from.z) * 2,
              0.7,
              from.z + (to.z - from.z) * progress - (to.x - from.x) * 2
            )
          )
          await page.waitForSelector('[aria-label="Safe drag target"]')
          expect(await page.$$('[aria-label="Safe drag target"]')).has.length(1)
          const actual = await page.evaluate(() => {
            const guide = (
              window as unknown as SceneProbeWindow
            ).qaScene!.getObjectByName('move-preview')!
            const marker = guide.getObjectByName('destination-marker')!
            const line = guide.getObjectByName('runner-transition-line')!
            return {
              x: marker.position.x,
              z: marker.position.z,
              line: line.visible
            }
          })
          const expected = progress > 0.5 ? 1 : progress
          expect(actual.x).closeTo(from.x + (to.x - from.x) * expected, 0.1)
          expect(actual.z).closeTo(from.z + (to.z - from.z) * expected, 0.1)
          expect(actual.line).equals(progress > 0)
          const style = await page.$eval(
            '[aria-label="Safe drag target"]',
            n => ({
              height: n.getBoundingClientRect().height,
              size: getComputedStyle(n.firstElementChild!).fontSize,
              weight: getComputedStyle(n.firstElementChild!).fontWeight
            })
          )
          expect(style).deep.equals({ height: 66, size: '21px', weight: '700' })
          locations.push(
            await page.$eval(
              '[aria-label="Safe drag target"]',
              node => node.getBoundingClientRect().y
            )
          )
        }
        expect(locations[0]).equals(locations[2])
        expect(locations[0]).not.equals(locations[1])
        await page.keyboard.press('Escape')
        await page.mouse.up()
        expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
        expect(
          await page.$eval('[aria-label^="Undo "]', node =>
            node.getAttribute('aria-label')
          )
        ).equals(before)
      } finally {
        await page.close()
      }
    }
  })
  it('holds and advances a runner by touch on a phone, resetting the correction window', async function () {
    this.timeout(90000)
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector('[aria-label="Time to edit play"]')!
              .getAttribute('aria-valuenow')
          ) <= 4,
        { timeout: 10000 }
      )
      const rect = await page.$eval('canvas', canvas => {
        const r = canvas.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width: rect.width,
        height: rect.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const project = (base: number, y: number): [number, number] => {
        const point = new Vector3(BASES[base].x, y, BASES[base].z).project(
          camera
        )
        return [
          rect.x + ((point.x + 1) * rect.width) / 2,
          rect.y + ((1 - point.y) * rect.height) / 2
        ]
      }
      const from = project(1, 6)
      const to = project(2, 0)
      await page.touchscreen.touchStart(...from)
      await new Promise(resolve => setTimeout(resolve, 400))
      await page.touchscreen.touchMove(to[0], to[1])
      await page.waitForSelector('[aria-label="Safe drag target"]')
      const safe = await page.$eval('[aria-label="Safe drag target"]', node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await page.touchscreen.touchMove(safe.x, safe.y)
      await page.touchscreen.touchEnd()
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
      await page.waitForSelector(
        '[aria-label="Time to edit play"][aria-valuenow="7"]',
        { timeout: 30000 }
      )
      expect(await page.$('[aria-label="Steal"]')).equals(null)
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Ball"]')!
            .getAttribute('aria-disabled') === 'true'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('keeps gray bottom controls inert throughout fielding and trajectory decisions', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Batter Out')
      await click(page, 'Ground Out')
      const reject = async (): Promise<void> => {
        const undo = await page.$eval('[aria-label^="Undo "]', n =>
          n.getAttribute('aria-label')
        )
        for (const label of [
          'Ball',
          'Called Strike',
          'Swing and Miss',
          'Foul Ball',
          'More',
          'Swing in Play',
          'Bunt in Play'
        ]) {
          const selector = `[aria-label="${label}"]`
          const point = await page.$eval(selector, n => {
            const r = n.getBoundingClientRect()
            return {
              x: r.x + r.width / 2,
              y: r.y + r.height / 2,
              disabled:
                n.getAttribute('aria-disabled') === 'true' ||
                (n instanceof HTMLButtonElement && n.disabled)
            }
          })
          expect(point.disabled, label).equals(true)
          await page.mouse.move(point.x, point.y)
          await page.mouse.down()
          await page.mouse.move(point.x, point.y - 30)
          await page.mouse.up()
          await page.$eval(selector, n => {
            ;(n as HTMLElement).click()
          })
          await page.$eval(selector, n =>
            n.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
            )
          )
        }
        expect(await page.$('[role="menu"]')).equals(null)
        expect(
          await page.$eval('[aria-label^="Undo "]', n =>
            n.getAttribute('aria-label')
          )
        ).equals(undo)
      }
      await reject()
      await tapOffered(puppeteerDriver(page))
      await reject()
      await setTrajectory(puppeteerDriver(page))
      await reject()
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]',
        { timeout: 20000 }
      )
      await reject()
      await page.locator('[aria-label^="Undo "]').click()
    } finally {
      await page.close()
    }
  })
  for (const caught of [false, true]) {
    it(`arrives ${caught ? 'before catch' : 'after landing'} on the live field`, async function () {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right',
        true
      )
      try {
        await click(page, 'Swing in Play')
        if (caught) {
          await click(page, 'Batter Out')
          await click(page, 'Ball Caught')
        } else await click(page, 'Single')
        // The pitcher takes it some thirty feet out.
        const field = puppeteerDriver(page)
        await placeOffered(field, 0, 60)
        const target = await readGuide(page)
        const samplesPromise = page.evaluate(
          async () =>
            await new Promise<Array<{ z: number; gap: number; fz: number }>>(
              resolve => {
                const scene = (window as unknown as SceneProbeWindow).qaScene!
                const out: Array<{ z: number; gap: number; fz: number }> = []
                let seen = false
                const run = (): void => {
                  const ball = scene.getObjectByName('animated-baseball')
                  const fielder = scene.getObjectByName('player-defense-10')
                  if (ball != null && ball.visible && fielder != null) {
                    seen = true
                    out.push({
                      z: ball.position.z,
                      fz: fielder.position.z,
                      gap: Math.hypot(
                        ball.position.x - fielder.position.x,
                        ball.position.z - fielder.position.z
                      )
                    })
                  }
                  if (seen && ball == null) resolve(out)
                  else requestAnimationFrame(run)
                }
                run()
              }
            )
        )
        await setTrajectory(field)
        const samples = await samplesPromise
        const moving = samples
          .filter(p => p.z < -3 && p.z > target.z / 2)
          .at(-1)
        expect(moving, 'defender starts during early ball flight').not.equals(
          undefined
        )
        expect(moving!.fz).lessThan(-18.44)
        const landing = samples.filter(p => Math.abs(p.z - target.z) < 0.01)
        if (caught) {
          expect(landing.length).equals(0)
          expect(samples.at(-1)!.gap).lessThan(3)
        } else {
          expect(landing.length).greaterThan(1)
          expect(landing[0].gap).greaterThan(0.1)
          expect((landing[0].fz + 18.44) / (target.z + 18.44)).closeTo(
            0.8,
            0.08
          )
          expect(landing.at(-1)!.gap).lessThan(landing[0].gap)
        }
        await page.locator('[aria-label^="Undo "]').click()
      } finally {
        await page.close()
      }
    })
  }
  for (const outside of [false, true]) {
    it(`celebrates ${outside ? 'stands' : 'in-park'} home run on the LED scoreboard`, async function () {
      this.timeout(90000)
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        outside ? 'left' : 'right',
        true
      )
      try {
        await page.setViewport(
          outside ? { width: 844, height: 390 } : { width: 390, height: 844 }
        )
        await click(page, 'Swing in Play')
        await click(page, 'Home Run')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        const target = await readGuide(page)
        expect(Math.hypot(target.x, target.z)).closeTo(113.5, 0.01)
        expect(target.bearing).closeTo(outside ? 15 : -15, 0.01)
        // On the guide, or fifteen feet past it into the stands.
        await aimLandingAt(page, target.x, target.z - (outside ? 15 : 0))
        await setTrajectory(puppeteerDriver(page))
        await page.waitForFunction(
          () =>
            (window as unknown as SceneProbeWindow).qaScene!.getObjectByName(
              'home-run-celebration'
            ) != null
        )
        expect(await page.$('[aria-label^="Ball trajectory:"]')).equals(null)
        const samples = (await page.evaluate(async () => {
          const scene = (window as unknown as SceneProbeWindow).qaScene!
          const sample = (): unknown => {
            const lights = scene.getObjectByName(
              'home-run-fireworks'
            )! as unknown as { instanceMatrix: { array: ArrayLike<number> } }
            const text = scene.getObjectByName(
              'home-run-letters'
            )! as unknown as {
              material: {
                opacity: number
                map: { image: { data: ArrayLike<number> } }
              }
            }
            return {
              matrix: Array.from(lights.instanceMatrix.array),
              opacity: text.material.opacity,
              pixels: Array.from(text.material.map.image.data)
            }
          }
          const before = sample()
          await new Promise(resolve => setTimeout(resolve, 300))
          return { before, after: sample() }
        })) as {
          before: { matrix: number[]; opacity: number; pixels: number[] }
          after: { matrix: number[]; opacity: number; pixels: number[] }
        }
        expect(samples.before.matrix).not.deep.equals(samples.after.matrix)
        expect(samples.before.opacity).not.equals(samples.after.opacity)
        expect(samples.before.pixels).deep.equals(samples.after.pixels)
        await page.screenshot({
          path: join(
            process.env.TS_SCORING_ARTIFACT_DIR!,
            `celebration-${outside ? 'stands' : 'park'}.png`
          )
        })
        await page.waitForFunction(
          () =>
            (window as unknown as SceneProbeWindow).qaScene!.getObjectByName(
              'home-run-celebration'
            ) == null,
          { timeout: 10000 }
        )
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 45000
        })
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      } finally {
        await page.close()
      }
    })
  }
  it('defaults home-run guidance by batting side and eases through the center gap', async function () {
    this.timeout(150000)
    for (const bats of ['right', 'left'] as const) {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        bats,
        true
      )
      try {
        await click(page, 'Swing in Play')
        await click(page, 'Home Run')
        await page.waitForSelector('canvas[data-field-ready="true"]')
        expect((await readGuide(page)).bearing).closeTo(
          bats === 'right' ? -15 : 15,
          0.01
        )
        // The landing is held and moved in three-foot steps towards the
        // middle, where the guide's bearing eases across the center gap.
        const guide = await readGuide(page)
        const toward = bats === 'right' ? 3 : -3
        let x = guide.x
        const moveTo = async (to: number): Promise<void> => {
          x = to
          await page.mouse.move(...(await groundPoint(page, x, guide.z)), {
            steps: 3
          })
        }
        await page.mouse.move(...(await groundPoint(page, x, guide.z)))
        await page.mouse.down()
        await moveTo(x + toward / 3)
        await moveTo(guide.x)
        for (let i = 0; i < 9; i++) {
          await moveTo(x + toward)
          await new Promise(resolve => setTimeout(resolve, 60))
        }
        await page.waitForFunction(() => {
          const arc = (
            window as unknown as SceneProbeWindow
          ).qaScene!.getObjectByName('ball-arc')!
          return Math.abs(Math.abs(Number(arc.userData.bearing)) - 5) < 0.01
        })
        const start = await readGuide(page)
        expect(start.bearing).closeTo(bats === 'right' ? -5 : 5, 0.01)
        for (const step of [toward, -toward]) {
          const samples = page.evaluate(
            async () =>
              await new Promise<number[]>(resolve => {
                const out: number[] = []
                const sample = (): void => {
                  out.push(
                    Number(
                      (
                        window as unknown as SceneProbeWindow
                      ).qaScene!.getObjectByName('ball-arc')!.userData.bearing
                    )
                  )
                  if (out.length < 35) requestAnimationFrame(sample)
                  else resolve(out)
                }
                requestAnimationFrame(sample)
              })
          )
          await moveTo(x + step)
          const values = await samples
          expect(
            values.some(
              value => Math.abs(value) > 0.05 && Math.abs(value) < 4.95
            )
          ).equals(true)
          expect(Math.abs(values.at(-1)!)).closeTo(5, 0.01)
        }
        const final = await readGuide(page)
        expect(final.x).closeTo(start.x, 0.01)
        expect(final.z).closeTo(start.z, 0.01)
        await page.mouse.up()
        await setTrajectory(puppeteerDriver(page))
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 45000
        })
        for (let undo = 0; undo < 4; undo++) {
          if (
            await page.$eval(
              '[aria-label="Swing in Play"]',
              n => n.getAttribute('aria-disabled') !== 'true'
            )
          )
            break
          await page.locator('[aria-label^="Undo "]').click()
        }
        await click(page, 'Swing in Play')
        await click(page, 'Single')
        await tapOffered(puppeteerDriver(page))
        await page.waitForSelector('[aria-label^="Ball trajectory:"]')
        const central = await readGuide(page)
        expect(central.x).equals(0)
        expect(Math.abs(central.bearing)).equals(5)
        await setTrajectory(puppeteerDriver(page))
        await page.waitForSelector('[aria-label="Finish at-bat"]', {
          timeout: 45000
        })
        await click(page, 'Finish at-bat')
      } finally {
        await page.close()
      }
    }
  })
  for (const outside of [false, true])
    for (const loaded of [false, true]) {
      it(`classifies ${outside ? 'stands' : 'in-park'} home run with ${loaded ? 'loaded' : 'empty'} bases and finishes automatically`, async function () {
        this.timeout(90000)
        const { page } = await open('/games/g1/score')
        try {
          await page.setViewport({ width: 390, height: 844 })
          if (loaded) {
            await overrideBases(page, [
              ['First base', 'Player 6'],
              ['Second base', 'Player 7'],
              ['Third base', 'Player 8']
            ])
          }
          await click(page, 'Swing in Play')
          await click(page, 'Home Run')
          await page.waitForSelector('canvas[data-field-ready="true"]')
          const rect = await page.$eval('canvas', node => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height }
          })
          const camera = new PerspectiveCamera()
          applyFieldCamera(camera, {
            ...rect,
            view: 'home',
            zoom: 1.25,
            tilt: (-11 * Math.PI) / 180,
            heightOffset: 33,
            bottomExtension: 112
          })
          const project = (
            x: number,
            z: number,
            y: number
          ): [number, number] => {
            const p = new Vector3(x, y, z).project(camera)
            return [
              rect.x + ((p.x + 1) * rect.width) / 2,
              rect.y + ((1 - p.y) * rect.height) / 2
            ]
          }
          // Start away from the target; apply a screen-space displacement from
          // the initial landing rather than aiming directly under the mouse.
          const origin = project(loaded ? 32 : -32, -25, 0)
          const initialTarget = initialHitTarget('R')
          const initial = project(initialTarget.x, initialTarget.z, 0.7)
          const target = project(0, outside ? -133 : -100, outside ? 8 : 0.7)
          await page.mouse.move(...origin)
          await page.mouse.down()
          await page.waitForSelector(
            '[aria-label="Home run type: In-the-park Home Run"]'
          )
          await page.mouse.move(
            origin[0] + target[0] - initial[0],
            origin[1] + target[1] - initial[1],
            { steps: 10 }
          )
          await page.waitForSelector(
            `[aria-label="Home run type: ${outside ? 'Home Run' : 'In-the-park Home Run'}"]`
          )
          await page.mouse.up()
          await setTrajectory(puppeteerDriver(page))
          await page.waitForSelector('[aria-label*="Batter Player 2"]', {
            timeout: 45000
          })
          await page.waitForSelector(
            `[aria-label*="Owls ${loaded ? 4 : 1} · Hawks 0"]`
          )
          expect(await page.$('[aria-label="Safe"]')).equals(null)
          expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
          await page.locator('[aria-label^="Undo "]').click()
          expect(await page.$('[aria-label*="Batter Player 2"]')).equals(null)
        } finally {
          await page.close()
        }
      })
    }
  it('scores all four loaded home-run arrivals automatically on a phone', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await overrideBases(page, [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ])
      await chooseHit(page, 'Home Run')
      await page.waitForSelector('[aria-label*="Owls 4 · Hawks 0"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      expect(await page.$('[aria-label="Safe"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('backs up a legal home arrival', async function () {
    this.timeout(120000)
    const rollback = await open('/games/g1/score')
    const tap = async (label: string): Promise<void> => {
      await rollback.page
        .locator(`[aria-label="${label}"]:not([aria-disabled="true"])`)
        .click()
    }
    try {
      await overrideBases(rollback.page, [
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ])
      await chooseHit(rollback.page, 'Single')
      await rollback.page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      if (process.env.RUNNER_CONTROLS_ARTIFACT_DIR != null) {
        await rollback.page.setViewport({ width: 402, height: 579 })
        await new Promise(resolve => setTimeout(resolve, 500))
        await rollback.page.screenshot({
          path: join(
            process.env.RUNNER_CONTROLS_ARTIFACT_DIR,
            `home-${process.env.RUNNER_CONTROLS_STAGE ?? 'after'}.png`
          )
        })
      }
      await tap('Back')
      await rollback.page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await rollback.page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
    } finally {
      await rollback.page.close()
    }
  })
  for (const [mask, outIds] of [
    [1, [6]],
    [2, [7]],
    [3, [6]],
    [4, []],
    [5, [6]],
    [6, [7]],
    [7, []],
    [7, [6, 7]],
    [7, [8]]
  ] as Array<[number, number[]]>)
    it(`completes fielder choice bases ${mask}, runners out ${outIds.length === 0 ? 'none' : outIds.join(',')}, then reloads the saved play`, async function () {
      this.timeout(120000)
      const { page, unexpected } = await open('/games/g1/score')
      const saves: Array<
        Promise<{
          plays?: Array<{
            matchup: { batter: { id: number } }
            runners: Array<{
              details: { runner: { id: number; fullName: string } }
              movement: { isOut: boolean }
            }>
            result: { awayScore: number }
            teamStation: {
              detail: {
                fieldingRoute: Array<{
                  player: { id: number }
                  location: { x: number; z: number }
                }>
              }
            }
          }>
        }>
      > = []
      page.on('request', request => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname.endsWith('/events')
        )
          saves.push(
            request.fetchPostData().then(body => JSON.parse(body ?? '{}'))
          )
      })
      // Locators wait for sheet controls to finish moving before pointer input.
      const tap = async (label: string): Promise<void> => {
        await page
          .locator(`[aria-label="${label}"]:not([aria-disabled="true"])`)
          .click()
      }
      try {
        await overrideBases(
          page,
          (['First base', 'Second base', 'Third base'] as const).flatMap(
            (base, index) =>
              (mask & (1 << index)) !== 0
                ? [
                    [base, `Player ${index + 6}`] as [
                      'First base' | 'Second base' | 'Third base',
                      string
                    ]
                  ]
                : []
          )
        )
        await chooseHit(page, "Fielder's Choice")
        await page.waitForSelector(
          '[aria-label^="Tap or drag each defender"]',
          { timeout: 30000 }
        )
        expect(
          await page.$('[aria-label^="Fielder\'s choice decision for"]')
        ).equals(null)
        expect(await page.$('[aria-label^="Drag batter to a base"]')).equals(
          null
        )
        await placeOffered(puppeteerDriver(page), 1)
        await page.waitForSelector(
          '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
        )
        if (mask === 3) {
          await placeOffered(puppeteerDriver(page), 1)
          await page.waitForSelector(
            '[aria-label="Finish defensive play"]:not([aria-disabled="true"])'
          )
        }
        await click(page, 'Finish defensive play')
        await page.waitForSelector(
          '[aria-label^="Mark each runner Safe or Out"]',
          { timeout: 30000 }
        )
        const ids = [6, 7, 8].filter((_, index) => (mask & (1 << index)) !== 0)
        expect(
          await page.$$('[aria-label^="Fielder\'s choice decision for"]')
        ).length(ids.length)
        expect(await page.$('[aria-label="Out Player 1"]')).equals(null)
        if (
          mask === 7 &&
          outIds.length === 0 &&
          process.env.CHOICE_ARTIFACT_DIR != null
        )
          await page.screenshot({
            path: join(
              process.env.CHOICE_ARTIFACT_DIR,
              'loaded-bases-after.png'
            )
          })
        if (mask === 7 && outIds.length === 0) {
          if (process.env.RUNNER_CONTROLS_ARTIFACT_DIR != null) {
            for (const [name, viewport] of [
              ['portrait', { width: 402, height: 579 }],
              ['landscape', { width: 844, height: 390 }]
            ] as const) {
              await page.setViewport(viewport)
              await new Promise(resolve => setTimeout(resolve, 500))
              await page.screenshot({
                path: join(
                  process.env.RUNNER_CONTROLS_ARTIFACT_DIR,
                  `${name}-${process.env.RUNNER_CONTROLS_STAGE ?? 'after'}.png`
                )
              })
            }
          }
          for (const viewport of [
            { width: 402, height: 579 },
            { width: 844, height: 390 },
            { width: 1200, height: 900 },
            { width: 800, height: 450 },
            { width: 390, height: 640 },
            { width: 568, height: 320 },
            { width: 874, height: 292 }
          ]) {
            await page.setViewport(viewport)
            if (process.env.RUNNER_CONTROLS_ARTIFACT_DIR != null) {
              await new Promise(resolve => setTimeout(resolve, 500))
              console.log(
                'Runner decision hit targets',
                viewport,
                await page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll(
                      '[aria-label^="Fielder\'s choice decision for"] [role="button"]'
                    )
                  ).map(button => {
                    const box = button.getBoundingClientRect()
                    const hit = document.elementFromPoint(
                      box.x + box.width / 2,
                      box.y + box.height / 2
                    )
                    return {
                      label: button.getAttribute('aria-label'),
                      rect: box.toJSON(),
                      // Browser callbacks cannot reference Sucrase helpers.

                      hit: hit == null ? null : hit.getAttribute('aria-label'),

                      text: hit == null ? null : hit.textContent
                    }
                  })
                )
              )
            }
            await page.waitForFunction(() => {
              const buttons = Array.from(
                document.querySelectorAll(
                  '[aria-label^="Fielder\'s choice decision for"] [role="button"]'
                )
              )
              return (
                buttons.length === 6 &&
                buttons.every((button, index) => {
                  const box = button.getBoundingClientRect()
                  const hit = document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2
                  )
                  return (
                    hit != null &&
                    button.contains(hit) &&
                    buttons.slice(index + 1).every(other => {
                      const target = other.getBoundingClientRect()
                      return (
                        box.right <= target.left ||
                        target.right <= box.left ||
                        box.bottom <= target.top ||
                        target.bottom <= box.top
                      )
                    })
                  )
                })
              )
            })
            const placements = await page.evaluate(() =>
              [6, 7, 8].map(id => {
                const group = document.querySelector(
                  `[aria-label="Fielder's choice decision for Player ${id}"]`
                )!
                const plate = document.querySelector(
                  `[data-nameplate="offense-${100 + id}"]`
                )!
                return {
                  control: group.getBoundingClientRect().toJSON(),
                  runner: plate.getBoundingClientRect().toJSON(),
                  text: group.textContent,
                  background: getComputedStyle(group).backgroundColor
                }
              })
            )
            expect(placements[0].control.bottom).lessThan(
              placements[0].runner.top
            )
            expect(placements[1].control.right).at.most(
              placements[1].runner.left
            )
            expect(placements[2].control.left).at.least(
              placements[2].runner.right
            )
            for (const placed of placements) {
              expect(placed.text).equals('SafeOut')
              expect(placed.background).equals('rgba(0, 0, 0, 0)')
            }
          }
          const controls = await page.$$(
            '[aria-label^="Fielder\'s choice decision for"] [role="button"]'
          )
          for (const control of controls) {
            const box = await control.boundingBox()
            expect(box).not.equals(null)
            expect(box!.y).at.least(0)
            expect(box!.y + box!.height).at.most(292)
          }
        }
        for (const id of ids) {
          await tap(`${outIds.includes(id) ? 'Out' : 'Safe'} Player ${id}`)
          if (outIds.includes(id)) {
            await page.waitForSelector('[aria-label^="Putout by"]')
            if (mask === 3 && id === 6) {
              await tap('Cancel')
              await tap(`Out Player ${id}`)
              await page.waitForSelector('[aria-label^="Putout by"]')
            }
            if (
              mask === 7 &&
              outIds.includes(6) &&
              id === 6 &&
              process.env.CHOICE_ARTIFACT_DIR != null
            )
              await page.screenshot({
                path: join(
                  process.env.CHOICE_ARTIFACT_DIR,
                  'putout-picker-after.png'
                )
              })
            const choices = await page.$$('[aria-label^="Putout by"]')
            const label = await choices[
              mask === 3 ? 1 : choices.length - 1
            ].evaluate(node => node.getAttribute('aria-label')!)
            await tap(label)
          }
        }
        await page.setViewport({ width: 1200, height: 900 })
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
        await click(page, 'Finish at-bat')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        const expectedRuns = (mask & 4) !== 0 && !outIds.includes(8) ? 1 : 0
        await page.waitForSelector(
          `[aria-label*="Owls ${expectedRuns} · Hawks 0"]`
        )
        const bodies = await Promise.all(saves)
        const play = bodies.flatMap(body => body.plays ?? []).at(-1)!
        expect(play, 'saved completed choice').not.equals(undefined)
        expect(play.runners.filter(row => row.movement.isOut)).length(
          outIds.length
        )
        expect(
          play.runners.some(
            row =>
              row.details.runner.id === play.matchup.batter.id &&
              row.movement.isOut
          )
        ).equals(false)
        expect(play.result.awayScore).equals(expectedRuns)
        const route = play.teamStation.detail.fieldingRoute
        expect(route).length(mask === 3 ? 3 : 2)
        expect(
          route.every(
            hop =>
              Number.isFinite(hop.location.x) && Number.isFinite(hop.location.z)
          )
        ).equals(true)
        const loadedEvents = page.waitForResponse(
          response =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname.endsWith('/games/g1/events')
        )
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 })
        const loaded = (await (await loadedEvents).json()) as {
          plays: Array<{
            gumbo: { teamStation: { detail: { fieldingRoute: typeof route } } }
          }>
        }
        expect(
          loaded.plays.at(-1)!.gumbo.teamStation.detail.fieldingRoute
        ).deep.equals(route)
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        await page.waitForSelector(
          `[aria-label*="Owls ${expectedRuns} · Hawks 0"]`
        )
        expect(await page.$('[aria-label^="Home plate decision"]')).equals(null)
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })

  for (const [decision, advance, reasons] of [
    [
      'Safe',
      true,
      [
        'Steal',
        'Wild Pitch',
        'Passed Ball',
        'Throwing Error',
        'Fielding Error',
        'Defensive Indifference',
        'Other'
      ]
    ],
    [
      'Out',
      true,
      ['Caught Stealing', 'Offensive Interference', 'Out on Appeal', 'Other']
    ],
    [
      'Out',
      false,
      ['Picked Off', 'Offensive Interference', 'Out on Appeal', 'Other']
    ]
  ] as const)
    for (const reason of reasons)
      it(`records ${advance ? 'advanced' : 'stationary'} ${decision}: ${reason} between pitches`, async function () {
        const { page, unexpected } = await open('/games/g1/score')
        try {
          await overrideBases(page, [['First base', 'Player 6']])
          await click(page, 'Ball')
          await waitReady(page)
          await dropOfferedRunner(page, decision, advance)
          await click(page, reason)
          if (reason === 'Wild Pitch')
            await click(page, 'Use previous pitch as wild pitch')
          else if (reason === 'Passed Ball') await click(page, 'YES')
          else if (reason === 'Throwing Error' || reason === 'Fielding Error')
            await placeOffered(puppeteerDriver(page))
          if (decision === 'Out') {
            await page.waitForSelector(
              '[aria-label^="Tap or drag a player to where the ball was fielded."]'
            )
            await placeOffered(puppeteerDriver(page))
            await page.waitForSelector(
              '[aria-label^="Tap or drag the next defender"]'
            )
            await placeOffered(puppeteerDriver(page), 1)
            await click(page, 'Finish defensive play')
          }
          await waitReady(page)
          await page.waitForSelector(
            `[aria-label*="1 balls 0 strikes ${decision === 'Out' ? 1 : 0} outs · Pitches 1"]`
          )
          await page.waitForSelector('[aria-label*="Batter Jordan K"]')
          expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
          await page.locator('[aria-label^="Undo "]').click()
          await page.waitForSelector('[aria-label="Undo Ball"]')
          await page.waitForSelector(
            '[aria-label*="1 balls 0 strikes 0 outs · Pitches 1"]'
          )
          expect(unexpected).deep.equals([])
        } finally {
          await page.close()
        }
      })
  for (const sameDefender of [true, false])
    it(`retires a current-play runner with ${sameDefender ? 'one defender' : 'an assist'} and finishes when no runners remain`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        await chooseHit(page, 'Double')
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await dropOfferedRunner(page, 'Out')
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await new Promise(resolve => setTimeout(resolve, 10500))
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        if (!sameDefender) await placeOffered(puppeteerDriver(page), 1)
        await click(page, 'Finish defensive play')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        await page.waitForSelector('[aria-label*="0 balls 0 strikes 1 outs"]')
      } finally {
        await page.close()
      }
    })
  describe('did not tag up', function () {
    const returnOutReasons = [
      'Did Not Tag Up',
      'Offensive Interference',
      'Out on Appeal',
      'Other'
    ]
    async function phoneWithRunnerOnFirst(page: Page): Promise<void> {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await overrideBases(page, [['First base', 'Player 6']])
      await page.waitForSelector('canvas[data-field-ready="true"]')
    }
    async function caughtFly(page: Page): Promise<void> {
      await click(page, 'Swing in Play')
      await click(page, 'Batter Out')
      await click(page, 'Ball Caught')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await placeOffered(puppeteerDriver(page))
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      await setTrajectory(puppeteerDriver(page))
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
    }
    /** Holds the runner on `base` and lets go on the Out target beside him. */
    async function holdRunnerOut(page: Page, base: 1 | 2): Promise<void> {
      const [x, y] = await projectBase(page, base, 6)
      await page.touchscreen.touchStart(x, y)
      await new Promise(resolve => setTimeout(resolve, 450))
      await page.waitForSelector('[aria-label="Out drag target"]')
      const out = await page.$eval('[aria-label="Out drag target"]', e => {
        const r = e.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await page.touchscreen.touchMove(out.x, out.y)
      await page.touchscreen.touchEnd()
    }
    async function shot(page: Page, name: string): Promise<void> {
      const directory = process.env.TS_SCORING_ARTIFACT_DIR
      if (directory == null) return
      await new Promise(resolve => setTimeout(resolve, 900))
      await page.screenshot({ path: join(directory, `${name}.png`) })
    }
    it('records a runner returning to first on a caught fly as doubled off', async function () {
      this.timeout(120000)
      const { page } = await open('/games/g1/score')
      interface SavedPlay {
        result: { eventType: string }
        runners: Array<{
          movement: { isOut: boolean }
          details: { movementReason: string | null }
        }>
      }
      const saves: Array<Promise<{ plays?: SavedPlay[] }>> = []
      page.on('request', request => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname.endsWith('/events')
        )
          saves.push(
            request.fetchPostData().then(body => JSON.parse(body ?? '{}'))
          )
      })
      try {
        await phoneWithRunnerOnFirst(page)
        await caughtFly(page)
        await holdRunnerOut(page, 1)
        await shot(page, 'did-not-tag-up-after')
        for (const reason of returnOutReasons)
          await page.waitForSelector(`[aria-label="${reason}"]`)
        expect(await page.$('[aria-label="Picked Off"]')).equals(null)
        await tapSettled(page, 'Did Not Tag Up')
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        await placeOffered(puppeteerDriver(page), 1)
        await click(page, 'Finish defensive play')
        await page.waitForSelector('[aria-label*="0 balls 0 strikes 2 outs"]')
        await shot(page, 'did-not-tag-up-recorded')
        await page.waitForSelector('[aria-label^="Undo Out by "]')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        // The outbox posts the closed play on its own schedule: wait for it.
        let play: SavedPlay | undefined
        for (let wait = 0; play == null && wait < 60; wait++) {
          play = (await Promise.all(saves))
            .flatMap(body => body.plays ?? [])
            .find(row => row.result.eventType === 'double_play')
          if (play == null)
            await new Promise(resolve => setTimeout(resolve, 250))
        }
        expect(play, 'saved double play').not.equals(undefined)
        expect(
          play!.runners
            .filter(row => row.movement.isOut)
            .map(row => row.details.movementReason)
        ).includes('r_doubled_off')
      } finally {
        await page.close()
      }
    })
    it('keeps the runner on first when the reason menu is closed', async function () {
      this.timeout(90000)
      const { page } = await open('/games/g1/score')
      try {
        await phoneWithRunnerOnFirst(page)
        await caughtFly(page)
        await holdRunnerOut(page, 1)
        await page.waitForSelector('[aria-label="Did Not Tag Up"]')
        await tapSettled(page, 'Cancel')
        await page.waitForSelector('[aria-label="Did Not Tag Up"]', {
          hidden: true
        })
        await page.waitForSelector('[aria-label="Time to edit play"]')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 30000
        })
        await page.waitForSelector('[aria-label*="0 balls 0 strikes 1 outs"]')
      } finally {
        await page.close()
      }
    })
    it('asks no reason for a runner put out at his base after a single', async function () {
      this.timeout(90000)
      const { page } = await open('/games/g1/score')
      try {
        await phoneWithRunnerOnFirst(page)
        await chooseHit(page, 'Single')
        await page.waitForSelector('[aria-label="Time to edit play"]', {
          timeout: 30000
        })
        await holdRunnerOut(page, 2)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender"]'
        )
        expect(await page.$('[aria-label="Did Not Tag Up"]')).equals(null)
      } finally {
        await page.close()
      }
    })
    it('offers no Did Not Tag Up between pitches', async function () {
      this.timeout(90000)
      const { page } = await open('/games/g1/score')
      try {
        await phoneWithRunnerOnFirst(page)
        await click(page, 'Ball')
        await waitReady(page)
        await holdRunnerOut(page, 1)
        await page.waitForSelector('[aria-label="Picked Off"]')
        expect(await page.$('[aria-label="Did Not Tag Up"]')).equals(null)
      } finally {
        await page.close()
      }
    })
  })
  for (const walk of [true, false])
    it(`completes a terminal ${walk ? 'walk' : 'strikeout'} with the appropriate play completion`, async function () {
      const { page } = await open('/games/g1/score')
      try {
        for (let i = 0; i < (walk ? 4 : 3); i++)
          await click(page, walk ? 'Ball' : 'Called Strike')
        await page.waitForSelector('[aria-label*="Batter Player 2"]', {
          timeout: 20000
        })
        await page.waitForSelector(
          `[aria-label*="0 balls 0 strikes ${walk ? 0 : 1} outs · Pitches ${walk ? 4 : 3}"]`
        )
        expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
        await page.locator('[aria-label^="Undo "]').click()
        await page.waitForSelector(
          `[aria-label*="${walk ? '3 balls 0' : '0 balls 2'} strikes 0 outs"]`
        )
      } finally {
        await page.close()
      }
    })
  for (const logos of ['valid', 'broken', undefined] as const) {
    it(`keeps team colors and dugout identities across halves with ${logos ?? 'absent'} logos`, async function () {
      const { page, unexpected } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right',
        true,
        logos
      )
      try {
        await page.setViewport({ width: 390, height: 844 })
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await captureScene(page)
        if (logos === 'valid')
          await page.waitForFunction(() =>
            Boolean(
              (window as unknown as SceneProbeWindow).qaScene!.getObjectByName(
                'dugout-logo-home'
              )
            )
          )
        for (const half of ['top', 'bottom']) {
          const data = await page.evaluate(() => {
            const scene = (window as unknown as SceneProbeWindow).qaScene!
            const color = (name: string): string =>
              (
                (
                  scene
                    .getObjectByName(name)!
                    .getObjectByName('jersey-torso') as Mesh
                ).material as MeshStandardMaterial
              ).color.getHexString()
            const heads: string[] = []
            scene.traverse(n => {
              if (n.name === 'dugout-head') heads.push(n.name)
            })
            return {
              offense: color(
                'player-offense-' +
                  (scene.getObjectByName('player-offense-1') == null
                    ? '10'
                    : '1')
              ),
              defense: color(
                'player-defense-' +
                  (scene.getObjectByName('player-defense-10') == null
                    ? '1'
                    : '10')
              ),
              heads: heads.length,
              logos: ['away', 'home'].filter(
                s => scene.getObjectByName('dugout-logo-' + s) != null
              )
            }
          })
          expect(data.offense).equals(half === 'top' ? '294c78' : 'b74242')
          expect(data.defense).equals(half === 'top' ? 'b74242' : '294c78')
          expect(data.heads).equals(6)
          expect(data.logos).has.length(logos === 'valid' ? 2 : 0)
          await page.screenshot({
            path: join(
              process.env.TS_SCORING_ARTIFACT_DIR ?? '/tmp',
              `dugouts-${logos ?? 'absent'}-${half}.png`
            )
          })
          if (half === 'top') {
            await click(page, 'Open scoring menu')
            await click(page, 'End Half Inning')
            await click(page, 'Confirm End Half Inning')
            await page.waitForFunction(() =>
              document.body.textContent!.includes('Bottom')
            )
          }
        }
        expect(unexpected).deep.equals([])
      } finally {
        await page.close()
      }
    })
  }
  it('confirms and undoes a manual half and a runner-only third out', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'End Half Inning')
      await click(page, 'Cancel')
      await page.waitForSelector('[aria-label*="Top 1st"]')
      await click(page, 'Open scoring menu')
      await click(page, 'End Half Inning')
      await click(page, 'Confirm End Half Inning')
      await page.waitForSelector('[aria-label*="Bottom 1st"]')
      await page.locator('[aria-label^="Undo "]').click()
      await page.waitForSelector('[aria-label*="Top 1st"]')
      await overrideBases(page, [['First base', 'Player 6']])
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'Outs 2')
      await click(page, 'Apply Override')
      // A pitch locks the switch hitter, leaving the base runner selectable.
      await click(page, 'Ball')
      await waitReady(page)
      await dropOfferedRunner(page, 'Out')
      await click(page, 'Picked Off')
      await placeOffered(puppeteerDriver(page))
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label*="Bottom 1st"]', {
        timeout: 30000
      })
      await page.locator('[aria-label^="Undo "]').click()
      await page.waitForSelector('[aria-label*="Top 1st"]')
      await page.waitForSelector('[aria-label*="2 outs"]')
    } finally {
      await page.close()
    }
  })
  it('waits when the next lineup batter is on base after a strikeout, then repairs through Overrides', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await overrideBases(page, [['First base', 'Player 2']])
      for (let i = 0; i < 3; i++) await click(page, 'Called Strike')
      await page.waitForSelector('[aria-label^="Next batter is on base."]', {
        timeout: 30000
      })
      expect(
        await page.$eval('[aria-label="Ball"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'Batter')
      expect(
        await page.$eval('[aria-label="2. Player 2 #2"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, '3. Player 3 #3')
      await click(page, 'Apply Override')
      await page.waitForSelector('[aria-label*="Batter Player 3"]')
    } finally {
      await page.close()
    }
  })
  it('hides scoring for nonzero scores and recovers failed roster reads', async function () {
    const scored = await open('/games/g1', 7)
    try {
      await scored.page.waitForSelector('[aria-label="Box score"]')
      expect(await scored.page.$('[aria-label="Score"]')).equals(null)
    } finally {
      await scored.page.close()
    }
    const { page } = await open('/games/g1/score', false, false, true)
    try {
      await page.waitForSelector('[aria-label*="Owls 0 · Hawks 0"]')
      await page.waitForSelector('[aria-label*="Batter Player 1"]')
      await click(page, 'Ball')
      await page.waitForSelector('[aria-label*="1 balls"]')
    } finally {
      await page.close()
    }
  })
  it('rejects invalid lineups, pitchers and base occupants, and restores a moving play with Undo', async function () {
    this.timeout(90000)
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      await click(page, 'Remove Jordan K.')
      for (let i = 2; i <= 9; i++) await click(page, `Remove Player ${i}`)
      // Incomplete setup is now saveable; readiness blocks scoring until repaired.
      expect(
        await page.$eval('[aria-label="Save Rosters"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).not.equals('true')
      await click(page, 'Add Jordan K. to Lineup')
      await click(page, 'Defense')
      await click(page, 'Clear P')
      expect(
        await page.$eval('[aria-label="Save Rosters"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).not.equals('true')
      await click(page, 'Cancel')
      await overrideBases(page, [['First base', 'Player 6']])
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'Batter')
      expect(
        await page.$eval('[aria-label="6. Player 6 #6"]', node =>
          node.getAttribute('aria-disabled')
        )
      ).equals('true')
      await click(page, 'Cancel')
      await click(page, 'Cancel')
      await click(page, 'Undo Override game state')
      await chooseHit(page, 'Home Run')
      await click(page, 'Undo 45° Fly Ball')
      await click(page, 'Undo Home-run landing')
      await new Promise(resolve => setTimeout(resolve, 11000))
      await page.waitForSelector('[aria-label^="Drag where the ball was hit"]')
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await click(page, 'Undo Home Run')
      await page.waitForSelector(
        '[aria-label*="0 balls 0 strikes 0 outs · Pitches 0"]'
      )
    } finally {
      await page.close()
    }
  })
  it('completes a tapped caught pop fly and undoes after automatic completion', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Batter Out')
      await click(page, 'Ball Caught')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await placeOffered(puppeteerDriver(page))
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      await setTrajectory(puppeteerDriver(page), 50)
      await page.waitForSelector('[aria-label*="50° Pop Fly"]')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Time to edit play"]')).equals(null)
      await click(page, 'Undo 50° Pop Fly')
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
    } finally {
      await page.close()
    }
  })
  it('allows exit when the game cannot be read', async function () {
    const { page, unexpected } = await open('/games/g1/score', false, true)
    try {
      await page.waitForFunction(() =>
        String(document.body.textContent).includes('Unable to load scoring.')
      )
      expect(await page.$('[aria-label="Retry loading scoring"]')).not.equals(
        null
      )
      await click(page, 'Exit Current Game')
      await page.waitForFunction(() => location.pathname === '/games/g1')
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('stationary runner presents one Safe and Out pair only during the hold', async () => {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await overrideBases(page, [['First base', 'Player 6']])
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const rect = await page.$eval('canvas', n => {
        const r = n.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width: rect.width,
        height: rect.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const pt = new Vector3(BASES[1].x, 6, BASES[1].z).project(camera)
      await page.touchscreen.touchStart(
        rect.x + ((pt.x + 1) * rect.width) / 2,
        rect.y + ((1 - pt.y) * rect.height) / 2
      )
      await new Promise(resolve => setTimeout(resolve, 450))
      await page.waitForSelector('[aria-label="Safe drag target"]')
      const positions = await page.evaluate(() =>
        ['Safe drag target', 'Out drag target'].map(label => {
          const e = document.querySelector(`[aria-label="${label}"]`)!
          const r = e.getBoundingClientRect()
          return { label, x: r.x, y: r.y, width: r.width, height: r.height }
        })
      )
      expect(unexpected).deep.equals([])
      expect(positions[0].x).equals(positions[1].x)
      expect(positions[0].y + positions[0].height).at.most(positions[1].y)
      expect(positions[0].x).greaterThan(rect.x + ((pt.x + 1) * rect.width) / 2)
      await page.touchscreen.touchEnd()
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
    } finally {
      await page.close()
    }
  })
  it('keeps earlier runs when a runner is tagged out at home for third out', async () => {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await overrideBases(page, [
        ['Third base', 'Player 8'],
        ['Second base', 'Player 7']
      ])
      await click(page, 'Open scoring menu')
      await click(page, 'Overrides')
      await click(page, 'Outs 2')
      await click(page, 'Apply Override')
      await chooseHit(page, 'Triple')
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      for (const name of ['Player 8']) {
        await page.waitForSelector(
          `[aria-label="Home plate decision for ${name}"]`,
          { timeout: 30000 }
        )
        await click(page, 'Safe')
      }
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 7"]',
        { timeout: 30000 }
      )
      await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
      await click(page, 'Out')
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      await click(page, 'Finish defensive play')
      await page.waitForSelector('[aria-label*="Bottom 1st"]', {
        timeout: 30000
      })
      const summary = await page.$eval('[aria-label*="Owls "]', n =>
        n.getAttribute('aria-label')
      )
      expect(unexpected).deep.equals([])
      expect(summary).includes('Owls 1 · Hawks 0')
    } finally {
      await page.close()
    }
  })
  for (const width of [320, 390, 844])
    it(`keeps paired controls and camera framing fixed at ${width}px`, async () => {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right',
        true
      )
      try {
        const height = width === 844 ? 390 : 844
        await page.setViewport({ width, height })
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await captureScene(page)
        const actual = await page.evaluate(() => {
          const camera = (window as unknown as SceneProbeWindow).qaCamera!
          const labels = [
            'More',
            'Nothing to undo',
            'Ball',
            'Called Strike',
            'Swing and Miss',
            'Foul Ball',
            'Swing in Play',
            'Bunt in Play'
          ]
          return {
            matrix: camera.matrixWorld.toArray(),
            projection: camera.projectionMatrix.toArray(),
            controls: labels.map(label => {
              const n = document.querySelector(`[aria-label="${label}"]`)!
              const r = n.getBoundingClientRect()
              const st = getComputedStyle(n)
              return {
                label,
                x: r.x,
                y: r.y,
                bottom: r.bottom,
                right: r.right,
                h: r.height,
                bg: st.backgroundColor,
                font: getComputedStyle(
                  n.querySelector('[data-testid="scoring-control-label"]') ==
                    null
                    ? n
                    : n.querySelector('[data-testid="scoring-control-label"]')!
                ).fontSize,
                weight: getComputedStyle(
                  n.querySelector('[data-testid="scoring-control-label"]') ==
                    null
                    ? n
                    : n.querySelector('[data-testid="scoring-control-label"]')!
                ).fontWeight,
                shadow: st.boxShadow,
                images: n.querySelectorAll('img').length
              }
            }),
            canvas: {
              width: document.querySelector('canvas')!.clientWidth,
              height: document.querySelector('canvas')!.clientHeight
            }
          }
        })
        const camera = new PerspectiveCamera()
        applyFieldCamera(camera, {
          ...actual.canvas,
          view: 'home',
          zoom: 1.25,
          tilt: (-11 * Math.PI) / 180,
          heightOffset: 33,
          bottomExtension: 112
        })
        for (const [a, b] of [
          [actual.matrix, camera.matrixWorld.toArray()],
          [actual.projection, camera.projectionMatrix.toArray()]
        ])
          a.forEach((v, i) => expect(v).closeTo(b[i], 1e-8))
        // Equal matrices preserve every projected landmark, including plate and scoreboard.
        for (const point of [
          new Vector3(0, 0, 0),
          new Vector3(27, 0, -27),
          new Vector3(0, 28.2, -135)
        ]) {
          const comparison = camera.clone()
          comparison.matrixWorld.fromArray(actual.matrix)
          comparison.matrixWorldInverse.copy(comparison.matrixWorld).invert()
          comparison.projectionMatrix.fromArray(actual.projection)
          expect(
            point
              .clone()
              .project(comparison)
              .distanceTo(point.clone().project(camera))
          ).lessThan(1e-8)
        }
        const swing = actual.controls.find(c => c.label === 'Swing in Play')!
        const bunt = actual.controls.find(c => c.label === 'Bunt in Play')!
        expect(swing.bottom - bunt.y).closeTo(120, 0.1)
        expect(swing.y - bunt.bottom).closeTo(8, 0.1)
        for (const c of actual.controls) {
          expect(c.h, c.label).closeTo(56, 0.1)
          const backgrounds: Record<string, string> = {
            More: 'rgb(28, 39, 33)',
            'Nothing to undo': 'rgb(26, 38, 32)',
            Ball: 'rgb(15, 92, 59)',
            'Called Strike': 'rgb(146, 64, 14)',
            'Swing and Miss': 'rgb(130, 30, 20)',
            'Foul Ball': 'rgb(127, 100, 69)',
            'Swing in Play': 'rgb(111, 66, 25)',
            'Bunt in Play': 'rgb(111, 66, 25)'
          }
          expect(c.bg).equals(backgrounds[c.label] ?? actual.controls[0].bg)
          expect(c.shadow).not.equals('none')
          expect(c.images).equals(0)
          expect(c.font).equals(
            [
              'Ball',
              'Nothing to undo',
              'Bunt in Play',
              'Swing in Play'
            ].includes(c.label)
              ? '12px'
              : '11px'
          )
          expect(c.weight).equals('900')
          if (c.label !== 'Nothing to undo')
            expect(c.right - c.x).closeTo(swing.right - swing.x, 0.2)
          expect(c.right).at.most(width)
          expect(c.bottom).at.most(height)
        }
        await click(page, 'Open scoring menu')
        expect(
          await page.$eval('[aria-label="Set Team Rosters"]', n => {
            const t = n.querySelector('[dir="auto"]')!
            return {
              font: getComputedStyle(t).fontSize,
              weight: getComputedStyle(t).fontWeight
            }
          })
        ).deep.equals({ font: '13px', weight: '700' })
        await page.screenshot({
          path: join(
            process.env.TS_SCORING_ARTIFACT_DIR!,
            `paired-controls-${width}.png`
          )
        })
      } finally {
        await page.close()
      }
    })
  for (const outcome of ['Single', 'Ground Out'])
    it(`completes a bunt ${outcome} with distinct menus and Undo`, async () => {
      const { page } = await open('/games/g1/score')
      try {
        await click(page, 'Bunt in Play')
        expect(await page.$('[aria-label="Home Run"]')).equals(null)
        expect(await page.$('[aria-label="Swing in Play outcomes"]')).equals(
          null
        )
        expect(await page.$('[aria-label="Fielder\'s Choice"]')).equals(null)
        if (outcome === 'Ground Out') await click(page, 'Batter Out')
        await click(page, outcome)
        await page.waitForSelector(`[aria-label="Undo Bunt: ${outcome}"]`)
        await placeOffered(puppeteerDriver(page))
        await setTrajectory(puppeteerDriver(page))
        if (outcome === 'Ground Out') {
          await page.waitForSelector(
            '[aria-label^="Tap or drag the next defender"]'
          )
          await placeOffered(puppeteerDriver(page), 1)
          await click(page, 'Finish defensive play')
        } else await click(page, 'Finish at-bat')
        await waitReady(page)
        await page.waitForSelector('[aria-label*="Batter Player 2"]')
        await page.locator('[aria-label^="Undo "]').click()
        await page.screenshot({
          path: join(
            process.env.TS_SCORING_ARTIFACT_DIR!,
            `bunt-${outcome}.png`
          )
        })
      } finally {
        await page.close()
      }
    })
  for (const kind of ['Swing', 'Bunt'])
    for (const touch of [false, true])
      it(`drags ${kind} outcomes with ${touch ? 'touch' : 'mouse'} through both menu levels`, async () => {
        const { page } = await open('/games/g1/score')
        try {
          await page.setViewport({
            width: 390,
            height: 844,
            hasTouch: touch,
            isMobile: touch
          })
          await page.waitForSelector(`[aria-label="${kind} in Play"]`)
          const center = async (
            label: string
          ): Promise<{ x: number; y: number }> =>
            await page.$eval(`[aria-label="${label}"]`, n => {
              const r = n.getBoundingClientRect()
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
            })
          const move = async (p: { x: number; y: number }): Promise<void> => {
            if (touch) await page.touchscreen.touchMove(p.x, p.y)
            else await page.mouse.move(p.x, p.y)
          }
          const trigger = await center(`${kind} in Play`)
          if (touch) await page.touchscreen.touchStart(trigger.x, trigger.y)
          else {
            await page.mouse.move(trigger.x, trigger.y)
            await page.mouse.down()
          }
          await move({ x: trigger.x, y: trigger.y - 25 })
          await page.waitForSelector('[aria-label="Batter Out"]')
          const parent = await center('Batter Out')
          await move(parent)
          await page.waitForSelector('[aria-label="Ball Caught"]')
          await move(await center('Single'))
          await page.waitForSelector('[aria-label="Ball Caught"]', {
            hidden: true
          })
          await move(parent)
          await page.waitForSelector('[aria-label="Ball Caught"]')
          await move(await center('Ball Caught'))
          if (touch) await page.touchscreen.touchEnd()
          else await page.mouse.up()
          await page.waitForSelector(
            `[aria-label="Undo ${kind === 'Bunt' ? 'Bunt: ' : ''}Ball Caught"]`
          )
          expect(await page.$('[role="menu"]')).equals(null)
        } finally {
          await page.close()
        }
      })
  for (const touch of [false, true])
    it(`closes More after crossing its submenu bridge with ${touch ? 'touch' : 'mouse'}`, async () => {
      const { page } = await open('/games/g1/score')
      try {
        await page.setViewport({
          width: 390,
          height: 844,
          hasTouch: touch,
          isMobile: touch
        })
        await page.waitForSelector('[aria-label="More"]')
        const center = async (
          label: string
        ): Promise<{ x: number; y: number }> =>
          await page.$eval(`[aria-label="${label}"]`, n => {
            const r = n.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          })
        const move = async (p: { x: number; y: number }): Promise<void> => {
          if (touch) await page.touchscreen.touchMove(p.x, p.y)
          else await page.mouse.move(p.x, p.y)
        }
        const trigger = await center('More')
        if (touch) await page.touchscreen.touchStart(trigger.x, trigger.y)
        else {
          await page.mouse.move(trigger.x, trigger.y)
          await page.mouse.down()
        }
        await move({ x: trigger.x, y: trigger.y - 20 })
        await page.waitForSelector('[aria-label="Put Batter on Base"]')
        const parent = await center('Put Batter on Base')
        await move(parent)
        await page.waitForSelector('[aria-label="First"]')
        const first = await center('First')
        await move({ x: 195, y: first.y })
        expect(await page.$('[aria-label="First"]')).not.equals(null)
        await move(first)
        await move({ x: 350, y: 140 })
        await page.waitForSelector('[aria-label="First"]', { hidden: true })
        expect(await page.$('[aria-label="First"]')).equals(null)
        await move(parent)
        if (touch) await page.touchscreen.touchEnd()
        else await page.mouse.up()
        expect(await page.$('[role="menu"]')).equals(null)
        expect(await page.$('[aria-label^="Undo Put Batter"]')).equals(null)
        await click(page, 'More')
        await page.waitForSelector('[aria-label="Hit by Pitch"]')
      } finally {
        await page.close()
      }
    })

  for (const bats of ['right', 'left'] as const)
    for (const bunt of [true, false])
      it(`renders a ${bats} ${bunt ? 'ninety-degree bunt' : 'full swing'} from the outcome choice`, async () => {
        const { page } = await open(
          '/games/g1/score',
          false,
          false,
          false,
          bats,
          true
        )
        try {
          await page.setViewport({ width: 390, height: 844 })
          await click(page, bunt ? 'Bunt in Play' : 'Swing in Play')
          await click(page, 'Single')
          await page.waitForSelector('canvas[data-field-ready="true"]')
          await placeOffered(puppeteerDriver(page))
          await page.waitForSelector('[aria-label^="Ball trajectory:"]')
          await captureScene(page)
          const sampling = page.evaluate(async () => {
            const scene = (window as unknown as SceneProbeWindow).qaScene!
            const samples: Array<{ x: number; y: number; z: number }> = []
            const start = performance.now()
            let started = false
            let completed = false
            while (performance.now() - start < 12000) {
              await new Promise(requestAnimationFrame)
              const player = scene.getObjectByName('player-offense-1')
              const rig =
                player == null
                  ? undefined
                  : player.getObjectByName('athlete-rig')
              const bat =
                rig == null ? undefined : rig.getObjectByName('animated-bat')
              if (rig != null && rig.visible && bat != null) {
                started = true
                const d = bat.position
                  .clone()
                  .set(0, 1, 0)
                  .applyQuaternion(bat.quaternion)
                samples.push({ x: d.x, y: d.y, z: d.z })
              } else if (started) {
                completed = true
                break
              }
            }
            return { samples, completed }
          })
          await setTrajectory(puppeteerDriver(page))
          if (bunt) {
            await page.waitForFunction(
              () => {
                const scene = (window as unknown as SceneProbeWindow).qaScene!
                const player = scene.getObjectByName('player-offense-1')
                const rig =
                  player == null
                    ? undefined
                    : player.getObjectByName('athlete-rig')
                const bat =
                  rig == null ? undefined : rig.getObjectByName('animated-bat')
                return (
                  rig != null &&
                  rig.visible &&
                  bat != null &&
                  Math.abs(
                    bat.position
                      .clone()
                      .set(0, 1, 0)
                      .applyQuaternion(bat.quaternion).x
                  ) > 0.98
                )
              },
              { polling: 'raf' }
            )
            await page.screenshot({
              path: join(
                process.env.TS_SCORING_ARTIFACT_DIR ?? '/tmp',
                `bunt-contact-${bats}.png`
              )
            })
          }
          const { samples, completed } = await sampling
          expect(completed, 'rendered batting motion must finish').equals(true)
          expect(samples.length, 'observe actual rendered motion').greaterThan(
            0
          )
          if (bunt) {
            expect(
              samples.every(d => d.y >= -0.00001 && Math.abs(d.z) < 0.00001)
            ).equals(true)
            expect(
              samples.some(d => (bats === 'right' ? d.x > 0.98 : d.x < -0.98))
            ).equals(true)
          } else expect(samples.some(d => Math.abs(d.z) > 0.4)).equals(true)
          await click(page, 'Finish at-bat')
          await page.waitForSelector('[aria-label*="Batter Player 2"]')
          await page.locator('[aria-label^="Undo "]').click()
        } finally {
          await page.close()
        }
      })
  for (const width of [390, 844])
    for (const homeRun of [false, true])
      it(`pulses yellow guidance text without badges for ${homeRun ? 'home run' : 'single'} at ${width}px`, async () => {
        const { page } = await open(
          '/games/g1/score',
          false,
          false,
          false,
          'right'
        )
        try {
          await page.setViewport({ width, height: width === 390 ? 844 : 390 })
          await click(page, 'Swing in Play')
          await click(page, homeRun ? 'Home Run' : 'Single')
          await page.waitForSelector('canvas[data-field-ready="true"]')
          if (homeRun)
            await page.waitForSelector('[aria-label^="Home run type:"]')
          if (homeRun) {
            // Placed on the guide, where it already points.
            const guide = await readGuide(page)
            await aimLandingAt(page, guide.x, guide.z)
          } else await placeOffered(puppeteerDriver(page))
          await page.waitForSelector('[aria-label^="Ball trajectory:"]')
          const style = await page.$$eval('[data-testid$=" value"]', nodes =>
            nodes.map(node => {
              const st = getComputedStyle(node)
              const parent = getComputedStyle(node.parentElement!)
              return {
                color: st.color,
                weight: st.fontWeight,
                background: parent.backgroundColor,
                radius: parent.borderRadius
              }
            })
          )
          expect(style).has.length(homeRun ? 2 : 1)
          for (const row of style)
            expect(row).deep.equals({
              color: 'rgb(241, 207, 85)',
              weight: '700',
              background: 'rgba(0, 0, 0, 0)',
              radius: '0px'
            })
          const samples = await page.evaluate(async () => {
            const shadow = document.querySelector(
              '[data-testid="Ball trajectory shadow"]'
            )!
            const foreground = document.querySelector(
              '[data-testid="Ball trajectory value"]'
            )!
            const result: Array<{ shadow: number; foreground: number }> = []
            const begin = performance.now()
            while (performance.now() - begin < 3500) {
              await new Promise(requestAnimationFrame)
              result.push({
                shadow: Number(getComputedStyle(shadow).opacity),
                foreground: Number(getComputedStyle(foreground).opacity)
              })
            }
            return result
          })
          expect(Math.max(...samples.map(s => s.shadow))).greaterThan(0.8)
          expect(Math.min(...samples.map(s => s.shadow))).lessThan(0.2)
          expect(samples.every(s => s.foreground === 1)).equals(true)
          await page.screenshot({
            path: join(
              process.env.TS_SCORING_ARTIFACT_DIR ?? '/tmp',
              `guidance-${homeRun ? 'home-run' : 'single'}-${width}.png`
            )
          })
          await page.emulateMediaFeatures([
            { name: 'prefers-reduced-motion', value: 'reduce' }
          ])
          await page.waitForFunction(
            () =>
              getComputedStyle(
                document.querySelector(
                  '[data-testid="Ball trajectory shadow"]'
                )!
              ).opacity === '0'
          )
          await page.emulateMediaFeatures([
            { name: 'prefers-reduced-motion', value: 'no-preference' }
          ])
          await page.waitForFunction(
            () =>
              Number(
                getComputedStyle(
                  document.querySelector(
                    '[data-testid="Ball trajectory shadow"]'
                  )!
                ).opacity
              ) > 0.5
          )
          await page.locator('[aria-label^="Undo "]').click()
          expect(await page.$('[data-testid="Ball trajectory shadow"]')).equals(
            null
          )
        } finally {
          await page.close()
        }
      })
  it('animates the live badge with live reduced-motion changes', async () => {
    const { page, unexpected } = await open(
      '/games/g1',
      false,
      false,
      false,
      'right',
      false,
      undefined,
      true
    )
    try {
      await page.waitForSelector('[aria-label="Live now"]')
      const sample = async (
        selector: string,
        transform = false
      ): Promise<number[]> =>
        await page.evaluate(
          async (selector, transform) => {
            const node = document.querySelector(selector)!
            const values: number[] = []
            const start = performance.now()
            while (performance.now() - start < 3500) {
              await new Promise(requestAnimationFrame)
              const style = getComputedStyle(node)
              values.push(
                transform
                  ? new DOMMatrixReadOnly(style.transform).m41
                  : Number(style.opacity)
              )
            }
            return values
          },
          selector,
          transform
        )
      const pulse = await sample('[aria-label="Live now"]')
      expect(Math.min(...pulse)).within(0.71, 0.76)
      expect(Math.max(...pulse)).within(0.96, 1)
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ])
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[aria-label="Live now"]')!)
            .opacity === '1'
      )
      const still = await sample('[aria-label="Live now"]')
      expect(still.every(value => value === 1)).equals(true)
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'no-preference' }
      ])
      const resumed = await sample('[aria-label="Live now"]')
      expect(Math.min(...resumed)).within(0.71, 0.76)
      await page.screenshot({
        path: join(
          process.env.TS_SCORING_ARTIFACT_DIR ?? '/tmp',
          'reanimated-live.png'
        )
      })
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })
  it('pulses the switch-hitter hint with Reanimated and stops it for reduced motion and dismissal', async () => {
    const { page } = await open('/games/g1/score')
    try {
      await page.evaluate(() => {
        localStorage.removeItem('teamstation:scoring:100:switch-hitter')
      })
      await page.reload()
      const selector = '[aria-label="Drag to the other batter box"]'
      await page.waitForSelector(selector)
      const values = await page.evaluate(async selector => {
        const node = document.querySelector(selector)!
        const result: number[] = []
        const start = performance.now()
        while (performance.now() - start < 3000) {
          await new Promise(requestAnimationFrame)
          result.push(Number(getComputedStyle(node).opacity))
        }
        return result
      }, selector)
      expect(Math.min(...values)).within(0.29, 0.4)
      expect(Math.max(...values)).greaterThan(0.9)
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ])
      await page.waitForFunction(
        selector =>
          getComputedStyle(document.querySelector(selector)!).opacity === '1',
        {},
        selector
      )
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'no-preference' }
      ])
      await page.waitForFunction(
        selector =>
          Number(getComputedStyle(document.querySelector(selector)!).opacity) <
          0.5,
        {},
        selector
      )
      await click(page, 'OK')
      expect(await page.$(selector)).equals(null)
    } finally {
      await page.close()
    }
  })
  for (const [width, height, direction, outcome] of [
    [390, 844, -1, 'Single'],
    [844, 390, 1, 'Single'],
    [390, 844, -1, 'Home Run'],
    [844, 390, 1, 'Home Run']
  ] as const) {
    it(`shows the trajectory polish grip and grass apron for ${outcome} at ${width}px`, async function () {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right',
        true
      )
      try {
        await page.setViewport({ width, height })
        await click(page, 'Swing in Play')
        await click(page, outcome)
        await page.waitForSelector('canvas[data-field-ready="true"]')
        if (outcome === 'Single')
          // The pitcher takes it out and to the side.
          await placeOffered(puppeteerDriver(page), 0, 60, direction * 50)
        else {
          await captureScene(page)
          expect(
            await page.evaluate(() => {
              const ring = (
                window as unknown as SceneProbeWindow
              ).qaScene!.getObjectByName('destination-ring') as Mesh
              return (
                ring.geometry as unknown as {
                  parameters: { outerRadius: number }
                }
              ).parameters.outerRadius
            })
          ).equals(11)
          const guide = await readGuide(page)
          await aimLandingAt(page, guide.x, guide.z - (direction > 0 ? 15 : 0))
        }
        await page.waitForSelector(
          '[aria-label^="Drag up and down for ball trajectory."]'
        )
        await captureScene(page)
        await page.waitForFunction(() => {
          const scene = (window as unknown as SceneProbeWindow).qaScene!
          return scene.getObjectByName('arc-angle-handle')!.scale.x !== 1
        })
        const data = await page.evaluate(() => {
          const host = window as unknown as SceneProbeWindow
          const scene = host.qaScene!
          const camera = host.qaCamera!
          const box = document.querySelector('canvas')!.getBoundingClientRect()
          const handle = scene.getObjectByName('arc-angle-handle')!
          const target = scene.getObjectByName('destination-marker')!
          const ring = scene.getObjectByName('destination-ring') as Mesh
          const world = handle.position.clone()
          const screen = world.clone().project(camera)
          const home = world.clone().set(0, 0.7, 0).project(camera)
          const landing = target.position
            .clone()
            .setY(target.position.y - 0.1)
            .project(camera)
          const footprint = (scene.getObjectByName('grass-apron') as Mesh)
            .geometry
          footprint.computeBoundingBox()
          return {
            x: box.x + ((screen.x + 1) * box.width) / 2,
            y: box.y + ((1 - screen.y) * box.height) / 2,
            midpointError:
              (Math.abs(screen.y - (home.y + landing.y) / 2) * box.height) / 2,
            radius: (
              ring.geometry as unknown as {
                parameters: { outerRadius: number }
              }
            ).parameters.outerRadius,
            color: (
              ring.material as unknown as {
                color: { getHexString: () => string }
              }
            ).color.getHexString(),
            rings: handle.children.filter(c => c.name === 'arc-grab-ring')
              .length,
            arrows: handle.children.filter(c => c.name === 'arc-pulse-arrow')
              .length,
            grassBack: -footprint.boundingBox!.min.y,
            camera: camera.matrixWorld.toArray()
          }
        })
        expect(data.midpointError).lessThan(1)
        expect(data.radius).equals(5.5)
        expect(data.color).equals('ffffff')
        expect(data.rings).equals(3)
        expect(data.arrows).equals(6)
        expect(data.grassBack).closeTo(15.24, 0.01)
        await page.screenshot({
          path: `${process.env.TS_SCORING_ARTIFACT_DIR}/trajectory-polish-${outcome}-${width}.png`
        })
        await page.mouse.move(data.x, data.y)
        await page.mouse.down()
        await page.mouse.move(data.x, data.y - 30, { steps: 8 })
        await page.mouse.up()
        await page.waitForSelector('[aria-label^="Undo "]')
        expect(
          await page.evaluate(() =>
            (
              window as unknown as SceneProbeWindow
            ).qaCamera!.matrixWorld.toArray()
          )
        ).deep.equals(data.camera)
      } finally {
        await page.close()
      }
    })
  }
  for (const [width, height] of [
    [390, 844],
    [844, 390]
  ])
    it(`names the teams inside a full-width Away/Home pill at ${width}×${height}`, async function () {
      const { page } = await open('/games/g1/score')
      const box = async (
        selector: string
      ): Promise<{ x: number; y: number; width: number; height: number }> =>
        await page.$eval(selector, n => {
          const r = n.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        })
      try {
        await page.setViewport({ width, height })
        await click(page, 'Open scoring menu')
        await click(page, 'Set Team Rosters')
        await page.waitForSelector('[data-testid="Roster selector captions"]')
        await new Promise(resolve => setTimeout(resolve, 300))
        const footer = await box('[data-testid="Roster footer"]')
        const away = await box('[aria-label="Away Team"]')
        const home = await box('[aria-label="Home Team"]')
        expect(away.x).closeTo(footer.x, 1)
        expect(home.x + home.width).closeTo(footer.x + footer.width, 1)
        expect(
          await page.$eval('[aria-label="Away Team"]', n => n.textContent)
        ).equals('Owls')
        expect(
          await page.$eval('[aria-label="Home Team"]', n => n.textContent)
        ).equals('Hawks')
        // "Away" and "Home" sit above their halves, centred on them.
        const captions = await page.$$eval(
          '[data-testid="Roster selector captions"] > * > *',
          nodes =>
            nodes.map(n => {
              const r = n.getBoundingClientRect()
              return {
                text: n.textContent,
                centre: r.x + r.width / 2,
                bottom: r.bottom
              }
            })
        )
        expect(captions.map(c => c.text)).deep.equals(['Away', 'Home'])
        expect(captions[0].centre).closeTo(away.x + away.width / 2, 2)
        expect(captions[1].centre).closeTo(home.x + home.width / 2, 2)
        for (const caption of captions)
          expect(caption.bottom).at.most(Math.min(away.y, home.y))
        // No team name stands on its own outside the pill.
        const loose = await page.$$eval(
          'body *',
          nodes =>
            nodes.filter(
              n =>
                n.children.length === 0 &&
                ['Owls', 'Hawks'].includes(String(n.textContent)) &&
                n.closest('[role="tab"]') == null
            ).length
        )
        expect(loose).equals(0)
        // Both pills show whole inside the editor's top area.
        const top = await box('[data-testid="Roster editor top"]')
        for (const tab of ['Away Team', 'Lineup', 'Defense']) {
          const r = await box(`[aria-label="${tab}"]`)
          expect(r.y).at.least(top.y - 0.5)
          expect(r.y + r.height).at.most(top.y + top.height + 0.5)
        }
        if (process.env.TS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: `${process.env.TS_SCORING_ARTIFACT_DIR}/roster-pill-${width}.png`
          })
        // Tapping the right half picks the home team; dragging back picks away.
        const lineup = async (): Promise<string> =>
          await page.$eval('[aria-label="Batting lineup"]', n =>
            String(n.textContent)
          )
        const awayLineup = await lineup()
        await click(page, 'Home Team')
        await page.waitForSelector(
          '[aria-label="Home Team"][aria-selected="true"]'
        )
        expect(await lineup()).not.equals(awayLineup)
        // Measured again: choosing a side can scroll the top of the editor.
        const from = await box('[aria-label="Home Team"]')
        const to = await box('[aria-label="Away Team"]')
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
        await page.mouse.down()
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
          steps: 8
        })
        await page.mouse.up()
        await page.waitForSelector(
          '[aria-label="Away Team"][aria-selected="true"]'
        )
        expect(await lineup()).equals(awayLineup)
        await click(page, 'Cancel')
      } finally {
        await page.close()
      }
    })
  it('lists the roster by jersey number with players who have none last', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      const create = async (
        first: string,
        last: string,
        jersey: string
      ): Promise<void> => {
        await click(page, 'Create Player')
        await page.waitForFunction(
          () =>
            document.activeElement!.getAttribute('aria-label') === 'First Name'
        )
        await page.locator('[aria-label="First Name"]').fill(first)
        await page.locator('[aria-label="Last Name"]').fill(last)
        if (jersey !== '')
          await page.locator('[aria-label="Jersey Number"]').fill(jersey)
        await click(page, 'Create Player')
        await page.waitForSelector('[aria-label="First Name"]', {
          hidden: true
        })
      }
      // Added out of order, then five placeholders.
      await create('Aaron', 'Judge', '')
      await create('Mookie', 'Betts', '10')
      await openPlaceholderSheet(page)
      await new Promise(resolve => setTimeout(resolve, 400))
      await click(page, 'Player count 5')
      await page.waitForSelector(
        '[aria-label="Player count 5"][aria-selected="true"]'
      )
      // The list scrolls to the count it was given; let it settle there.
      await new Promise(resolve => setTimeout(resolve, 600))
      await page.waitForSelector(
        '[aria-label="Player count 5"][aria-selected="true"]'
      )
      await click(page, 'Create')
      await page.waitForSelector(
        '[aria-label="Number of placeholder players"]',
        { hidden: true }
      )
      await new Promise(resolve => setTimeout(resolve, 400))
      await page.keyboard.press('Escape')
      await page.waitForSelector('[aria-label="First Name"]', { hidden: true })
      const roster = async (): Promise<string[]> =>
        await page.$$eval(
          '[data-roster-target="roster"] [data-roster-player]',
          nodes => nodes.map(n => String(n.textContent).trim())
        )
      const rows = await roster()
      expect(rows).length(2 + 5)
      const numbers = rows.map(row => /^#(\d+)/.exec(row)?.[1])
      const numbered = numbers.filter(number => number != null)
      // Numbers first, lowest first; then everyone without one, by name.
      expect(numbers.slice(0, numbered.length)).deep.equals(numbered)
      expect(numbered.map(Number)).deep.equals(
        [...numbered].map(Number).sort((a, b) => a - b)
      )
      expect(numbered.at(-1)).equals('10')
      const unnumbered = rows.slice(numbered.length)
      expect(unnumbered).deep.equals(
        [...unnumbered].sort((a, b) => a.localeCompare(b))
      )
      expect(unnumbered).includes('Aaron J')
      await click(page, 'Defense')
      expect(await roster()).deep.equals(rows)
      await click(page, 'Lineup')
      // The lineup keeps the order it is built in.
      await click(page, 'Add Mookie B to Lineup')
      const lineup = await page.$$eval(
        '[data-roster-target^="lineup-"][data-roster-player]',
        nodes => nodes.map(n => String(n.textContent))
      )
      expect(lineup.at(-1)).includes('Mookie B')
      await click(page, 'Cancel')
    } finally {
      await page.close()
    }
  })
  it('keeps a long team name on one line inside its half of the pill', async function () {
    awayTeamName = 'The Extremely Long Named Visiting Squadron'
    const { page } = await open('/games/g1/score')
    try {
      await page.setViewport({ width: 390, height: 844 })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await page.waitForSelector('[data-testid="Roster selector captions"]')
      await new Promise(resolve => setTimeout(resolve, 300))
      const sizes = await page.$$eval('[role="tab"]', nodes =>
        nodes.slice(0, 2).map(n => {
          const r = n.getBoundingClientRect()
          const text = n.firstElementChild!.getBoundingClientRect()
          return { width: r.width, height: r.height, textHeight: text.height }
        })
      )
      expect(sizes[0].width).closeTo(sizes[1].width, 1)
      expect(sizes[0].height).closeTo(sizes[1].height, 1)
      expect(sizes[0].textHeight).closeTo(sizes[1].textHeight, 1)
      expect(
        await page.$eval('[aria-label="Away Team"]', n => n.textContent)
      ).equals(awayTeamName)
      await click(page, 'Cancel')
    } finally {
      awayTeamName = undefined
      await page.close()
    }
  })
  it('roster flow keeps compact selectors and footer visible while full cards animate between columns', async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      false,
      undefined,
      true
    )
    const rect = async (
      selector: string
    ): Promise<{
      x: number
      y: number
      width: number
      height: number
      bottom: number
    }> =>
      await page.$eval(selector, n => {
        const r = n.getBoundingClientRect()
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          bottom: r.bottom
        }
      })
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Lineup')
      for (const name of ['Jordan K.', 'Player 2', 'Player 3'])
        await click(page, `Remove ${name}`)
      await new Promise(resolve => setTimeout(resolve, 350))
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(animation => animation.playState !== 'running')
      )
      for (const [width, height] of [
        [390, 844],
        [844, 390]
      ]) {
        await page.setViewport({
          width,
          height,
          isMobile: true,
          hasTouch: true
        })
        await new Promise(resolve => setTimeout(resolve, 250))
        const footer = await rect('[data-testid="Roster footer"]')
        // The team pill spans the editor, one half per team.
        const awayTab = await rect('[aria-label="Away Team"]')
        const homeTab = await rect('[aria-label="Home Team"]')
        expect(awayTab.x).closeTo(footer.x, 1)
        expect(homeTab.x + homeTab.width).closeTo(footer.x + footer.width, 1)
        expect(awayTab.width).closeTo(homeTab.width, 1)
        expect((await rect('[aria-label="Lineup"]')).height).equals(36)
        expect(footer.bottom).at.most(height)
        expect(height - footer.bottom).lessThan(30)
        for (const label of ['Roster players', 'Batting lineup']) {
          const list = await rect(`[aria-label="${label}"]`)
          expect(list.height).greaterThan(60)
          expect(list.bottom).at.most(footer.y)
        }
        if (process.env.TS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: `${process.env.TS_SCORING_ARTIFACT_DIR}/roster-flow-${width}.png`
          })
      }
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await page.$$eval(
        '[aria-label="Roster players"], [aria-label="Batting lineup"]',
        lists => {
          lists.forEach(n => {
            n.scrollTop = 0
          })
        }
      )
      await new Promise(resolve => setTimeout(resolve, 1200))
      const source = '[data-roster-target="roster"] [data-roster-player="102"]'
      const third = '[data-roster-target="roster"] [data-roster-player="103"]'
      const a = await rect(source)
      const following = await rect(third)
      expect(following.y - a.bottom).closeTo(ROSTER_CARD_GAP, 0.5)
      const destination = await rect('[data-roster-target="lineup-1"]')
      const next = await rect('[data-roster-target="lineup-2"]')
      expect(next.y - destination.bottom).closeTo(ROSTER_CARD_GAP, 0.5)
      await page.touchscreen.touchStart(a.x + 17, a.y + 13)
      await new Promise(resolve => setTimeout(resolve, 750))
      const ghost = '[data-testid="Roster dragged card"]'
      await page.waitForFunction(
        selector =>
          document.querySelector(selector)!.getBoundingClientRect().height < 1,
        {},
        source
      )
      expect((await rect(source)).height).lessThan(1)
      expect((await rect(third)).y).lessThan(following.y - 40)
      // The lifted card's place closes to one gap between its neighbours.
      await new Promise(resolve => setTimeout(resolve, 250))
      const above = await rect(
        '[data-roster-target="roster"] [data-roster-player="101"]'
      )
      expect((await rect(third)).y - above.bottom).closeTo(ROSTER_CARD_GAP, 0.5)
      await page.touchscreen.touchMove(destination.x + 17, destination.y + 10)
      await new Promise(resolve => setTimeout(resolve, 250))
      const floating = await rect(ghost)
      expect(floating.width).closeTo(a.width, 1)
      expect(floating.height).closeTo(a.height, 1)
      expect(floating.x).closeTo(destination.x, 1)
      expect(floating.y).closeTo(destination.y - 3, 1)
      expect(await page.$eval(ghost, n => n.textContent)).includes(
        '#2 Player 2'
      )
      await page.waitForFunction(
        y =>
          document
            .querySelector('[data-roster-target="lineup-2"]')!
            .getBoundingClientRect().y >
          y + 40,
        {},
        next.y
      )
      expect((await rect('[data-roster-target="lineup-2"]')).y).greaterThan(
        next.y + 40
      )
      if (process.env.TS_SCORING_ARTIFACT_DIR != null)
        await page.screenshot({
          path: `${process.env.TS_SCORING_ARTIFACT_DIR}/roster-flow-drag.png`
        })
      await page.touchscreen.touchEnd()
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-roster-target="lineup-1"]')!
            .getAttribute('data-roster-player') === '2'
      )
      expect(await page.$(ghost)).equals(null)
      await page.waitForFunction(
        selector => document.querySelector(selector) == null,
        {},
        source
      )
      // The dropped card lands in the gap the drag held open: full height,
      // one gap from each neighbour, drawn over neither.
      const landed = await rect('[data-roster-target="lineup-1"]')
      expect(landed.height).closeTo(a.height, 1)
      expect(
        landed.y - (await rect('[data-roster-target="lineup-0"]')).bottom
      ).closeTo(ROSTER_CARD_GAP, 0.5)
      expect(
        (await rect('[data-roster-target="lineup-2"]')).y - landed.bottom
      ).closeTo(ROSTER_CARD_GAP, 0.5)
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
    } finally {
      await page.close()
    }
  })
  for (const outcome of ['Single', 'Ball Caught'] as const)
    it(`keeps the fielding position through an 85-degree high fly for ${outcome}`, async function () {
      const { page } = await open(
        '/games/g1/score',
        false,
        false,
        false,
        'right',
        true
      )
      try {
        await page.setViewport({ width: 390, height: 844 })
        await click(page, 'Swing in Play')
        if (outcome === 'Ball Caught') await click(page, 'Batter Out')
        await click(page, outcome)
        await page.waitForSelector('canvas[data-field-ready="true"]')
        await captureScene(page)
        const before = await page.evaluate(() => {
          const host = window as unknown as SceneProbeWindow
          return {
            player: host
              .qaScene!.getObjectByName('player-defense-10')!
              .position.toArray(),
            camera: host.qaCamera!.position.toArray()
          }
        })
        // The pitcher takes it on his way in, a short landing in front of
        // home.
        await placeOffered(puppeteerDriver(page), 0, -40)
        await page.waitForSelector(
          '[aria-label^="Drag up and down for ball trajectory."]'
        )
        // Held while the angle is dragged up to its limit: what the screen
        // shows before the scorer lets go.
        const grip = await page.$eval('canvas', node => {
          const r = node.getBoundingClientRect()
          return [r.x + r.width / 2, r.y + r.height / 2] as [number, number]
        })
        await page.mouse.move(...grip)
        await page.mouse.down()
        await page.mouse.move(grip[0], grip[1] - 120, { steps: 20 })
        await page.waitForSelector(
          '[aria-label="Ball trajectory: 85° Pop Fly"]'
        )
        await captureScene(page)
        const selected = await page.evaluate(() => {
          const host = window as unknown as SceneProbeWindow
          const curve = host.qaScene!.getObjectByName('ball-trajectory') as Mesh
          curve.geometry.computeBoundingBox()
          return {
            player: host
              .qaScene!.getObjectByName('player-defense-10')!
              .position.toArray(),
            camera: host.qaCamera!.position.toArray(),
            apex: curve.geometry.boundingBox!.max.y
          }
        })
        expect(selected.player).deep.equals(before.player)
        expect(selected.camera).deep.equals(before.camera)
        expect(selected.apex).greaterThan(15)
        if (process.env.TS_SCORING_ARTIFACT_DIR != null)
          await page.screenshot({
            path: join(
              process.env.TS_SCORING_ARTIFACT_DIR,
              `high-fly-${outcome.replaceAll(' ', '-')}.png`
            )
          })
        const sample = page.evaluate(async () => {
          const scene = (window as unknown as SceneProbeWindow).qaScene!
          const samples: number[][] = []
          const start = performance.now()
          while (performance.now() - start < 2300) {
            await new Promise(requestAnimationFrame)
            samples.push(
              scene.getObjectByName('player-defense-10')!.position.toArray()
            )
          }
          return samples
        })
        await page.mouse.up()
        const positions = await sample
        expect(
          positions.some(p => Math.abs(p[2] - before.player[2]) > 1)
        ).equals(true)
        expect(
          positions.some(p => p[2] > before.player[2] + 1 && p[2] < -4)
        ).equals(true)
      } finally {
        await page.close()
      }
    })
})

describe('unforced hit-offer on a single (E1–E4)', function () {
  this.timeout(120000)
  // Own browser lifecycle so `--grep unforced` still launches Puppeteer
  // (sibling of `scoring browser`, whose before/after would otherwise be skipped).
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  it('E1 auto-advances an unforced runner second to third on a single', async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await overrideBases(page, [['Second base', 'Player 7']])
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      // Auto-advanced: no forced Safe/Out; retreat from third is available.
      expect(await page.$('[aria-label="Safe"]')).equals(null)
      expect(await page.$('[aria-label="Out"]')).equals(null)
      expect(await runnerNearBase(page, 3)).equals(true)
      await dragRunner(page, 3, 2)
      // Hit-offer retreat commits without mounting Safe/Out.
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
      expect(await page.$('[aria-label="Out drag target"]')).equals(null)
      await page.touchscreen.touchEnd()
      await waitRunnerNearBase(page, 2)
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await runnerNearBase(page, 2)).equals(true)
    } finally {
      await page.close()
    }
  })

  it('E2 leaves the auto-advanced runner on third when the scorer does not drag', async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    try {
      await overrideBases(page, [['Second base', 'Player 7']])
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      expect(await page.$('[aria-label="Safe"]')).equals(null)
      expect(await runnerNearBase(page, 3)).equals(true)
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await runnerNearBase(page, 3)).equals(true)
    } finally {
      await page.close()
    }
  })

  it('E3 retreats third back to second without a Safe/Out strip', async function () {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    try {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true
      })
      await overrideBases(page, [['Second base', 'Player 7']])
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      expect(await runnerNearBase(page, 3)).equals(true)
      await dragRunner(page, 3, 2)
      // Retreat must not mount Safe/Out.
      expect(await page.$('[aria-label="Safe drag target"]')).equals(null)
      expect(await page.$('[aria-label="Out drag target"]')).equals(null)
      await page.touchscreen.touchEnd()
      await waitRunnerNearBase(page, 2)
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      expect(await runnerNearBase(page, 2)).equals(true)
    } finally {
      await page.close()
    }
  })

  it('E4 still forces the runner on first on a bases-loaded single', async function () {
    const { page } = await open('/games/g1/score')
    try {
      await overrideBases(page, [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ])
      await chooseHit(page, 'Single')
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      // Forced advances leave no Back for the runner scoring from third.
      expect(await page.$('[aria-label="Back"]')).equals(null)
      await click(page, 'Safe')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
    } finally {
      await page.close()
    }
  })
})

/**
 * E1: a ground out sends every other runner up a base. With TS_CAPTURE_ONLY=1
 * (the before pictures, taken on the base revision) only the scenarios that
 * take a picture run, and nothing is asserted. Pictures go to
 * TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png` (after by
 * default).
 */
describe('ground outs', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  const phase = process.env.TS_ARTIFACT_PHASE ?? 'after'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  async function openPhone(): Promise<Page> {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return page
  }
  async function frame(page: Page): Promise<void> {
    await page.evaluate(
      async () =>
        await new Promise(resolve => {
          requestAnimationFrame(resolve)
        })
    )
  }
  async function picture(
    page: Page,
    name: string,
    settleMs = 1500
  ): Promise<void> {
    const dir = process.env.TS_SCORING_ARTIFACT_DIR
    if (dir == null || dir === '') return
    await mkdir(dir, { recursive: true })
    // Let the last motion settle before the picture.
    await new Promise(resolve => setTimeout(resolve, settleMs))
    await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
  }
  /** The play stays open for correction for a few seconds: drag at once. */
  async function correcting(page: Page): Promise<void> {
    await page.waitForSelector('[aria-label="Time to edit play"]', {
      timeout: 30000
    })
  }
  /** The ground ball to the shortstop, the fifth player the field offers. */
  async function groundOut(
    page: Page,
    contact: 'Swing' | 'Bunt' = 'Swing'
  ): Promise<void> {
    await waitReady(page)
    await click(page, `${contact} in Play`)
    await click(page, 'Batter Out')
    // The base revision calls it Throw Out.
    await page.waitForSelector(
      '[aria-label="Ground Out"], [aria-label="Throw Out"]'
    )
    await click(
      page,
      (await page.$('[aria-label="Ground Out"]')) == null
        ? 'Throw Out'
        : 'Ground Out'
    )
    await page.waitForSelector(
      '[aria-label^="Tap or drag a player to where the ball was fielded"]'
    )
    // The shortstop, fifth of the players the field offers.
    const field = puppeteerDriver(page)
    await placeOffered(field, 4)
    await setTrajectory(field, contact === 'Swing' ? -10 : undefined)
    await page.waitForSelector(
      '[aria-label^="Tap or drag the next defender"]',
      {
        timeout: 30000
      }
    )
  }
  /** Places the player `presses` steps along the field's choosable list. */
  /** The player `presses` places along what the field offers takes the ball. */
  async function place(page: Page, presses: number): Promise<void> {
    await frame(page)
    await frame(page)
    await placeOffered(puppeteerDriver(page), Math.max(0, presses - 1))
  }
  async function tapEither(page: Page, label: string): Promise<void> {
    const selector = `[aria-label="${label}"], [aria-label="Bottom ${label}"]`
    await page.waitForSelector(selector, { timeout: 30000 })
    await click(
      page,
      (await page.$(`[aria-label="${label}"]`)) == null
        ? `Bottom ${label}`
        : label
    )
  }
  /** The shortstop holds the ball: the first baseman is third, and takes it. */
  async function batterOutAtFirst(page: Page): Promise<void> {
    await place(page, 3)
    await tapEither(page, 'Finish defensive play')
  }
  async function outsShown(page: Page, outs: number): Promise<void> {
    await page.waitForSelector(`[aria-label*=" ${outs} outs"]`, {
      timeout: 30000
    })
  }
  async function score(page: Page, away: number): Promise<void> {
    await page.waitForSelector(`[aria-label*="Owls ${away} · Hawks 0"]`, {
      timeout: 30000
    })
  }
  async function stillNear(page: Page, base: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await runnerNearBase(page, base), `runner on ${base}`).equals(true)
  }
  /**
   * A dropped runner is set back on the base he left and runs to the one he
   * was dropped on, so a base he passes through is not empty until the field
   * moves nobody.
   */
  async function atRest(page: Page): Promise<void> {
    await page.waitForSelector(
      '[aria-label="Baseball field"][data-moving=""]',
      {
        timeout: 30000
      }
    )
  }
  async function nobodyNear(page: Page, base: number): Promise<void> {
    expect(await runnerNearBase(page, base), `nobody on ${base}`).equals(false)
  }

  it('sends the runner on first to second, and he drags back to first', async function () {
    const page = await openPhone()
    try {
      await overrideBases(page, [['First base', 'Player 7']])
      await groundOut(page)
      await batterOutAtFirst(page)
      await correcting(page)
      if (!capturing) await waitRunnerNearBase(page, 2)
      await picture(page, 'ground-out-runner-on-first', 0)
      if (capturing) return
      await outsShown(page, 1)
      await dragRunner(page, 2, 1)
      await page.touchscreen.touchEnd()
      await atRest(page)
      await waitRunnerNearBase(page, 1)
      await nobodyNear(page, 2)
      await tapEither(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await stillNear(page, 1)
    } finally {
      await page.close()
    }
  })

  it('sends runners on first and second to second and third, and refuses the lead back onto the trail', async function () {
    if (capturing) this.skip()
    const page = await openPhone()
    try {
      await overrideBases(page, [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7']
      ])
      await groundOut(page)
      await batterOutAtFirst(page)
      await correcting(page)
      await waitRunnerNearBase(page, 3)
      await waitRunnerNearBase(page, 2)
      // Second is taken: the field offers the lead runner no way back, and
      // he stays on third.
      await dragRunner(page, 3, 2)
      await page.touchscreen.touchEnd()
      await waitRunnerNearBase(page, 3)
      // The trailing runner goes back to first; the lead keeps third.
      await dragRunner(page, 2, 1)
      await page.touchscreen.touchEnd()
      await atRest(page)
      await waitRunnerNearBase(page, 1)
      await waitRunnerNearBase(page, 3)
      await nobodyNear(page, 2)
    } finally {
      await page.close()
    }
  })

  for (const call of ['Safe', 'Out', 'Back'] as const)
    it(`asks Safe, Out or Back for the runner from third, and he is ${call}`, async function () {
      if (capturing) this.skip()
      const page = await openPhone()
      try {
        await overrideBases(page, [['Third base', 'Player 8']])
        await groundOut(page)
        await batterOutAtFirst(page)
        await page.waitForSelector(
          '[aria-label="Home plate decision for Player 8"]',
          { timeout: 30000 }
        )
        // The run is not on the board until he is called safe.
        await score(page, 0)
        expect(await page.$('[aria-label="Back"]')).not.equals(null)
        await click(page, call)
        if (call === 'Safe') await score(page, 1)
        else if (call === 'Out') {
          await place(page, 0)
          await tapEither(page, 'Finish defensive play')
          await page.waitForSelector('[aria-label*="Batter Player 2"]', {
            timeout: 30000
          })
          await outsShown(page, 2)
          await score(page, 0)
        } else {
          await waitRunnerNearBase(page, 3)
          await score(page, 0)
          await tapEither(page, 'Finish at-bat')
          await page.waitForSelector('[aria-label*="Batter Player 2"]', {
            timeout: 30000
          })
          await stillNear(page, 3)
          await score(page, 0)
        }
      } finally {
        await page.close()
      }
    })

  it('scores the lead runner with the bases loaded and moves the others up a base', async function () {
    if (capturing) this.skip()
    const page = await openPhone()
    try {
      await overrideBases(page, [
        ['First base', 'Player 6'],
        ['Second base', 'Player 7'],
        ['Third base', 'Player 8']
      ])
      await groundOut(page)
      await batterOutAtFirst(page)
      await page.waitForSelector(
        '[aria-label="Home plate decision for Player 8"]',
        { timeout: 30000 }
      )
      await score(page, 0)
      await click(page, 'Safe')
      await score(page, 1)
      await waitRunnerNearBase(page, 2)
      await waitRunnerNearBase(page, 3)
      await outsShown(page, 1)
    } finally {
      await page.close()
    }
  })

  it('moves the runner up on a bunt ground out too', async function () {
    if (capturing) this.skip()
    const page = await openPhone()
    try {
      await overrideBases(page, [['First base', 'Player 7']])
      await groundOut(page, 'Bunt')
      await batterOutAtFirst(page)
      await waitRunnerNearBase(page, 2)
    } finally {
      await page.close()
    }
  })

  it('puts the runner from first out on second in a 6-4-3, then the batter at first', async function () {
    const page = await openPhone()
    try {
      await overrideBases(page, [['First base', 'Player 7']])
      await groundOut(page)
      // The shortstop holds the ball, so the second baseman is fourth.
      await place(page, 4)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]'
      )
      if (!capturing)
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender, hold a runner to put him out on his base"]'
        )
      // The runner is the last player the field offers: held where he stands.
      await frame(page)
      await frame(page)
      await dropOfferedRunner(page, 'Out')
      if (!capturing) {
        await page.waitForSelector(
          '[aria-label^="Tap or drag the next defender, or hit Done"]'
        )
      }
      // The second baseman still holds it, so the first baseman is third.
      await batterOutAtFirst(page)
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      await picture(page, 'ground-out-double-play')
      if (capturing) return
      await outsShown(page, 2)
      for (const at of [1, 2, 3]) await nobodyNear(page, at)
    } finally {
      await page.close()
    }
  })

  it('moves nobody with two out: the batter out ends the half', async function () {
    if (capturing) this.skip()
    const page = await openPhone()
    try {
      await overrideBases(page, [['First base', 'Player 7']])
      for (let i = 0; i < 6; i++) {
        await waitReady(page)
        await click(page, 'Swing and Miss')
      }
      await waitReady(page)
      await groundOut(page)
      await stillNear(page, 1)
      await nobodyNear(page, 2)
      await batterOutAtFirst(page)
      await page.waitForSelector('[aria-label*="Bottom 1st"]', {
        timeout: 30000
      })
      await score(page, 0)
    } finally {
      await page.close()
    }
  })
})

/**
 * E2: scoring waits only for a pitcher, and a ball to an empty position is
 * played by a nameless stand-in. With TS_CAPTURE_ONLY=1 (the before
 * pictures, taken on the base revision) nothing is asserted, and pictures go
 * to TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png`.
 */
describe('pitcher only', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  const phase = process.env.TS_ARTIFACT_PHASE ?? 'after'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  async function openPhone(): Promise<Page> {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return page
  }
  async function frame(page: Page): Promise<void> {
    await page.evaluate(
      async () =>
        await new Promise(resolve => {
          requestAnimationFrame(resolve)
        })
    )
  }
  async function picture(
    page: Page,
    name: string,
    settleMs = 1500
  ): Promise<void> {
    const dir = process.env.TS_SCORING_ARTIFACT_DIR
    if (dir == null || dir === '') return
    await mkdir(dir, { recursive: true })
    await new Promise(resolve => setTimeout(resolve, settleMs))
    await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
  }
  /** Leaves on the hosts' defense only the positions named. */
  async function fieldOnly(page: Page, kept: readonly string[]): Promise<void> {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    // The hosts take the field in the top of the first.
    await click(page, 'Home Team')
    await click(page, 'Defense')
    for (const position of ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'])
      if (!kept.includes(position)) await click(page, `Clear ${position}`)
    await click(page, 'Save Rosters')
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save Rosters"]') == null,
      { timeout: 30000 }
    )
  }
  async function shown(page: Page, text: string): Promise<boolean> {
    return await page.evaluate(
      said => document.body.innerText.includes(said),
      text
    )
  }
  async function ballEnabled(page: Page): Promise<boolean> {
    return await page.$eval(
      '[aria-label="Ball"]',
      node => node.getAttribute('aria-disabled') !== 'true'
    )
  }
  /** Places the player `presses` steps along the field's choosable list. */
  /** The player `presses` places along what the field offers takes the ball. */
  async function place(page: Page, presses: number): Promise<void> {
    await frame(page)
    await frame(page)
    await placeOffered(puppeteerDriver(page), Math.max(0, presses - 1))
  }
  async function tapEither(page: Page, label: string): Promise<void> {
    const selector = `[aria-label="${label}"], [aria-label="Bottom ${label}"]`
    await page.waitForSelector(selector, { timeout: 30000 })
    await click(
      page,
      (await page.$(`[aria-label="${label}"]`)) == null
        ? `Bottom ${label}`
        : label
    )
  }

  /** The fielder at `position` takes the ball, dragged where he fields it. */
  async function placePosition(page: Page, position: string): Promise<void> {
    await frame(page)
    await placeFielder(puppeteerDriver(page), position)
  }

  it('scores with only a pitcher, and plays a ground ball to an empty short with a nameless fielder', async function () {
    const page = await openPhone()
    try {
      await fieldOnly(page, ['P'])
      await picture(page, 'missing-defense')
      if (!capturing) {
        // No prompt: the pitch controls are live.
        expect(await shown(page, 'Missing defensive positions')).equals(false)
        expect(await shown(page, 'Assign a pitcher')).equals(false)
        await waitReady(page)
        expect(await ballEnabled(page)).equals(true)
        // Every empty position still has its plate to fill.
        for (const position of ['C', '1B', 'SS', 'RF'])
          expect(
            await page.$(`[aria-label="Assign ${position}"]`),
            position
          ).not.equals(null)
        await click(page, 'Ball')
        await page.waitForSelector('[aria-label*="1 ball"]', { timeout: 30000 })
      }
      if (
        capturing &&
        !(await page.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              '[aria-label="Swing in Play"]:not([aria-disabled="true"]):not(:disabled)'
            )
          ).some(node => node.checkVisibility())
        ))
      ) {
        // The base revision puts no ball in play without a whole defense:
        // nobody can play the empty shortstop's spot.
        await picture(page, 'stand-in-fielder', 0)
        return
      }
      await click(page, 'Swing in Play')
      await click(page, 'Batter Out')
      await page.waitForSelector(
        '[aria-label="Ground Out"], [aria-label="Throw Out"]'
      )
      await click(
        page,
        (await page.$('[aria-label="Ground Out"]')) == null
          ? 'Throw Out'
          : 'Ground Out'
      )
      await page.waitForSelector(
        '[aria-label^="Tap or drag a player to where the ball was fielded"]'
      )
      if (capturing) {
        // The pitcher is first among the players the field offers, then the
        // empty positions in order: C, 1B, 2B, SS.
        await place(page, 5)
        // The base revision offers no empty position: the play cannot use
        // the shortstop's spot.
        await picture(page, 'stand-in-fielder', 500)
        return
      }
      // The empty shortstop's spot fields it.
      await placePosition(page, 'SS')
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      // While the play is open the shortstop's spot is a fielder, with no
      // name and no plate. The plates follow the field's next drawn frame.
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Assign SS"]') == null,
        { timeout: 2000 }
      )
      expect(await page.$('[aria-label="Assign 1B"]')).not.equals(null)
      // The angle the control starts at will do for a ground ball.
      await frame(page)
      await setTrajectory(puppeteerDriver(page))
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]',
        {
          timeout: 30000
        }
      )
      await picture(page, 'stand-in-fielder', 300)
      // The stand-in at short throws to the stand-in at first.
      await placePosition(page, '1B')
      await tapEither(page, 'Finish defensive play')
      await page.waitForSelector(
        '[aria-label*=" 1 outs"], [aria-label*=" 1 out"]',
        {
          timeout: 30000
        }
      )
      // With nobody on, the play closes once its correction time is up.
      if ((await page.$('[aria-label="Finish at-bat"]')) != null)
        await click(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      // The play over, short is an empty plate again.
      await page.waitForSelector('[aria-label="Assign SS"]', { timeout: 30000 })
      await page.waitForSelector('[aria-label="Assign 1B"]', { timeout: 30000 })
      expect(await shown(page, 'Assign a pitcher')).equals(false)
    } finally {
      await page.close()
    }
  })

  it('waits for a pitcher once Clear P empties the mound', async function () {
    if (capturing) this.skip()
    const page = await openPhone()
    try {
      await fieldOnly(page, [])
      await page.waitForFunction(
        () => document.body.innerText.includes('Assign a pitcher'),
        { timeout: 30000 }
      )
      expect(await ballEnabled(page)).equals(false)
      expect(await page.$('[aria-label="Assign P"]')).not.equals(null)
    } finally {
      await page.close()
    }
  })
})

/**
 * E3: Out at First is a Batter Out row of its own on a swing and a bunt. A
 * ball the shortstop fields goes to first with no receiver to choose, the
 * shortstop assisting and the first baseman taking the putout; a ball the
 * first baseman fields asks who took it; with nobody at first a nameless
 * stand-in takes the throw and nobody is credited. Each play's box score is
 * printed (`box:` lines) from what the page saved. With TS_CAPTURE_ONLY=1
 * (the before picture, taken on the base revision) only the menu picture is
 * taken and nothing is asserted; pictures go to TS_SCORING_ARTIFACT_DIR as
 * `<name>-<TS_ARTIFACT_PHASE>.png`.
 */
describe('out at first', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  const phase = process.env.TS_ARTIFACT_PHASE ?? 'after'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  /** A fielding credit as the saved play document writes it. */
  interface SavedCredit {
    credit: string
    position: { abbreviation: string }
    player?: { id: number }
  }
  interface SavedPlay {
    about: { atBatIndex: number }
    runners?: Array<{
      details: { runner: { id: number }; event?: string }
      movement: { isOut: boolean; outBase?: string | null }
      credits: SavedCredit[]
    }>
  }
  /** The plays the page saved, the latest version of each. */
  type Saved = Map<number, SavedPlay>

  async function openPhone(): Promise<{ page: Page; saved: Saved }> {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    const saved: Saved = new Map()
    // The save each play was last seen in, so a later save always wins.
    const seenIn = new Map<number, number>()
    let saves = 0
    page.on('request', request => {
      const url = new URL(request.url())
      if (
        request.method() !== 'POST' ||
        url.pathname !== '/api/v1/games/g1/events'
      )
        return
      const save = ++saves
      const read = async (): Promise<void> => {
        const change = JSON.parse((await request.fetchPostData()) ?? '{}') as {
          plays?: SavedPlay[]
          currentPlay?: SavedPlay | null
        }
        for (const play of [...(change.plays ?? []), change.currentPlay]) {
          if (play?.about == null) continue
          const index = play.about.atBatIndex
          if ((seenIn.get(index) ?? 0) > save) continue
          seenIn.set(index, save)
          saved.set(index, play)
        }
      }
      read().catch(() => undefined)
    })
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return { page, saved }
  }
  async function frame(page: Page): Promise<void> {
    await page.evaluate(
      async () =>
        await new Promise(resolve => {
          requestAnimationFrame(resolve)
        })
    )
  }
  async function picture(
    page: Page,
    name: string,
    settleMs = 1500
  ): Promise<void> {
    const dir = process.env.TS_SCORING_ARTIFACT_DIR
    if (dir == null || dir === '') return
    await mkdir(dir, { recursive: true })
    await new Promise(resolve => setTimeout(resolve, settleMs))
    await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
  }
  /** The Batter Out rows the open menu lists, in order. */
  async function batterOutRows(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-label]'))
        .map(node => node.getAttribute('aria-label')!)
        .filter(label =>
          [
            'Throw Out',
            'Ground Out',
            'Out at First',
            'Ball Caught',
            'Batter Interference'
          ].includes(label)
        )
    )
  }
  /** Places the player `presses` steps along the field's choosable list. */
  /** The player `presses` places along what the field offers takes the ball. */
  async function place(page: Page, presses: number): Promise<void> {
    await frame(page)
    await frame(page)
    await placeOffered(puppeteerDriver(page), Math.max(0, presses - 1))
  }
  async function tapEither(page: Page, label: string): Promise<void> {
    const selector = `[aria-label="${label}"], [aria-label="Bottom ${label}"]`
    await page.waitForSelector(selector, { timeout: 30000 })
    await click(
      page,
      (await page.$(`[aria-label="${label}"]`)) == null
        ? `Bottom ${label}`
        : label
    )
  }
  /**
   * An Out at First fielded by the player `presses` steps along the list
   * the field offers: P, C, 1B, 2B, SS with the whole defense out.
   */
  async function outAtFirst(page: Page, presses: number): Promise<void> {
    await waitReady(page)
    await click(page, 'Swing in Play')
    await click(page, 'Batter Out')
    await click(page, 'Out at First')
    await page.waitForSelector(
      '[aria-label^="Tap or drag a player to where the ball was fielded"]'
    )
    await place(page, presses)
    await setTrajectory(puppeteerDriver(page), -10)
  }
  async function oneOut(page: Page): Promise<void> {
    await page.waitForSelector(
      '[aria-label*=" 1 outs"], [aria-label*=" 1 out"]',
      { timeout: 30000 }
    )
  }
  /** Ends the play: with nobody on it closes once its correction time is up. */
  async function nextBatter(page: Page): Promise<void> {
    if ((await page.$('[aria-label="Finish at-bat"]')) != null)
      await click(page, 'Finish at-bat')
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 30000
    })
  }
  /**
   * The fielding box score of the saved plays, a line per credit: putouts
   * and assists by position, and the player credited (nobody for a
   * stand-in). Printed for the proving log.
   */
  /** The fixture's names: the hosts are Player 1–9 (201–209). */
  function name(id: number): string {
    return id > 200
      ? `Player ${id - 200}`
      : id === 101
        ? 'Jordan K.'
        : `Player ${id - 100}`
  }
  async function boxScore(saved: Saved, title: string): Promise<string[]> {
    for (let wait = 0; wait < 100; wait++) {
      if (
        [...saved.values()].some(play =>
          (play.runners ?? []).some(runner => runner.movement.isOut)
        )
      )
        break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const lines = [...saved.values()]
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
      .flatMap(play =>
        (play.runners ?? []).flatMap(runner =>
          runner.credits.map(
            credit =>
              `${credit.credit === 'f_putout' ? 'PO' : credit.credit === 'f_assist' ? 'A' : credit.credit} ${credit.position.abbreviation} ${credit.player == null ? '(nobody)' : name(credit.player.id)}`
          )
        )
      )
    const outs = [...saved.values()].flatMap(play =>
      (play.runners ?? [])
        .filter(runner => runner.movement.isOut)
        .map(
          runner =>
            `${name(runner.details.runner.id)} ${runner.details.event ?? ''}, out at ${runner.movement.outBase ?? ''}`
        )
    )
    console.log(`box: ${title}`)
    for (const line of [...outs.map(out => `out: ${out}`), ...lines])
      console.log(`box:   ${line}`)
    return lines
  }

  for (const contact of ['Swing', 'Bunt'] as const)
    it(`lists Out at First under Batter Out on a ${contact.toLowerCase()}`, async function () {
      if (capturing && contact === 'Bunt') this.skip()
      const { page } = await openPhone()
      try {
        await waitReady(page)
        await click(page, `${contact} in Play`)
        await click(page, 'Batter Out')
        await page.waitForSelector(
          '[aria-label="Ground Out"], [aria-label="Throw Out"]'
        )
        if (contact === 'Swing') await picture(page, 'batter-out-menu', 300)
        if (capturing) return
        expect(await batterOutRows(page)).deep.equals([
          'Ground Out',
          'Out at First',
          'Ball Caught',
          'Batter Interference'
        ])
      } finally {
        await page.close()
      }
    })

  it("throws the shortstop's ball to first with no prompt: SS assist, 1B putout", async function () {
    if (capturing) this.skip()
    const { page, saved } = await openPhone()
    try {
      await outAtFirst(page, 5)
      await oneOut(page)
      expect(
        await page.$('[aria-label^="Tap or drag the next defender"]')
      ).equals(null)
      await nextBatter(page)
      expect(await boxScore(saved, 'shortstop to first')).deep.equals([
        'A SS Player 5',
        'PO 1B Player 3'
      ])
    } finally {
      await page.close()
    }
  })

  it("asks who took the first baseman's own ball", async function () {
    if (capturing) this.skip()
    const { page, saved } = await openPhone()
    try {
      await outAtFirst(page, 3)
      await page.waitForSelector(
        '[aria-label^="Tap or drag the next defender"]',
        { timeout: 30000 }
      )
      // Nobody is out until the scorer says who took it.
      expect(await page.$('[aria-label*=" 1 out"]')).equals(null)
      // The pitcher covers first: first among the players the field offers.
      await place(page, 1)
      await tapEither(page, 'Finish defensive play')
      await oneOut(page)
      await nextBatter(page)
      expect(await boxScore(saved, 'first baseman to pitcher')).deep.equals([
        'A 1B Player 3',
        'PO P Player 1'
      ])
    } finally {
      await page.close()
    }
  })

  it('throws to a nameless stand-in at an empty first, crediting nobody', async function () {
    if (capturing) this.skip()
    const { page, saved } = await openPhone()
    try {
      await click(page, 'Open scoring menu')
      await click(page, 'Set Team Rosters')
      await click(page, 'Home Team')
      await click(page, 'Defense')
      await click(page, 'Clear 1B')
      await click(page, 'Save Rosters')
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save Rosters"]') == null,
        { timeout: 30000 }
      )
      await page.waitForSelector('[aria-label="Assign 1B"]', { timeout: 30000 })
      // The players on the field come first: P, C, 2B, SS.
      await outAtFirst(page, 4)
      await oneOut(page)
      expect(
        await page.$('[aria-label^="Tap or drag the next defender"]')
      ).equals(null)
      await nextBatter(page)
      await page.waitForSelector('[aria-label="Assign 1B"]', { timeout: 30000 })
      expect(await boxScore(saved, 'shortstop to an empty first')).deep.equals([
        'A SS Player 5',
        'PO 1B (nobody)'
      ])
    } finally {
      await page.close()
    }
  })
})

/**
 * E4: a runner who scores leaves the field. After a home run, in the park or
 * over the fence, with the bases empty or loaded, nobody stays beside home
 * and there is no handle there to drag back; a runner dragged home and
 * called safe is gone, and still gone after the next pitch. With
 * TS_CAPTURE_ONLY=1 (the before pictures, taken on the base revision) only
 * the scenarios that take a picture run, and nothing is asserted; pictures go
 * to TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png`.
 */
describe('scorers leave the field', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  const phase = process.env.TS_ARTIFACT_PHASE ?? 'after'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  async function openPhone(): Promise<Page> {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'switch',
      true
    )
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return page
  }
  async function picture(page: Page, name: string): Promise<void> {
    const dir = process.env.TS_SCORING_ARTIFACT_DIR
    if (dir == null || dir === '') return
    await mkdir(dir, { recursive: true })
    await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
  }
  /** Where a ground point sits on the canvas, in the home view. */
  async function project(
    page: Page,
    x: number,
    z: number,
    y = 0
  ): Promise<[number, number]> {
    const rect = await page.$eval('canvas', canvas => {
      const r = canvas.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width: rect.width,
      height: rect.height,
      view: 'home',
      zoom: 1.25,
      tilt: (-11 * Math.PI) / 180,
      heightOffset: 33,
      bottomExtension: 112
    })
    const point = new Vector3(x, y, z).project(camera)
    return [
      rect.x + ((point.x + 1) * rect.width) / 2,
      rect.y + ((1 - point.y) * rect.height) / 2
    ]
  }
  /** The offense players drawn on the field, by gumbo id. */
  async function offense(page: Page): Promise<number[]> {
    await captureScene(page)
    return await page.evaluate(() => {
      const scene = (window as unknown as SceneProbeWindow).qaScene
      if (scene == null) return []
      const ids: number[] = []
      scene.traverse(obj => {
        if (!obj.name.startsWith('player-offense-')) return
        let shown = true
        for (
          let node: typeof obj | null = obj;
          node != null;
          node = node.parent
        )
          if (!node.visible) shown = false
        if (shown) ids.push(Number(obj.name.slice('player-offense-'.length)))
      })
      return ids.sort((a, b) => a - b)
    })
  }
  /** Waits for the walk to the dugout to end with exactly `ids` drawn. */
  async function onlyOffense(page: Page, ids: number[]): Promise<void> {
    let drawn: number[] = []
    for (let i = 0; i < 100; i++) {
      drawn = await offense(page)
      if (JSON.stringify(drawn) === JSON.stringify(ids)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(drawn, 'offense players drawn').deep.equals(ids)
  }
  /**
   * The old drag-back handle stood in the home queue, well behind the
   * batter: a drag from there to third changes nothing.
   */
  async function noHandleAtHome(page: Page, runs: number): Promise<void> {
    const distance = 1.2 + 15 * 0.61
    const from = await project(
      page,
      -distance / Math.SQRT2,
      -distance / Math.SQRT2,
      6
    )
    const to = await project(page, BASES[3].x, BASES[3].z)
    await page.touchscreen.touchStart(...from)
    await new Promise(resolve => setTimeout(resolve, 400))
    await page.touchscreen.touchMove(...to)
    await page.touchscreen.touchEnd()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await page.content()).not.includes('Runner did not advance')
    await page.waitForSelector(`[aria-label*="Owls ${runs} · Hawks 0"]`)
    expect(await runnerNearBase(page, 3), 'nobody on 3').equals(false)
  }
  /** Aims the ball in the park or over the fence, as the scorer drags it. */
  async function homeRun(page: Page, outside: boolean): Promise<void> {
    await waitReady(page)
    await click(page, 'Swing in Play')
    await click(page, 'Home Run')
    await page.waitForSelector('[aria-label^="Drag where the ball was hit"]')
    const origin = await project(page, -32, -25)
    const start = initialHitTarget('R')
    const initial = await project(page, start.x, start.z, 0.7)
    const target = await project(
      page,
      0,
      outside ? -133 : -100,
      outside ? 8 : 0.7
    )
    await page.mouse.move(...origin)
    await page.mouse.down()
    await page.mouse.move(
      origin[0] + target[0] - initial[0],
      origin[1] + target[1] - initial[1],
      { steps: 10 }
    )
    if (!capturing)
      await page.waitForSelector(
        `[aria-label="Home run type: ${outside ? 'Home Run' : 'In-the-park Home Run'}"]`
      )
    await page.mouse.up()
    await setTrajectory(puppeteerDriver(page))
    await page.waitForSelector('[aria-label*="Batter Player 2"]', {
      timeout: 45000
    })
  }

  for (const outside of [false, true])
    for (const loaded of [false, true])
      it(`sends everyone off after ${outside ? 'an over-the-fence' : 'an in-the-park'} home run with the bases ${loaded ? 'loaded' : 'empty'}`, async function () {
        // The before picture is the plainest case.
        if (capturing && (outside || loaded)) this.skip()
        const page = await openPhone()
        try {
          if (loaded)
            await overrideBases(page, [
              ['First base', 'Player 6'],
              ['Second base', 'Player 7'],
              ['Third base', 'Player 8']
            ])
          await homeRun(page, outside)
          const runs = loaded ? 4 : 1
          if (capturing) {
            await new Promise(resolve => setTimeout(resolve, 4000))
            await picture(page, 'home-run-end')
            return
          }
          await page.waitForSelector(`[aria-label*="Owls ${runs} · Hawks 0"]`)
          // Only the next batter, Player 2, is left on the offense.
          await onlyOffense(page, [102])
          if (!loaded && !outside) await picture(page, 'home-run-end')
          await noHandleAtHome(page, runs)
          await onlyOffense(page, [102])
        } finally {
          await page.close()
        }
      })

  it('sends a runner dragged home and called safe off, and keeps him off after the next pitch', async function () {
    const page = await openPhone()
    try {
      await overrideBases(page, [['Second base', 'Player 7']])
      await chooseHit(page, 'Single')
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      if (!capturing) await waitRunnerNearBase(page, 3)
      // Drag him home and drop him on Safe.
      await dragRunner(page, 3, 0)
      const safe = await page.waitForSelector(
        '[aria-label="Safe drag target"]',
        { timeout: 10000 }
      )
      const box = (await safe!.boundingBox())!
      await page.touchscreen.touchMove(
        box.x + box.width / 2,
        box.y + box.height / 2
      )
      await page.touchscreen.touchEnd()
      await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]', {
        timeout: 30000
      })
      await tapSettled(page, 'Finish at-bat')
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 30000
      })
      if (!capturing) {
        // The batter on first and the next batter; Player 7 (107) is gone.
        await onlyOffense(page, [101, 102])
        await noHandleAtHome(page, 1)
      }
      await waitReady(page)
      await click(page, 'Ball')
      await page.waitForSelector(
        '[aria-label*="1 balls 0 strikes 1 outs"], [aria-label*="1 balls 0 strikes 0 outs"]',
        {
          timeout: 30000
        }
      )
      await new Promise(resolve => setTimeout(resolve, 1500))
      await picture(page, 'safe-at-home-next-play')
      if (capturing) return
      await onlyOffense(page, [101, 102])
      await page.waitForSelector('[aria-label*="Owls 1 · Hawks 0"]')
    } finally {
      await page.close()
    }
  })
})

/**
 * E5: the lineup's Clear and its lock at the first pitch. Before the first
 * pitch the Lineup header has a red Clear on its right, each row a red X, and
 * Clear empties the order; after a pitch there is neither, a bench player
 * dropped on a row takes that slot, a swap of slots 3 and 4 bats the man now
 * in slot 3, and the bat icon marks that slot. With TS_CAPTURE_ONLY=1 (the
 * before pictures, taken on the base revision) only the pictures are taken,
 * and nothing is asserted; pictures go to TS_SCORING_ARTIFACT_DIR as
 * `<name>-<TS_ARTIFACT_PHASE>.png`.
 */
describe('lineup clear', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  const phase = process.env.TS_ARTIFACT_PHASE ?? 'after'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  async function openPhone(): Promise<Page> {
    const { page } = await open('/games/g1/score')
    await page.setViewport({ width: 402, height: 874, deviceScaleFactor: 2 })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return page
  }
  async function picture(page: Page, name: string): Promise<void> {
    const dir = process.env.TS_SCORING_ARTIFACT_DIR
    if (dir == null || dir === '') return
    await mkdir(dir, { recursive: true })
    await settle(page)
    await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
  }
  async function settle(page: Page): Promise<void> {
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(animation => animation.playState !== 'running')
    )
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  /** The away team's roster sheet, on its Lineup tab. */
  async function lineupTab(page: Page): Promise<void> {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]')
    await click(page, 'Lineup')
    await page.waitForSelector('[data-roster-target="lineup-0"]', {
      visible: true
    })
  }
  /** The batting order shown, by name. */
  async function order(page: Page): Promise<string[]> {
    return await page.$$eval(
      '[data-roster-target^="lineup-"][data-roster-player]',
      nodes =>
        nodes.map(node =>
          String(node.textContent)
            .replace(/^\D*\d+\. (#\S+ )?/, '')
            .replace(/\W+$/, '')
        )
    )
  }
  /** A mouse drag, held until the card lifts, from `source` onto `target`. */
  async function dragOnto(
    page: Page,
    source: string,
    target: string
  ): Promise<void> {
    await page.$eval(source, node => {
      node.scrollIntoView({ block: 'center' })
    })
    const centre = async (selector: string): Promise<[number, number]> =>
      await page.$eval(selector, node => {
        const r = node.getBoundingClientRect()
        return [r.x + Math.min(40, r.width / 2), r.y + r.height / 2] as [
          number,
          number
        ]
      })
    const from = await centre(source)
    await page.mouse.move(...from)
    await page.mouse.down()
    await page.waitForSelector('[data-testid="Roster dragged card"]')
    const to = await centre(target)
    await page.mouse.move(...to, { steps: 12 })
    await new Promise(resolve => setTimeout(resolve, 200))
    await page.mouse.up()
    await settle(page)
  }
  /** Four balls to the batter, and the next one up. */
  async function walk(page: Page, next: string): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await waitReady(page)
      await click(page, 'Ball')
    }
    await page.waitForSelector(`[aria-label*="Batter ${next}"]`, {
      timeout: 45000
    })
  }

  it('offers a red Clear on the Lineup header and an X per row before the first pitch, and Clear empties the order', async function () {
    const page = await openPhone()
    try {
      await lineupTab(page)
      await picture(page, 'lineup-header')
      if (capturing) return
      const header = await page.$eval('[data-testid="Lineup header"]', node => {
        const words = Array.from(node.querySelectorAll('*'))
          .filter(
            each =>
              each.children.length === 0 &&
              ['Lineup', 'Clear'].includes(String(each.textContent))
          )
          .map(each => {
            const r = each.getBoundingClientRect()
            const style = window.getComputedStyle(each)
            return {
              text: String(each.textContent),
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              color: style.color,
              clipped: each.scrollWidth > each.clientWidth + 1
            }
          })
        const r = node.getBoundingClientRect()
        return { words, right: r.right }
      })
      const lineup = header.words.find(word => word.text === 'Lineup')!
      const clear = header.words.find(word => word.text === 'Clear')!
      expect(lineup, 'Lineup').not.equals(undefined)
      expect(clear, 'Clear').not.equals(undefined)
      // One row: Lineup on the left, Clear right-justified, both whole.
      expect(clear.left).greaterThan(lineup.right)
      expect(Math.abs(clear.right - header.right)).lessThan(2)
      expect(Math.abs(clear.top - lineup.top)).lessThan(4)
      expect(clear.clipped || lineup.clipped).equals(false)
      expect(clear.color).equals('rgb(168, 53, 53)')
      const rows = (await order(page)).length
      expect(rows).equals(9)
      expect(
        await page.$$eval(
          '[data-roster-target^="lineup-"] [aria-label^="Remove "]',
          nodes => nodes.length
        )
      ).equals(rows)
      await click(page, 'Clear Lineup')
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-roster-target^="lineup-"][data-roster-player]'
          ).length === 0
      )
      // Every player is back in the roster column.
      expect(
        await page.$$eval(
          '[data-roster-target="roster"] [data-roster-player]',
          nodes => nodes.length
        )
      ).equals(9)
      await click(page, 'Cancel')
    } finally {
      await page.close()
    }
  })

  it('locks the lineup at the first pitch: no Clear or X, a bench drop replaces, and a swap of slots 3 and 4 bats the new slot 3 under the bat', async function () {
    const page = await openPhone()
    try {
      // Player 9 sits before the game; two walks bring up slot 3.
      await lineupTab(page)
      await click(page, 'Remove Player 9')
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label="Undo Set team roster"]')
      // Eight batters: the scorer accepts the short lineup.
      await click(page, 'Accept Lineup')
      await walk(page, 'Player 2')
      await walk(page, 'Player 3')
      await lineupTab(page)
      await picture(page, 'lineup-after-pitch')
      if (capturing) return
      expect(await page.$('[aria-label="Clear Lineup"]')).equals(null)
      expect(await page.$('[aria-label^="Remove Player"]')).equals(null)
      const batSlot = async (): Promise<string | null> =>
        await page.$eval('[data-testid="batIcon"]', node =>
          node
            .closest('[data-roster-target]')!
            .getAttribute('data-roster-target')
        )
      expect(await batSlot()).equals('lineup-2')
      // The bench player dropped on slot 6 replaces Player 6 there.
      const shown = await order(page)
      expect(shown[5]).equals('Player 6')
      await dragOnto(
        page,
        '[data-roster-target="roster"] [aria-label="Add Player 9 to Lineup"]',
        '[data-roster-target="lineup-5"]'
      )
      expect(await order(page)).deep.equals(
        shown.map((name, slot) => (slot === 5 ? 'Player 9' : name))
      )
      expect(
        await page.$('[aria-label="Add Player 6 to Lineup"]'),
        'Player 6 on the roster'
      ).not.equals(null)
      // Slot 4 dropped on slot 3: the two swap, and the bat stays on slot 3.
      await dragOnto(
        page,
        '[aria-label="Reorder Player 4"]',
        '[data-roster-target="lineup-2"]'
      )
      expect((await order(page)).slice(2, 4)).deep.equals([
        'Player 4',
        'Player 3'
      ])
      expect(await batSlot()).equals('lineup-2')
      expect(
        await page.$eval('[data-testid="batIcon"]', node =>
          node.getAttribute('aria-label')
        )
      ).equals('Player 4 bats')
      await click(page, 'Save Rosters')
      await page.waitForSelector('[aria-label*="Batter Player 4"]', {
        timeout: 30000
      })
    } finally {
      await page.close()
    }
  })
})

/**
 * E6: fielders drag between positions with no hold, and the defense has a red
 * Clear. On the hosts' Defense tab a touch that moves 9 px is a tap and clears
 * the position; one that moves 10 px lifts the card at once; a fielder dropped
 * on an empty position moves there and one dropped on an occupied position
 * swaps with the man there. Clear, level with Roster, empties every position,
 * the pitcher's too, and scoring then waits for a pitcher. With
 * TS_CAPTURE_ONLY=1 (the before pictures, taken on the base revision) only the
 * pictures are taken, and nothing is asserted; pictures go to
 * TS_SCORING_ARTIFACT_DIR as `<name>-<TS_ARTIFACT_PHASE>.png`.
 */
describe('fielder drag', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  const phase = process.env.TS_ARTIFACT_PHASE ?? 'after'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  async function openPhone(): Promise<Page> {
    const { page } = await open('/games/g1/score')
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    })
    await page.waitForSelector('canvas[data-field-ready="true"]', {
      timeout: 30000
    })
    return page
  }
  async function settle(page: Page): Promise<void> {
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(animation => animation.playState !== 'running')
    )
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  async function picture(page: Page, name: string): Promise<void> {
    const dir = process.env.TS_SCORING_ARTIFACT_DIR
    if (dir == null || dir === '') return
    await mkdir(dir, { recursive: true })
    await settle(page)
    await page.screenshot({ path: join(dir, `${name}-${phase}.png`) })
  }
  /** The hosts' roster sheet, on its Defense tab: they field first. */
  async function defenseTab(page: Page): Promise<void> {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await page.waitForSelector('[aria-label="Save Rosters"]')
    await click(page, 'Home Team')
    await click(page, 'Defense')
    await page.waitForSelector('[data-roster-target="defense-P"]', {
      visible: true
    })
  }
  const card = (position: string): string =>
    `[data-roster-target="defense-${position}"]`
  /** The player id at a position, or null when it is empty. */
  async function fielder(page: Page, position: string): Promise<string | null> {
    return await page.$eval(card(position), node =>
      node.getAttribute('data-roster-player')
    )
  }
  async function centre(
    page: Page,
    selector: string
  ): Promise<[number, number]> {
    return await page.$eval(selector, node => {
      const r = node.getBoundingClientRect()
      return [r.x + r.width / 2, r.y + r.height / 2] as [number, number]
    })
  }
  /**
   * A touch on `position`'s card that travels `distance` px right, with no
   * hold, then on to `target` when given. Resolves whether the card lifted
   * within 400 ms of the move.
   */
  async function touchDrag(
    page: Page,
    position: string,
    distance: number,
    target?: string
  ): Promise<boolean> {
    const [x, y] = await centre(page, card(position))
    await page.touchscreen.touchStart(x, y)
    await page.touchscreen.touchMove(x + distance, y)
    const lifted = await page
      .waitForSelector('[data-testid="Roster dragged card"]', { timeout: 400 })
      .then(
        () => true,
        () => false
      )
    if (target != null) {
      const [tx, ty] = await centre(page, card(target))
      for (let step = 1; step <= 8; step++)
        await page.touchscreen.touchMove(
          x + distance + ((tx - x - distance) * step) / 8,
          y + ((ty - y) * step) / 8
        )
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await page.touchscreen.touchEnd()
    await settle(page)
    return lifted
  }

  it('drags fielders with no hold, swaps on an occupied position, and clears the defense from the red Clear at the field’s top right', async function () {
    const page = await openPhone()
    try {
      await defenseTab(page)
      await picture(page, 'defense-header')
      if (!capturing) {
        // No Roster title over the cards: blue Help and red Clear sit in the
        // field's top corners, clear of every position card.
        expect(await page.$('[data-testid="Defense roster header"]')).equals(
          null
        )
        const corners = await page.$eval(
          '[data-testid="Defensive field"]',
          field => {
            const box = (node: Element): DOMRect => node.getBoundingClientRect()
            const word = (
              label: string
            ): {
              left: number
              right: number
              top: number
              bottom: number
              color: string
            } | null => {
              const node = field.querySelector(`[aria-label="${label}"]`)
              if (node == null) return null
              const r = box(node)
              const text = node.querySelector('[dir="auto"]')
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                color: text == null ? '' : window.getComputedStyle(text).color
              }
            }
            const cards = Array.from(
              field.querySelectorAll('[data-testid$=" card"]')
            ).map(card => {
              const r = box(card)
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom
              }
            })
            const r = box(field)
            return {
              field: { left: r.left, right: r.right, top: r.top },
              help: word('Defense help'),
              clear: word('Clear Defense'),
              cards
            }
          }
        )
        const { field, help, clear, cards } = corners
        expect(help, 'Help').not.equals(null)
        expect(clear, 'Clear').not.equals(null)
        expect(help!.left - field.left).closeTo(4, 1)
        expect(field.right - clear!.right).closeTo(4, 1)
        expect(help!.top - field.top).closeTo(4, 1)
        expect(clear!.top - field.top).closeTo(4, 1)
        expect(clear!.color).equals('rgb(168, 53, 53)')
        expect(cards).has.length(9)
        for (const control of [help!, clear!])
          for (const card of cards)
            expect(
              control.right <= card.left ||
                control.left >= card.right ||
                control.bottom <= card.top ||
                control.top >= card.bottom
            ).equals(true)
      }
      // Swap: first base's man dropped on short trades places with him.
      const first = await fielder(page, '1B')
      const short = await fielder(page, 'SS')
      const swapLifted = await touchDrag(page, '1B', 12, 'SS')
      await picture(page, 'fielder-swap')
      if (capturing) return
      expect(swapLifted, 'lifted with no hold').equals(true)
      expect(await fielder(page, 'SS')).equals(first)
      expect(await fielder(page, '1B')).equals(short)
      // A 9 px touch is a tap: the catcher's spot empties.
      const catcher = await fielder(page, 'C')
      expect(catcher).not.equals(null)
      expect(await touchDrag(page, 'C', 9)).equals(false)
      expect(await fielder(page, 'C')).equals(null)
      // A 10 px touch lifts the pitcher at once; dropped on the empty
      // catcher's spot he moves there and the mound empties.
      const pitcher = await fielder(page, 'P')
      expect(await touchDrag(page, 'P', 10, 'C')).equals(true)
      expect(await fielder(page, 'C')).equals(pitcher)
      expect(await fielder(page, 'P')).equals(null)
      // Clear empties every position.
      await click(page, 'Clear Defense')
      for (const position of [
        'P',
        'C',
        '1B',
        '2B',
        'SS',
        '3B',
        'LF',
        'CF',
        'RF'
      ])
        expect(await fielder(page, position), position).equals(null)
      await click(page, 'Save Rosters')
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save Rosters"]') == null,
        { timeout: 30000 }
      )
      // Scoring waits for a pitcher.
      await page.waitForFunction(
        () => document.body.innerText.includes('Assign a pitcher'),
        { timeout: 30000 }
      )
      expect(
        await page.$eval(
          '[aria-label="Ball"]',
          node => node.getAttribute('aria-disabled') === 'true'
        )
      ).equals(true)
    } finally {
      await page.close()
    }
  })
})

/**
 * E9: a pitch has no windup and its controls are back within 400 ms, and the
 * other scoring pictures play in half their old time. Each test prints the
 * in-page `performance.now()` times it measured as `pitch-timing:` lines. With
 * TS_CAPTURE_ONLY=1 (the before run, on the base revision) the same times are
 * printed and nothing is asserted.
 */
describe('pitch animation, hit flight and celebration timing (E9)', function () {
  this.timeout(180000)
  const capturing = process.env.TS_CAPTURE_ONLY === '1'
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader'
      ]
    })
  })
  after(async function () {
    await browser?.close()
  })

  interface Frame {
    t: number
    presentation: string
    ballVisible: boolean
    ballZ: number
    windup: boolean
    ready: boolean
    celebration: boolean
  }
  interface TimelineWindow {
    qaTimeline: Frame[]
    qaStop: boolean
  }
  async function openField(): Promise<Page> {
    const { page } = await open(
      '/games/g1/score',
      false,
      false,
      false,
      'right',
      true
    )
    // A phone's field: software WebGL draws it fast enough to time.
    await page.setViewport({ width: 390, height: 844 })
    // The field's opening frames finished on the GPU: software WebGL takes
    // a second over them after the page shows the field, and a tap meanwhile
    // waits. A revision before `data-field-drawn` (the before run) is timed
    // from the field's first frame, as it was.
    await page.waitForSelector(
      capturing
        ? 'canvas[data-field-ready="true"]'
        : 'canvas[data-field-drawn="true"]',
      { timeout: 30000 }
    )
    await captureScene(page)
    return page
  }
  /* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser evaluation cannot reference generated Sucrase helpers. */
  /** Records, every 10 ms, what the field and the controls show. */
  async function record(page: Page): Promise<void> {
    await page.evaluate(() => {
      const host = window as unknown as SceneProbeWindow & TimelineWindow
      host.qaTimeline = []
      host.qaStop = false
      // The pitcher is the fielder on the mound.
      let pitcher: { getObjectByName: (name: string) => unknown } | undefined
      host.qaScene!.traverse(object => {
        if (
          object.name.startsWith('player-defense-') &&
          Math.abs(object.position.x) < 1 &&
          Math.abs(object.position.z + 18.44) < 1
        )
          pitcher = object
      })
      const step = (): void => {
        if (host.qaStop) {
          clearInterval(timer)
          return
        }
        const scene = host.qaScene!
        const ball = scene.getObjectByName('animated-baseball')
        const rig =
          pitcher == null ? undefined : pitcher.getObjectByName('athlete-rig')
        const field = document.querySelector('[data-presentation]')
        const control = document.querySelector('[aria-label="Ball"]')
        host.qaTimeline.push({
          t: performance.now(),
          presentation:
            field == null
              ? 'none'
              : String(field.getAttribute('data-presentation')),
          ballVisible: ball != null && ball.visible,
          ballZ: ball == null ? 0 : ball.position.z,
          // The articulated rig is drawn only while the pitcher is posed in
          // a delivery.
          windup: rig != null && (rig as { visible: boolean }).visible,
          ready:
            control != null && control.getAttribute('aria-disabled') !== 'true',
          // The scoreboard's summary names the home run while it is
          // celebrated.
          celebration:
            document.querySelector('[aria-label*="HOME RUN · "]') != null
        })
      }
      // Sampled on a timer as well as drawn frames: a slow frame must not
      // hide when the page changed.
      const timer = setInterval(step, 10)
      step()
    })
  }
  /** Taps a control in the page and returns when, by the page's clock. */
  async function tap(page: Page, label: string): Promise<number> {
    return await page.evaluate(label => {
      const t = performance.now()
      document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click()
      return t
    }, label)
  }
  async function timeline(page: Page): Promise<Frame[]> {
    return await page.evaluate(() => {
      const host = window as unknown as TimelineWindow
      host.qaStop = true
      return host.qaTimeline
    })
  }
  /* eslint-enable @typescript-eslint/prefer-optional-chain */
  /** The first frame at or after `from` that `test` holds for. */
  function first(
    frames: Frame[],
    from: number,
    test: (frame: Frame) => boolean
  ): Frame | undefined {
    return frames.find(frame => frame.t >= from && test(frame))
  }
  const since = (frame: Frame | undefined, from: number): number | undefined =>
    frame == null ? undefined : frame.t - from
  const ms = (n: number | undefined): string =>
    n == null ? 'never' : `${Math.round(n)} ms`

  it('pitch animation: takes the next tap within 400 ms, and the pitcher never winds up', async function () {
    const page = await openField()
    try {
      await waitReady(page)
      await record(page)
      // Three pitches, each tapped as soon as the last one's controls are
      // back. The first is the screen's first: the field warmed the ball's
      // shader and the cues when it opened, so it is as fast as the others.
      const taps: number[] = []
      for (const count of [1, 2, 3]) {
        taps.push(await tap(page, 'Ball'))
        await page.waitForSelector(`[aria-label*="Pitches ${count}"]`, {
          timeout: 5000
        })
        await waitReady(page)
      }
      const frames = await timeline(page)
      const pitches = taps.map((tapped, index) => {
        const until = taps[index + 1] ?? Infinity
        const own = frames.filter(f => f.t >= tapped && f.t < until)
        const shown = first(own, tapped, f => f.presentation !== 'none')
        return {
          tapped,
          shown,
          // Two feet off the mound, on its way to the plate.
          ballOut: first(own, tapped, f => f.ballVisible && f.ballZ > -16.44),
          done: first(own, shown?.t ?? tapped, f => f.presentation === 'none'),
          ready: first(
            own,
            shown?.t ?? tapped,
            f => f.ready && f.presentation === 'none'
          ),
          windup: own.filter(f => f.windup).length,
          samples: own.length
        }
      })
      pitches.forEach((pitch, index) => {
        console.log(
          `pitch-timing: pitch ${index + 1} tap=0 ms; picture shown ${ms(since(pitch.shown, pitch.tapped))}; ` +
            `ball out of the hand toward the plate ${ms(since(pitch.ballOut, pitch.tapped))}; ` +
            `PRESENTATION_DONE (picture none) ${ms(since(pitch.done, pitch.tapped))}; ` +
            `picture lasted ${ms(pitch.done == null || pitch.shown == null ? undefined : pitch.done.t - pitch.shown.t)}; ` +
            `controls ready ${ms(since(pitch.ready, pitch.tapped))}; ` +
            (index + 1 < taps.length
              ? `next tap taken ${ms(taps[index + 1] - pitch.tapped)}; `
              : '') +
            `windup samples ${pitch.windup} of ${pitch.samples}`
        )
      })
      if (capturing) return
      for (const pitch of pitches) {
        expect(pitch.windup).equals(0)
        expect(pitch.done).not.equals(undefined)
        expect(pitch.ready).not.equals(undefined)
      }
      for (const pitch of pitches) {
        // The ball is on its way on the picture's first drawn frames.
        expect(pitch.ballOut!.t - pitch.tapped).lessThan(150)
        // The picture lasts 280 ms of its own clock; software WebGL's frames
        // and React's commit add a frame or two, and the controls take the
        // next tap within 400 ms of this one.
        expect(pitch.done!.t - pitch.shown!.t).within(260, 400)
        expect(pitch.ready!.t - pitch.tapped).at.most(400)
      }
    } finally {
      await page.close()
    }
  })

  it('hit flight: plays a single in half its old time', async function () {
    const page = await openField()
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Single')
      await page.waitForSelector(
        '[aria-label^="Tap or drag a player to where the ball was fielded"]'
      )
      await placeOffered(puppeteerDriver(page))
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      await record(page)
      const pressed = await page.evaluate(() => performance.now())
      await setTrajectory(puppeteerDriver(page))
      await page.waitForSelector('[aria-label="Time to edit play"]', {
        timeout: 30000
      })
      await page.waitForSelector('[data-presentation="none"]', {
        timeout: 30000
      })
      const frames = await timeline(page)
      const swing = first(frames, pressed, f => f.presentation === 'hit:swing')
      const flight = first(
        frames,
        pressed,
        f => f.presentation === 'hit:flight'
      )
      const done = first(
        frames,
        flight?.t ?? pressed,
        f => f.presentation === 'none'
      )
      const flightMs = flight != null && done != null ? done.t - flight.t : NaN
      console.log(
        `pitch-timing: hit flight (Single) trajectory set=0 ms; swing ${ms(since(swing, pressed))}; ` +
          `contact (flight) ${ms(since(flight, pressed))}; ` +
          `motion end (picture none) ${ms(since(done, pressed))}; ` +
          `contact to end ${ms(flightMs)}`
      )
      await click(page, 'Finish at-bat')
      if (capturing) return
      // On the base revision this single's contact to end measured 1245 to
      // 1340 ms (pitch-timing.log): half of it, within a few frames.
      expect(flightMs).within(1290 / 2 - 150, 1290 / 2 + 150)
    } finally {
      await page.close()
    }
  })

  it('celebration: shows the home run for at most three seconds, half its old time', async function () {
    this.timeout(90000)
    const page = await openField()
    try {
      await click(page, 'Swing in Play')
      await click(page, 'Home Run')
      await page.waitForSelector('canvas[data-field-ready="true"]')
      await page.waitForSelector('[aria-label^="Drag where the ball was hit"]')
      await captureScene(page)
      const guide = await readGuide(page)
      await aimLandingAt(page, guide.x, guide.z)
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      await record(page)
      const pressed = await page.evaluate(() => performance.now())
      await setTrajectory(puppeteerDriver(page))
      await page.waitForSelector('[aria-label*="Batter Player 2"]', {
        timeout: 45000
      })
      await page.waitForFunction(
        () => document.querySelector('[aria-label*="HOME RUN · "]') == null,
        { timeout: 20000 }
      )
      await waitReady(page)
      const frames = await timeline(page)
      const shown = first(frames, pressed, f => f.celebration)
      const gone = first(frames, shown?.t ?? pressed, f => !f.celebration)
      const flight = first(
        frames,
        pressed,
        f => f.presentation === 'hit:flight'
      )
      const landed = first(
        frames,
        flight?.t ?? pressed,
        f => f.presentation === 'none'
      )
      const ready = first(frames, gone?.t ?? pressed, f => f.ready)
      const celebrationMs =
        shown != null && gone != null ? gone.t - shown.t : NaN
      console.log(
        `pitch-timing: home run trajectory set=0 ms; contact ${ms(since(flight, pressed))}; ` +
          `ball picture end ${ms(since(landed, pressed))}; ` +
          `celebration shown ${ms(since(shown, pressed))}; ` +
          `celebration end ${ms(since(gone, pressed))}; ` +
          `celebration lasted ${ms(celebrationMs)}; ` +
          `controls ready ${ms(since(ready, pressed))}; ` +
          `frames ${frames.length}, last ${ms(since(frames.at(-1), pressed))}`
      )
      if (capturing) return
      // At most its three seconds; the home run's play closes sooner, and
      // with it the celebration: on the base revision it ended 5194 to 5227
      // ms after the trajectory was set, and now in half that, as its
      // runners run twice as fast.
      expect(since(gone, pressed)).within(5200 / 2 - 400, 3000 + 300)
      expect(celebrationMs).at.most(3000 + 150)
    } finally {
      await page.close()
    }
  })
})
