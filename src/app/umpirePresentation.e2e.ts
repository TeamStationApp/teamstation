import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  const baseline = process.env.TS_UMPIRE_BASELINE === '1'
  const suffix = baseline ? 'before' : 'after'
  const web = join(
    artifacts,
    baseline ? 'support/baseline-web' : 'support/presentation-web'
  )
  await mkdir(web, { recursive: true })
  if (!baseline) await cp(resolve('dist'), web, { recursive: true })
  process.env.TS_UMPIRE_NOW = UMPIRE_BROWSER_NOW
  const instant = Date.parse(UMPIRE_BROWSER_NOW)
  if (!baseline)
    await writeFile(
      join(web, 'index.html'),
      (await readFile(join(web, 'index.html'), 'utf8')).replace(
        '<head>',
        `<head><script>window.Date=new Proxy(Date,{construct(t,a){return Reflect.construct(t,a.length?a:[${instant}])},get(t,p){return p==='now'?()=>${instant}:Reflect.get(t,p)}})</script>`
      )
    )
  const f = await umpireBrowserFixture(web)
  const daemon = await maestro('umpireManagement6')
  let b: BrowserSession | undefined
  try {
    await readyUmpireBrowser(f)
    await f.h.db
      .updateTable('games')
      .set({ timezone: 'UTC' })
      .where('id', '=', 'gam_umpire_g1')
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: userIdOfGumbo(101),
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    await f.h.db
      .insertInto('umpire_note_types')
      .values({
        id: 'unt_demo_color',
        league_id: f.leagueA,
        name: 'Jersey Color',
        position: 0
      })
      .execute()
    const assign = async (): Promise<void> => {
      await f.h.db
        .insertInto('umpire_assignments')
        .values({
          game_id: 'gam_umpire_g1',
          slot: 'uty_plate:1',
          user_id: userIdOfGumbo(103),
          assigned_by: userIdOfGumbo(101)
        })
        .execute()
    }
    await assign()
    b = await browserSession(
      daemon,
      'umpire-presentation',
      1440,
      900,
      artifacts
    )
    await b.page.emulateTimezone('America/Los_Angeles')
    const login = async (id: number): Promise<void> => {
      await b!.browser.setCookie({
        name: 'ts_session',
        value: f.h.tokens.get(id)!,
        domain: new URL(f.h.origin).hostname,
        path: '/',
        httpOnly: true
      })
    }
    const open = async (path: string, text: string): Promise<void> => {
      await b!.m.openBrowser({ url: f.h.origin + path })
      await contains(b!.page, text)
      await b!.page.evaluate(async () => await document.fonts.ready)
    }
    const shot = async (name: string): Promise<void> => {
      await capture(b!.m, artifacts, `${name}-${suffix}.png`)
    }
    const base = '/groups/league/' + f.leagueA
    const schedule = '/umpires/' + f.leagueA
    const geometry = async (): Promise<void> => {
      const row = await b!.page.$eval(
        '[data-testid="umpire-game-gam_umpire_g1"]',
        el => ({
          height: el.getBoundingClientRect().height,
          text: el.textContent
        })
      )
      if (baseline)
        await writeFile(
          join(artifacts, 'baseline-geometry.json'),
          JSON.stringify(row)
        )
      else {
        const before = JSON.parse(
          await readFile(join(artifacts, 'baseline-geometry.json'), 'utf8')
        )
        expect(row.height / before.height).within(0.65, 0.85)
        expect(row.text).contains('Apr 3').and.contains('5:00 pm')
        const targets = await b!.page.$$eval(
          '[aria-label="Conflict"], [aria-label^="Sign Up,"]',
          els =>
            els.map(el => ({
              target: el.getBoundingClientRect().height,
              shell: el.firstElementChild!.getBoundingClientRect().height
            }))
        )
        for (const target of targets) {
          expect(target.target).at.least(48)
          expect(target.shell).equals(24)
        }
        const headers = await b!.page.$eval(
          '[data-testid="umpire-table-header"]',
          el => [...el.children].map(cell => cell.textContent)
        )
        expect(headers.at(-1)).equals('Conflicts')
        expect(headers.at(-2)).equals('Jersey Color')
        const tabs = await b!.page.$$eval(
          '[aria-label="Umpire pages"] [role="tab"], [aria-label="Schedule view"] [role="tab"]',
          els =>
            els.map(el => ({
              target: el.getBoundingClientRect().height,
              shell: el.firstElementChild!.getBoundingClientRect().height
            }))
        )
        expect(tabs).length(4)
        for (const tab of tabs) {
          expect(tab.target).at.least(48)
          expect(tab.shell).equals(36)
        }
        console.log(
          'B1 compact geometry',
          JSON.stringify({ before: before.height, after: row.height, targets })
        )
      }
    }
    const alignment = async (): Promise<void> => {
      if (baseline) return
      const bounds = await b!.page.evaluate(() => {
        const name = [...document.querySelectorAll('div')].find(
          el => el.textContent === 'Demo Regular' && el.children.length === 0
        )!
        const text = name.parentElement!
        const badges = [
          ...text.querySelectorAll('[data-testid="settings-pill-badge"]')
        ]
        return {
          title: name.getBoundingClientRect().x,
          badges: badges.map(el => el.getBoundingClientRect().x),
          width: document.documentElement.scrollWidth,
          viewport: innerWidth
        }
      })
      expect(bounds.badges.length).greaterThan(0)
      expect(bounds.badges[0]).equals(bounds.title)
      expect(bounds.badges.every(x => x >= bounds.title)).equals(true)
      expect(bounds.width).at.most(bounds.viewport)
    }
    await login(101)
    await open(schedule + '?view=league', 'Sign Up')
    await shot('schedule')
    await geometry()
    if (!baseline) {
      await tap(b.m, 'Umpire view', 'tab')
      await contains(b.page, 'No games match this schedule.')
      await tap(b.m, 'League view', 'tab')
      await contains(b.page, 'Sign Up')
      await tap(b.m, 'Leaderboard', 'tab')
      await contains(b.page, 'COMPLETED GAMES')
      await tap(b.m, 'Schedule', 'tab')
      await contains(b.page, 'Sign Up')
    }
    for (const [name, path, text] of [
      ['requirements', base + '/umpire-requirements', 'Select seasons'],
      [
        'requirements-edit',
        base + '/umpire-requirements/edit?seasons=' + f.seasonA,
        'Apply umpire requirements'
      ]
    ]) {
      await open(path, text)
      await alignment()
      await shot(name)
    }
    if (!baseline) {
      await open(base + '/umpire-requirements', 'Select seasons')
      await tap(b.m, 'Select Demo Regular', 'checkbox')
      await tap(b.m, 'Next')
      await contains(b.page, 'Required Plate')
      await tap(b.m, 'Optional Field')
      await tap(b.m, 'Optional Field 1')
      await tap(b.m, 'Done')
      await tap(b.m, 'Apply umpire requirements to the below seasons')
      await contains(b.page, 'Select seasons')
      await open(base + '/umpire-requirements', 'Field: 1 required, 1 optional')
      // Restore the fixture so paired captures and subsequent signup have identical requirements.
      await f.h.db
        .updateTable('season_umpire_type_requirements')
        .set({ optional_count: 0 })
        .where('season_id', '=', f.seasonA)
        .execute()
      console.log('B2 selection, count picker, apply and reload passed')
    }
    await login(103)
    await open(schedule, 'Sign Up')
    await shot('schedule-umpire')
    await tap(b.m, 'Conflict')
    await contains(b.page, 'playing')
    await shot('conflicts')
    if (!baseline)
      expect(await b.page.evaluate(() => document.body.textContent)).contains(
        'Apr 3'
      )
    await tap(b.m, 'Cancel')
    await b.m.tapOn({ css: '[aria-label^="Sign Up,"]' })
    await contains(b.page, 'Confirm')
    await shot('signup')
    await tap(b.m, 'Cancel')
    if (!baseline) {
      await tap(b.m, 'Schedule filters')
      await tap(b.m, 'Saturday')
      await tap(b.m, 'Start time')
      await tap(b.m, 'Use time')
      await tap(b.m, 'End time')
      await tap(b.m, 'Use time')
      await tap(b.m, 'Apply filters')
      await contains(b.page, '5:00 pm')
      expect(
        await b.page.$('[data-testid="umpire-game-gam_umpire_g1"]')
      ).not.equals(null)
      await b.m.tapOn({ css: '[aria-label="Schedule filters"]' })
      await tap(b.m, 'Clear filters')
      await contains(b.page, 'Apply filters')
      await tap(b.m, 'Apply filters')
      // Real signup, rather than trusting a seeded assignment alone.
      await f.h.db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', 'gam_umpire_g1')
        .execute()
      await open(schedule, 'Sign Up')
      await b.m.tapOn({ css: '[aria-label^="Sign Up, Plate,"]' })
      await contains(b.page, 'Confirm')
      await tap(b.m, 'Confirm')
      await contains(b.page, 'Uma L')
    }
    await open('/games/gam_umpire_g1?tab=info', 'UMPIRES')
    await b.page.evaluate(() => {
      document
        .querySelector('[data-testid="game-umpires"]')!
        .scrollIntoView({ block: 'center' })
    })
    await shot('attendance')
    if (!baseline) {
      const groups = await b.page.$$eval(
        '[data-testid="game-umpires"], [data-testid^="attendance-"]',
        els => els.map(el => el.getAttribute('data-testid'))
      )
      expect(groups[0]).equals('game-umpires')
      expect(
        await b.page.$eval('[data-testid="game-umpires"]', el => el.textContent)
      )
        .contains('Uma L')
        .and.contains('Plate')
        .and.not.contains('Field')
    }
    for (const [name, path] of [
      ['team', '/teams/' + f.teamA + '?tab=schedule'],
      ['feed', '/schedule']
    ]) {
      await open(path, 'Field 1')
      await shot(name)
      if (!baseline)
        expect(await b.page.evaluate(() => document.body.textContent)).contains(
          'UMP'
        )
    }
    // A real surviving pitch makes the shared server LIVE predicate true.
    await f.h.db
      .updateTable('games')
      .set({
        start_at: new Date(Date.now() - 600000),
        end_at: new Date(Date.now() + 3600000),
        status: 'inProgress',
        currentPlay: {
          teamStation: { actions: [{ type: 'pitch', kind: 'ball' }] }
        }
      })
      .where('id', '=', 'gam_umpire_g1')
      .execute()
    for (const [name, path] of [
      ['team', '/teams/' + f.teamA + '?tab=schedule'],
      ['feed', '/schedule?when=all']
    ]) {
      await open(path, 'LIVE')
      await shot(name + '-live')
      if (!baseline)
        expect(await b.page.evaluate(() => document.body.textContent)).matches(
          /UMP.*LIVE/
        )
    }
    if (!baseline) {
      await login(101)
      await open('/teams/' + f.teamA + '?tab=schedule', 'LIVE')
      expect(
        await b.page.evaluate(() => document.body.textContent)
      ).not.contains('UMP')
      await f.h.db
        .deleteFrom('umpire_assignments')
        .where('game_id', '=', 'gam_umpire_g1')
        .execute()
      await login(103)
      await open('/teams/' + f.teamA + '?tab=schedule', 'LIVE')
      expect(
        await b.page.evaluate(() => document.body.textContent)
      ).not.contains('UMP')
      await open('/games/gam_umpire_g1?tab=info', 'ARE YOU GOING')
      expect(await b.page.$('[data-testid="game-umpires"]')).equals(null)
      console.log(
        'B3/B4 signup, person cards, own UMP, LIVE coexistence, other viewer and removal passed'
      )
      await recordBrowserCoverage(
        [b.page],
        f.h.origin,
        join(artifacts, 'support/browser-presentation.json'),
        web
      )
    }
    await f.h.db
      .updateTable('games')
      .set({
        start_at: new Date('2027-04-04T00:00:00Z'),
        end_at: new Date('2027-04-04T02:00:00Z'),
        status: 'scheduled',
        currentPlay: null
      })
      .where('id', '=', 'gam_umpire_g1')
      .execute()
    await b.browser.close()
    await b.m.detach().catch(() => undefined)
    b = undefined
    b = await browserSession(
      daemon,
      'umpire-presentation-narrow',
      390,
      844,
      artifacts
    )
    await b.page.emulateTimezone('America/Los_Angeles')
    await login(101)
    for (const [name, path, text] of [
      ['schedule', schedule + '?view=league', 'Sign Up'],
      ['requirements', base + '/umpire-requirements', 'Select seasons'],
      [
        'requirements-edit',
        base + '/umpire-requirements/edit?seasons=' + f.seasonA,
        'Apply umpire requirements'
      ]
    ]) {
      await open(path, text)
      if (name !== 'schedule') await alignment()
      await shot(name + '-narrow')
    }
    if (!baseline) {
      await f.h.db
        .updateTable('umpire_types')
        .set({ name: 'First and Third Base' })
        .where('id', '=', 'uty_plate')
        .execute()
      for (const [name, path] of [
        ['requirements', base + '/umpire-requirements'],
        [
          'requirements-edit',
          base + '/umpire-requirements/edit?seasons=' + f.seasonA
        ]
      ]) {
        await open(path, 'First and Third Base: 1 required, 0 optional')
        await alignment()
        const bounds = await b.page.evaluate(() => {
          const detail = document.querySelector(
            '[data-testid^="season-requirements-"]'
          )!
          const text = detail.parentElement!.getBoundingClientRect()
          return [
            ...detail.querySelectorAll('[data-testid="settings-pill-badge"]')
          ].map(el => {
            const box = el.getBoundingClientRect()
            return {
              right: box.right,
              limit: text.right,
              scroll: el.scrollWidth,
              radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
              padding: parseFloat(getComputedStyle(el).paddingLeft),
              width: el.clientWidth
            }
          })
        })
        for (const box of bounds) {
          expect(box.right).at.most(box.limit + 1)
          expect(box.scroll).at.most(box.width + 1)
          expect(box.radius).at.most(box.padding)
        }
        await shot(name + '-long-narrow')
      }
    }
    console.log('Presentation browser journeys passed:', suffix)
  } finally {
    if (b != null) {
      await b.browser.close()
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
