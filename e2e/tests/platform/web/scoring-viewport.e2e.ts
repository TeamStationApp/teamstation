import { writeFileSync } from 'node:fs'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import { defineE2e, type E2eContext } from '../../../core/spec'

/**
 * What a phone browser's bottom toolbar leaves the web scoring screen (#373),
 * proved on the page `e2e/fixtures/viewportProbe/index.html` before the
 * scoring route is changed: a root 100lvh tall painted the field's green, a
 * deck-sized blue block placed from the visual viewport as the scoring deck
 * will be, and a magenta band from the visual viewport's bottom (the
 * toolbar's top edge) to the bottom of the root.
 *
 * The page is served from the seat's web build at `/viewportProbe/`, beside
 * the app's own page. The scenario opens it in the phone's browser, taps the
 * strip under the toolbar with the phone's own tap, collapses the toolbar
 * and brings it back, and writes `toolbar-probe.json`: whether the page
 * paints behind the toolbar, the strip under it in CSS px, whether the tap
 * reached the page, and whether the deck stayed above the toolbar in each
 * state. Screen geometry is read from the screenshots' colours, the page's
 * own numbers from its readings in the view hierarchy: its text in Safari,
 * its address bar in Chrome on Android, which reports no page text.
 */

const PROBE_PATH = '/viewportProbe/index.html'
const BROWSERS = {
  'web-safari-ios': { platform: 'ios', appId: 'com.apple.mobilesafari' },
  'web-chrome-android': { platform: 'android', appId: 'com.android.chrome' }
} as const
/** The deck's height, as the page sets it (CONTROL_DECK_HEIGHT). */
const DECK_HEIGHT = 120

/** A browser on a phone that was never set up asks first. */
const FIRST_RUN = [
  'Use without an account',
  'Accept & continue',
  'No thanks',
  'No, thanks',
  'Got it',
  'Not now'
]

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function pastFirstRun(m: any): Promise<void> {
  for (let round = 0; round < 3; round++) {
    let answered = false
    for (const text of FIRST_RUN) {
      const asked: boolean = await m
        .assertVisible({ text, timeout: 1000 })
        .then(
          () => true,
          () => false
        )
      if (asked) {
        await m.tapOn({ text })
        answered = true
      }
    }
    if (!answered) return
  }
}

interface Node {
  text?: string
  id?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
  attributes?: Record<string, unknown>
}

function flatten(node: Node | Node[] | undefined, into: Node[] = []): Node[] {
  if (node == null) return into
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, into)
    return into
  }
  into.push(node)
  flatten(node.children, into)
  return into
}

function saysOf(node: Node): string[] {
  const attributes = node.attributes ?? {}
  return [
    node.text,
    attributes.text,
    attributes.label,
    attributes.value,
    attributes['content-desc'],
    attributes.accessibilityText
  ].filter((say): say is string => typeof say === 'string' && say !== '')
}

/**
 * The page's readings, `name=value`, as the view hierarchy reports them:
 * its text in Safari, its address bar in Chrome on Android (the page writes
 * them into the URL's fragment there). Undefined after `waitMs` without
 * them, as when Chrome's toolbar, and its address bar, has scrolled away.
 */
async function readingsOf(
  m: any,
  waitMs = 15000
): Promise<Record<string, number> | undefined> {
  for (const until = Date.now() + waitMs; ;) {
    const readings: Record<string, number> = {}
    for (const node of flatten((await m.hierarchy()) as Node)) {
      for (const say of saysOf(node)) {
        for (const [, name, value] of say.matchAll(/(\w+)=(-?[\d.]+)/g)) {
          readings[name] ??= Number(value)
        }
      }
    }
    if (readings.innerHeight != null && readings.pageTaps != null) {
      return readings
    }
    if (Date.now() > until) return undefined
    await sleep(500)
  }
}

type Colour = 'magenta' | 'green' | 'blue' | 'white' | 'other'

function colourOf(r: number, g: number, b: number): Colour {
  if (r > 200 && g < 90 && b > 200) return 'magenta'
  if (b > 200 && r < 110 && g > 60 && g < 160) return 'blue'
  // The page's #0f5a2a, closely: Safari's darker glass is a few steps off it.
  if (Math.abs(r - 15) <= 6 && Math.abs(g - 90) <= 8 && Math.abs(b - 42) <= 6)
    return 'green'
  if (r > 245 && g > 245 && b > 245) return 'white'
  return 'other'
}

/**
 * The field's green or the band's magenta. Green alone proves nothing under
 * a toolbar: Safari fills what it covers with a tint of the page's colour.
 * Only the magenta band, which lies past the visual viewport's bottom, is
 * the page itself painting there.
 */
const isPageColour = (colour: Colour): boolean =>
  colour === 'magenta' || colour === 'green'

interface Run {
  colour: Colour
  /** Screen pixels from the bottom edge to the run's lower edge. */
  from: number
  rows: number
}

/** A column of the screenshot, bottom to top, as runs of one colour. */
function columnRuns(png: PNG, x: number): Run[] {
  const runs: Run[] = []
  for (let y = png.height - 1; y >= 0; y--) {
    const at = (y * png.width + x) * 4
    const colour = colourOf(png.data[at], png.data[at + 1], png.data[at + 2])
    const last = runs[runs.length - 1]
    if (last?.colour === colour) last.rows++
    else runs.push({ colour, from: png.height - 1 - y, rows: 1 })
  }
  return runs
}

/** One toolbar state: the screenshot's geometry, in CSS px, and the page's. */
interface StateFacts {
  readings: Record<string, number>
  /** Screenshot pixels per CSS px, and the screen's height in CSS px. */
  scale: number
  screenHeight: number
  /** Where the page's top is on the screen, from the deck's place. */
  pageTop: number | null
  /** A browser toolbar was found at the foot of the screen. */
  bottomToolbar: boolean
  /** The toolbar's top edge, from the screen's top, and its height. */
  toolbarTop: number
  toolbarHeight: number
  /** The strip between the toolbar's bottom edge and the screen's. */
  stripBelowToolbar: number
  /** How much of that strip the page painted (magenta). */
  stripPainted: number
  /** How much of the band (past the visual viewport) shows on screen. */
  bandShown: number
  /**
   * The page paints where the toolbar is: the band past the visual
   * viewport shows, or, with no band, the page is laid out down behind the
   * toolbar. Null with no toolbar at the foot.
   */
  paintsBehindToolbar: boolean | null
  /** The deck's bottom edge, from the screen's top, and how much of it shows. */
  deckBottom: number | null
  deckVisibleHeight: number
  deckAboveToolbar: boolean
  /** Between the deck's bottom and the toolbar's top. */
  deckClearance: number | null
  /** White under the toolbar, or in the bottom 100 CSS px with none. */
  whiteAtFoot: boolean
  /** Bottom-up colour runs at 30% of the width, in CSS px. */
  runs: Array<{ colour: Colour; from: number; height: number }>
}

/** Page runs thinner than this inside the toolbar are its own glass, not a strip. */
const SPLINTER = 3

function factsOf(shot: Buffer, readings: Record<string, number>): StateFacts {
  const png = PNG.sync.read(shot)
  const scale = png.width / readings.innerWidth
  const css = (px: number): number => Math.round((px / scale) * 10) / 10
  // At 30% of the width: inside Safari's collapsed address pill (about
  // 26-74%) and clear of the home indicator (about 33-67%).
  const runs = columnRuns(png, Math.round(png.width * 0.3))
  const opposite = columnRuns(png, Math.round(png.width * 0.75))
  // The strip: field or band colour up from the bottom edge.
  let index = 0
  let strip = 0
  let painted = 0
  while (index < runs.length && isPageColour(runs[index].colour)) {
    strip += runs[index].rows
    if (runs[index].colour === 'magenta') painted += runs[index].rows
    index++
  }
  // The toolbar: neither the page's colours nor the deck, above the strip,
  // with splinters of page colour through its glass taken as part of it.
  let toolbar = 0
  while (index < runs.length) {
    const run = runs[index]
    if (run.colour === 'blue') break
    if (isPageColour(run.colour)) {
      const next = runs[index + 1]
      if (
        css(run.rows) > SPLINTER ||
        next == null ||
        isPageColour(next.colour) ||
        next.colour === 'blue'
      )
        break
    }
    toolbar += run.rows
    index++
  }
  const bottomToolbar = css(toolbar) >= 20
  const toolbarTopPx = bottomToolbar ? png.height - strip - toolbar : png.height
  // The deck: the lowest blue run, and how tall it shows.
  const deck = runs.find(run => run.colour === 'blue')
  const deckBottomPx = deck == null ? null : png.height - deck.from
  const pageTop =
    deckBottomPx == null ? null : css(deckBottomPx) - readings.deckBottom
  const bandShown = css(
    runs
      .filter(run => run.colour === 'magenta')
      .reduce((sum, run) => sum + run.rows, 0)
  )
  let paintsBehindToolbar: boolean | null = null
  if (bottomToolbar) {
    if (readings.bandHeight >= 4) {
      paintsBehindToolbar = bandShown >= readings.bandHeight / 2
    } else if (pageTop != null) {
      // No band: the visual viewport reaches the root's bottom. The page is
      // behind the toolbar only if that bottom is below the toolbar's middle.
      paintsBehindToolbar =
        pageTop + readings.rootHeight >= css(toolbarTopPx + toolbar / 2)
    }
  }
  const footRows = Math.round(100 * scale)
  return {
    readings,
    scale: Math.round(scale * 1000) / 1000,
    screenHeight: css(png.height),
    pageTop: pageTop == null ? null : Math.round(pageTop * 10) / 10,
    bottomToolbar,
    toolbarTop: css(toolbarTopPx),
    toolbarHeight: bottomToolbar ? css(toolbar) : 0,
    stripBelowToolbar: bottomToolbar ? css(strip) : 0,
    stripPainted: bottomToolbar ? css(painted) : 0,
    bandShown,
    paintsBehindToolbar,
    deckBottom: deckBottomPx == null ? null : css(deckBottomPx),
    deckVisibleHeight: deck == null ? 0 : css(deck.rows),
    deckAboveToolbar:
      deckBottomPx != null &&
      deck != null &&
      css(deck.rows) >= DECK_HEIGHT - 4 &&
      deckBottomPx <= (bottomToolbar ? toolbarTopPx : png.height - strip),
    deckClearance:
      deckBottomPx == null ? null : css(toolbarTopPx - deckBottomPx),
    // White in the strip under the toolbar, or at the foot with none:
    // what #373 is about. The toolbar's icons and the readings' glyphs,
    // thinner than a background, do not count.
    whiteAtFoot: [runs, opposite].some(column =>
      column.some(
        run =>
          run.colour === 'white' &&
          css(run.rows) >= 4 &&
          run.from < (bottomToolbar ? strip : footRows)
      )
    ),
    runs: runs.slice(0, 12).map(run => ({
      colour: run.colour,
      from: css(run.from),
      height: css(run.rows)
    }))
  }
}

interface TapFacts {
  /** Where the tap went, as shares of the screen. */
  point: string
  /**
   * `strip` under the toolbar, whatever fills it; `band` when no strip
   * showed but the band did; `none` when neither is on screen.
   */
  target: 'strip' | 'band' | 'none'
  reachedPage: boolean
  reachedBand: boolean
  /** The tap's y as the page saw it, in CSS px. */
  pageY: number | null
  after: Record<string, number>
}

/** Taps the middle of the strip under the toolbar, or the band's, with the phone's tap. */
async function tapStrip(m: any, facts: StateFacts): Promise<TapFacts> {
  const before = facts.readings
  let y: number | undefined
  let target: TapFacts['target'] = 'none'
  if (facts.bottomToolbar && facts.stripBelowToolbar >= 4) {
    y = facts.screenHeight - facts.stripBelowToolbar / 2
    target = 'strip'
  } else if (facts.bandShown >= 4 && facts.pageTop != null) {
    y = facts.pageTop + before.bandTop + before.bandHeight / 2
    target = 'band'
  }
  if (y == null) {
    return {
      point: '',
      target,
      reachedPage: false,
      reachedBand: false,
      pageY: null,
      after: before
    }
  }
  const point = `50%,${((y / facts.screenHeight) * 100).toFixed(1)}%`
  await m.tapOn({ point })
  await sleep(1200)
  const after = (await readingsOf(m, 5000)) ?? before
  return {
    point,
    target,
    reachedPage: after.pageTaps > before.pageTaps,
    reachedBand: after.bandTaps > before.bandTaps,
    pageY: after.pageTaps > before.pageTaps ? after.lastTapY : null,
    after
  }
}

async function capture(
  ctx: E2eContext,
  m: any,
  name: string,
  last?: Record<string, number>
): Promise<
  StateFacts & {
    readingsAfter: Record<string, number> | undefined
    readingsStale: boolean
  }
> {
  await sleep(1500)
  const read = await readingsOf(m, last == null ? 15000 : 5000)
  if (read == null && last == null) {
    throw new Error('the probe page’s readings are not in the hierarchy')
  }
  const shot: Buffer = Buffer.from(await m.screenshot())
  writeFileSync(ctx.artifact(`${name}.png`), shot)
  // Read again: a browser's accessibility tree can lag what it painted, and
  // the two readings differing says the state moved under the screenshot.
  const readingsAfter = await readingsOf(m, 2000)
  // With none to read, the last state's: the screen's geometry is still
  // measured, and the JSON says the page's numbers are the earlier ones.
  const readings = read ?? last ?? {}
  return {
    ...factsOf(shot, readings),
    readingsAfter,
    readingsStale: read == null
  }
}

export default defineE2e({
  id: 'platform/web/scoring-viewport',
  title:
    'What a phone browser’s bottom toolbar leaves the web scoring screen: paint, strip, taps and the deck',
  kind: 'e2e',
  covers: [
    'e2e/fixtures/viewportProbe/index.html',
    'src/app/field/useFieldSurface.ts'
  ],
  stack: 'seat',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      devices: [{ role: 'phone', needs: ['ios'], hardware: 'required' }]
    },
    'web-chrome-android': {
      devices: [{ role: 'phone', needs: ['android'], hardware: 'required' }]
    }
  },
  services: ['web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  // A probe of the browser, not of the app: no fault of the app reaches it.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'toolbar-probe': async ctx => {
      const browser =
        BROWSERS[ctx.surface as keyof typeof BROWSERS] ??
        BROWSERS['web-safari-ios']
      const m = await ctx.attach('phone', { ...browser })
      await m.run([{ setOrientation: 'PORTRAIT' }])
      await m.launchApp({ appId: browser.appId, stopApp: false })
      await pastFirstRun(m)
      const url = `${ctx.stack.origin}${PROBE_PATH}?run=${Date.now().toString(36)}`
      await m.openLink({ link: url, browser: true })
      await sleep(3000)
      await pastFirstRun(m)

      // 1. Open, toolbar shown.
      await ctx.checkpoint(
        'probe-open',
        {
          // Chrome reports the readings as one text of several lines.
          expect: [{ text: '[\\s\\S]*innerHeight=[\\s\\S]*', timeout: 30000 }]
        },
        m
      )
      const expanded = await capture(ctx, m, 'expanded')

      // 2. The phone's own tap in the strip under the toolbar.
      const tap = await tapStrip(m, expanded)

      // 3. Collapse the toolbar by scrolling the page, then bring it back.
      await m.swipe({ start: '50%,65%', end: '50%,25%' })
      const collapsed = await capture(ctx, m, 'collapsed', expanded.readings)
      const collapsedTap = await tapStrip(m, collapsed)
      for (let swipe = 0; swipe < 2; swipe++) {
        await m.swipe({ start: '50%,30%', end: '50%,75%' })
        await sleep(600)
      }
      const reexpanded = await capture(
        ctx,
        m,
        'expanded-again',
        collapsed.readings
      )

      // 4. The facts M1 decides the notice's place from.
      // The layout as the browser shows it: an address bar at the top
      // pushes the page down past the status bar (Safari's Top keeps its
      // tool row at the foot); at the foot, Safari's Bottom is two rows
      // tall and its Compact one.
      const addressAtTop = (expanded.pageTop ?? 0) >= 100
      const layout =
        ctx.surface === 'web-chrome-android'
          ? addressAtTop
            ? 'address-bar-top'
            : 'address-bar-bottom'
          : addressAtTop
            ? 'top'
            : expanded.toolbarHeight > 60
              ? 'bottom'
              : 'compact'
      const states = { expanded, collapsed, reexpanded }
      const shown = Object.values(states)
        .map(state => state.paintsBehindToolbar)
        .filter((paints): paints is boolean => paints != null)
      const result = {
        surface: ctx.surface,
        layout,
        url,
        collapsedReached:
          collapsed.readings.vvHeight > expanded.readings.vvHeight + 10 ||
          collapsed.toolbarHeight < expanded.toolbarHeight - 10,
        paintsBehindToolbar:
          shown.length === 0 ? null : shown.every(paints => paints),
        stripBelowToolbar: {
          expanded: expanded.stripBelowToolbar,
          collapsed: collapsed.stripBelowToolbar,
          reexpanded: reexpanded.stripBelowToolbar
        },
        stripPainted: {
          expanded: expanded.stripPainted,
          collapsed: collapsed.stripPainted,
          reexpanded: reexpanded.stripPainted
        },
        tapReachedPage: tap.reachedPage,
        tap,
        collapsedTap,
        deckAboveToolbar: {
          collapsed: collapsed.deckAboveToolbar,
          expanded: expanded.deckAboveToolbar && reexpanded.deckAboveToolbar
        },
        whiteAtFoot: Object.values(states).some(state => state.whiteAtFoot),
        states
      }
      writeFileSync(
        ctx.artifact('toolbar-probe.json'),
        `${JSON.stringify(result, null, 2)}\n`
      )
      console.log(`toolbar-probe.json ${JSON.stringify(result)}`)
      // The page was drawn and read in every state.
      for (const state of Object.values(states)) {
        expect(state.readings.innerHeight, 'the page’s readings').greaterThan(0)
      }
    }
  }
})
