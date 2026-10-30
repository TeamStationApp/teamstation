/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser callbacks are serialized without compiler helpers. */
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { SESSION_COOKIE } from '../server/auth/tokens'
import { startLongLists } from './longListsFixture.e2e'
import { longListsSupport } from './longListsSeed'
import {
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
/** How far down a list the at-depth proofs are taken. */
const DEPTH = 6000

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
  const scrollToEnd = async (): Promise<void> => {
    let height = -1
    for (let still = 0; still < 3;) {
      const next = await scroll('end')
      await page
        .waitForNetworkIdle({ idleTime: 200, timeout: 5000 })
        .catch(() => undefined)
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

  const guestSeesNoPrivateEvent = async (): Promise<void> => {
    const text = await page.evaluate(() => document.body.textContent!)
    assert.ok(!text.includes(seeded.privateEventTitle), 'E8: a private event')
  }

  const cases: Record<string, () => Promise<void>> = {
    E1: async () => {
      await onSchedule()
      await scrollDown(DEPTH)
      await shot('schedule-past')
      later('M5: rows arrive with no button, one request per page')
      // schedule-dom-count
      await scrollToEnd()
      const count = await scheduleRowNodes()
      await appendFile(
        join(artifacts!, 'schedule-dom-count.log'),
        `$ ${command}\nrow nodes at the end of Past (${phase}): ${count}\n`
      )
      console.log(`  row nodes at the end of Past: ${count}`)
      assert.ok(count > 0, 'E1: the end of Past holds rows')
      later('M5: fewer than 60 row nodes at once; the last seeded game shows')
    },
    E2: async () => {
      await onSchedule()
      await scrollDown(DEPTH)
      await tapCss('[role="tablist"] [role="tab"][aria-label="All"]')
      await settle('Demo Owls')
      await tapCss('[role="tablist"] [role="tab"][aria-label="Past"]')
      await settle('Demo Owls')
      later('M5: the head holds; each pill starts under the pills; no blanks')
    },
    E3: async () => {
      await page.setViewport(DESKTOP)
      await open('/videos', 'Game videos')
      await settle('Demo Owls')
      await pause(600)
      await shot('videos-grid')
      later('M5: grid order; resize to two columns; next page loads')
      await page.setViewport(PHONE)
    },
    E4: async () => {
      await onSchedule()
      later('M5: refuse a page; rows stay; Retry shows; next page loads')
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
