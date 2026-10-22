import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { userIdOfGumbo } from '../common/userId'
import {
  type BrowserSession,
  browserSession,
  capture,
  contains,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import {
  readyUmpireBrowser,
  UMPIRE_BROWSER_NOW,
  umpireBrowserFixture
} from '../test/umpireBrowserFixture'
import { recordBrowserCoverage } from './browserCoverage.e2e'

async function main(): Promise<void> {
  const artifacts = process.env.TS_UMPIRE_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_UMPIRE_ARTIFACTS')
  process.env.TS_UMPIRE_NOW = UMPIRE_BROWSER_NOW
  const web = join(artifacts, 'support/refinements-web')
  await mkdir(web, { recursive: true })
  await cp(resolve('dist'), web, { recursive: true })
  const f = await umpireBrowserFixture(web)
  const daemon = await maestro('umpire3Refinements')
  let b: BrowserSession | undefined
  try {
    await readyUmpireBrowser(f)
    await f.h.db
      .insertInto('umpire_certifications')
      .values({
        user_id: userIdOfGumbo(103),
        level_id: 'ulv_browser_majors',
        type_id: 'uty_field',
        enabled: true
      })
      .execute()
    b = await browserSession(daemon, 'umpire3-refinements', 390, 844, artifacts)
    const { page, m, browser } = b
    const instant = Date.parse(UMPIRE_BROWSER_NOW)
    await page.evaluateOnNewDocument(now => {
      window.Date = new Proxy(Date, {
        construct(target, args) {
          return Reflect.construct(target, args.length === 0 ? [now] : args)
        },
        get(target, key) {
          return key === 'now' ? () => now : Reflect.get(target, key)
        }
      })
    }, instant)
    const open = async (path: string): Promise<void> => {
      await m.openBrowser({ url: f.h.origin + path })
    }
    const login = async (id: number): Promise<void> => {
      await browser.setCookie({
        name: 'ts_session',
        value: f.h.tokens.get(id)!,
        domain: new URL(f.h.origin).hostname,
        path: '/',
        httpOnly: true
      })
    }
    const base = `/groups/league/${f.leagueA}`
    await login(101)
    await open(base + '/umpire-requirements')
    await page.waitForSelector('[aria-label="Select Demo Regular"]')
    await tap(m, 'Select Demo Regular', 'checkbox')
    await tap(m, 'Next')
    await contains(page, 'Optional Field')
    const optional = '[aria-label="Optional Field"]'
    expect(await page.$eval(optional, n => n.textContent)).contains('0')
    await tap(m, 'Required Plate')
    await tap(m, 'Required Plate 0')
    await tap(m, 'Done')
    await tap(m, 'Required Field')
    await tap(m, 'Required Field 0')
    await tap(m, 'Done')
    await tap(m, 'Optional Field')
    await tap(m, 'Optional Field 2')
    await tap(m, 'Done')
    const action =
      '[aria-label="Apply umpire requirements to the below seasons"]'
    for (const width of [390, 320]) {
      await page.setViewport(null)
      await page.setViewport({ width, height: 844 })
      const geometry = await page.$eval(action, n => ({
        width: n.getBoundingClientRect().width,
        parent: n.parentElement!.getBoundingClientRect().width,
        text: n.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth
      }))
      expect(geometry.width).at.most(geometry.parent)
      expect(geometry.overflow).equals(false)
      expect(geometry.text).equals(
        'Apply umpire requirements to the below seasons'
      )
    }
    const applied = page.waitForResponse(
      r =>
        r.request().method() === 'PUT' &&
        r.url().endsWith('/umpire-requirements')
    )
    await tap(m, 'Apply umpire requirements to the below seasons')
    expect((await applied).status()).equals(200)
    await contains(page, 'Select seasons to apply umpire needs.')
    const requirement = await f.h.db
      .selectFrom('season_umpire_type_requirements')
      .selectAll()
      .where('type_id', '=', 'uty_field')
      .where('season_id', '=', f.seasonA)
      .executeTakeFirstOrThrow()
    expect(requirement).includes({
      required_count: 0,
      optional_count: 2
    })
    await login(103)
    await open(`/umpires/${f.leagueA}`)
    await page.waitForSelector('[aria-label^="Sign Up, Field"]')
    await m.tapOn({ css: '[aria-label^="Sign Up, Field"]' })
    await contains(page, 'Field 1 (optional)')
    await tap(m, 'Confirm')
    await page.waitForSelector('[aria-label="Uma L, uty_field:1"]')
    await open(`/umpires/${f.leagueA}?levels=ulv_browser_majors`)
    await contains(page, 'No games match this schedule.')
    await open('/games/gam_umpire_g1')
    await contains(page, 'Field 1 (optional): Uma L')
    await contains(page, 'Field 2 (optional)')
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="game-umpires"]')!
        .scrollIntoView({ block: 'center' })
    })
    await capture(m, artifacts, 'support/optional-game-info.png')
    await page.setViewport({ width: 1440, height: 900 })
    await open(`/umpires/${f.leagueA}`)
    await page.waitForSelector('[aria-label="Uma L, uty_field:1"]')
    expect(
      await page.$eval('[aria-label="Uma L, uty_field:1"]', n => n.textContent)
    ).contains('Demo Hawks')
    for (const [name, id] of [
      ['Demo Hawks', f.teamA],
      ['Demo Eagles', f.teamB]
    ]) {
      await tap(m, `Open ${name}`, 'link')
      await page.waitForFunction(
        expected => location.pathname === expected,
        {},
        `/teams/${id}`
      )
      await contains(page, name)
      await m.command('back')
      await page.waitForSelector('[aria-label="Uma L, uty_field:1"]')
    }
    await page.evaluate(() => {
      window.open = url => {
        ;(window as unknown as { capturedMap: string }).capturedMap =
          String(url)
        return null
      }
    })
    await tap(m, 'Map of Field 1', 'link')
    expect(
      await page.evaluate(
        () => (window as unknown as { capturedMap: string }).capturedMap
      )
    ).equals('https://www.google.com/maps/dir/?api=1&destination=Field%201')
    await m.tapOn({ css: '[aria-label^="Open game "]' })
    await page.waitForFunction(
      () => location.pathname === '/games/gam_umpire_g1'
    )
    await contains(page, 'Field 1 (optional): Uma L')
    await m.command('back')
    await page.waitForSelector('[aria-label="Uma L, uty_field:1"]')
    await tap(m, 'Leaderboard', 'tab')
    await page.waitForSelector('[aria-label="Gold trophy"]')
    const ranks = await page.$$eval('[aria-label="Gold trophy"]', nodes =>
      nodes.map(n => ({
        icon: n.getBoundingClientRect().x,
        words: n.nextElementSibling!.getBoundingClientRect().x
      }))
    )
    expect(ranks.length).at.least(2)
    expect(ranks.every(r => r.icon < r.words)).equals(true)
    console.log(
      'Assignment affiliations, home/away/game navigation and Back, Google Maps destination and leading rank icons passed.'
    )
    await login(101)
    await open(base + '/umpires')
    await page.waitForSelector('[data-testid="umpire-management-table"]')
    for (const width of [1440, 390]) {
      await page.setViewport(null)
      await page.setViewport({ width, height: 900 })
      await page.waitForFunction(
        expected => {
          const table = document.querySelector(
            '[data-testid="umpire-management-table"]'
          )!
          const row = table.querySelector(
            '[data-testid="umpire-certification-circle"]'
          )!
          return (
            row != null &&
            (expected < 500 || table.scrollWidth <= table.clientWidth + 1)
          )
        },
        {},
        width
      )
      const geometry = await page.evaluate(() => {
        const table = document.querySelector(
          '[data-testid="umpire-management-table"]'
        )!
        const circle = table.querySelector(
          '[data-testid="umpire-certification-circle"]'
        )!
        const target = circle.parentElement!
        const caption = target.nextElementSibling!
        const c = circle.getBoundingClientRect()
        const t = target.getBoundingClientRect()
        const l = caption.getBoundingClientRect()
        const viewport = table.querySelector('[data-testid$="-viewport"]')!
        const text = viewport.querySelector(
          '[data-testid^="umpire-affiliation-"]:not([data-testid$="-motion"])'
        )!
        return {
          circle: c.width,
          target: t.width,
          targetHeight: t.height,
          center: Math.abs(t.x + t.width / 2 - l.x - l.width / 2),
          innerCircle: circle.textContent!.includes('○'),
          width: table.clientWidth,
          scroll: table.scrollWidth,
          affiliationFits:
            text.getBoundingClientRect().width <=
            viewport.getBoundingClientRect().width
        }
      })
      expect(geometry.circle).equals(30)
      expect(geometry.target).equals(48)
      expect(geometry.targetHeight).equals(48)
      expect(geometry.center).lessThan(1)
      expect(geometry.innerCircle).equals(false)
      if (width === 1440) {
        expect(geometry.scroll).at.most(geometry.width + 1)
        expect(geometry.affiliationFits).equals(true)
      } else expect(geometry.scroll).greaterThan(geometry.width)
      console.log('Manage Umpires geometry', width, geometry)
    }
    await page.setViewport(null)
    await page.setViewport({ width: 1440, height: 900 })
    const control = '[aria-label="Uma L, majors, Plate"]'
    const before = await page.$eval(control, n =>
      n.getAttribute('aria-pressed')
    )
    const point = await page.$eval(control, n => {
      const r = n.getBoundingClientRect()
      return { x: r.x + 2, y: r.y + 2 }
    })
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(
      (selector, old) =>
        document.querySelector(selector)!.getAttribute('aria-pressed') !== old,
      {},
      control,
      before
    )
    await tap(m, 'Save')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Save"]')!
          .getAttribute('aria-disabled') === 'true' &&
        document
          .querySelector('[aria-label="Save"]')!
          .getAttribute('aria-busy') !== 'true'
    )
    console.log(
      'Certification responds outside its visible circle within the retained 48px target.'
    )
    await recordBrowserCoverage(
      [page],
      f.h.origin,
      join(artifacts, 'support/browser-refinements.json'),
      web
    )
    console.log(
      'Four settings rows, optional default, long action fit at320/390, persistence, optional signup, needs filter and game info passed.'
    )
  } finally {
    if (b != null) {
      await b.browser.close().catch(() => undefined)
      await b.m.detach().catch(() => undefined)
    }
    await daemon.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
