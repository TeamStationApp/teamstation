import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  PLAYER_ID,
  PLAYER_NAME,
  SEASON_ID,
  TEAM_ID,
  TEAM_NAME,
  teamScheduleAnswer
} from '../../../../src/test/teamScheduleFixture'
import { signInWithPassword } from '../../../core/fixtures'
import { iosIsSimulator } from '../../../core/prepare'
import { BlockedError } from '../../../core/result'
import {
  defineE2e,
  type E2eContext,
  type Scenario,
  type WebSession
} from '../../../core/spec'
import {
  bandFrameOf,
  boundsOf,
  expectedPaneBottom,
  expectFrame,
  GLASS_IDS,
  type GlassFrame,
  glassFrameOf,
  type GlassKind,
  grownOf,
  linesInColumn,
  phoneToTop,
  pinAtOf,
  pinned,
  recordPhone,
  stepOnPhone,
  tabPoint
} from '../../../rigs/app/glassGrowth'
import { prove } from '../../../rigs/app/keyboardDock'
import { setServer } from '../../../rigs/app/setServer'
import {
  clearSignInLimits,
  DEVELOP_APP,
  openCoachApp
} from '../../../rigs/coach/coachApp'

/**
 * The header's glass grows down over a pinned pill band with the scroll: on
 * the team page, the pane from the top of the screen keeps its lower edge at
 * the header's until the band is a band-height from it, then follows the
 * scroll 1:1 to the band's lower edge at the pin, and back. While it has
 * grown the shell's header draws no material and no lower line of its own;
 * a screen pushed over the pinned band has the normal header, and Back gives
 * the glass to the band again. On a wide window the header keeps its glass
 * and line over the sidebar, beside the scene's pane. A sticky section
 * (`StickySectionLayout`: the season page, the umpire schedule) grows the
 * same glass over its whole sticky stack.
 *
 * In a browser the API is answered by maestro-d's network mocks from the
 * team-schedule fixture (`src/test/teamScheduleFixture.ts`), or for the
 * sticky sections from a league's recorded answers
 * (`e2e/fixtures/glassStickyAnswers.json`); maestro-d sets the page's
 * scroll, and `page` only reads where things are. On the phones the
 * `coach-game` and `tess` worlds are seeded on the stack.
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

/** The recorded league: a season of games, and its umpire schedule. */
const STICKY_SEASON = 'sea_rt_zGYyzvtqY38fF'
const STICKY_LEAGUE = 'lea_JlnGnAsS__HHKzr6'
/** Before every recorded game, so the season's default list holds them all. */
const STICKY_NOW = Date.parse('2027-02-01T20:00:00.000Z')

/** The recorded answers, by path: longer paths are mocked first. */
function stickyAnswers(): Array<[string, unknown]> {
  const answers = JSON.parse(
    readFileSync(
      join(__dirname, '../../../fixtures/glassStickyAnswers.json'),
      'utf8'
    )
  ) as Record<string, unknown>
  return Object.entries(answers)
    .sort(([a], [b]) => b.length - a.length)
    .map(([path, body]) => [`*/api/v1${path}*`, body])
}

const json = (status: number, body: unknown): Record<string, unknown> => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

async function openWeb(
  ctx: E2eContext,
  size: { width: number; height: number },
  path: string,
  kind: GlassKind = 'band'
): Promise<WebSession> {
  const sticky = kind === 'sticky'
  const session = await ctx.browser(size, {
    clock: new Date(sticky ? STICKY_NOW : PINNED_NOW).toISOString(),
    timeZone: 'America/Los_Angeles'
  })
  const { m } = session
  if (sticky) {
    for (const [url, body] of stickyAnswers())
      await m.mockNetwork({ url, method: 'GET', response: json(200, body) })
  } else
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
  await until(sticky ? 'the sticky section' : 'the team’s pills', async () =>
    (await webFrame(session.page, kind)) == null ? undefined : true
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
  /** The umpire schedule's stack: tabs, Chat and the column headers. */
  umpire: {
    tabsTop: number
    chatTop: number
    columnsBottom: number
  } | null
}

/**
 * Plain JavaScript inside the page: the spec is compiled by sucrase, which
 * would turn `??` and `?.` into helpers the page does not have.
 */
async function webFrame(
  page: Page,
  kind: GlassKind = 'band'
): Promise<WebFrame | undefined> {
  const ids = GLASS_IDS[kind]
  const read = await page.evaluate(function (ids: {
    bands: string[]
    pane: string
  }) {
    const header = document.querySelector('[data-testid="app-header"]')
    if (header === null) return null
    // The band on show: a covered scene's is hidden.
    const bands = Array.from(
      document.querySelectorAll(
        ids.bands
          .map(function (id) {
            return '[data-testid="' + id + '"]'
          })
          .join(', ')
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
    const pane = band.querySelector('[data-testid="' + ids.pane + '"]')
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
    const stack = band.querySelector('[data-testid="umpire-sticky-stack"]')
    let umpire = null
    if (stack !== null) {
      const tabs = stack.querySelector('[aria-label="Umpire pages"]')
      const chat = stack.querySelector('[data-testid="umpire-chat"]')
      const columns = stack.querySelector('[data-testid="umpire-table-header"]')
      umpire = {
        tabsTop: tabs === null ? -1 : tabs.getBoundingClientRect().top,
        chatTop: chat === null ? -1 : chat.getBoundingClientRect().top,
        columnsBottom:
          columns === null ? -1 : columns.getBoundingClientRect().bottom
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
      sidebar,
      umpire
    }
  }, ids)
  return read ?? undefined
}

/**
 * Scrolls the page that holds the band to `y`, then waits out its last
 * scroll event: react-native-web passes on at most one every 16ms, and the
 * last of a run 100ms after it.
 */
async function scrollTo(
  session: WebSession,
  y: number,
  kind: GlassKind = 'band'
): Promise<void> {
  await session.m.evalBrowserScript({
    script: `(function () {
      var band = document.querySelector('[data-testid="${GLASS_IDS[kind].bands[0]}"]')
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
  shots: boolean,
  kind: GlassKind = 'band'
): Promise<{ pinAt: number; frames: number; top: WebFrame }> {
  await scrollTo(session, 0, kind)
  const rest = (await webFrame(session.page, kind))!
  const pinAt = pinAtOf(rest)
  expect(pinAt, 'the band starts below the header').greaterThan(0)
  const band = rest.bandBottom - rest.bandTop
  let frames = 0
  let half = false
  const check = async (y: number): Promise<WebFrame> => {
    await scrollTo(session, y, kind)
    const frame = (await webFrame(session.page, kind))!
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
  const top = (await webFrame(session.page, kind))!
  expect(pinned(top), 'pinned at the end of the steps').equals(true)
  expect(grownOf(top), 'grown to the band’s lower edge').closeTo(1, 0.02)
  if (shots) await prove(ctx, session.m, 'web-team-glass-grow-100.png')
  for (let y = end; y >= 0; y -= STEP) await check(y)
  return { pinAt, frames, top }
}

/** A scenario for one kind of surface: the others report it blocked. */
function on(kind: 'web' | 'ios' | 'android', run: Scenario): Scenario {
  const surface = {
    web: 'web-chromium',
    ios: 'ios-app',
    android: 'android-app'
  }[kind]
  return async ctx => {
    if (ctx.surface !== surface)
      throw new BlockedError(`${ctx.scenarioId} runs on ${kind} only`)
    await run(ctx)
  }
}

/**
 * The `tess` world's admin signed in on the phone: Demo League A's Demo
 * Regular season, with its games, and the league's umpire schedule, which
 * the admin umpires in.
 */
async function openTessPhone(ctx: E2eContext): Promise<{
  m: any
  screen: { width: number; height: number }
  ids: Record<string, string>
  open: (path: string) => Promise<void>
}> {
  const world = await ctx.fixture('tess')
  const platform = ctx.surface === 'ios-app' ? 'ios' : 'android'
  const udid = ctx.device('device')
  const m = await ctx.attach('device', { platform, appId: DEVELOP_APP })
  await clearSignInLimits(ctx)
  await m.launchApp({ appId: DEVELOP_APP, clearState: true })
  await setServer({
    platform,
    udid,
    appId: DEVELOP_APP,
    origin: ctx.stack.origin,
    device: m,
    simulator: platform === 'ios' && iosIsSimulator(udid)
  })
  await signInWithPassword(m, world.accounts.admin)
  const root = await m.hierarchy()
  const screen = { width: root.bounds.width, height: root.bounds.height }
  const open = async (path: string): Promise<void> => {
    await m.openLink({ link: `teamstation://${path}` })
    if (JSON.stringify(await m.hierarchy()).includes('"Open"'))
      await m.tapOn({ text: 'Open', optional: true })
  }
  return { m, screen, ids: world.ids, open }
}

/**
 * On iOS: 40pt steps from rest to the pin and back on the sticky section,
 * every step's pane read from the hierarchy (`stepOnPhone`).
 */
async function stickyOnIos(
  ctx: E2eContext,
  m: any,
  screen: { width: number; height: number },
  name: string
): Promise<void> {
  await stepOnPhone(
    m,
    screen,
    name,
    async shot => {
      await prove(ctx, m, `${shot}.png`)
    },
    false,
    2,
    'sticky'
  )
}

/**
 * On Android, where the hierarchy leaves the empty pane out: 40pt steps to
 * the pin, the one lower line read from each screenshot, where the scroll
 * puts the pane's edge, and the header and pane one filled surface.
 */
async function stickyOnAndroid(
  ctx: E2eContext,
  m: any,
  name: string
): Promise<void> {
  const png = async (): Promise<Buffer> => Buffer.from(await m.screenshot())
  const first = PNG_SIZE(await png())
  // The hierarchy's units are the screenshot's pixels on Android, at the
  // phone class's 420dpi: 2.625 to a point.
  const density = ANDROID_PIXELS_PER_POINT
  const frame = async (): Promise<
    NonNullable<ReturnType<typeof bandFrameOf>>
  > => {
    const read = bandFrameOf(await m.hierarchy(), 'sticky')
    if (read == null) throw new Error(`${name}: no sticky section on screen`)
    return read
  }
  // From the top: a page that opens anchored starts pinned.
  let now = await frame()
  for (let i = 0; i < 20; i++) {
    await m.dragPath({ points: ['2%, 30%', '2%, 85%'], duration: 400 })
    await new Promise(resolve => setTimeout(resolve, 1200))
    const after = await frame()
    const still = Math.abs(after.bandTop - now.bandTop) < 1
    now = after
    if (still) break
  }
  const pinAt = now.bandTop - now.headerBottom
  for (let step = 0; step < 40; step++) {
    const shot = await png()
    const expected = expectedPaneBottom(
      { ...now, paneTop: 0, paneBottom: 0 },
      pinAt
    )
    const seen = linesInColumn(shot, 6, Math.round(now.bandBottom + 8))
    expect(seen, `${name} step ${step}: one line`).length(1)
    expect(
      Math.abs(seen[0] - expected),
      `${name} step ${step}: the line where the scroll puts it`
    ).lte(4)
    await prove(ctx, m, `${name}-step-${String(step).padStart(2, '0')}.png`)
    if (Math.abs(now.bandTop - now.headerBottom) <= 4) break
    const from = 60
    const to = from - ((40 * density) / first.height) * 100
    await m.dragPath({
      points: [`2%, ${from}%`, `2%, ${to.toFixed(3)}%`],
      duration: 1500
    })
    now = await frame()
  }
  expect(Math.abs(now.bandTop - now.headerBottom)).lte(4)
}

/** A 420dpi Android phone, the class the scenario asks for. */
const ANDROID_PIXELS_PER_POINT = 2.625

/** A PNG's size, from its header. */
function PNG_SIZE(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
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

  'sticky-sections-phone': on('web', async ctx => {
    const session = await openWeb(
      ctx,
      PHONE,
      `/seasons/${STICKY_SEASON}?tab=schedule`,
      'sticky'
    )
    const { frames, top, pinAt } = await stepThrough(
      ctx,
      session,
      false,
      'sticky'
    )
    expect(frames).greaterThan(20)
    await scrollTo(session, pinAt + 3 * STEP, 'sticky')
    // Pinned: one pane from the top of the screen to the sections' lower
    // edge, the section clear over it.
    expect(top.paneGlass).equals(true)
    expect(Math.abs((top.lineBottom ?? -1) - top.bandBottom)).lte(0.5)
    await prove(ctx, session.m, 'web-season-sticky-pinned.png')
    await ctx.checkpoint('season-pinned', {
      expect: [{ id: 'sticky-section-glass' }]
    })
  }),

  'umpire-stack-phone': on('web', async ctx => {
    const session = await openWeb(
      ctx,
      PHONE,
      `/umpires/${STICKY_LEAGUE}`,
      'sticky'
    )
    const { frames, top, pinAt } = await stepThrough(
      ctx,
      session,
      false,
      'sticky'
    )
    expect(frames).greaterThan(5)
    await scrollTo(session, pinAt + 3 * STEP, 'sticky')
    // The glass covers the whole stack: the tabs, the Chat pill and the
    // column headers, down to the headers' lower edge.
    const stack = top.umpire
    expect(stack, 'the umpire stack').not.equals(null)
    expect(stack!.tabsTop).gte(top.headerBottom - 0.5)
    expect(stack!.chatTop).gte(top.headerBottom - 0.5)
    expect(Math.abs(top.paneBottom - top.bandBottom)).lte(0.5)
    expect(stack!.columnsBottom).lte(top.paneBottom + 0.5)
    expect(top.paneBottom - stack!.columnsBottom).lte(2)
    expect(top.headerFilter).equals('none')
    await prove(ctx, session.m, 'web-umpire-stack-pinned.png')
    await ctx.checkpoint('umpire-pinned', {
      expect: [{ id: 'umpire-sticky-stack' }]
    })
  }),

  'sticky-sections-ios': on('ios', async ctx => {
    const { m, screen, ids, open } = await openTessPhone(ctx)
    await open(`seasons/${ids.season}?tab=schedule`)
    await m.assertVisible({ text: 'Season sections', timeout: 30000 })
    // Every game, past and to come, so the page is long enough to pin.
    await m.tapOn({ text: 'All' })
    await stickyOnIos(ctx, m, screen, 'ios-season')
    await open(`umpires/${ids.league}`)
    await m.assertVisible({ id: 'umpire-sticky-stack', timeout: 30000 })
    // It opens at the next game, pinned: the steps start from the top.
    await phoneToTop(m, screen, 'ios-umpire', 'sticky')
    await stickyOnIos(ctx, m, screen, 'ios-umpire')
    // Pinned again: the pane reaches the column headers' lower edge.
    await stepOnPhone(
      m,
      screen,
      'ios-umpire-pin',
      async () => undefined,
      true,
      2,
      'sticky'
    )
    const root = await m.hierarchy()
    const frame = glassFrameOf(root, screen.height, 'sticky')!
    const columns = boundsOf(root, 'umpire-table-header')!
    expect(Math.abs(frame.paneBottom - (columns.y + columns.height))).lte(2)
  }),

  'sticky-sections-android': on('android', async ctx => {
    const { m, open, ids } = await openTessPhone(ctx)
    await open(`seasons/${ids.season}?tab=schedule`)
    await m.assertVisible({ text: 'Season sections', timeout: 30000 })
    // Every game, past and to come, so the page is long enough to pin.
    await m.tapOn({ text: 'All' })
    await stickyOnAndroid(ctx, m, 'android-season')
    await open(`umpires/${ids.league}`)
    await m.assertVisible({ id: 'umpire-sticky-stack', timeout: 30000 })
    await stickyOnAndroid(ctx, m, 'android-umpire')
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
    'src/app/components/StickySectionLayout.tsx',
    'src/app/components/StickySectionLayout.native.tsx',
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
  fixtures: ['coach-game', 'tess'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'device', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'device', needs: ['android-phone'], hardware: 'none' }]
    }
  },
  services: ['api', 'web'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: ['layout-shift', 'hidden-element', 'blank-screen'],
  manual: false,
  sendsNoMail: true,
  scenarios
})
