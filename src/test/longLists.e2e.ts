/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser callbacks are serialized without compiler helpers. */
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { HTTPRequest } from 'puppeteer'

import { scheduleDate, shortDate } from '../app/screens/format'
import type { SeasonGame } from '../common/api'
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
/** A row on the phone's screen, with what a list keeps drawn around it. */
const MOST_ROWS_AT_ONCE = 60
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
  const scroll = async (to: number | 'end'): Promise<number> =>
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
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/events') && url.searchParams.has('paged'))
      reads.push(url)
  })
  /** The whole list, as an unpaged read answers it. */
  const wholeList = async (query: string): Promise<SeasonGame[]> => {
    const answer = await f.h.request('GET', `/events${query}`, undefined, 101)
    return (await answer.json()) as SeasonGame[]
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
      await open(`/teams/${seeded.teamId}?tab=schedule`, 'Demo Hawks')
      await settle('Demo Owls')
      await pause(900)
      await shot('team-schedule-next')
      later('M6: opens under the pills at the next game')
      await tapCss('[aria-label="Team sections"] [aria-label="Videos"]')
      await settle('Demo Owls')
      await pause(600)
      await shot('team-videos')
      later('M6: back on Schedule, it anchors on the next game again')
      later('M6: older rows arrive above; the reader stays; an RSVP stays')
    },
    E7: async () => {
      await open(`/seasons/${seeded.seasonId}`, 'Demo Regular')
      await tapCss('[aria-label="Season sections"] [aria-label="Schedule"]')
      await settle('Demo Owls')
      await pause(600)
      await shot('season-games')
      later('M6: pills slide; a kept page returns with rows')
      await tapCss('[aria-label="Season sections"] [aria-label="Videos"]')
      await settle('Demo Owls')
      await pause(600)
      await shot('season-videos')
      later('M6: hero counts stay the same as rows load')
    },
    E8: async () => {
      await signedOut()
      try {
        await open(`/teams/${seeded.publicTeamId}`, 'Demo Visitors')
        await settle('Demo Gulls')
        await pause(600)
        await shot('public-team')
        await guestSeesNoPrivateEvent()
        await open(`/groups/season/${seeded.publicSeasonId}`, 'Demo Standalone')
        await settle('Demo Gulls')
        await pause(600)
        await shot('public-season')
        later('M7: pages load; counts are right; pills switch')
        await guestSeesNoPrivateEvent()
      } finally {
        await signedIn()
      }
    },
    E9: async () => {
      await open('/notifications', 'Pending')
      await settle('Demo')
      await scrollToEnd()
      if (before) await contains(page, 'Load more')
      await shot('notifications')
      later('M7: pages in each mode; a dismissed row leaves; no Load more')
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
