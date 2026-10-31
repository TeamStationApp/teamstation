import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { HTTPRequest } from 'puppeteer'

import { userIdOfGumbo } from '../common/userId'
import {
  type BrowserSession,
  browserSession,
  contains,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import {
  readyUmpireBrowser,
  UMPIRE_BROWSER_NOW,
  umpireBrowserFixture
} from '../test/umpireBrowserFixture'
import { seedUmpireCounts } from '../test/umpireTypes'
import { recordBrowserCoverage } from './browserCoverage.e2e'

async function main(): Promise<void> {
  const artifacts = process.env.TS_UMPIRE_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_UMPIRE_ARTIFACTS')
  const baseline = process.env.TS_UMPIRE_BASELINE === '1'
  const suffix = baseline ? 'before' : 'after'
  const web = baseline
    ? join(artifacts, 'support/baseline-web')
    : resolve('dist')
  process.env.TS_UMPIRE_NOW = UMPIRE_BROWSER_NOW
  const f = await umpireBrowserFixture(web)
  const daemon = await maestro('umpireScheduleLayout')
  let b: BrowserSession | undefined
  const log: string[] = [
    '$ node -r sucrase/register src/app/umpireScheduleLayout.e2e.ts'
  ]
  try {
    await readyUmpireBrowser(f)
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(101),
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    const game = await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', 'gam_umpire_g1')
      .executeTakeFirstOrThrow()
    for (let i = 0; i < 30; i++)
      await f.h.db
        .insertInto('games')
        .values({
          ...game,
          id: `gam_layout_${i}`,
          start_at: new Date(new Date(game.start_at).getTime() + i * 86400000),
          end_at: new Date(new Date(game.end_at!).getTime() + i * 86400000)
        })
        .execute()
    await f.h.db
      .insertInto('season_umpire_requirements')
      .values({ season_id: f.playoffs, level_id: 'ulv_browser_majors' })
      .execute()
    await seedUmpireCounts(f.h.db, f.playoffs, true, 1)
    await f.h.db
      .insertInto('games')
      .values({
        ...game,
        id: 'gam_layout_prior',
        season_id: f.playoffs,
        start_at: new Date('2026-11-10T22:00:00Z'),
        end_at: new Date('2026-11-11T00:00:00Z')
      })
      .execute()
    for (const [id, name, position] of [
      ['unt_color', 'Jersey Color', 0],
      ['unt_contact', 'Venue Contact', 1]
    ] as const)
      await f.h.db
        .insertInto('umpire_note_types')
        .values({ id, name, position, league_id: f.leagueA })
        .execute()
    await f.h.db
      .updateTable('users')
      .set({ first_name: 'Ken Griffey Junior', last_name: 'Trout' })
      .where('id', '=', userIdOfGumbo(103))
      .execute()
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: game.id,
        slot: 'uty_plate:1',
        user_id: userIdOfGumbo(103),
        assigned_by: userIdOfGumbo(101)
      })
      .execute()
    b = await browserSession(
      daemon,
      'umpire-schedule-layout',
      1440,
      900,
      artifacts
    )
    const { page, m, browser } = b
    page.on('pageerror', error => {
      console.error(
        'Browser error',
        error instanceof Error ? error.message : String(error)
      )
    })
    await page.emulateTimezone('America/Los_Angeles')
    const login = async (id: number): Promise<void> => {
      await browser.setCookie({
        name: 'ts_session',
        value: f.h.tokens.get(id)!,
        domain: new URL(f.h.origin).hostname,
        path: '/',
        httpOnly: true
      })
    }
    const path = `/umpires/${f.leagueA}`
    const open = async (query = ''): Promise<void> => {
      await m.openBrowser({ url: f.h.origin + path + query })
      await contains(page, baseline ? 'Umpire schedule' : 'Umpire')
      await page.evaluate(async () => await document.fonts.ready)
    }
    const shot = async (name: string): Promise<void> => {
      await m.waitForAnimationToEnd()
      await writeFile(
        join(artifacts, `${name}-${suffix}.png`),
        await page.screenshot({ fullPage: false })
      )
    }
    const scrollDown = async (): Promise<void> => {
      if ((page.viewport()?.width ?? 1440) < 500) {
        // Maestro's mouse-wheel center retains the original desktop window size.
        // Target the actual scroll container after a responsive viewport resize.
        await m.evalBrowserScript({
          script: `(() => {
          let node = document.querySelector('[data-testid="umpire-table"]');
          while (node && getComputedStyle(node).overflowY !== 'auto' && getComputedStyle(node).overflowY !== 'scroll') node = node.parentElement;
          (node ?? document.scrollingElement).scrollBy({ top: 300 });
        })()`
        })
      } else await m.scroll({ direction: 'down' })
      if (baseline)
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('*')).some(
            node => node.scrollTop > 0
          )
        )
      if (!baseline)
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="sticky-season-sections"]')!
              .getBoundingClientRect().top <= 50
        )
    }
    await login(101)
    await open(baseline ? '?view=league' : '')
    await page.waitForSelector('[data-testid="umpire-game-gam_umpire_g1"]')
    await shot('schedule-desktop')
    if (!baseline) {
      const geometry = await page.evaluate(() => {
        const row = document.querySelector(
          '[data-testid="umpire-game-gam_umpire_g1"]'
        )!
        const cells = Array.from(row.children) as HTMLElement[]
        const dateWidths = Array.from(
          document.querySelectorAll('[data-testid="umpire-date-measure"]')
        ).map(n => n.getBoundingClientRect().width)
        const pill = document
          .querySelector('[data-testid="umpire-signup-measure"]')!
          .getBoundingClientRect().width
        const conflict = document
          .querySelector('[data-testid="umpire-conflict-measure"]')!
          .getBoundingClientRect().width
        return {
          widths: cells.map(n => n.getBoundingClientRect().width),
          dates: Math.max(...dateWidths),
          pill,
          conflict,
          borders: cells.map(n => getComputedStyle(n).borderRightWidth),
          bodyHeight: document.documentElement.scrollHeight,
          viewport: innerHeight
        }
      })
      expect(geometry.bodyHeight).equals(geometry.viewport)
      expect(
        geometry.widths.slice(0, 5).every(w => w === geometry.widths[0])
      ).equals(true)
      expect(geometry.widths[0]).closeTo(
        Math.ceil(Math.max(98, geometry.dates) + 16),
        1
      )
      expect(geometry.widths[5]).closeTo(Math.ceil(geometry.pill + 32), 1)
      expect(geometry.widths.at(-1)).closeTo(
        Math.ceil(geometry.conflict + 13),
        1
      )
      expect(geometry.borders.every(w => w === '1px')).equals(true)
      log.push('Compact table geometry ' + JSON.stringify(geometry))
      const ticker = '[data-testid="ticker-text"]'
      await page.waitForFunction(
        selector => {
          const node = document.querySelector(selector)!
          const text = node.querySelector(
            '[data-testid="ticker-text-content"]'
          )!
          return (
            text.getBoundingClientRect().width >
            node.getBoundingClientRect().width
          )
        },
        {},
        ticker
      )
      await page.waitForFunction(
        selector => {
          const transform = getComputedStyle(
            document.querySelector(selector)!.firstElementChild!
          ).transform
          return (
            transform !== 'none' && new DOMMatrixReadOnly(transform).m41 < -2
          )
        },
        {},
        ticker
      )
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ])
      await page.waitForFunction(
        selector => {
          const transform = getComputedStyle(
            document.querySelector(selector)!.firstElementChild!
          ).transform
          return (
            transform === 'none' || new DOMMatrixReadOnly(transform).m41 === 0
          )
        },
        {},
        ticker
      )
      await page.emulateMediaFeatures([
        { name: 'prefers-reduced-motion', value: 'no-preference' }
      ])
      log.push('Overflow label animates and resets for reduced motion.')
    }
    await scrollDown()
    await shot('schedule-scrolled')
    if (!baseline) {
      const sticky = await page.$eval(
        '[data-testid="sticky-season-sections"]',
        n => n.getBoundingClientRect().top
      )
      const header = await page.$eval(
        '[data-testid="umpire-table-header-scroll"]',
        n => n.getBoundingClientRect().top
      )
      expect(sticky).at.least(40).and.below(100)
      expect(header).greaterThan(sticky)
      const handed = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[dir="auto"]'))
          .filter(n => n.textContent === 'Umpire')
          .some(
            n =>
              n.getBoundingClientRect().top >= 0 &&
              n.getBoundingClientRect().bottom < 90
          )
      )
      expect(handed).equals(true)
      log.push(`Sticky stack top ${sticky}; headings top ${header}.`)
    }
    await page.setViewport({ width: 390, height: 844 })
    await open(baseline ? '?view=league' : '')
    if (!baseline) {
      // From Home's Help Umpire row, the way the header's mask used to.
      await m.openBrowser({ url: f.h.origin + '/' })
      await tap(m, 'Umpire Schedule')
    }
    await page.waitForSelector('[data-testid="umpire-game-gam_umpire_g1"]')
    await scrollDown()
    await shot('schedule-narrow')
    if (!baseline) {
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight)
      ).equals(844)
      const align = async (
        source: 'header' | 'body',
        x: number
      ): Promise<void> => {
        await m.evalBrowserScript({
          script: `document.querySelector('[data-testid="umpire-table-${source}-scroll"]').scrollLeft = ${x}`
        })
        await page.waitForFunction(
          x => {
            const header = document.querySelector(
              '[data-testid="umpire-table-header-scroll"]'
            )!
            const body = document.querySelector(
              '[data-testid="umpire-table-body-scroll"]'
            )!
            return body.scrollLeft === x && header.scrollLeft === x
          },
          {},
          x
        )
      }
      expect(new URL(page.url()).searchParams.has('pill')).equals(false)
      await align('body', 350)
      await tap(m, 'Schedule', 'tab')
      await page.waitForFunction(
        () => new URL(location.href).searchParams.get('pill') === 'schedule'
      )
      await align('body', 0)
      await align('body', 350)
      await align('header', 200)
      await align('body', 350)
      await tap(m, 'Leaderboard', 'tab')
      await contains(page, 'COMPLETED GAMES')
      await tap(m, 'Schedule', 'tab')
      await page.waitForSelector('[data-testid="umpire-table-body-scroll"]')
      await align('body', 350)
      await shot('schedule-horizontal-tab')
      await align('body', 400)
      await tap(m, 'Schedule filters')
      await tap(m, 'Prior seasons', 'switch')
      await tap(m, 'Apply filters')
      await page.waitForSelector('[data-testid="umpire-game-gam_layout_prior"]')
      await align('body', 400)
      await shot('schedule-horizontal-filter')
      await align('body', 650)
      await m.tapOn({
        css: '[data-testid="umpire-note-gam_umpire_g1-unt_color"]'
      })
      await m.inputText({
        text: 'Blue',
        css: '[data-testid="umpire-note-input-gam_umpire_g1-unt_color"]'
      })
      await tap(m, 'Schedule filters')
      await tap(m, 'Cancel')
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-testid="umpire-note-gam_umpire_g1-unt_color"]'
          )!.textContent === 'Blue'
      )
      await align('body', 0)
      await shot('schedule-horizontal-note-save')
      log.push(
        'Narrow table aligned at nonzero offsets in both directions, after reselecting the default Schedule tab, tab remount, filter reload, and an inline note save followed by returning to the left edge.'
      )
    }
    await open(baseline ? '?view=league' : '')
    await page.waitForSelector('[data-testid="umpire-game-gam_umpire_g1"]')
    await tap(m, 'Schedule filters')
    await shot('filters')
    if (!baseline) {
      expect(await page.$('[aria-label="Prior seasons"]')).not.equals(null)
      await tap(m, 'Prior seasons', 'switch')
      await tap(m, 'Apply filters')
      await page.waitForSelector('[data-testid="umpire-game-gam_layout_prior"]')
      await tap(m, 'Schedule filters')
      await tap(m, 'Clear filters')
      expect(
        await page.$eval(
          '[aria-label="Prior seasons"]',
          n => (n as HTMLInputElement).checked
        )
      ).equals(false)
      await tap(m, 'Cancel')
      expect(page.url()).contains('priorSeasons=true')
      await tap(m, 'Schedule filters')
      await tap(m, 'Clear filters')
      await tap(m, 'Apply filters')
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-testid="umpire-game-gam_layout_prior"]'
          ) === null
      )
      log.push(
        'Prior seasons applies, Clear retains modal, Cancel preserves route, Apply restores current seasons.'
      )
    } else await tap(m, 'Cancel')
    await page.setViewport({ width: 1440, height: 900 })
    await open(baseline ? '?view=league&pill=leaderboard' : '?pill=leaderboard')
    await contains(page, 'COMPLETED GAMES')
    await shot('leaderboard')
    if (!baseline)
      expect(await page.$('[data-testid="umpire-table-header-scroll"]')).equals(
        null
      )
    const sample = await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-schedule?view=schedule&paged=1`,
        undefined,
        101
      )
    ).json()
    const noGames = {
      ...sample,
      items: [],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      positions: []
    }
    let mode = 'empty'
    let pending: HTTPRequest | undefined
    await page.setRequestInterception(true)
    const intercept = (request: HTTPRequest): void => {
      if (request.url().includes('/umpire-schedule?')) {
        if (mode === 'loading') {
          pending = request
          return
        }
        request
          .respond({
            status: mode === 'error' ? 500 : 200,
            contentType: 'application/json',
            body: JSON.stringify(
              mode === 'error' ? { error: 'Fixture unavailable' } : noGames
            )
          })
          .catch((error: unknown) => {
            console.error(error)
          })
      } else
        request.continue().catch((error: unknown) => {
          console.error(error)
        })
    }
    page.on('request', intercept)
    for (const state of ['empty', 'error', 'loading']) {
      mode = state
      await open(baseline ? '?view=league' : '')
      await contains(
        page,
        state === 'empty'
          ? 'No games match'
          : state === 'error'
            ? 'Schedule unavailable'
            : 'Loading…'
      )
      await shot(state)
    }
    if (pending != null)
      await pending.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(noGames)
      })
    page.off('request', intercept)
    await page.setRequestInterception(false)
    if (!baseline) {
      await login(103)
      await open()
      await page.waitForSelector('[data-testid="umpire-game-gam_umpire_g1"]')
      await tap(m, 'Schedule filters')
      expect(await page.$('[aria-label="Prior seasons"]')).equals(null)
      const response = await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-schedule?view=schedule&priorSeasons=true`,
        undefined,
        103
      )
      expect(response.status).equals(403)
      await tap(m, 'Cancel')
      await mkdir(join(artifacts, 'support'), { recursive: true })
      await recordBrowserCoverage(
        [page],
        f.h.origin,
        join(artifacts, 'support/browser-layout.json')
      )
      log.push(
        'Nonadmin control absent; server rejects crafted widening; loading/error/empty/leaderboard shells checked.'
      )
    }
  } finally {
    await writeFile(
      join(artifacts, baseline ? 'baseline.log' : 'browser.log'),
      log.join('\n') + '\n'
    )
    if (b != null) {
      await writeFile(
        join(artifacts, 'support/last-browser-state.txt'),
        await b.page.evaluate(() => document.body.innerText)
      )
      await b.page.screenshot({
        path: join(artifacts, 'support/last-browser-state.png')
      })
      await b.browser.close()
    }
    await daemon.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
