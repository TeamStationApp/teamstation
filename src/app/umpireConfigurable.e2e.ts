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
  addFallMinors,
  FALL,
  readyUmpireBrowser,
  UMPIRE_BROWSER_NOW,
  umpireBrowserFixture
} from '../test/umpireBrowserFixture'

/** League A's third current season, with no requirement and no games. */
const SPRING = 'sea_layout_spring_majors'

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
    // A proving artifact, under its own name in TS_UMPIRE_PROOF when set.
    const proofDir = process.env.TS_UMPIRE_PROOF ?? artifacts
    const proof = async (name: string): Promise<void> => {
      await m.waitForAnimationToEnd()
      await mkdir(proofDir, { recursive: true })
      await writeFile(
        join(proofDir, `${name}.png`),
        await page.screenshot({ fullPage: false })
      )
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
    await tap(m, 'Uma Lee, majors, 1st')
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
    // Uma reads her own assignment in full.
    await page.waitForSelector(`[aria-label="Uma Lee, ${first.id}:1"]`)
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
    // A coach of the playoffs season only — no membership, role or roster
    // in the regular season — signs up for a regular-season game (#345).
    const coach = userIdOfGumbo(106)
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'rol_umpire_browser_coach',
        user_id: coach,
        scope_type: 'season',
        scope_id: f.playoffs,
        role: 'coach',
        granted_by: userIdOfGumbo(101),
        granted_at: new Date()
      })
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: coach,
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    await f.h.db
      .insertInto('umpire_certifications')
      .values({
        user_id: coach,
        level_id: 'ulv_browser_majors',
        type_id: 'uty_plate',
        enabled: true
      })
      .execute()
    await login(106)
    await open('/umpires/' + f.leagueA, 'Sign Up')
    await m.tapOn({ css: '[aria-label^="Sign Up, Plate,"]' })
    await contains(page, 'Confirm')
    await tap(m, 'Confirm')
    // 106 is Bobby Lee in this fixture, and reads their own name in full.
    await page.waitForSelector('[aria-label="Bobby Lee, uty_plate:1"]')
    await capture(m, artifacts, 'coach-signup-after.png')
    expect(
      (
        await f.h.db
          .selectFrom('umpire_assignments')
          .select('user_id')
          .where('game_id', '=', 'gam_umpire_g1')
          .where('slot', '=', 'uty_plate:1')
          .executeTakeFirst()
      )?.user_id
    ).equals(coach)
    // From the game's Info tab, the umpire's league card opens for 106, who
    // is accepted into League A (the playoffs coach above) and neither
    // manages its people nor is Uma (#347).
    await open('/games/gam_umpire_g1', 'UMPIRES')
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="game-umpires"]')!
        .scrollIntoView({ block: 'center' })
    })
    await capture(m, artifacts, 'game-umpires-after.png')
    await m.tapOn({
      css: `[data-testid="umpire-person-${userIdOfGumbo(103)}"] [role="button"]`
    })
    await page.waitForFunction(
      (league, uma) => location.pathname === `/leagues/${league}/people/${uma}`,
      { polling: 100 },
      f.leagueA,
      userIdOfGumbo(103)
    )
    await contains(page, 'Uma Lee')
    expect(
      await page.evaluate(() =>
        String(document.body.textContent).includes('ROLES')
      )
    ).equals(false)
    await capture(m, artifacts, 'game-umpire-profile-after.png')
    // ---- The league's season order (#348): Sort, drag, Cancel and Save on
    // the requirements screen, and Season 1→9 following the saved order.
    // League A holds three current seasons: Demo Regular, Fall Minors (a
    // requirement and two games) and Spring Majors (no games).
    await addFallMinors(f, 2)
    await f.h.db
      .insertInto('seasons')
      .values({
        id: SPRING,
        league_id: f.leagueA,
        name: 'Spring Majors',
        year: 2027,
        starts_on: '2027-03-02',
        ends_on: '2027-06-30',
        timezone: 'America/Los_Angeles'
      })
      .execute()
    await login(101)
    await page.setViewport({ width: 1440, height: 900 })
    const requirementsPage = base + '/umpire-requirements'
    /** The season list's names, top to bottom. */
    const seasonNames = async (): Promise<string[]> =>
      await page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid^="season-requirements-"]'
          )
        )
          .sort(
            (a, b) =>
              a.getBoundingClientRect().top - b.getBoundingClientRect().top
          )
          .map(
            n => (n.parentElement!.firstElementChild as HTMLElement).innerText
          )
      )
    const priorities = async (): Promise<Array<[string, number | null]>> =>
      (await client.umpireRequirements(f.leagueA))
        .filter(s => [f.seasonA, FALL, SPRING].includes(s.id))
        .map(s => [s.name, s.priority ?? null])
    const readOrder = ['Demo Regular', 'Fall Minors', 'Spring Majors']
    await open(requirementsPage, 'Spring Majors')
    expect(await seasonNames()).deep.equals(readOrder)
    expect(await priorities()).deep.equals(readOrder.map(n => [n, null]))
    // 1. Sort at the upper right of the season list.
    const sortPlace = await page.evaluate(() => {
      const sort = document
        .querySelector('[data-testid="season-priority-sort"]')!
        .getBoundingClientRect()
      const list = document
        .querySelector('[data-testid="season-priority-list"]')!
        .getBoundingClientRect()
      const first = document
        .querySelector('[data-testid^="season-requirements-"]')!
        .getBoundingClientRect()
      return {
        sortRight: sort.right,
        sortBottom: sort.bottom,
        listRight: list.right,
        listTop: list.top,
        firstTop: first.top,
        label: document.querySelector<HTMLElement>(
          '[data-testid="season-priority-sort"]'
        )!.innerText
      }
    })
    expect(sortPlace.label).equals('Sort')
    expect(sortPlace.sortBottom).at.most(sortPlace.listTop)
    expect(sortPlace.listTop).at.most(sortPlace.firstTop)
    expect(Math.abs(sortPlace.sortRight - sortPlace.listRight)).at.most(2)
    await proof('requirements-after')
    // 2. Reorder mode: grips, a red Cancel, Save, no checkbox.
    const sortTap = async (): Promise<void> => {
      await m.tapOn({ css: '[data-testid="season-priority-sort"]' })
    }
    const reorderMode = async (): Promise<void> => {
      await sortTap()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-roster-grip]').length === 3,
        { polling: 100 }
      )
    }
    await reorderMode()
    const mode = await page.evaluate(() => {
      const sort = document.querySelector<HTMLElement>(
        '[data-testid="season-priority-sort"]'
      )!
      const label = Array.from(sort.querySelectorAll<HTMLElement>('div')).find(
        n => n.children.length === 0 && n.innerText === 'Cancel'
      )
      const save = document.querySelector<HTMLElement>(
        '[data-testid="season-priority-save"]'
      )
      return {
        sort: sort.innerText,
        color: label == null ? '' : getComputedStyle(label).color,
        save: save == null ? '' : save.innerText,
        saveColor: save == null ? '' : getComputedStyle(save).backgroundColor,
        saveLeft: save == null ? 0 : save.getBoundingClientRect().left,
        listLeft: document
          .querySelector('[data-roster-target="season-0"]')!
          .getBoundingClientRect().left,
        checkboxes: document.querySelectorAll('[aria-label^="Select "]').length
      }
    })
    expect(mode.sort).equals('Cancel')
    expect(mode.color).equals('rgb(186, 26, 26)')
    expect(mode.save).equals('Save')
    expect(mode.saveColor).not.equals('rgba(0, 0, 0, 0)')
    expect(Math.abs(mode.saveLeft - mode.listLeft)).at.most(2)
    expect(mode.checkboxes).equals(0)
    await proof('requirements-reorder')
    /** Fall Minors, by its grip, onto the top edge of the first row. */
    const dragFallToTop = async (): Promise<void> => {
      const points = await page.evaluate(() => {
        const grip = document
          .querySelector('[aria-label="Drag Fall Minors"]')!
          .closest('[data-roster-grip]')!
          .getBoundingClientRect()
        const first = document
          .querySelector('[data-roster-target="season-0"]')!
          .getBoundingClientRect()
        return {
          from: [grip.x + grip.width / 2, grip.y + grip.height / 2],
          to: [first.x + first.width / 2, first.y + 3]
        }
      })
      await m.command('dragAndDrop', {
        from: { point: points.from.map(Math.round).join(',') },
        to: { point: points.to.map(Math.round).join(',') },
        holdDuration: 200,
        duration: 1000
      })
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="Roster dragged card"]') == null,
        { polling: 100 }
      )
    }
    const moved = ['Fall Minors', 'Demo Regular', 'Spring Majors']
    // 3. A drag, then Cancel: the order read is back, nothing saved.
    await dragFallToTop()
    expect(await seasonNames()).deep.equals(moved)
    await proof('requirements-dragged')
    await sortTap()
    await page.waitForFunction(
      () => document.querySelectorAll('[data-roster-grip]').length === 0,
      { polling: 100 }
    )
    expect(await seasonNames()).deep.equals(readOrder)
    await proof('requirements-cancel')
    expect(await priorities()).deep.equals(readOrder.map(n => [n, null]))
    // 4. A drag, then Save: the new order, stored as 1, 2, 3.
    await reorderMode()
    await dragFallToTop()
    expect(await seasonNames()).deep.equals(moved)
    const priority = page.waitForResponse(
      r =>
        r.request().method() === 'PUT' &&
        r.url().endsWith('/umpire-season-priority')
    )
    await m.tapOn({ css: '[data-testid="season-priority-save"]' })
    expect((await priority).status()).equals(200)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-roster-grip]').length === 0,
      { polling: 100 }
    )
    expect(await seasonNames()).deep.equals(moved)
    expect(await seasonNames()).not.deep.equals(readOrder)
    expect(await priorities()).deep.equals(moved.map((n, i) => [n, i + 1]))
    await capture(m, artifacts, 'support/requirements-saved.png')
    // 5. Season 1→9 follows the saved order: Fall Minors' games first, the
    //    reverse of the name order it gave before the save; 9→1 the reverse.
    const seasonOf = new Map(
      (await client.umpireSchedule(f.leagueA, 'view=league')).games.map(g => [
        g.id,
        g.seasonName
      ])
    )
    /** The divisions of the rows on the screen, top to bottom. */
    const shownDivisions = async (): Promise<string[]> =>
      (
        await page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid^="umpire-game-"]'
            )
          )
            .filter(row => row.getBoundingClientRect().height > 0)
            .sort(
              (a, b) =>
                a.getBoundingClientRect().top - b.getBoundingClientRect().top
            )
            .map(row => row.dataset.testid!.slice('umpire-game-'.length))
        )
      )
        .map(id => seasonOf.get(id))
        .filter((name): name is string => name != null)
    const schedule = async (sort: string): Promise<string[]> => {
      await m.openBrowser({
        url: `${f.h.origin}/umpires/${f.leagueA}?view=league&sort=${sort}`
      })
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid^="umpire-game-gam_minors_"]') !=
          null,
        { polling: 100 }
      )
      await page.evaluate(async () => await document.fonts.ready)
      return await shownDivisions()
    }
    const firstUp = await schedule('seasonPriority')
    expect(firstUp.lastIndexOf('Fall Minors')).lessThan(
      firstUp.indexOf('Demo Regular')
    )
    await proof('schedule-season-priority')
    const lastUp = await schedule('-seasonPriority')
    expect(lastUp.lastIndexOf('Demo Regular')).lessThan(
      lastUp.indexOf('Fall Minors')
    )
    const apiOrder = (
      await client.umpireSchedule(f.leagueA, 'view=league&sort=seasonPriority')
    ).games.map(g => g.seasonName)
    expect(apiOrder.lastIndexOf('Fall Minors')).lessThan(
      apiOrder.indexOf('Demo Regular')
    )
    // 6. The keyboard: Spring Majors grabbed with Space, moved up, dropped
    //    with Enter, and saved.
    await open(requirementsPage, 'Spring Majors')
    expect(await seasonNames()).deep.equals(moved)
    await reorderMode()
    await page.focus('[data-roster-target="season-2"]')
    await m.pressKey({ key: 'space' })
    await m.pressKey({ key: 'up' })
    await m.pressKey({ key: 'enter' })
    const keyed = ['Fall Minors', 'Spring Majors', 'Demo Regular']
    await page.waitForFunction(
      first =>
        Array.from(
          document.querySelectorAll('[data-testid^="season-requirements-"]')
        ).map(n => n.parentElement!.firstElementChild!.textContent)[1] ===
        first,
      { polling: 100 },
      keyed[1]
    )
    expect(await seasonNames()).deep.equals(keyed)
    const keyedSave = page.waitForResponse(
      r =>
        r.request().method() === 'PUT' &&
        r.url().endsWith('/umpire-season-priority')
    )
    await m.tapOn({ css: '[data-testid="season-priority-save"]' })
    expect((await keyedSave).status()).equals(200)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-roster-grip]').length === 0,
      { polling: 100 }
    )
    expect(await priorities()).deep.equals(keyed.map((n, i) => [n, i + 1]))
    await capture(m, artifacts, 'support/requirements-keyboard-saved.png')
    await recordBrowserCoverage(
      [page],
      f.h.origin,
      join(artifacts, 'coverage/browser-configurable.json'),
      web
    )
    console.log(
      'B1–B4 configurable types, counts, certification, signup, game detail and spreadsheet notes, a season coach umpiring another season, and the league’s season order, passed'
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
