import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

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
import { exerciseUmpireNotes } from '../../e2e/rigs/umpireNotesBrowser'
import { TeamStationClient } from '../common/api'
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
  const web = join(artifacts, 'support/configurable-web')
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
  const daemon = await maestro('umpireConfigurable')
  const f = await umpireBrowserFixture(web)
  let b: BrowserSession | undefined
  try {
    await readyUmpireBrowser(f)
    const client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    b = await browserSession(
      daemon,
      'umpire-configurable',
      1440,
      900,
      artifacts
    )
    const { page, m, browser } = b
    const login = async (id: number): Promise<void> => {
      await browser.setCookie({
        name: 'ts_session',
        value: f.h.tokens.get(id)!,
        domain: new URL(f.h.origin).hostname,
        path: '/',
        httpOnly: true
      })
    }
    const open = async (path: string, text: string): Promise<void> => {
      await m.openBrowser({ url: f.h.origin + path })
      await contains(page, text)
      await page.evaluate(async () => await document.fonts.ready)
    }
    const base = '/groups/league/' + f.leagueA
    await login(101)
    await open(base + '/settings', 'Manage Umpire Types')
    await page.evaluate(() => {
      document
        .querySelector('[aria-label="Manage Umpire Types"]')!
        .scrollIntoView({ block: 'center' })
    })
    await capture(m, artifacts, 'settings-after.png')
    await tap(m, 'Manage Umpire Types')
    await contains(page, 'Add Type')
    expect(
      await page.$eval(
        'input[placeholder="ie. Plate, Field, 1st, 2nd, 3rd"]',
        n => n.getAttribute('autocapitalize')
      )
    ).equals('words')
    for (const name of ['1st', '2nd', '3rd']) {
      await fill(m, 'Type name', name)
      await tap(m, 'Add Type')
      await page.waitForSelector(`[aria-label="Remove ${name}"]`)
    }
    await capture(m, artifacts, 'catalog-after.png')
    const types = await client.umpireTypes(f.leagueA)
    const first = types.find(t => t.name === '1st')!
    expect(
      (await client.umpireRequirements(f.leagueA))
        .find(s => s.id === f.seasonA)!
        .requirement!.types.find(t => t.typeId === first.id)
    ).deep.equals({ typeId: first.id, required: 1, optional: 0 })
    await tap(m, 'Remove 3rd')
    await contains(page, 'Removing type “3rd”')
    await tap(m, 'Cancel')
    expect(
      (await client.umpireTypes(f.leagueA)).some(t => t.name === '3rd')
    ).equals(true)
    await tap(m, 'Remove 3rd')
    await tap(m, 'Remove type')
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Remove 3rd"]') == null
    )
    await open(base + '/umpire-levels', 'Manage Umpire Levels')
    expect(
      await page.$('input[placeholder="ie. Majors, Minors, AA, AAA"]')
    ).not.equals(null)
    await open(base + '/umpire-requirements', 'Select seasons')
    await tap(m, 'Select Demo Regular', 'checkbox')
    await tap(m, 'Next')
    await contains(page, 'Required 1st')
    await tap(m, 'Optional 1st')
    await new Promise(resolve => setTimeout(resolve, 180))
    await tap(m, 'Optional 1st 1')
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Optional 1st: 1"]') != null,
      { polling: 100 }
    )
    await tap(m, 'Done')
    expect(
      await page.$eval('[aria-label="Optional 1st"]', n => n.textContent)
    ).contains('1')
    await capture(m, artifacts, 'requirements-after.png')
    const applied = page.waitForResponse(
      r =>
        r.request().method() === 'PUT' &&
        r.url().endsWith('/umpire-requirements')
    )
    await tap(m, 'Apply umpire requirements to the below seasons')
    const appliedResponse = await applied
    expect(appliedResponse.status()).equals(200)
    await contains(page, 'Select seasons')
    expect(
      (await client.umpireRequirements(f.leagueA))
        .find(s => s.id === f.seasonA)!
        .requirement!.types.find(t => t.typeId === first.id)!.optional
    ).equals(1)
    await login(101)
    for (const name of ['First Base Umpire', 'X'.repeat(100)])
      await client.addUmpireType(f.leagueA, name)
    await open(base + '/umpires', 'Manage Umpires')
    for (const name of ['First Base Umpire', 'X'.repeat(100)]) {
      const geometry = await page.$eval(`[aria-label="${name}"]`, n => ({
        width: n.getBoundingClientRect().width,
        parent: n.parentElement!.getBoundingClientRect().width,
        height: n.getBoundingClientRect().height,
        whiteSpace: getComputedStyle(n).whiteSpace
      }))
      expect(geometry.width).at.most(geometry.parent)
      expect(geometry.height).lessThan(24)
      expect(geometry.whiteSpace).equals('nowrap')
    }
    await capture(m, artifacts, 'support/long-type-labels.png')
    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 844 })
      await open(base + '/umpire-types', 'Manage Umpire Types')
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).equals(true)
      await capture(m, artifacts, `support/types-${width}.png`)
    }
    await page.setViewport({ width: 1440, height: 900 })
    await open(base + '/umpires', 'Manage Umpires')
    await tap(m, 'Uma L, majors, 1st')
    const saving = page.waitForResponse(
      r => r.request().method() === 'PUT' && r.url().endsWith('/umpires')
    )
    await tap(m, 'Save')
    const saved = await saving
    expect(saved.status(), await saved.text()).equals(200)
    await page.waitForFunction(
      () => {
        const button = document.querySelector('[aria-label="Save"]')
        if (button == null) return false
        return (
          button.getAttribute('aria-busy') === 'false' &&
          button.getAttribute('aria-disabled') === 'true'
        )
      },
      { polling: 100 }
    )
    await capture(m, artifacts, 'management-after.png')
    await open(base + '/umpire-note-types', 'Create Per-Game Umpire Notes')
    for (const name of ['Jersey Color', 'Venue Contact']) {
      await fill(m, 'Notes Type name', name)
      await tap(m, 'Add Notes Type')
      await page.waitForSelector(`[aria-label="Remove ${name}"]`)
    }
    const noteTypes = await client.umpireNoteTypes(f.leagueA)
    const color = noteTypes[0]
    await client.saveUmpireNote('gam_umpire_g1', color.id, '', 'Blue')
    await open(base + '/umpire-note-types', 'Jersey Color')
    await tap(m, 'Remove Jersey Color')
    await contains(page, 'clears its notes from every game')
    await tap(m, 'Cancel')
    await capture(m, artifacts, 'notes-catalog.png')
    expect(
      (await client.umpireSchedule(f.leagueA, 'view=league')).games.find(
        g => g.id === 'gam_umpire_g1'
      )!.umpireNotes[color.id]
    ).equals('Blue')
    await exerciseUmpireNotes(f, client, page, m, artifacts)
    await login(103)
    await open('/umpires/' + f.leagueA, 'Sign Up')
    expect(await page.$('[data-testid^="umpire-note-"]')).equals(null)
    await contains(page, 'Gate A')
    await m.tapOn({ css: '[aria-label^="Sign Up, 1st 1,"]' })
    await contains(page, 'Confirm')
    await capture(m, artifacts, 'signup-after.png')
    await tap(m, 'Confirm')
    await page.waitForSelector(`[aria-label="Uma L, ${first.id}:1"]`)
    await open('/games/gam_umpire_g1', 'UMPIRES')
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="game-umpires"]')!
        .scrollIntoView({ block: 'center' })
    })
    await capture(m, artifacts, 'game-detail-after.png')
    expect(
      (await client.umpireLeaderboard(f.leagueA)).scheduled.find(
        p => p.userId === userIdOfGumbo(103)
      )?.count
    ).equals(1)
    await recordBrowserCoverage(
      [page],
      f.h.origin,
      join(artifacts, 'coverage/browser-configurable.json'),
      web
    )
    console.log(
      'B1–B4 configurable types, counts, certification, signup, game detail and spreadsheet notes passed'
    )
  } finally {
    if (b != null) {
      await b.browser.close().catch(() => undefined)
      await b.m.detach().catch(() => undefined)
    }
    await f.h.close()
    await daemon.shutdown()
  }
}
main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
