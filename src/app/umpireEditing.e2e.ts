import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { KeyInput } from 'puppeteer'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import {
  type BrowserSession,
  browserSession,
  capture,
  contains,
  fill,
  maestro,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import { userIdOfGumbo } from '../common/userId'
import {
  readyUmpireBrowser,
  UMPIRE_BROWSER_NOW,
  umpireBrowserFixture
} from '../test/umpireBrowserFixture'

async function main(): Promise<void> {
  const artifacts = process.env.TS_UMPIRE_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_UMPIRE_ARTIFACTS')
  process.env.TS_UMPIRE_NOW = UMPIRE_BROWSER_NOW
  const web = join(artifacts, 'support/editing-web')
  await mkdir(web, { recursive: true })
  await cp(resolve('dist'), web, { recursive: true })
  const instant = Date.parse(UMPIRE_BROWSER_NOW)
  await writeFile(
    join(web, 'index.html'),
    (await readFile(join(web, 'index.html'), 'utf8')).replace(
      '<head>',
      `<head><script>window.Date=new Proxy(Date,{construct(t,a){return Reflect.construct(t,a.length?a:[${instant}])},get(t,p){return p==='now'?()=>${instant}:Reflect.get(t,p)}})</script>`
    )
  )
  const daemon = await maestro('umpireEditing')
  const f = await umpireBrowserFixture(web)
  let b: BrowserSession | undefined
  try {
    await readyUmpireBrowser(f)
    for (const id of [101, 104])
      await f.h.db
        .insertInto('league_umpires')
        .values({
          league_id: f.leagueA,
          user_id: userIdOfGumbo(id),
          granted_by: userIdOfGumbo(101)
        })
        .execute()
    for (const [id, name, position] of [
      ['ulv_aa', 'AA', 1],
      ['ulv_aaa', 'AAA', 2]
    ] as const)
      await f.h.db
        .insertInto('umpire_levels')
        .values({ id, name, position, league_id: f.leagueA })
        .execute()
    await f.h.db
      .updateTable('season_umpire_type_requirements')
      .set({ optional_count: 1 })
      .where('type_id', '=', 'uty_field')
      .where('season_id', '=', f.seasonA)
      .execute()
    b = await browserSession(daemon, 'umpire-editing', 1440, 900, artifacts)
    const { page, m, browser } = b
    await browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(101)!,
      domain: new URL(f.h.origin).hostname,
      path: '/',
      httpOnly: true
    })
    const base = `/groups/league/${f.leagueA}/umpires`
    const open = async (path: string, text: string): Promise<void> => {
      await m.openBrowser({ url: f.h.origin + path })
      await contains(page, text)
      await page.evaluate(async () => await document.fonts.ready)
    }
    const checked = async (): Promise<string[]> =>
      await page.$$eval('[role="checkbox"][aria-checked="true"]', ns =>
        ns.map(n => n.getAttribute('aria-label')!)
      )
    const click = async (name: string, modifier?: KeyInput): Promise<void> => {
      if (modifier != null) await page.keyboard.down(modifier)
      try {
        // Maestro's independent input channel cannot retain Puppeteer's modifier state.
        if (modifier != null) await page.click(`[aria-label="Select ${name}"]`)
        else await m.tapOn({ css: `[aria-label="Select ${name}"]` })
      } finally {
        if (modifier != null) await page.keyboard.up(modifier)
      }
    }
    const saved = async (): Promise<void> => {
      const response = page.waitForResponse(
        r =>
          r.request().method() === 'PUT' &&
          r.url().endsWith(`/leagues/${f.leagueA}/umpires`)
      )
      await tap(m, 'Save')
      expect((await response).status()).equals(200)
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Save"]')!
            .getAttribute('aria-disabled') === 'true' &&
          document
            .querySelector('[aria-label="Save"]')!
            .getAttribute('aria-busy') !== 'true'
      )
    }
    await open(base, 'Select rows')
    for (const name of ['Ada L', 'Billy L', 'Uma L']) await click(name)
    expect(await checked()).length(3)
    for (const name of ['Ada L', 'Billy L', 'Uma L']) await click(name)
    expect(await checked()).length(0)
    await click('Ada L')
    await click('Uma L', 'Shift')
    expect(await checked()).length(3)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await click('Billy L', modifier)
    expect(await checked()).deep.equals(['Select Ada L', 'Select Uma L'])
    await click('Ada L', modifier)
    expect(await checked()).deep.equals(['Select Uma L'])
    await click('Billy L', 'Shift')
    expect(await checked()).deep.equals(['Select Ada L', 'Select Billy L'])
    await click('Ada L')
    await click('Billy L')
    await page.focus('[aria-label="Select Uma L"]')
    await page.keyboard.press('Space')
    expect(await checked()).deep.equals(['Select Uma L'])
    await page.keyboard.press('Space')
    expect(await checked()).length(0)
    await click('Ada L')
    await page.focus('[aria-label="Select Uma L"]')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Shift')
    expect(await checked()).deep.equals([
      'Select Ada L',
      'Select Billy L',
      'Select Uma L'
    ])
    for (const name of ['Ada L', 'Billy L', 'Uma L']) await click(name)
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1
    })
    const point = await page.$eval('[aria-label="Select Ada L"]', n => {
      const r = n.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    const drag = async (offsets: number[], start = point): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [start]
      })
      for (const y of offsets)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...start, y: start.y + y }]
        })
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      })
    }
    await drag([160])
    expect(await checked()).length(3)
    await click('Billy L')
    expect(await checked()).deep.equals(['Select Ada L', 'Select Uma L'])
    await click('Ada L')
    await click('Uma L')
    await drag([160, 80])
    expect(await checked()).deep.equals(['Select Ada L', 'Select Billy L'])
    await click('Ada L')
    await click('Billy L')
    await drag([113], { ...point, y: point.y + 23 })
    expect(await checked()).length(3)
    for (const name of ['Ada L', 'Billy L', 'Uma L']) await click(name)
    await drag([-113], { ...point, y: point.y + 136 })
    expect(await checked()).length(3)
    for (const name of ['Ada L', 'Billy L', 'Uma L']) await click(name)
    await drag([])
    expect(await checked()).deep.equals(['Select Ada L'])
    await click('Ada L')
    expect(
      await page.$eval('[aria-label="Save"]', n =>
        n.getAttribute('aria-disabled')
      )
    ).equals('true')
    await tap(m, 'Ada L, AA, Plate')
    await tap(m, 'Ada L, AA, Plate')
    expect(
      await page.$eval('[aria-label="Save"]', n =>
        n.getAttribute('aria-disabled')
      )
    ).equals('true')
    await tap(m, 'Ada L, AA, Plate')
    await capture(m, artifacts, 'management-after.png')
    let fail = true
    await page.setRequestInterception(true)
    page.on('request', request => {
      const respond = async (): Promise<void> => {
        if (
          request.method() === 'PUT' &&
          request.url().endsWith(`/leagues/${f.leagueA}/umpires`) &&
          fail
        ) {
          fail = false
          await request.respond({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'internal',
              message: 'Simulated save failure'
            })
          })
        } else await request.continue()
      }
      respond().catch((error: unknown) => {
        console.error(error)
      })
    })
    await tap(m, 'Save')
    await contains(page, 'Simulated save failure')
    expect(
      await page.$eval('[aria-label="Ada L, AA, Plate"]', n =>
        n.getAttribute('aria-pressed')
      )
    ).equals('true')
    await saved()
    await open(base, 'Select rows')
    expect(
      await page.$eval('[aria-label="Ada L, AA, Plate"]', n =>
        n.getAttribute('aria-pressed')
      )
    ).equals('true')
    await click('Ada L')
    await click('Uma L', 'Shift')
    await tap(m, 'Ada L, AAA, Field')
    await saved()
    expect(
      await f.h.db
        .selectFrom('umpire_certifications')
        .selectAll()
        .where('level_id', '=', 'ulv_aaa')
        .where('type_id', '=', 'uty_field')
        .where('enabled', '=', true)
        .execute()
    ).length(3)
    await click('Ada L')
    await click('Billy L')
    await click('Uma L')
    await tap(m, 'Ada L, AA, Field')
    await f.h.db
      .updateTable('umpire_certifications')
      .set({ enabled: false })
      .where('type_id', '=', 'uty_plate')
      .where('user_id', '=', userIdOfGumbo(101))
      .where('level_id', '=', 'ulv_aa')
      .execute()
    await tap(m, 'Save')
    await contains(page, 'changed')
    await tap(m, 'Reload saved settings')
    await tap(m, 'Discard and reload')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Save"]')!
          .getAttribute('aria-disabled') === 'true' &&
        document
          .querySelector('[aria-label="Save"]')!
          .getAttribute('aria-busy') !== 'true'
    )
    await fill(m, 'Search affiliated people', 'Bobby')
    await tap(m, 'Bobby L')
    await m.tapOn({ css: '[aria-label="Open profile for Bobby L"]' })
    await tap(m, 'Cancel')
    expect(page.url()).contains('/umpires')
    await m.tapOn({ css: '[aria-label="Open profile for Bobby L"]' })
    await tap(m, 'Save and open profile')
    await page.waitForFunction(() => location.pathname.includes('/people/'))
    await contains(page, 'Bobby')
    await open(base, 'Select rows')
    await click('Bobby L')
    await m.tapOn({ css: '[aria-label="Revoke Bobby L"]' })
    await tap(m, 'Revoke umpire')
    await click('Uma L', 'Shift')
    expect(await checked()).deep.equals(['Select Uma L'])
    await saved()
    expect(
      await f.h.db
        .selectFrom('league_umpires')
        .selectAll()
        .where('league_id', '=', f.leagueA)
        .where('user_id', '=', userIdOfGumbo(106))
        .execute()
    ).length(0)
    await f.h.db
      .deleteFrom('memberships')
      .where('user_id', '=', userIdOfGumbo(104))
      .execute()
    await f.h.db
      .deleteFrom('user_links')
      .where('related_user_id', '=', userIdOfGumbo(104))
      .execute()
    await open(base, 'Select rows')
    await m.tapOn({ css: '[aria-label="Open profile for Billy L"]' })
    await page.waitForFunction(() => location.pathname.includes('/people/'))
    await contains(page, 'Billy')
    console.log(
      'Selection, draft saves, failures, conflicts and profiles passed.'
    )
    await writeFile(
      join(artifacts, 'editing.log'),
      '$ node -r sucrase/register src/app/umpireEditing.e2e.ts\nPASS: click/Shift/modifier/keyboard, touch tap/drag/reverse/hybrid mouse, clean/reverted Save, failed save retry, persistence, bulk save, conflict recovery, added-person save/profile, revoke.\n'
    )
    await open(`/umpires/${f.leagueA}?view=league`, 'Field 2')
    expect(
      await page.$$eval('[data-testid^="umpire-game-"]', ns =>
        ns.some(n => n.textContent!.includes('Optional'))
      )
    ).equals(false)
    await tap(m, 'Schedule filters')
    for (const day of ['Monday', 'Wednesday', 'Friday', 'Saturday'])
      await tap(m, day)
    await tap(m, 'Start time')
    await tap(m, 'Use time')
    await tap(m, 'End time')
    await tap(m, 'Hour 06')
    await tap(m, 'Use time')
    await tap(m, 'Apply filters')
    await contains(page, 'Filter · MWFS')
    await capture(m, artifacts, 'schedule-after.png')
    for (const width of [390, 320]) {
      await page.setViewport(null)
      await page.setViewport({ width, height: 844 })
      await tap(m, 'Schedule filters')
      await tap(m, 'Start time')
      const geometry = await page.evaluate(() => {
        const a = document
          .querySelector('[data-testid="umpire-filter-times"]')!
          .getBoundingClientRect()
        const b = document
          .querySelector('[data-testid="umpire-filter-time-picker"]')!
          .getBoundingClientRect()
        return {
          bottom: a.bottom,
          top: b.top,
          right: b.right,
          width: innerWidth
        }
      })
      expect(geometry.top - geometry.bottom).within(0, 24)
      expect(geometry.right).at.most(geometry.width)
      if (width === 390) await capture(m, artifacts, 'filters-after.png')
      await tap(m, 'Cancel time picker')
      await tap(m, 'Clear filters')
      expect(await page.$('[aria-label="Start time"]')).not.equals(null)
      expect(page.url()).contains('days=')
      await tap(m, 'Cancel')
      expect(page.url()).contains('days=')
    }
    await tap(m, 'Schedule filters')
    await tap(m, 'Clear filters')
    await tap(m, 'Apply filters')
    await page.waitForFunction(() => !location.search.includes('days='))
    await writeFile(
      join(artifacts, 'filters.log'),
      '$ node -r sucrase/register src/app/umpireEditing.e2e.ts\nPASS: optional headers, filter summary, time picker at390/320, Cancel retains applied route, Clear stays open, Clear plus Apply removes filters.\n'
    )
    await f.h.db
      .updateTable('umpire_levels')
      .set({ name: 'Advanced championship certification' })
      .where('id', '=', 'ulv_aaa')
      .execute()
    await open(
      `/umpires/${f.leagueA}?view=league&days=0,1,2,3,4,5,6&from=09:00&to=18:00&levels=ulv_browser_majors,ulv_aa,ulv_aaa`,
      'Advanced championship certification'
    )
    for (const width of [390, 320]) {
      await page.setViewport(null)
      await page.setViewport({ width, height: 844 })
      await page.waitForFunction(expected => innerWidth === expected, {}, width)
      const bounds = await page.$eval(
        '[aria-label="Schedule filters"]',
        node => {
          const pill = node.getBoundingClientRect()
          const label = node.lastElementChild!
          return {
            left: pill.left,
            right: pill.right,
            viewport: innerWidth,
            overflow: getComputedStyle(label).textOverflow
          }
        }
      )
      expect(bounds.left).at.least(0)
      expect(bounds.right).at.most(bounds.viewport)
      expect(bounds.overflow).equals('ellipsis')
      await capture(m, artifacts, `support/filter-summary-${width}.png`)
      await tap(m, 'Schedule filters')
      expect(
        await page.$eval(
          '[aria-label="Advanced championship certification"]',
          node => node.getAttribute('aria-pressed')
        )
      ).equals('true')
      await tap(m, 'Cancel')
    }
    await recordBrowserCoverage(
      [page],
      f.h.origin,
      join(artifacts, 'support/browser-editing.json'),
      web
    )
    console.log('Umpire editing and filtering browser scenarios passed.')
  } finally {
    if (b != null) {
      await b.browser.close().catch(() => undefined)
      await b.m.detach().catch(() => undefined)
    }
    await f.h.close()
    await daemon.shutdown()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
