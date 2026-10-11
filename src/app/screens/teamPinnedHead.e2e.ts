import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import {
  FIRST_ROW,
  type FixtureSeason,
  LAST_ROW,
  NEXT_ROW,
  PREVIOUS_ROW,
  TEAM_ID,
  TEAM_NAME,
  teamScheduleAnswer
} from '../../test/teamScheduleFixture'

/**
 * The team screen's pinned pills and its schedule, in Chrome, against the
 * web app on :8080 (`node src/build.mjs --serve`) with the API answered from
 * the team-schedule fixture:
 *
 *   TEST_PHASE=after TEST_ARTIFACT_DIR=… \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 300000 src/app/screens/teamPinnedHead.e2e.ts
 *
 * Each scenario runs at phone size, with touch, and at desktop size, unless
 * it says otherwise. `TEST_PHASE=before` records what it sees and the
 * screenshots without asserting, for the base branch. `TEST_ONLY` is a comma
 * list of scenario ids (default all). Chrome is `TS_CHROME_PATH` when set.
 */
const WEB = (process.env.TS_E2E_WEB_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  ''
)
const PHASE = process.env.TEST_PHASE ?? 'after'
const ASSERTING = PHASE === 'after'
const SHOTS = process.env.TEST_ARTIFACT_DIR
const ONLY = (process.env.TEST_ONLY ?? '').split(',').filter(id => id !== '')
const TOLERANCE = 2

interface Size {
  name: 'phone' | 'desktop'
  viewport: {
    width: number
    height: number
    isMobile?: boolean
    hasTouch?: boolean
    deviceScaleFactor?: number
  }
}

const SIZES: Size[] = [
  {
    name: 'phone',
    viewport: {
      width: 393,
      height: 852,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3
    }
  },
  { name: 'desktop', viewport: { width: 1440, height: 900 } }
]

interface Box {
  top: number
  bottom: number
}
interface Layout {
  card?: Box
  pill: Box
  /** The selected tab's content (`teamTabContent`). */
  content?: Box
  /** Each schedule row by its team line: `vs Falcons`, `@ Owls`. */
  rows: Record<string, Box>
  /** Everything written in each `scheduleGame` card. */
  rowTexts: string[]
  /** The header's copy of the team's name, 0 hidden to 1 shown. */
  name: number
}

let browser: Browser | undefined
const observed: string[] = []

const wanted = (id: string): boolean => ONLY.length === 0 || ONLY.includes(id)

function check(ok: boolean, message: string): void {
  observed.push(`${ok ? 'ok' : ASSERTING ? 'FAIL' : 'observed'}: ${message}`)
  if (ASSERTING) expect(ok, message).equals(true)
}
const near = (a: number | undefined, b: number | undefined): boolean =>
  a != null && b != null && Math.abs(a - b) <= TOLERANCE

async function open(
  size: Size,
  path: string,
  season: FixtureSeason = 'normal'
): Promise<Page> {
  if (browser == null) throw new Error('no browser')
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport(size.viewport)
  const now = Date.now()
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) {
      request.continue().catch(() => undefined)
      return
    }
    const headers = {
      'access-control-allow-origin': WEB,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers':
        request.headers()['access-control-request-headers'] ?? 'content-type'
    }
    if (request.method() === 'OPTIONS') {
      request.respond({ status: 204, headers }).catch(() => undefined)
      return
    }
    const answer = teamScheduleAnswer(
      request.method(),
      url.pathname + url.search,
      now,
      (method, route) => {
        observed.push(`fixture: unanswered ${method} ${route}`)
      },
      season
    )
    request
      .respond({
        status: answer.status,
        contentType: 'application/json',
        headers,
        body: JSON.stringify(answer.body)
      })
      .catch(() => undefined)
  })
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' })
  // The pills, and the data under them: Loading… is gone.
  await page.waitForFunction(
    () =>
      document.querySelector('[role="tab"]') != null &&
      !document.body.innerText.includes('Loading…')
  )
  await settle(page)
  return page
}

/**
 * The page-side half of `read`, as plain JavaScript in a string: the test
 * file is compiled by sucrase, which turns `??` and `?.` into calls to helpers
 * that do not exist inside the page.
 */
const READ_IN_PAGE = `(function (teamName) {
  var leaves = Array.prototype.filter.call(
    document.querySelectorAll('div, span'),
    function (node) { return node.childElementCount === 0 }
  )
  function box(node) {
    if (node == null) return undefined
    var rect = node.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  }
  var stats = Array.prototype.find.call(
    document.querySelectorAll('[role="tab"]'),
    function (tab) { return (tab.textContent || '').indexOf('Stats') === 0 }
  )
  if (stats == null) throw new Error('the pills are not on the page')
  var cards = Array.prototype.slice.call(
    document.querySelectorAll('[data-testid="scheduleGame"]')
  )
  var rows = {}
  leaves.forEach(function (leaf) {
    var text = leaf.textContent || ''
    if (!/^(@|vs) /.test(text)) return
    // The row's card when it has one; the line itself on a screen drawn
    // before rows had cards of their own.
    var card = cards.find(function (c) { return c.contains(leaf) })
    rows[text] = box(card || leaf)
  })
  // The header's copy is the highest drawing of the name; its opacity is the
  // product of every ancestor's.
  var copies = leaves
    .filter(function (leaf) { return leaf.textContent === teamName })
    .sort(function (a, b) {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top
    })
  var name = 0
  if (copies.length > 0) {
    name = 1
    for (var node = copies[0]; node != null; node = node.parentElement) {
      name *= Number(getComputedStyle(node).opacity)
    }
  }
  return {
    // The card's own title: the lowest drawing of the name above the pills.
    card: box(
      copies
        .filter(function (leaf) {
          return leaf.getBoundingClientRect().top < stats.getBoundingClientRect().top
        })
        .pop()
    ),
    pill: box(stats),
    content: box(document.querySelector('[data-testid="teamTabContent"]')),
    rows: rows,
    rowTexts: cards.map(function (card) { return card.textContent || '' }),
    name: name
  }
})`

/** Every rectangle the checks read, in one pass over the page. */
async function read(page: Page): Promise<Layout> {
  return (await page.evaluate(
    `${READ_IN_PAGE}(${JSON.stringify(TEAM_NAME)})`
  )) as Layout
}

/** Waits until the layout stops changing, so smooth scrolling has ended. */
async function settle(page: Page): Promise<Layout> {
  let last = JSON.stringify(await read(page))
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 150))
    const now = JSON.stringify(await read(page))
    if (now === last) return JSON.parse(now) as Layout
    last = now
  }
  throw new Error('The page never settled')
}

/**
 * Scrolls the page under the pointer by `dy` pixels: negative is a drag down
 * (toward the top of the list), positive a drag up.
 */
async function scroll(page: Page, size: Size, dy: number): Promise<Layout> {
  await page.mouse.move(size.viewport.width / 2, size.viewport.height * 0.7)
  await page.mouse.wheel({ deltaY: dy })
  return await settle(page)
}

/** Scrolls by `dy` until nothing moves any more. */
async function scrollToEnd(
  page: Page,
  size: Size,
  dy: number
): Promise<Layout> {
  let last = JSON.stringify(await read(page))
  for (let i = 0; i < 30; i++) {
    const now = await scroll(page, size, dy)
    if (JSON.stringify(now) === last) return now
    last = JSON.stringify(now)
  }
  throw new Error('The page kept scrolling')
}

async function tab(page: Page, name: string): Promise<Layout> {
  const target = (await page.evaluate(`(function (label) {
    var found = Array.prototype.find.call(
      document.querySelectorAll('[role="tab"]'),
      function (node) { return (node.textContent || '').indexOf(label) === 0 }
    )
    if (found == null) return null
    var rect = found.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })(${JSON.stringify(name)})`)) as { x: number; y: number } | null
  if (target == null) throw new Error(`no ${name} pill`)
  await page.mouse.click(target.x, target.y)
  return await settle(page)
}

async function shot(page: Page, size: Size, name: string): Promise<void> {
  if (SHOTS == null) return
  mkdirSync(SHOTS, { recursive: true })
  const file = `web-${size.name}-${name}-${PHASE}.png`
  await page.screenshot({ path: join(SHOTS, file) })
  observed.push(`captured ${file}`)
}

describe('team screen: pinned pills and the schedule', function () {
  before(async function () {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.TS_CHROME_PATH
    })
  })

  after(async function () {
    await browser?.close()
    if (SHOTS != null) {
      mkdirSync(SHOTS, { recursive: true })
      writeFileSync(
        join(SHOTS, `web-e2e-${PHASE}.txt`),
        observed.join('\n') + '\n'
      )
    }
  })

  for (const size of SIZES) {
    const at = size.name

    it(`${at}: E1–E6, the schedule opens at the next game and the pills pin`, async function () {
      if (!['E1', 'E2', 'E3', 'E4', 'E5', 'E6'].some(wanted)) this.skip()
      const page = await open(size, `/teams/${TEAM_ID}`)
      // E1
      const rest = await read(page)
      /** How far below the pills a tab's content starts. */
      const lead = (rest.content?.top ?? rest.pill.bottom) - rest.pill.top
      const contentStart = (layout: Layout): number => layout.pill.top + lead
      check(
        rest.card != null && rest.card.bottom <= rest.pill.top,
        `${at} E1: the card is above the pills`
      )
      check(rest.name < 0.1, `${at} E1: the header shows no name`)
      await shot(page, size, 'arrive')

      // E2
      const anchored = await tab(page, 'Schedule')
      const names = Object.keys(anchored.rows)
      observed.push(`${at} rows: ${names.join(', ')}`)
      check(
        anchored.rowTexts.length === 14 &&
          anchored.rowTexts.every(text => !text.includes(TEAM_NAME)),
        `${at} E2: no row repeats the team’s own name`
      )
      check(
        near(anchored.rows[NEXT_ROW]?.top, contentStart(anchored)),
        `${at} E2: ${NEXT_ROW} starts right under the pills`
      )
      check(
        (anchored.rows[PREVIOUS_ROW]?.top ?? 0) < anchored.pill.bottom,
        `${at} E2: ${PREVIOUS_ROW} is under the head`
      )
      check(
        near(anchored.card?.top, rest.card?.top) &&
          near(anchored.pill.top, rest.pill.top),
        `${at} E2: the card and pills have not moved`
      )
      check(anchored.name < 0.1, `${at} E2: the header shows no name`)
      await shot(page, size, 'schedule')

      // E3
      const down = await scroll(page, size, -300)
      check(
        (down.rows[PREVIOUS_ROW]?.top ?? -1) >= down.pill.bottom,
        `${at} E3: ${PREVIOUS_ROW} is below the pills`
      )
      check(
        near(down.card?.top, rest.card?.top) &&
          near(down.pill.top, rest.pill.top),
        `${at} E3: the card and pills have not moved`
      )
      check(down.name < 0.1, `${at} E3: the header shows no name`)
      await shot(page, size, 'drag-down')

      // E4
      const top = await scrollToEnd(page, size, -400)
      check(
        near(top.content?.top, contentStart(top)),
        `${at} E4: the schedule's heading is back under the pills`
      )
      check(
        (top.rows[FIRST_ROW]?.top ?? -1) > (top.content?.top ?? Infinity),
        `${at} E4: ${FIRST_ROW} is directly below the heading`
      )
      check(
        near(top.card?.top, rest.card?.top) &&
          near(top.pill.top, rest.pill.top),
        `${at} E4: the card and pills have still not moved`
      )
      check(top.name < 0.1, `${at} E4: the header shows no name`)

      // E5
      let previous = top
      let pinned: Layout | undefined
      for (let step = 1; step <= 15; step++) {
        const now = await scroll(page, size, 250)
        const rowsMoved = Object.entries(now.rows).some(
          ([name, box]) =>
            previous.rows[name] != null &&
            box.top < previous.rows[name].top - TOLERANCE
        )
        if (near(now.pill.top, previous.pill.top) && rowsMoved) {
          pinned = now
          break
        }
        check(
          now.pill.top < previous.pill.top - TOLERANCE,
          `${at} E5: step ${step}, the pills rise with the rows`
        )
        previous = now
      }
      check(pinned != null, `${at} E5: the pills pin and the rows go on`)
      check(
        pinned != null &&
          (pinned.card == null || pinned.card.bottom <= pinned.pill.top),
        `${at} E5: the card has gone under the header`
      )
      check((pinned?.name ?? 0) > 0.9, `${at} E5: the name is in the header`)
      await shot(page, size, 'pinned')

      // E6
      let topBack = false
      for (let i = 0; i < 30; i++) {
        const before = JSON.stringify(await read(page))
        const now = await scroll(page, size, -300)
        if (near(now.content?.top, contentStart(now))) topBack = true
        const cardShowing =
          now.card != null && now.card.top > (pinned?.pill.top ?? 0)
        if (cardShowing && !topBack) {
          check(false, `${at} E6: the card came back before the list's top`)
        }
        if (JSON.stringify(now) === before) break
      }
      const back = await read(page)
      check(topBack, `${at} E6: the list came back to its top first`)
      check(
        near(back.card?.top, rest.card?.top) &&
          near(back.pill.top, rest.pill.top),
        `${at} E6: at rest the card and pills are where they started`
      )
      await page.close()
    })

    it(`${at}: E7, every tab pins and starts under the pills`, async function () {
      if (!wanted('E7')) this.skip()
      const page = await open(size, `/teams/${TEAM_ID}`)
      const rest = await read(page)
      const lead = (rest.content?.top ?? rest.pill.bottom) - rest.pill.top
      await tab(page, 'Team')
      let pinned = await read(page)
      for (let i = 0; i < 8; i++) {
        const now = await scroll(page, size, 250)
        if (near(now.pill.top, pinned.pill.top)) break
        pinned = now
      }
      pinned = await read(page)
      check(
        pinned.pill.top > 0 &&
          pinned.pill.top < rest.pill.top - TOLERANCE &&
          pinned.name > 0.9,
        `${at} E7: the pills pin on Team, the name in the header`
      )
      for (const name of ['Stats', 'Videos', 'Schedule']) {
        const now = await tab(page, name)
        check(
          near(now.pill.top, pinned.pill.top),
          `${at} E7: ${name} leaves the pills pinned where they were`
        )
        check(now.name > 0.9, `${at} E7: ${name} keeps the name in the header`)
        const start =
          name === 'Schedule' ? now.rows[NEXT_ROW]?.top : now.content?.top
        check(
          near(start, now.pill.top + lead),
          `${at} E7: ${name} starts directly under the pills`
        )
        if (name === 'Videos') await shot(page, size, 'tabs')
      }
      await page.close()
    })

    it(`${at}: E9, the manage gear on a held card`, async function () {
      if (!wanted('E9')) this.skip()
      const page = await open(size, `/teams/${TEAM_ID}`)
      await tab(page, 'Schedule')
      const gear = await page.$('[aria-label="Manage"]')
      check(gear != null, `${at} E9: the gear is on the card`)
      if (gear != null) {
        await gear.click()
        await page
          .waitForFunction(() => location.pathname.endsWith('/settings'), {
            timeout: 5000
          })
          .catch(() => undefined)
        check(
          new URL(page.url()).pathname === `/groups/team/${TEAM_ID}/settings`,
          `${at} E9: the gear opens the team's Settings`
        )
      }
      await page.close()
    })

    if (size.name !== 'phone') continue

    it(`${at}: E8, ?tab=schedule opens at the next game`, async function () {
      if (!wanted('E8')) this.skip()
      const rest = await (async () => {
        const page = await open(size, `/teams/${TEAM_ID}`)
        const layout = await read(page)
        await page.close()
        return layout
      })()
      const page = await open(size, `/teams/${TEAM_ID}?tab=schedule`)
      const now = await settle(page)
      const lead = (rest.content?.top ?? rest.pill.bottom) - rest.pill.top
      check(
        near(now.rows[NEXT_ROW]?.top, now.pill.top + lead),
        `${at} E8: ${NEXT_ROW} starts right under the pills`
      )
      check(
        near(now.card?.top, rest.card?.top),
        `${at} E8: the card is showing`
      )
      check(
        new URL(page.url()).search === '?tab=schedule',
        `${at} E8: the address still says ?tab=schedule`
      )
      await page.close()
    })

    it(`${at}: E10, the nav bar's schedule still has two lines a row`, async function () {
      if (!wanted('E10')) this.skip()
      const page = await open(size, `/teams/${TEAM_ID}`)
      await page.goto(`${WEB}/schedule`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => document.body.innerText.includes('@ '))
      const lines = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].map(
          node => node.innerText.split('\n').slice(0, 4).join(' | ')
        )
      )
      observed.push(`${at} feed rows: ${lines.slice(0, 4).join(' / ')}`)
      check(
        lines.some(
          line => line.includes('Falcons') && line.includes(`@ ${TEAM_NAME}`)
        ),
        `${at} E10: Falcons / @ Mudcats`
      )
      check(
        lines.some(
          line => line.includes(TEAM_NAME) && line.includes('@ Pelicans')
        ),
        `${at} E10: Mudcats / @ Pelicans`
      )
      await page.close()
    })

    it(`${at}: E12, a live game, a season over and no games`, async function () {
      if (!wanted('E12')) this.skip()
      const restPage = await open(size, `/teams/${TEAM_ID}`)
      const rest = await read(restPage)
      await restPage.close()
      const lead = (rest.content?.top ?? rest.pill.bottom) - rest.pill.top
      const cases: Array<[FixtureSeason, string, string | undefined]> = [
        ['live', 'live', PREVIOUS_ROW],
        ['over', 'season-over', LAST_ROW],
        ['empty', 'empty', undefined]
      ]
      for (const [season, name, row] of cases) {
        // Where the card sits for this season: without standings it is a
        // line shorter.
        const seasonRest = await open(size, `/teams/${TEAM_ID}`, season)
        const restCard = (await read(seasonRest)).card
        await seasonRest.close()
        const page = await open(size, `/teams/${TEAM_ID}?tab=schedule`, season)
        const now = await settle(page)
        const top = row == null ? now.content?.top : now.rows[row]?.top
        check(
          near(top, now.pill.top + lead),
          `${at} E12 ${season}: ${row ?? 'the heading'} starts right under the pills`
        )
        if (season === 'empty') {
          const empty = await page.evaluate(() =>
            document.body.innerText.includes('No games scheduled.')
          )
          check(empty, `${at} E12 empty: the schedule says it has no games`)
        }
        check(
          near(now.card?.top, restCard?.top),
          `${at} E12 ${season}: the card is showing`
        )
        await shot(page, size, name)
        await page.close()
      }
    })

    it(`${at}: E13, a drag up from the anchor pins the pills`, async function () {
      if (!wanted('E13')) this.skip()
      const restPage = await open(size, `/teams/${TEAM_ID}`)
      const rest = await read(restPage)
      await restPage.close()
      const lead = (rest.content?.top ?? rest.pill.bottom) - rest.pill.top
      const cases: Array<[FixtureSeason, string | undefined]> = [
        ['normal', NEXT_ROW],
        ['over', LAST_ROW],
        ['empty', undefined]
      ]
      for (const [season, row] of cases) {
        const page = await open(size, `/teams/${TEAM_ID}?tab=schedule`, season)
        let before = await settle(page)
        let pinned: Layout | undefined
        for (let step = 0; step < 12 && pinned == null; step++) {
          const now = await scroll(page, size, 100)
          if (near(now.pill.top, before.pill.top)) pinned = before
          before = now
        }
        check(
          pinned != null &&
            pinned.pill.top > 0 &&
            pinned.pill.top < rest.pill.top - TOLERANCE,
          `${at} E13 ${season}: dragging up from the anchor pins the pills`
        )
        const top = row == null ? pinned?.content?.top : pinned?.rows[row]?.top
        const start = pinned == null ? undefined : pinned.pill.top + lead
        check(
          top != null &&
            start != null &&
            top <= start + TOLERANCE &&
            top >= start - 100 - TOLERANCE,
          `${at} E13 ${season}: ${row ?? 'the heading'} is at the content start under the pinned pills`
        )
        check(
          (pinned?.name ?? 0) > 0.9,
          `${at} E13 ${season}: the name is in the header`
        )
        // A season too short to fill the screen stops with its anchored row
        // still right under the pinned pills; a full one goes on scrolling,
        // so its last games can be reached.
        const end = await scrollToEnd(page, size, 100)
        if (season === 'normal') {
          const last = end.rows[LAST_ROW]
          check(
            last != null &&
              last.top >= end.pill.bottom &&
              last.bottom <= size.viewport.height,
            `${at} E13 normal: a full season scrolls on to its last game, ${LAST_ROW}`
          )
          await page.close()
          continue
        }
        const endTop = row == null ? end.content?.top : end.rows[row]?.top
        check(
          near(endTop, end.pill.top + lead),
          `${at} E13 ${season}: the page stops with ${row ?? 'the heading'} under the pinned pills`
        )
        if (season === 'over') await shot(page, size, 'season-over-pinned')
        await page.close()
      }
    })

    it(`${at}: E11, the batting table scrolls sideways under pinned pills`, async function () {
      if (!wanted('E11')) this.skip()
      const page = await open(size, `/teams/${TEAM_ID}`)
      await tab(page, 'Stats')
      for (let i = 0; i < 6; i++) await scroll(page, size, 250)
      const pinned = await read(page)
      // The table's name column, and the scroller it sits in.
      const PLAYER_CELL = `(function () {
        return Array.prototype.find.call(
          document.querySelectorAll('div'),
          function (node) {
            return node.childElementCount === 0 && node.textContent === 'Player'
          }
        )
      })()`
      /**
       * Scrolls the table sideways to `left` and says where the name column
       * and the first number column are: the name column sticks at the
       * table's edge, and the numbers go under it.
       */
      const sideways = async (
        left: number
      ): Promise<{ name: number; first: number; scrolled: number } | null> =>
        (await page.evaluate(`(function () {
          var name = ${PLAYER_CELL}
          if (name == null) return null
          var scroller = name.parentElement
          while (scroller != null && scroller.scrollWidth <= scroller.clientWidth)
            scroller = scroller.parentElement
          if (scroller == null) return null
          scroller.scrollLeft = ${left}
          var first = name.nextElementSibling
          return {
            name: name.getBoundingClientRect().left,
            first: first == null ? 0 : first.getBoundingClientRect().left,
            scrolled: scroller.scrollLeft
          }
        })()`)) as { name: number; first: number; scrolled: number } | null
      const part = await sideways(100)
      await settle(page)
      const more = await sideways(200)
      await settle(page)
      const now = await read(page)
      check(
        part != null &&
          more != null &&
          more.scrolled > part.scrolled &&
          near(more.name, part.name) &&
          more.first < part.first - TOLERANCE,
        `${at} E11: the name column stays put while the numbers scroll under it`
      )
      check(
        near(now.pill.top, pinned.pill.top),
        `${at} E11: the pills stay pinned`
      )
      await page.close()
    })
  }
})
