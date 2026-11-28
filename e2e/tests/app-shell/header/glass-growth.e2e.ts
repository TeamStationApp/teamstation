import { expect } from 'chai'

import {
  PLAYER_ID,
  PLAYER_NAME,
  SEASON_ID,
  TEAM_ID,
  TEAM_NAME,
  teamScheduleAnswer
} from '../../../../src/test/teamScheduleFixture'
import { BlockedError } from '../../../core/result'
import {
  defineE2e,
  type E2eContext,
  type Scenario,
  type WebSession
} from '../../../core/spec'
import {
  expectFrame,
  type GlassFrame,
  glassFrameOf,
  grownOf,
  pinAtOf,
  pinned,
  recordPhone,
  stepOnPhone,
  tabPoint
} from '../../../rigs/app/glassGrowth'
import { prove } from '../../../rigs/app/keyboardDock'
import { openCoachApp } from '../../../rigs/coach/coachApp'

/**
 * The header's glass grows down over a pinned pill band with the scroll: on
 * the team page, the pane from the top of the screen keeps its lower edge at
 * the header's until the band is a band-height from it, then follows the
 * scroll 1:1 to the band's lower edge at the pin, and back. While it has
 * grown the shell's header draws no material and no lower line of its own;
 * a screen pushed over the pinned band has the normal header, and Back gives
 * the glass to the band again. On a wide window the header keeps its glass
 * and line over the sidebar, beside the scene's pane.
 *
 * In a browser the API is answered by maestro-d's network mocks from the
 * team-schedule fixture (`src/test/teamScheduleFixture.ts`); maestro-d sets
 * the page's scroll, and `page` only reads where things are. On the iPhone
 * the `coach-game` world is seeded on the stack.
 */

type Page = WebSession['page']

/** The clock the browser scenarios pin, which the fixture's dates follow. */
const PINNED_NOW = Date.parse('2026-10-04T12:00:00.000Z')
const PHONE = { width: 393, height: 852 }
const DESKTOP = { width: 1440, height: 900 }
/** The browser's scroll step, in CSS pixels. */
const STEP = 4

/** The fixture's answers, as maestro-d mocks: longer paths first. */
const ROUTES: Array<[string, string]> = [
  ['*/api/v1/auth/me*', '/auth/me'],
  ['*/api/v1/me/roles*', '/me/roles'],
  ['*/api/v1/me/notifications/summary*', '/me/notifications/summary'],
  ['*/api/v1/invites*', '/invites'],
  [
    `*/api/v1/players/${PLAYER_ID}/highlights*`,
    `/players/${PLAYER_ID}/highlights`
  ],
  [`*/api/v1/players/${PLAYER_ID}/stats*`, `/players/${PLAYER_ID}/stats`],
  [`*/api/v1/players/${PLAYER_ID}`, `/players/${PLAYER_ID}`],
  [`*/api/v1/players/${PLAYER_ID}?*`, `/players/${PLAYER_ID}`],
  [
    `*/api/v1/teams/${TEAM_ID}/games*hasVideo=1*`,
    `/teams/${TEAM_ID}/games?paged=1&hasVideo=1`
  ],
  [
    `*/api/v1/teams/${TEAM_ID}/games*`,
    `/teams/${TEAM_ID}/games?paged=1&order=asc&around=next`
  ],
  [`*/api/v1/teams/${TEAM_ID}/roster*`, `/teams/${TEAM_ID}/roster`],
  [
    `*/api/v1/teams/${TEAM_ID}/stats*kind=pitching*`,
    `/teams/${TEAM_ID}/stats?kind=pitching`
  ],
  [`*/api/v1/teams/${TEAM_ID}/stats*`, `/teams/${TEAM_ID}/stats`],
  [`*/api/v1/teams/${TEAM_ID}`, `/teams/${TEAM_ID}`],
  [`*/api/v1/teams/${TEAM_ID}?*`, `/teams/${TEAM_ID}`],
  ['*/api/v1/teams', '/teams'],
  ['*/api/v1/teams?*', '/teams'],
  [
    `*/api/v1/seasons/${SEASON_ID}/standings*`,
    `/seasons/${SEASON_ID}/standings`
  ],
  ['*/api/v1/events*', '/events?paged=1']
]

async function openWeb(
  ctx: E2eContext,
  size: { width: number; height: number },
  path: string
): Promise<WebSession> {
  const session = await ctx.browser(size, {
    clock: new Date(PINNED_NOW).toISOString(),
    timeZone: 'America/Los_Angeles'
  })
  const { m } = session
  const json = (status: number, body: unknown): Record<string, unknown> => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  for (const [url, path_] of ROUTES) {
    const answer = teamScheduleAnswer('GET', `/api/v1${path_}`, PINNED_NOW)
    await m.mockNetwork({
      url,
      method: 'GET',
      response: json(answer.status, answer.body)
    })
  }
  await m.mockNetwork({
    url: '*/api/*',
    method: 'GET',
    response: json(200, [])
  })
  await m.mockNetwork({
    url: '*/api/*',
    response: json(404, { error: 'not found' })
  })
  await m.openLink({ link: `${ctx.stack.origin}${path}` })
  await until('the team’s pills', async () =>
    (await webFrame(session.page)) == null ? undefined : true
  )
  return session
}

async function until<T>(
  what: string,
  read: () => Promise<T | undefined>
): Promise<T> {
  const end = Date.now() + 20000
  for (;;) {
    const value = await read()
    if (value != null) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** A web frame, and what the header draws in it. */
interface WebFrame extends GlassFrame {
  /** The header's backdrop filter, `none` while it is bare. */
  headerFilter: string
  /** The header's lower border, in pixels. */
  headerLine: number
  /** Whether the pane holds the glass and its line. */
  paneGlass: boolean
  /** The pane's line: its lower edge. */
  lineBottom: number | null
  /** The pane's left and right as the scene clips it, and the header's. */
  paneLeft: number
  paneRight: number
  headerRight: number
  /** The header's glass over the sidebar, while it is bare: its box and line. */
  sidebar: {
    left: number
    right: number
    bottom: number
    lineBottom: number
    filter: string
  } | null
}

/**
 * Plain JavaScript inside the page: the spec is compiled by sucrase, which
 * would turn `??` and `?.` into helpers the page does not have.
 */
async function webFrame(page: Page): Promise<WebFrame | undefined> {
  const read = await page.evaluate(() => {
    const header = document.querySelector('[data-testid="app-header"]')
    if (header === null) return null
    // The band on show: a covered scene's is hidden.
    const bands = Array.from(
      document.querySelectorAll(
        '[data-testid="pill-band"], [data-testid="event-pill-band"]'
      )
    ).filter(function (band) {
      const rect = band.getBoundingClientRect()
      let node: Element | null = band
      while (node !== null) {
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none')
          return false
        node = node.parentElement
      }
      return rect.height > 0 && rect.bottom > 0
    })
    if (bands.length === 0) return null
    const band = bands[0]
    const pane = band.querySelector('[data-testid="pill-band-glass"]')
    if (pane === null) return null
    const h = header.getBoundingClientRect()
    const b = band.getBoundingClientRect()
    const p = pane.getBoundingClientRect()
    // The pane reaches past the band, and the scene's scroller clips it:
    // what shows is the two's overlap.
    let scroller: Element | null = band
    while (
      scroller !== null &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement
    const clip =
      scroller === null
        ? { left: -Infinity, right: Infinity }
        : scroller.getBoundingClientRect()
    const hs = getComputedStyle(header)
    const line =
      pane.children.length > 1 ? pane.children[1].getBoundingClientRect() : null
    const strip = header.querySelector(
      '[data-testid="app-header-sidebar-glass"]'
    )
    let sidebar = null
    if (strip !== null) {
      const s = strip.getBoundingClientRect()
      const stripLine = strip.firstElementChild
      sidebar = {
        left: s.left,
        right: s.right,
        bottom: s.bottom,
        lineBottom:
          stripLine === null ? -1 : stripLine.getBoundingClientRect().bottom,
        filter: getComputedStyle(strip).backdropFilter
      }
    }
    return {
      headerBottom: h.bottom,
      headerRight: h.right,
      paneTop: p.top,
      paneBottom: p.bottom,
      paneLeft: Math.max(p.left, clip.left),
      paneRight: Math.min(p.right, clip.right),
      bandTop: b.top,
      bandBottom: b.bottom,
      headerFilter: hs.backdropFilter,
      headerLine: parseFloat(hs.borderBottomWidth),
      paneGlass: pane.children.length > 1,
      lineBottom: line === null ? null : line.bottom,
      sidebar
    }
  })
  return read ?? undefined
}

/**
 * Scrolls the page that holds the band to `y`, then waits out its last
 * scroll event: react-native-web passes on at most one every 16ms, and the
 * last of a run 100ms after it.
 */
async function scrollTo(session: WebSession, y: number): Promise<void> {
  await session.m.evalBrowserScript({
    script: `(function () {
      var band = document.querySelector('[data-testid="pill-band"]')
      var node = band
      while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY))
        node = node.parentElement
      if (node) node.scrollTop = ${y}
    })()`
  })
  await session.page.evaluate(async () => {
    await new Promise<void>(resolve => {
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve()
          })
        })
      }, 150)
    })
  })
}

/**
 * One web frame's header: bare with no line while the pane has grown, its
 * own glass and line otherwise, and exactly one line either way.
 */
function expectHandover(frame: WebFrame, what: string): void {
  const grown = frame.paneBottom > frame.headerBottom + 0.5
  if (grown) {
    expect(frame.paneGlass, `${what}: the pane holds the glass`).equals(true)
    expect(frame.headerFilter, `${what}: the header draws no glass`).equals(
      'none'
    )
    expect(frame.headerLine, `${what}: the header draws no line`).equals(0)
    expect(
      Math.abs((frame.lineBottom ?? -1) - frame.paneBottom),
      `${what}: the pane’s line is at its lower edge`
    ).lte(0.5)
  } else {
    expect(frame.paneGlass, `${what}: the pane is empty`).equals(false)
    expect(frame.headerFilter, `${what}: the header’s own glass`).not.equals(
      'none'
    )
    expect(frame.headerLine, `${what}: the header’s own line`).equals(1)
  }
}

/** Steps from the top to past the pin and back, checking every frame. */
async function stepThrough(
  ctx: E2eContext,
  session: WebSession,
  shots: boolean
): Promise<{ pinAt: number; frames: number }> {
  await scrollTo(session, 0)
  const rest = (await webFrame(session.page))!
  const pinAt = pinAtOf(rest)
  expect(pinAt, 'the band starts below the header').greaterThan(0)
  const band = rest.bandBottom - rest.bandTop
  let frames = 0
  let half = false
  const check = async (y: number): Promise<WebFrame> => {
    await scrollTo(session, y)
    const frame = (await webFrame(session.page))!
    expectFrame(frame, pinAt, `scroll ${y}`)
    expectHandover(frame, `scroll ${y}`)
    frames++
    return frame
  }
  if (shots) await prove(ctx, session.m, 'web-team-glass-grow-0.png')
  const end = pinAt + 3 * STEP
  for (let y = 0; y <= end; y += STEP) {
    const frame = await check(y)
    if (shots && !half && grownOf(frame) >= 0.5) {
      // Halfway: the step that first reaches it, to the step's accuracy.
      expect(grownOf(frame)).lte(0.5 + STEP / band + 0.01)
      await prove(ctx, session.m, 'web-team-glass-grow-50.png')
      half = true
    }
  }
  const top = (await webFrame(session.page))!
  expect(pinned(top), 'pinned at the end of the steps').equals(true)
  expect(grownOf(top), 'grown to the band’s lower edge').closeTo(1, 0.02)
  if (shots) await prove(ctx, session.m, 'web-team-glass-grow-100.png')
  for (let y = end; y >= 0; y -= STEP) await check(y)
  return { pinAt, frames }
}

/** A scenario for one kind of surface: the others report it blocked. */
function on(kind: 'web' | 'ios', run: Scenario): Scenario {
  return async ctx => {
    const web = ctx.surface === 'web-chromium'
    if (web !== (kind === 'web') || (!web && ctx.surface !== 'ios-app'))
      throw new BlockedError(`${ctx.scenarioId} runs on ${kind} only`)
    await run(ctx)
  }
}

const scenarios: Record<string, Scenario> = {
  'pinned-band-phone': on('web', async ctx => {
    const session = await openWeb(ctx, PHONE, `/teams/${TEAM_ID}`)
    const { frames } = await stepThrough(ctx, session, true)
    await scrollTo(session, 400)
    await ctx.checkpoint('pinned', {
      expect: [{ text: TEAM_NAME }, { id: 'pill-band-glass' }]
    })
    expect(frames).greaterThan(20)
  }),

  'push-while-pinned-phone': on('web', async ctx => {
    const session = await openWeb(ctx, PHONE, `/teams/${TEAM_ID}?tab=team`)
    const { m, page } = session
    await scrollTo(session, 0)
    const pinAt = pinAtOf((await webFrame(page))!)
    await scrollTo(session, pinAt + 40)
    const pinnedFrame = (await webFrame(page))!
    expect(pinned(pinnedFrame), 'the team’s pills pinned').equals(true)
    expectHandover(pinnedFrame, 'pinned on the team')
    expect(pinnedFrame.paneGlass).equals(true)
    // A player pushed over the pinned band: the header is the normal one.
    await m.tapOn({ text: PLAYER_NAME })
    await until('the player’s page', async () =>
      new URL(page.url()).pathname === `/players/${PLAYER_ID}`
        ? true
        : undefined
    )
    const player = await until('the player’s band', async () => {
      const frame = await webFrame(page)
      return frame != null && frame.bandTop > frame.headerBottom + 8
        ? frame
        : undefined
    })
    expect(
      player.headerFilter,
      'over the player: the header’s glass'
    ).not.equals('none')
    expect(player.headerLine, 'over the player: the header’s line').equals(1)
    expect(player.paneGlass, 'the player’s band at rest').equals(false)
    await prove(ctx, m, 'web-push-while-pinned-player.png')
    await ctx.checkpoint('player-header', { expect: [{ text: 'Back' }] })
    // Back to the team, still pinned: the band carries the glass again.
    await m.tapOn({ text: 'Back' })
    const back = await until('the team again, pinned', async () => {
      const frame = await webFrame(page)
      return new URL(page.url()).pathname === `/teams/${TEAM_ID}` &&
        frame != null &&
        pinned(frame) &&
        frame.paneGlass
        ? frame
        : undefined
    })
    expectHandover(back, 'back on the pinned team')
    expect(back.headerFilter).equals('none')
    await prove(ctx, m, 'web-push-while-pinned-back.png')
  }),

  'pinned-band-desktop': on('web', async ctx => {
    const session = await openWeb(ctx, DESKTOP, `/teams/${TEAM_ID}`)
    const { page } = session
    await scrollTo(session, 0)
    const rest = (await webFrame(page))!
    const pinAt = pinAtOf(rest)
    expect(rest.sidebar, 'the header’s own glass at rest').equals(null)
    // The scene starts right of the sidebar: so does the pane.
    expect(rest.paneLeft, 'the sidebar beside the scene').greaterThan(100)
    expect(Math.abs(rest.paneRight - rest.headerRight)).lte(0.5)
    let handover: WebFrame | undefined
    for (let y = 0; y <= pinAt + 3 * STEP; y += STEP) {
      await scrollTo(session, y)
      const frame = (await webFrame(page))!
      expectFrame(frame, pinAt, `desktop scroll ${y}`)
      const grown = frame.paneBottom > frame.headerBottom + 0.5
      if (!grown) {
        expect(frame.sidebar, `desktop ${y}: no strip yet`).equals(null)
        continue
      }
      handover ??= frame
      const strip = frame.sidebar
      expect(strip, `desktop ${y}: the sidebar keeps its glass`).not.equals(
        null
      )
      expect(strip!.left).lte(0.5)
      expect(
        Math.abs(strip!.right - frame.paneLeft),
        'the strip meets the pane'
      ).lte(0.5)
      expect(Math.abs(strip!.bottom - frame.headerBottom)).lte(0.5)
      expect(
        Math.abs(strip!.lineBottom - frame.headerBottom),
        'the line over the sidebar at the header’s lower edge'
      ).lte(0.5)
      expect(strip!.filter, 'the strip is glass').not.equals('none')
      expect(frame.headerFilter, 'bare right of it').equals('none')
      expect(frame.headerLine).equals(0)
    }
    expect(handover, 'the glass was handed over').not.equals(undefined)
    // At the handover the two lines are one: the pane's is where the
    // header's was, beside the strip's.
    expect(
      Math.abs((handover!.lineBottom ?? -1) - handover!.sidebar!.lineBottom),
      'one line across the window as the pane takes it'
    ).lte(STEP + 0.5)
    const top = (await webFrame(page))!
    expect(pinned(top)).equals(true)
    await prove(ctx, session.m, 'web-team-pinned-desktop.png')
    await ctx.checkpoint('desktop-pinned', {
      expect: [{ id: 'app-header-sidebar-glass' }]
    })
  }),

  'pinned-band-ios': on('ios', async ctx => {
    const world = await ctx.fixture('coach-game')
    const app = await openCoachApp(ctx, 'coach')
    const { m } = app
    const screen = await app.window()
    const shot = async (name: string): Promise<void> => {
      await prove(ctx, m, `${name}.png`)
    }
    const recording = ctx.artifact('ios-event-glass-pill.mp4')
    await recordPhone(ctx.device('device'), m, recording, async () => {
      // The pill's travel and its lift, on the event's sections.
      await app.openGame(world.ids.game)
      await m.assertVisible({ text: 'Game sections', timeout: 30000 })
      // The game's sections, as the lineup game has them: over each, then
      // a finger held on one, so the recording has the pill's lift.
      for (const tab of ['Box score', 'Videos', 'Info'])
        await m.tapOnPoint({ point: await tabPoint(m, screen, tab) })
      await m.holdOn({ text: 'Info', duration: 1500 })
      await stepOnPhone(m, screen, 'ios-event', shot)
      // The team page: pinned, then a push with no band and Back.
      await app.openTeam(world.ids.homeTeam)
      await m.assertVisible({ text: 'Team sections', timeout: 30000 })
      await stepOnPhone(m, screen, 'ios-team', shot, true)
      // The roster, under the pinned pills, and its first player's page.
      await m.tapOn({ text: 'Team' })
      const { LINEUP_NAMES } =
        await import('../../../../src/server/dev/lineupFixture')
      await m.tapOn({ text: `.*${LINEUP_NAMES.home[0]}.*` })
      await prove(ctx, m, 'ios-push-while-pinned-player.png')
      const over = glassFrameOf(await m.hierarchy(), screen.height)
      expect(
        over == null || !pinned(over) || grownOf(over) === 0,
        'over the player, no band carries the glass'
      ).equals(true)
      await m.tapOn({ text: 'Back' })
      const back = glassFrameOf(await m.hierarchy(), screen.height)
      await prove(ctx, m, 'ios-push-while-pinned-back.png')
      expect(back, 'the team’s band after Back').not.equals(undefined)
      expect(pinned(back!), 'still pinned after Back').equals(true)
      expect(grownOf(back!), 'the glass grown again').closeTo(1, 0.1)
    })
  })
}

export default defineE2e({
  id: 'app-shell/header/glass-growth',
  title:
    'The header’s glass grows down over a pinned pill band with the scroll, and hands its line over',
  kind: 'e2e',
  covers: [
    'src/app/components/AppHeader.tsx',
    'src/app/components/GlassView.tsx',
    'src/app/components/GlassView.native.tsx',
    'src/app/components/PinnedBands.tsx',
    'src/app/components/pinnedGlass.ts',
    'src/app/components/pinnedHead.ts',
    'src/app/components/sceneTop.ts',
    'src/app/components/usePinnedHead.ts',
    'src/app/components/usePinnedHead.native.ts',
    'src/app/navigation/sceneSlot.tsx'
  ],
  stack: 'isolated',
  fixtures: ['coach-game'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'device', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['api', 'web'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: ['layout-shift', 'hidden-element', 'blank-screen'],
  manual: false,
  sendsNoMail: true,
  scenarios
})
