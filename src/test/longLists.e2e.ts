/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser callbacks are serialized without compiler helpers. */
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { HTTPRequest } from 'puppeteer'

import { gameCountLabel } from '../app/locales/strings'
import { scheduleDate, shortDate } from '../app/screens/format'
import { countFor, type When } from '../app/screens/whenFilter'
import type {
  GameSummary,
  ListCounts,
  Page as ListPage,
  SeasonGame
} from '../common/api'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { startLongLists } from './longListsFixture.e2e'
import { longListsSupport } from './longListsSeed'
import {
  absent,
  browserSession,
  contains,
  log,
  maestro
} from './refinementsMaestro.e2e'
import { scrollToRow } from './scrollToRow'
import { stackBrowserCoverage } from './stackBrowserCoverage'

/**
 * The long lists scenarios in maestro-d's own Chromium, against the world of
 * `longListsSeed.ts`.
 *
 *   npm run build.web
 *   TS_LONG_LISTS_ARTIFACTS=… [TS_LONG_LISTS_CASES=E1,E2] \
 *   [TS_LONG_LISTS_COVERAGE=coverage/longListsBrowser.json] \
 *   TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/test/longLists.e2e.ts [before]
 *
 * Each scenario is a case of the same name. `before` writes each proof under
 * its `-before` name and `-after` otherwise, so a build before the lists and
 * one after them run the same steps. A `later` step names what a milestone
 * asserts there.
 */
const artifacts = process.env.TS_LONG_LISTS_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_LONG_LISTS_ARTIFACTS')
const before = process.argv.includes('before')
const phase = before ? 'before' : 'after'
const support = longListsSupport()
const daemonName = process.env.TS_LONG_LISTS_DAEMON ?? 'longLists'
const ALL_CASES = [
  'E1',
  'E2',
  'E3',
  'E4',
  'E5',
  'E6',
  'E7',
  'E8',
  'E9',
  'E10',
  'E11',
  'E12'
]
const chosen = (process.env.TS_LONG_LISTS_CASES ?? ALL_CASES.join(','))
  .split(',')
  .map(name => name.trim())
const command = `TS_LONG_LISTS_CASES=${chosen.join(',')} node -r sucrase/register src/test/longLists.e2e.ts${before ? ' before' : ''}`

const PHONE = {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true
}
const DESKTOP = { width: 1280, height: 800 }
const FOUR_COLUMNS = { width: 1800, height: 1000 }
const TWO_COLUMNS = { width: 900, height: 1000 }
/** How far down a list the at-depth proofs are taken. */
const DEPTH = 6000
/** The rows of a page the server answers. */
const PAGE_ROWS = 50
/** The rows of a page of notifications. */
const INBOX_ROWS = 25
/** A row on the phone's screen, with what a list keeps drawn around it. */
const MOST_ROWS_AT_ONCE = 60
/** Past what is kept drawn after a team's next game. */
const ROWS_PAST_THE_NEXT = 14
/** The section title and its space, from the pills to a pill's first row. */
const MOST_BELOW_PILLS = 110

/** One of a milestone's steps, empty until that milestone. */
function later(step: string): void {
  console.log(`  later: ${step}`)
}

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  await mkdir(support, { recursive: true })
  const { f, seeded } = await startLongLists()
  const daemon = await maestro(daemonName)
  const { m, page, browser } = await browserSession(
    daemon,
    `${daemonName}-phone`,
    PHONE.width,
    PHONE.height,
    support
  )
  const cookie = {
    name: SESSION_COOKIE,
    value: f.h.tokens.get(101)!,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true
  }
  const pause = async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
  /** The text is there, its reads are in, and no slide is running. */
  const settle = async (text: string): Promise<void> => {
    await contains(page, text)
    await page
      .waitForNetworkIdle({ idleTime: 250, timeout: 10000 })
      .catch(() => undefined)
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[data-scene-role="incoming"], [data-scene-role="outgoing"], [data-page-role="outgoing"]'
        ) === null,
      { polling: 50, timeout: 10000 }
    )
  }
  const open = async (path: string, text: string): Promise<void> => {
    await m.openLink({ link: f.h.origin + path })
    await settle(text)
  }
  const tapCss = async (css: string): Promise<void> => {
    await page.waitForSelector(css, { timeout: 15000 })
    await m.tapOn({ css, timeout: 15000 })
  }
  const shot = async (name: string): Promise<void> => {
    await writeFile(
      join(artifacts!, `${name}-${phase}.png`),
      await page.screenshot({ type: 'png' })
    )
  }
  /** A look at a state, for the support directory rather than the proofs. */
  const shotOf = async (name: string): Promise<void> => {
    await writeFile(
      join(support, `${name}.png`),
      await page.screenshot({ type: 'png' })
    )
  }
  /** The page's own scroller: the tallest one on the top scene. */
  const scroll = async (to: number | 'end' | 'here'): Promise<number> =>
    await page.evaluate(wanted => {
      const scene = document.querySelector('[data-scene-role="top"]')
      const nodes = [
        ...(scene === null ? document : scene).querySelectorAll<HTMLElement>(
          '*'
        )
      ].filter(node => {
        const { overflowY } = getComputedStyle(node)
        return (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight + 40
        )
      })
      nodes.sort((a, b) => b.scrollHeight - a.scrollHeight)
      const scroller = nodes[0]
      if (scroller === undefined) throw new Error('No scroller on this page')
      if (wanted === 'here') return scroller.scrollTop
      scroller.scrollTop = wanted === 'end' ? scroller.scrollHeight : wanted
      return scroller.scrollHeight
    }, to)
  /** Down in steps, as far as `y`, letting what arrives on the way land. */
  const scrollDown = async (y: number): Promise<void> => {
    for (let at = 1500; at < y; at += 1500) {
      await scroll(at)
      await pause(120)
    }
    await scroll(y)
    await pause(400)
  }
  /** To the last row, however many pages it takes. */
  const scrollToEnd = async (onStep?: () => Promise<void>): Promise<void> => {
    let height = -1
    for (let still = 0; still < 3;) {
      const next = await scroll('end')
      await page
        .waitForNetworkIdle({ idleTime: 200, timeout: 5000 })
        .catch(() => undefined)
      await onStep?.()
      still = next === height ? still + 1 : 0
      height = next
    }
    await pause(300)
  }
  const signedIn = async (): Promise<void> => {
    await browser.setCookie(cookie)
  }
  const signedOut = async (): Promise<void> => {
    await browser.deleteCookie(...(await browser.cookies()))
  }
  const onSchedule = async (): Promise<void> => {
    await open('/schedule', 'Schedule')
    await tapCss('[role="tablist"] [role="tab"][aria-label="Past"]')
    await settle('Demo Owls')
    await pause(600)
  }
  /** Schedule's rows: a card in the pill on show, or in one kept beside it. */
  const scheduleRowNodes = async (): Promise<number> =>
    await page.$$eval('[data-testid="schedule-date"]', nodes => nodes.length)

  /** The reads of a paged list since the last look. */
  const reads: URL[] = []
  const teamReads: URL[] = []
  const publicReads: URL[] = []
  const inboxReads: URL[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.searchParams.get('public') === '1') publicReads.push(url)
    if (url.pathname.endsWith('/me/notifications')) inboxReads.push(url)
    if (url.pathname.endsWith('/events') && url.searchParams.has('paged'))
      reads.push(url)
    if (
      url.pathname.endsWith(`/teams/${seeded.teamId}/games`) &&
      url.searchParams.has('paged')
    )
      teamReads.push(url)
  })
  /** The whole list, as an unpaged read answers it. */
  const wholeList = async (query: string): Promise<SeasonGame[]> => {
    const answer = await f.h.request('GET', `/events${query}`, undefined, 101)
    return (await answer.json()) as SeasonGame[]
  }
  /** The game a team's schedule opens on, as the server says. */
  const teamOpening = async (): Promise<ListPage<GameSummary>> => {
    const answer = await f.h.request(
      'GET',
      `/teams/${seeded.teamId}/games?paged=1&around=next`,
      undefined,
      101
    )
    return (await answer.json()) as ListPage<GameSummary>
  }
  const nextGame = async (): Promise<GameSummary> => {
    const { items, anchorId } = await teamOpening()
    return items.find(game => game.id === anchorId)!
  }
  const laterGame = async (): Promise<GameSummary> => {
    const { items, anchorId } = await teamOpening()
    const at = items.findIndex(game => game.id === anchorId)
    return items
      .slice(at + ROWS_PAST_THE_NEXT)
      .find(game => game.playerRsvps != null)!
  }
  /** The season's counts, as the server says. */
  const seasonCounts = async (): Promise<ListCounts> => {
    const answer = await f.h.request(
      'GET',
      `/events?season=${seeded.seasonId}&paged=1`,
      undefined,
      101
    )
    return ((await answer.json()) as ListPage<SeasonGame>).counts!
  }
  /** What the season's hero says. */
  const heroCounts = async (): Promise<{ games: number; videos: number }> =>
    await page.evaluate(() => {
      const scene = document.querySelector('[data-scene-role="top"]')!
      const said = (scene as HTMLElement).textContent!
      const figure = (name: string): number => {
        const found = new RegExp(`${name}(\\d+)`, 'i').exec(said)
        return found === null ? -1 : Number(found[1])
      }
      return { games: figure('games'), videos: figure('videos') }
    })
  /** A team's schedule rows on the page, top first. */
  const teamRows = async (): Promise<Array<{ text: string; top: number }>> =>
    await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-page-role="top"] [data-testid="scheduleGame"]'
        )
      ]
        .map(node => ({
          text: node.textContent!,
          top: node.getBoundingClientRect().top
        }))
        .sort((a, b) => a.top - b.top)
    )
  const teamPillsBottom = async (): Promise<number> =>
    await page.$eval(
      '[aria-label="Team sections"]',
      node => node.getBoundingClientRect().bottom
    )
  /** The first row at or below the pills. */
  const readerRow = async (): Promise<{ text: string; top: number }> => {
    const pills = await teamPillsBottom()
    const row = (await teamRows()).find(({ top }) => top >= pills)
    if (row == null) throw new Error('No row under the pills')
    return row
  }
  const rowTop = async (text: string): Promise<number> => {
    const row = (await teamRows()).find(row => row.text === text)
    if (row == null) throw new Error(`No row ${text} on the page`)
    return row.top
  }
  /** The next game's row starts right under the pills. */
  const underPills = async (game: GameSummary, step: string): Promise<void> => {
    const pills = await teamPillsBottom()
    const top = await page.$eval(
      `[data-testid="schedule-rsvps-${game.id}"]`,
      node =>
        node.closest('[data-testid="scheduleGame"]')!.getBoundingClientRect()
          .top
    )
    assert.ok(
      top >= pills && top - pills <= MOST_BELOW_PILLS,
      `E6: ${step}: the row is ${top - pills} under the pills`
    )
  }
  /** The pills, and where a pill's rows start beneath them. */
  const head = async (): Promise<{ pills: number; firstRow: number }> =>
    await page.evaluate(() => {
      const pills = [...document.querySelectorAll('[role="tablist"]')]
        .find(node => node.querySelector('[aria-label="Past"]') !== null)!
        .getBoundingClientRect()
      const rows = [
        ...document.querySelectorAll(
          '[data-page-role="top"] [data-testid="schedule-date"]'
        )
      ].map(node => node.getBoundingClientRect().top)
      return {
        pills: pills.bottom,
        firstRow: Math.min(...rows.filter(top => top >= pills.bottom))
      }
    })
  /**
   * Tapping a pill while every frame of its slide is read: how many rows
   * stand in the page's height on each side, at the worst frame.
   */
  const fewestRowsSliding = async (
    label: string
  ): Promise<{ arriving: number; leaving: number; frames: number }> => {
    await page.evaluate(() => {
      const watch = { arriving: 1e9, leaving: 1e9, frames: 0, done: false }
      const shownIn = (frame: Element): number =>
        [...frame.querySelectorAll('[data-testid="schedule-date"]')].filter(
          node => {
            const { top, bottom } = node.getBoundingClientRect()
            return bottom > 0 && top < window.innerHeight
          }
        ).length
      const look = (): void => {
        const arriving = document.querySelector('[data-page-role="incoming"]')
        const leaving = document.querySelector('[data-page-role="outgoing"]')
        if (arriving !== null) {
          watch.frames++
          watch.arriving = Math.min(watch.arriving, shownIn(arriving))
        }
        if (leaving !== null)
          watch.leaving = Math.min(watch.leaving, shownIn(leaving))
        if (!watch.done) requestAnimationFrame(look)
      }
      ;(window as unknown as { slideWatch: typeof watch }).slideWatch = watch
      requestAnimationFrame(look)
    })
    await tapCss(`[role="tablist"] [role="tab"][aria-label="${label}"]`)
    await settle('Demo Owls')
    return await page.evaluate(() => {
      const { slideWatch } = window as unknown as {
        slideWatch: {
          arriving: number
          leaving: number
          frames: number
          done: boolean
        }
      }
      slideWatch.done = true
      return slideWatch
    })
  }
  /** The cards on the top page, in reading order. */
  const cards = async (): Promise<
    Array<{ left: number; top: number; width: number; text: string }>
  > =>
    await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-page-role="top"] [role="button"][aria-label*=" @ "]'
        )
      ]
        .map(node => {
          const { left, top, width } = node.getBoundingClientRect()
          return {
            left: Math.round(left),
            top: Math.round(top),
            width,
            text: node.textContent === null ? '' : node.textContent
          }
        })
        .sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top))
    )
  const columnsDrawn = async (): Promise<number> =>
    new Set((await cards()).map(card => card.left)).size

  const guestSeesNoPrivateEvent = async (): Promise<void> => {
    const text = await page.evaluate(() => document.body.textContent!)
    assert.ok(!text.includes(seeded.privateEventTitle), 'E8: a private event')
  }
  /** The rows on show whose test id starts `prefix`, without it. */
  const rowsNamed = async (prefix: string): Promise<string[]> =>
    await page.$$eval(
      `[data-scene-role="top"] [data-testid^="${prefix}"]`,
      (nodes, cut) =>
        nodes
          .filter(
            node =>
              node.closest('[data-page-role]:not([data-page-role="top"])') ===
              null
          )
          .map(node => node.getAttribute('data-testid')!.slice(cut)),
      prefix.length
    )
  /**
   * Down a list a screen at a time to its end, as somebody reading it does:
   * every row it holds that was on the page, and the most on it at once.
   */
  const readDown = async (
    prefix: string,
    onStep?: () => Promise<void>
  ): Promise<{ seen: Set<string>; most: number }> => {
    const seen = new Set<string>()
    let most = 0
    const look = async (): Promise<void> => {
      const rows = await rowsNamed(prefix)
      most = Math.max(most, rows.length)
      for (const row of rows) seen.add(row)
      await onStep?.()
    }
    await scroll(0)
    await pause(300)
    let at = 0
    for (let still = 0; still < 3;) {
      await look()
      at += PHONE.height * 0.7
      const height = await scroll(at)
      await page
        .waitForNetworkIdle({ idleTime: 150, timeout: 5000 })
        .catch(() => undefined)
      const end = await page.evaluate(() => {
        const scene = document.querySelector('[data-scene-role="top"]')!
        const tallest = [...scene.querySelectorAll<HTMLElement>('*')]
          .filter(node => node.scrollHeight > node.clientHeight + 40)
          .filter(node =>
            ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
          )
          .sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
        return tallest.scrollHeight - tallest.clientHeight - tallest.scrollTop
      })
      still = end < 2 && height > 0 ? still + 1 : 0
    }
    await look()
    return { seen, most }
  }
  /** What a guest's read of a group's public games walks to, in order. */
  const publicGames = async (
    groups: string,
    id: string,
    query: string
  ): Promise<{ ids: string[]; counts: ListCounts }> => {
    const ids: string[] = []
    let counts: ListCounts | null = null
    let cursor: string | null = null
    do {
      const after: string =
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      const answer = await f.h.request(
        'GET',
        `/${groups}/${id}/games?public=1&paged=1&${query}${after}`
      )
      assert.equal(answer.status, 200, 'E8: a guest may read public games')
      const found = (await answer.json()) as ListPage<{ id: string }>
      ids.push(...found.items.map(row => row.id))
      counts ??= found.counts
      cursor = found.nextCursor
    } while (cursor !== null)
    return { ids, counts: counts! }
  }
  /** A mode's rows, as the server walks them for 101. */
  const inbox = async (query: string): Promise<string[]> => {
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const after: string =
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      const answer = await f.h.request(
        'GET',
        `/me/notifications?${query}${after}`,
        undefined,
        101
      )
      const found = (await answer.json()) as {
        items: Array<{ requestId: string }>
        nextCursor: string | null
      }
      ids.push(...found.items.map(row => row.requestId))
      cursor = found.nextCursor
    } while (cursor !== null)
    return ids
  }
  const sameRows = (seen: Set<string>, ids: string[], what: string): void => {
    assert.deepEqual([...seen].sort(), [...ids].sort(), what)
  }

  const cases: Record<string, () => Promise<void>> = {
    E1: async () => {
      await onSchedule()
      reads.length = 0
      await scrollDown(DEPTH)
      await shot('schedule-past')
      let most = 0
      const countRows = async (): Promise<void> => {
        most = Math.max(most, await scheduleRowNodes())
      }
      // schedule-dom-count
      await scrollToEnd(countRows)
      const count = await scheduleRowNodes()
      await appendFile(
        join(artifacts!, 'schedule-dom-count.log'),
        `$ ${command}\nrow nodes at the end of Past (${phase}): ${count}\n`
      )
      console.log(`  row nodes at the end of Past: ${count}`)
      assert.ok(count > 0, 'E1: the end of Past holds rows')
      if (before) return
      await absent(page, 'Load more')
      const past = await wholeList('?when=past')
      const pages = Math.ceil(past.length / PAGE_ROWS)
      const cursors = reads
        .filter(url => url.searchParams.get('when') === 'past')
        .map(url => url.searchParams.get('cursor'))
        .filter(cursor => cursor !== null)
      console.log(
        `  ${past.length} games, ${cursors.length + 1} pages, most rows at once ${most}`
      )
      assert.ok(pages >= 3, 'E1: at least three pages')
      assert.equal(cursors.length, pages - 1, 'E1: every page, read once')
      assert.equal(new Set(cursors).size, cursors.length, 'E1: no page twice')
      assert.ok(most < MOST_ROWS_AT_ONCE, `E1: ${most} row nodes at once`)
      for (const card of await cards())
        assert.ok(card.width > PHONE.width * 0.8, 'E1: a row across the screen')
      const { month, day } = scheduleDate(past.at(-1)!.startAt)
      const lastRow = await page.$$eval(
        '[data-page-role="top"] [data-testid="schedule-date"]',
        nodes => nodes.at(-1)!.textContent
      )
      assert.ok(
        lastRow?.includes(month) === true && lastRow.includes(day),
        `E1: the last row is ${lastRow}, not the oldest game`
      )
    },
    E2: async () => {
      await onSchedule()
      await scrollDown(DEPTH)
      const deep = await head()
      await tapCss('[role="tablist"] [role="tab"][aria-label="All"]')
      await settle('Demo Owls')
      await pause(600)
      const all = await head()
      const toPast = await fewestRowsSliding('Past')
      await pause(600)
      const past = await head()
      const toAll = await fewestRowsSliding('All')
      await pause(600)
      console.log('  head', { deep, all, past }, 'slides', { toPast, toAll })
      if (before) return
      assert.ok(Math.abs(all.pills - deep.pills) < 1, 'E2: All holds the head')
      assert.ok(Math.abs(past.pills - deep.pills) < 1, 'E2: Past holds it')
      for (const shown of [all, past])
        assert.ok(
          shown.firstRow - shown.pills < MOST_BELOW_PILLS,
          `E2: a pill starts ${shown.firstRow - shown.pills} under the pills`
        )
      for (const slide of [toPast, toAll]) {
        assert.ok(slide.frames > 0, 'E2: no slide seen')
        assert.ok(slide.arriving > 0, 'E2: a blank page slid in')
        assert.ok(slide.leaving > 0, 'E2: a blank page slid out')
      }
    },
    E3: async () => {
      await page.setViewport(DESKTOP)
      reads.length = 0
      await open('/videos', 'Game videos')
      await settle('Demo Owls')
      await pause(600)
      await shot('videos-grid')
      if (before) {
        await page.setViewport(PHONE)
        return
      }
      await page.setViewport(FOUR_COLUMNS)
      await pause(600)
      assert.equal(await columnsDrawn(), 4, 'E3: four columns')
      for (const card of await cards())
        assert.ok(
          card.width > (FOUR_COLUMNS.width / 4) * 0.8,
          `E3: a card ${card.width} wide in four columns`
        )
      const videos = (await wholeList(''))
        .filter(game => game.videoCount > 0)
        .sort((a, b) => b.startAt!.localeCompare(a.startAt!))
      const shown = await cards()
      for (const [index, card] of shown.slice(0, 8).entries())
        assert.ok(
          card.text.includes(shortDate(videos[index].startAt)),
          `E3: card ${index} reads ${card.text}, not newest first`
        )
      await page.setViewport(TWO_COLUMNS)
      await pause(600)
      assert.equal(await columnsDrawn(), 2, 'E3: two columns')
      for (const card of await cards())
        assert.ok(
          card.width > (TWO_COLUMNS.width / 2) * 0.8,
          `E3: a card ${card.width} wide in two columns`
        )
      await scrollToEnd()
      const next = reads.filter(
        url =>
          url.searchParams.get('hasVideo') === '1' &&
          url.searchParams.has('cursor')
      )
      assert.ok(next.length > 0, 'E3: the next page loads')
      const end = await cards()
      assert.ok(
        end.at(-1)!.text.includes(shortDate(videos.at(-1)!.startAt)),
        'E3: the last video shows'
      )
      await page.setViewport(PHONE)
    },
    E4: async () => {
      await onSchedule()
      if (before) return
      let refusing = true
      const gate = (request: HTTPRequest): void => {
        const url = new URL(request.url())
        const answer =
          refusing && url.searchParams.has('cursor')
            ? request.respond({
                status: 503,
                contentType: 'application/json',
                body: '{"code":"unavailable","message":"Refused"}'
              })
            : request.continue()
        answer.catch(() => undefined)
      }
      await page.setRequestInterception(true)
      page.on('request', gate)
      try {
        const rowsAtEnd = await scroll('end')
        await contains(page, 'Could not load more')
        await pause(300)
        assert.ok((await scheduleRowNodes()) > 0, 'E4: the rows stay')
        await scroll('end')
        await pause(300)
        await shotOf('schedule-retry')
        refusing = false
        await m.tapOn({ text: 'Retry', timeout: 15000 })
        await page.waitForFunction(
          text => !document.body.textContent!.includes(text),
          { timeout: 15000 },
          'Could not load more'
        )
        await page
          .waitForNetworkIdle({ idleTime: 250, timeout: 10000 })
          .catch(() => undefined)
        assert.ok(
          (await scroll('end')) > rowsAtEnd,
          'E4: the next page arrived'
        )
      } finally {
        page.off('request', gate)
        await page.setRequestInterception(false)
      }
    },
    E5: async () => {
      later('M5: iOS only, in src/app/screens/longListsNative.e2e.ts')
    },
    E6: async () => {
      teamReads.length = 0
      await open(`/teams/${seeded.teamId}?tab=schedule`, 'Demo Hawks')
      await settle('Demo Owls')
      await pause(900)
      await shot('team-schedule-next')
      const next = await nextGame()
      await underPills(next, 'opens at the next game')
      assert.ok(
        (await teamRows()).length < MOST_ROWS_AT_ONCE,
        'E6: rows mount near the screen'
      )
      assert.deepEqual(
        teamReads.filter(url => url.searchParams.has('cursor')),
        [],
        'E6: nothing older is read before the reader moves'
      )
      await log(support, 'longLists-web.log', `E6: opens on ${next.id}`)

      await tapCss('[aria-label="Team sections"] [aria-label="Videos"]')
      await settle('Demo Owls')
      await pause(600)
      await shot('team-videos')
      await tapCss('[aria-label="Team sections"] [aria-label="Schedule"]')
      await settle('Demo Owls')
      await pause(900)
      await underPills(next, 'anchors again from Videos')
      await tapCss('[aria-label="Team sections"] [aria-label="Videos"]')
      await settle('Demo Owls')
      await pause(600)
      await page.goBack()
      await settle('Demo Owls')
      await pause(900)
      await underPills(next, 'anchors again on Back')
      await log(support, 'longLists-web.log', 'E6: anchors again')

      // A wheel at a time, in the middle of the page, up past the loaded rows.
      await page.mouse.move(PHONE.width / 2, PHONE.height / 2)
      const older = (): URL[] =>
        teamReads.filter(url => url.searchParams.has('cursor'))
      for (let wheel = 0; wheel < 80 && older().length === 0; wheel++) {
        await page.mouse.wheel({ deltaY: -500 })
        await pause(50)
      }
      assert.ok(older().length > 0, 'E6: older rows are read')
      // Still in motion: the older page has not landed.
      const reader = await readerRow()
      const offset = await scroll('here')
      await pause(1200)
      const held = await rowTop(reader.text)
      const landed = (await scroll('here')) - offset
      assert.ok(landed > 1000, `E6: older rows landed above, ${landed} of them`)
      assert.ok(
        Math.abs(held - reader.top) <= 2,
        `E6: the reader's row stood at ${reader.top}, and stands at ${held}`
      )
      await log(
        support,
        'longLists-web.log',
        `E6: ${older().length} older reads; ${landed} of rows landed above; the reader's row ${reader.top} then ${held}`
      )

      // Past the rows kept drawn around the next game, so that it can leave.
      const row = await laterGame()
      const control = `[data-testid="schedule-rsvp-control-${row.id}"]`
      await scrollToRow(page, control)
      await pause(300)
      await tapCss(control)
      await page.waitForSelector('[data-testid="event-rsvp-modal"]')
      await tapCss('[data-testid="event-rsvp-modal"] [aria-label^="Yes for"]')
      await pause(400)
      await m.tapOn({ text: 'Done', timeout: 15000 })
      const answer = `[data-testid="schedule-rsvps-${row.id}"]`
      await page.waitForSelector(
        `${answer} [data-testid="schedule-rsvp-avatars"]`
      )
      const counted = await page.$eval(answer, node => node.textContent)
      await scroll(0)
      await pause(800)
      assert.equal(await page.$(answer), null, 'E6: the row left the page')
      await scrollToRow(page, answer)
      await page.waitForSelector(
        `${answer} [data-testid="schedule-rsvp-avatars"]`
      )
      assert.equal(
        await page.$eval(answer, node => node.textContent),
        counted,
        'E6: the answer stays'
      )
      await log(support, 'longLists-web.log', 'E6: the RSVP answer stayed')
    },
    E7: async () => {
      await open(`/seasons/${seeded.seasonId}`, 'Demo Regular')
      await tapCss('[aria-label="Season sections"] [aria-label="Schedule"]')
      await settle('Demo Owls')
      await pause(600)
      await shot('season-games')
      const counts = await seasonCounts()
      const hero = async (when: string): Promise<void> => {
        assert.deepEqual(
          await heroCounts(),
          { games: counts.total, videos: counts.videos },
          `E7: the hero's counts on ${when}`
        )
      }
      await hero('opening')
      await tapCss('[role="tablist"] [role="tab"][aria-label="Past"]')
      await settle('Demo Owls')
      await scrollDown(DEPTH)
      await hero('Past at depth')
      // A pill's first time in is a spinner. After that it is kept.
      for (const [label, kept] of [
        ['Upcoming', false],
        ['Past', true],
        ['All', false],
        ['Past', true],
        ['Upcoming', true]
      ] as const) {
        const slide = await fewestRowsSliding(label)
        assert.ok(slide.frames > 0, `E7: ${label} slides`)
        assert.ok(
          !kept || slide.arriving > 0,
          `E7: ${label} comes back with rows, at worst ${slide.arriving}`
        )
        await pause(300)
        await hero(label)
      }
      await tapCss('[aria-label="Season sections"] [aria-label="Videos"]')
      await settle('Demo Owls')
      await pause(600)
      await shot('season-videos')
      await hero('Videos')
      await scrollToEnd()
      await hero('Videos at its end')
      await tapCss('[aria-label="Season sections"] [aria-label="Schedule"]')
      await settle('Demo Owls')
      await pause(400)
      assert.ok(
        (await page.$$('[data-page-role="top"] [data-testid="schedule-date"]'))
          .length > 0,
        'E7: Schedule comes back with rows'
      )
      await log(
        support,
        'longLists-web.log',
        `E7: counts held at ${counts.total} games, ${counts.videos} videos`
      )
    },
    E8: async () => {
      await signedOut()
      try {
        await open(`/teams/${seeded.publicTeamId}`, 'Demo Visitors')
        await settle('Demo Gulls')
        await pause(600)
        await shot('public-team')
        await guestSeesNoPrivateEvent()
        if (before) {
          await open(
            `/groups/season/${seeded.publicSeasonId}`,
            'Demo Standalone'
          )
          await settle('Demo Gulls')
          await pause(600)
          await shot('public-season')
          await guestSeesNoPrivateEvent()
          return
        }
        const pillsAt = await teamPillsBottom()
        const teamId = seeded.publicTeamId
        const teamVideos = await publicGames(
          'teams',
          teamId,
          'order=asc&hasVideo=1'
        )
        await contains(page, `${teamVideos.counts.withVideo} with video`)
        const videos = await readDown('public-game-', guestSeesNoPrivateEvent)
        sameRows(videos.seen, teamVideos.ids, 'E8: the team Videos rows')
        assert.ok(
          publicReads.some(url => url.searchParams.get('hasVideo') === '1'),
          'E8: Videos asks hasVideo=1'
        )

        await tapCss('[aria-label="Team sections"] [aria-label="Schedule"]')
        await settle('Demo Gulls')
        await pause(600)
        publicReads.length = 0
        const teamGames = await publicGames('teams', teamId, 'order=asc')
        assert.ok(teamGames.ids.length > PAGE_ROWS * 2, 'E8: three pages')
        const games = await readDown('public-game-', guestSeesNoPrivateEvent)
        sameRows(games.seen, teamGames.ids, 'E8: the team Schedule rows')
        const cursors = publicReads
          .map(url => url.searchParams.get('cursor'))
          .filter(cursor => cursor !== null)
        assert.equal(
          cursors.length,
          Math.ceil(teamGames.ids.length / PAGE_ROWS) - 1,
          'E8: each page of the team Schedule, read once'
        )
        assert.equal(new Set(cursors).size, cursors.length, 'E8: no page twice')
        assert.ok(
          publicReads.every(url => url.searchParams.get('order') === 'asc'),
          'E8: the team reads in the order games are played'
        )
        assert.ok(games.most < MOST_ROWS_AT_ONCE, `E8: ${games.most} rows`)
        // The pills pin under the header at depth, and hold across tabs.
        const pinnedAt = await teamPillsBottom()
        assert.ok(pinnedAt < pillsAt - 40, 'E8: the pills go up with the card')
        await tapCss('[aria-label="Team sections"] [aria-label="Team"]')
        await settle('TEAM INFORMATION')
        await pause(600)
        const held = await teamPillsBottom()
        await tapCss('[aria-label="Team sections"] [aria-label="Schedule"]')
        await pause(600)
        assert.ok(
          (await rowsNamed('public-game-')).length > 0,
          'E8: a kept Schedule comes back with rows'
        )
        assert.ok(
          Math.abs((await teamPillsBottom()) - held) < 1 &&
            Math.abs(held - pinnedAt) < 1,
          'E8: the pills hold through a tab'
        )
        console.log(
          `  public team: ${teamGames.ids.length} games, ${videos.seen.size} with video, ${cursors.length + 1} pages, most rows at once ${games.most}, pills ${pillsAt} to ${pinnedAt}`
        )
        await log(
          support,
          'longLists-web.log',
          `E8: public team read ${games.seen.size} games by page`
        )

        publicReads.length = 0
        const seasonId = seeded.publicSeasonId
        await open(`/groups/season/${seasonId}`, 'Demo Standalone')
        await settle('Demo Gulls')
        await pause(600)
        await shot('public-season')
        await guestSeesNoPrivateEvent()
        const orders: Record<When, string> = {
          past: 'when=past&order=desc',
          upcoming: 'when=upcoming&order=asc',
          all: 'order=desc'
        }
        const walked = new Set<string>()
        for (const [label, when] of [
          ['Past', 'past'],
          ['Upcoming', 'upcoming'],
          ['All', 'all']
        ] as const) {
          if (when !== 'past') {
            await tapCss(`[role="tablist"] [role="tab"][aria-label="${label}"]`)
            await settle('Demo Gulls')
            await pause(600)
          }
          const listed = await publicGames('seasons', seasonId, orders[when])
          await contains(page, gameCountLabel(countFor(listed.counts, when)))
          const read = await readDown('public-game-', guestSeesNoPrivateEvent)
          sameRows(read.seen, listed.ids, `E8: the season's ${label} rows`)
          assert.ok(read.most < MOST_ROWS_AT_ONCE, `E8: ${read.most} rows`)
          for (const id of read.seen) walked.add(id)
          console.log(`  public season ${label}: ${read.seen.size} games`)
        }
        assert.ok(
          publicReads.every(url =>
            url.pathname.includes(`/seasons/${seasonId}`)
          ),
          'E8: only the public season read'
        )
        await log(
          support,
          'longLists-web.log',
          `E8: public season read ${walked.size} games by page in each pill`
        )
      } finally {
        await signedIn()
      }
    },
    E9: async () => {
      inboxReads.length = 0
      await open('/notifications', 'Pending')
      await settle('Demo')
      if (before) {
        await scrollToEnd()
        await contains(page, 'Load more')
        await shot('notifications')
        return
      }
      const PREFIX = 'notification-row-'
      const pages = (rows: number): number => Math.ceil(rows / INBOX_ROWS)
      const cursors = (mode: string | null): Array<string | null> =>
        inboxReads
          .filter(
            url =>
              (url.searchParams.get('history') === '1'
                ? 'history'
                : url.searchParams.get('sent') === '1'
                  ? 'sent'
                  : null) === mode
          )
          .map(url => url.searchParams.get('cursor'))
          .filter(cursor => cursor !== null)
      const pending = await inbox('')
      const read = await readDown(PREFIX)
      sameRows(read.seen, pending, 'E9: every row of Pending')
      assert.equal(
        new Set(cursors(null)).size,
        pages(pending.length) - 1,
        'E9: Pending reads each page'
      )
      assert.ok(read.most < MOST_ROWS_AT_ONCE, `E9: ${read.most} rows at once`)
      await absent(page, 'Load more')
      await shot('notifications')

      await scroll(0)
      await pause(400)
      const reminder = (await rowsNamed(PREFIX))[0]
      const row = `[data-testid="${PREFIX}${reminder}"]`
      assert.match(reminder, /^nev_long_reminder_/, 'E9: reminders come first')
      await page.$$eval(`${row} [role="button"]`, nodes => {
        const dismiss = nodes.find(node => node.textContent === 'Dismiss')
        ;(dismiss as HTMLElement).click()
      })
      await page.waitForFunction(
        (css: string) => document.querySelector(css) === null,
        { timeout: 10000 },
        row
      )
      const left = await inbox('')
      assert.ok(!left.includes(reminder), 'E9: the server dismissed it')
      assert.equal(left.length, pending.length - 1, 'E9: one row left')
      await pause(300)

      for (const [label, query, mode] of [
        ['Sent', 'sent=1', 'sent'],
        ['History', 'history=1', 'history']
      ] as const) {
        await m.tapOn({ text: label, timeout: 15000 })
        await page
          .waitForNetworkIdle({ idleTime: 250, timeout: 10000 })
          .catch(() => undefined)
        const rows = await inbox(query)
        assert.ok(rows.length > 0, `E9: ${label} holds rows`)
        const walked = await readDown(PREFIX)
        sameRows(walked.seen, rows, `E9: every row of ${label}`)
        assert.equal(
          new Set(cursors(mode)).size,
          pages(rows.length) - 1,
          `E9: ${label} reads each page`
        )
        await absent(page, 'Load more')
        if (mode === 'history')
          assert.ok(walked.seen.has(reminder), 'E9: dismissed, in History')
        console.log(`  ${label}: ${rows.length} rows, ${walked.most} at once`)
      }
      await m.tapOn({ text: 'Pending', timeout: 15000 })
      await page
        .waitForNetworkIdle({ idleTime: 250, timeout: 10000 })
        .catch(() => undefined)
      await pause(300)
      assert.ok(
        (await rowsNamed(PREFIX)).every(id => id !== reminder),
        'E9: the dismissed row stays gone'
      )
      await log(
        support,
        'longLists-web.log',
        `E9: Pending ${pending.length} rows, ${read.most} at once; a reminder left`
      )
    },
    E10: async () => {
      await open(`/players/${seeded.playerId}`, 'Mookie')
      await settle('Single')
      await scrollToEnd()
      if (before) await contains(page, 'Show more')
      await shot('player-videos')
      later('M8: auto-loads to the last highlight; no Show more')
    },
    E11: async () => {
      await open(`/games/${seeded.highlightsGameId}`, 'Demo Owls')
      await tapCss(
        '[data-scene-role="top"] [aria-label="Game sections"] [aria-label="Videos"]'
      )
      await settle('Mookie')
      await pause(600)
      await shot('game-highlights')
      later('M8: current row marks; jumpTo seeks; side-by-side layout')
    },
    E12: async () => {
      await open(`/umpires/${seeded.leagueId}`, 'Umpire')
      await page.waitForSelector('[data-testid="umpire-table"]', {
        timeout: 20000
      })
      await settle('Demo Owls')
      await pause(900)
      await shot('umpire-table')
      later("M9: opens on the rule's game; columns stay as pages arrive")
      later('M9: a note stays typed; sign-up past the first page; Leaderboard')
    }
  }

  let tests = 0
  try {
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' }
    ])
    await page.setViewport(PHONE)
    await signedIn()
    for (const name of chosen) {
      const run = cases[name]
      if (run == null) throw new Error(`No case ${name}`)
      await log(support, 'longLists-web.log', `${name}: start`)
      await run()
      tests++
      await log(support, 'longLists-web.log', `${name}: done`)
    }
    if (process.env.TS_LONG_LISTS_COVERAGE != null)
      await stackBrowserCoverage(
        page,
        f.h.origin,
        resolve(process.env.TS_LONG_LISTS_COVERAGE),
        tests
      )
  } finally {
    await m.detach()
    await browser.close().catch(() => undefined)
    await daemon.shutdown()
    await f.h.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
