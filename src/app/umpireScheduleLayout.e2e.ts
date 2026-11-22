import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { HTTPRequest, HTTPResponse } from 'puppeteer'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import {
  type BrowserSession,
  browserSession,
  contains,
  maestro,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import { userIdOfGumbo } from '../common/userId'
import type { GroupFixture } from '../test/groupFixtures'
import {
  readyUmpireBrowser,
  UMPIRE_BROWSER_NOW,
  umpireBrowserFixture
} from '../test/umpireBrowserFixture'
import { seedUmpireCounts } from '../test/umpireTypes'

/** League A's second current season, with its own level and same-day games. */
const FALL = 'sea_layout_fall_minors'

/**
 * "Fall Minors": a second current season of League A with a different
 * required level and a game three hours before each Demo Regular copy, the
 * same day in Los Angeles. The before capture builds the same.
 */
async function addFallMinors(f: GroupFixture, games: number): Promise<void> {
  const db = f.h.db
  await db
    .insertInto('seasons')
    .values({
      id: FALL,
      league_id: f.leagueA,
      name: 'Fall Minors',
      year: 2027,
      starts_on: '2027-03-02',
      ends_on: '2027-06-30',
      timezone: 'America/Los_Angeles'
    })
    .execute()
  await db
    .insertInto('umpire_levels')
    .values({
      id: 'ulv_browser_minors',
      league_id: f.leagueA,
      name: 'minors',
      position: 1
    })
    .execute()
  await db
    .insertInto('season_umpire_requirements')
    .values({ season_id: FALL, level_id: 'ulv_browser_minors' })
    .execute()
  await seedUmpireCounts(db, FALL)
  await db
    .insertInto('season_teams')
    .values(
      [f.teamA, f.teamB].map(teamId => ({
        season_id: FALL,
        team_id: teamId,
        active: true
      }))
    )
    .onConflict(oc => oc.doNothing())
    .execute()
  const game = await db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', 'gam_umpire_g1')
    .executeTakeFirstOrThrow()
  for (let i = 0; i < games; i++)
    await db
      .insertInto('games')
      .values({
        ...game,
        id: `gam_minors_${i}`,
        season_id: FALL,
        notes: null,
        start_at: new Date(
          new Date(game.start_at).getTime() + i * 86400000 - 3 * 3600000
        ),
        end_at: new Date(
          new Date(game.end_at!).getTime() + i * 86400000 - 3 * 3600000
        )
      })
      .execute()
}

/** Whether `shown` runs in the order of `all`, each once. */
function inOrderOf(shown: string[], all: string[]): boolean {
  const places = shown.map(id => all.indexOf(id))
  return places.every(
    (place, i) => place >= 0 && (i === 0 || place > places[i - 1])
  )
}

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
    // 103 umpires League B too, which manages umpires as well.
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: true })
      .where('id', '=', f.leagueB)
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueB,
        user_id: userIdOfGumbo(103),
        granted_by: userIdOfGumbo(102)
      })
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
    // A second current season on the same days, and no league default sort.
    if (!baseline) await addFallMinors(f, 30)
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
    const saveFilter = '[data-testid="umpire-save-filter"]'
    const savedFilter = async (): Promise<unknown> =>
      await (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/me/umpire-availability`,
          undefined,
          103
        )
      ).json()
    const filterLabel = async (): Promise<string> =>
      await page.$eval(
        '[aria-label="Schedule filters"]',
        n => (n as HTMLElement).innerText
      )
    // Save filter, the saved filter on entry, its zone, league switching,
    // no one else's filter on show, the admin's availability reads, and
    // clearing it again.
    const savedFilterSteps = async (): Promise<void> => {
      // 1. A filter applied with none saved: Save filter beside the filter.
      await open('?days=0,1,2,3,4&from=17:00&to=23:59')
      await page.waitForSelector(saveFilter)
      const placed = await page.evaluate(selector => {
        const box = (n: Element): DOMRect => n.getBoundingClientRect()
        const save = document.querySelector(selector)!
        const filter = document.querySelector(
          '[aria-label="Schedule filters"]'
        )!
        const row = document.querySelector('[data-testid="umpire-filter-row"]')!
        return {
          save: box(save).toJSON() as DOMRect,
          filter: box(filter).toJSON() as DOMRect,
          row: box(row).toJSON() as DOMRect
        }
      }, saveFilter)
      expect(placed.save.left).greaterThan(placed.filter.right)
      expect(placed.save.top).closeTo(placed.filter.top, 1)
      expect(placed.save.height).closeTo(placed.filter.height, 1)
      expect(placed.save.height).at.most(placed.row.height)
      log.push('Save filter placed ' + JSON.stringify(placed))
      await proof('schedule-save-filter')
      await tap(m, 'Save this filter as your availability')
      await page.waitForSelector(saveFilter, { hidden: true })
      expect(await savedFilter()).deep.equals({
        availability: {
          levels: [],
          days: [0, 1, 2, 3, 4],
          from: '17:00',
          to: '23:59',
          timezone: 'America/Los_Angeles'
        }
      })
      // 2. Opened with no filter in the address: the saved one applies.
      await open()
      await page.waitForFunction(
        () =>
          new URL(location.href).searchParams.get('timezone') ===
          'America/Los_Angeles'
      )
      const address = new URL(page.url()).searchParams
      expect(address.get('days')).equals('0,1,2,3,4')
      expect(address.get('from')).equals('17:00')
      expect(address.get('to')).equals('23:59')
      await page.waitForSelector('[data-testid="umpire-game-gam_layout_2"]')
      expect(await filterLabel()).contains('MTWTF · 5:00 PM–11:59 PM')
      expect(await page.$(saveFilter)).equals(null)
      await proof('schedule-saved-filter-applied')
      // 3. On a phone set to Chicago, the saved filter is still matched in
      // Los Angeles while rows are dated in Chicago, and nothing is asked for
      // before the saved filter answers.
      await page.emulateTimezone('America/Chicago')
      const traffic: string[] = []
      const onRequest = (request: HTTPRequest): void => {
        if (request.url().includes('/umpire-schedule?'))
          traffic.push(`schedule ${request.url()}`)
      }
      const onResponse = (response: { url: () => string }): void => {
        if (response.url().includes('/me/umpire-availability'))
          traffic.push(`saved ${response.url()}`)
      }
      page.on('request', onRequest)
      page.on('response', onResponse)
      await open()
      await page.waitForSelector('[data-testid="umpire-game-gam_layout_2"]')
      page.off('request', onRequest)
      page.off('response', onResponse)
      // The label names the zone its times are read in, not the device's.
      expect(await filterLabel()).matches(/5:00 PM–11:59 PM P[SD]T/)
      const firstSaved = traffic.findIndex(t => t.startsWith('saved '))
      const firstSchedule = traffic.findIndex(t => t.startsWith('schedule '))
      expect(firstSaved, traffic.join('\n')).at.least(0)
      expect(firstSchedule, traffic.join('\n')).greaterThan(firstSaved)
      const sent = new URL(traffic[firstSchedule].slice('schedule '.length))
        .searchParams
      // The client sends each day as a parameter of its own.
      expect(sent.getAll('days')).deep.equals(['0', '1', '2', '3', '4'])
      expect(sent.get('from')).equals('17:00')
      expect(sent.get('to')).equals('23:59')
      expect(sent.get('filterTimezone')).equals('America/Los_Angeles')
      expect(sent.get('timezone')).equals('America/Chicago')
      // No request asks for the saved filter matched in the device's zone.
      expect(
        traffic
          .filter(t => t.startsWith('schedule '))
          .every(t => {
            const params = new URL(t.slice('schedule '.length)).searchParams
            return (
              !params.has('days') ||
              params.get('filterTimezone') === 'America/Los_Angeles'
            )
          }),
        traffic.join('\n')
      ).equals(true)
      log.push('Saved filter zone carried:\n' + traffic.join('\n'))
      await page.emulateTimezone('America/Los_Angeles')
      // 4. Another league starts from its own saved filter: none, then
      // Saturday; back in League A, the weekday filter again.
      await tap(m, 'Demo Visitors')
      await page.waitForFunction(
        league => location.pathname === `/umpires/${league}`,
        {},
        f.leagueB
      )
      await page.waitForFunction(() => {
        const n = document.querySelector<HTMLElement>(
          '[aria-label="Schedule filters"]'
        )
        return n != null && !n.innerText.includes('·')
      })
      expect(new URL(page.url()).searchParams.has('days')).equals(false)
      expect(await page.$(saveFilter)).equals(null)
      await tap(m, 'Schedule filters')
      await tap(m, 'Saturday')
      await tap(m, 'Apply filters')
      await page.waitForSelector(saveFilter)
      await tap(m, 'Save this filter as your availability')
      await page.waitForSelector(saveFilter, { hidden: true })
      expect(await filterLabel()).contains('Filter · S')
      await proof('schedule-other-league')
      await tap(m, 'Demo League')
      await page.waitForFunction(
        () => new URL(location.href).searchParams.get('days') === '0,1,2,3,4'
      )
      // 5. No one else's filter on show, to the league's admin.
      await login(101)
      const hidden = ['MTWTF', '5:00 PM', '17:00', '11:59', 'America/']
      for (const [address, ready] of [
        [`/leagues/${f.leagueA}/people/${userIdOfGumbo(103)}`, 'Trout'],
        [`/groups/league/${f.leagueA}/umpires`, 'Trout']
      ] as const) {
        await m.openBrowser({ url: f.h.origin + address })
        await contains(page, ready)
        await m.waitForAnimationToEnd()
        const text = await page.evaluate(() => document.body.innerText)
        for (const words of hidden)
          expect(text, `${address}: ${words}`).not.contains(words)
      }
      log.push('No filter text on 103’s league profile or Manage Umpires.')
      // 6. The admin's availability reads, and a non-admin's refused.
      const api: string[] = []
      const read = async (
        address: string,
        as: number
      ): Promise<{ status: number; body: any }> => {
        const response = await f.h.request('GET', address, undefined, as)
        const body = await response.json()
        api.push(
          `$ GET /api/v1${address} (as ${as})`,
          `HTTP ${response.status}`,
          JSON.stringify(body, null, 2),
          ''
        )
        return { status: response.status, body }
      }
      const umpires = `/leagues/${f.leagueA}/umpires`
      const ids = (body: any): string[] =>
        (body.people as Array<{ id: string }>).map(p => p.id)
      const monday = await read(`${umpires}?day=0&time=18:00`, 101)
      expect(monday.status).equals(200)
      expect(ids(monday.body)).contains(userIdOfGumbo(103))
      const saturday = await read(`${umpires}?day=5&time=18:00`, 101)
      expect(ids(saturday.body)).not.contains(userIdOfGumbo(103))
      expect(ids(saturday.body)).contains(userIdOfGumbo(101))
      // Monday 2027-04-05, 6 pm in Los Angeles.
      const strict = await read(
        `${umpires}?availableAt=${encodeURIComponent('2027-04-06T01:00:00.000Z')}&strict=true`,
        101
      )
      expect(ids(strict.body)).deep.equals([userIdOfGumbo(103)])
      const commitments = await read(
        `${umpires}/${userIdOfGumbo(103)}/commitments?from=${encodeURIComponent('2027-04-01T00:00:00.000Z')}&to=${encodeURIComponent('2027-04-30T00:00:00.000Z')}`,
        101
      )
      expect(commitments.status).equals(200)
      expect(
        (commitments.body.commitments as Array<{ gameId: string }>).map(
          c => c.gameId
        )
      ).contains('gam_umpire_g1')
      const refused = await read(`${umpires}?day=0&time=18:00`, 104)
      expect(refused.status).within(403, 404)
      await mkdir(proofDir, { recursive: true })
      await writeFile(join(proofDir, 'availability-api.log'), api.join('\n'))
      // 7. Clear filters, then Apply: Save filter clears the saved one.
      await login(103)
      await open()
      await page.waitForFunction(
        () => new URL(location.href).searchParams.get('days') === '0,1,2,3,4'
      )
      await page.waitForSelector('[data-testid="umpire-game-gam_layout_2"]')
      await tap(m, 'Schedule filters')
      await tap(m, 'Clear filters')
      await tap(m, 'Apply filters')
      await page.waitForSelector(saveFilter)
      await tap(m, 'Save this filter as your availability')
      await page.waitForSelector(saveFilter, { hidden: true })
      expect(await savedFilter()).deep.equals({ availability: null })
      log.push(
        'Save filter saved, applied on entry with its zone, per league, hidden from the admin, queried by the admin, and cleared.'
      )
    }
    // The Division column, the one-line row, the sort buttons and their
    // dropdowns, Save sort, the sort for the visit, links, the narrow row,
    // paging and the API, the plan's sort steps 1–9.
    const sortSteps = async (): Promise<void> => {
      const api = `/leagues/${f.leagueA}`
      const zone = 'America/Los_Angeles'
      /** The schedule's rows as the API sorts them, for `as`. */
      const sorted = async (
        as: number,
        view: string,
        sort?: string
      ): Promise<
        Array<{ id: string; seasonName: string; startAt: string }>
      > => {
        const query = new URLSearchParams({
          view,
          timezone: zone,
          paged: '1',
          limit: '500',
          ...(sort == null ? {} : { sort })
        })
        const answer = await f.h.request(
          'GET',
          `${api}/umpire-schedule?${query.toString()}`,
          undefined,
          as
        )
        const body = (await answer.json()) as { items: any[] }
        expect(answer.status, JSON.stringify(body)).equals(200)
        return body.items
      }
      /** The rows on the page, top to bottom: their ids and Division cells. */
      const shownRows = async (): Promise<
        Array<{ id: string; division: string }>
      > =>
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
            .map(row => ({
              id: row.dataset.testid!.slice('umpire-game-'.length),
              division: (row.children[1] as HTMLElement).innerText
            }))
        )
      /** What stands on the filter row, by test id, in order. */
      // No `??` or `?.` in code the page runs: sucrase would call a helper
      // the page lacks.
      const rowButtons = async (): Promise<string[]> =>
        (
          await page.$eval('[data-testid="umpire-filter-row"]', row =>
            Array.from(row.firstElementChild!.children).map(node =>
              node.getAttribute('data-testid')
            )
          )
        ).map(id => id ?? '')
      const sortLabels = async (): Promise<string[]> =>
        await page.evaluate(() =>
          ['umpire-sort-1', 'umpire-sort-2', 'umpire-sort-add']
            .map(id => document.querySelector(`[data-testid="${id}"]`))
            .filter(node => node != null)
            .map(node => node.getAttribute('aria-label')!)
        )
      const address = (): string | null =>
        new URL(page.url()).searchParams.get('sort')
      const waitForSort = async (sort: string | null): Promise<void> => {
        await page.waitForFunction(
          sort => new URL(location.href).searchParams.get('sort') === sort,
          {},
          sort
        )
      }
      /** The open dropdown's rows: label and whether marked. */
      const menuRows = async (): Promise<
        Array<{ label: string; selected: string | null; icon: boolean }>
      > => {
        await page.waitForSelector('[data-testid="header-menu-panel"]')
        await m.waitForAnimationToEnd()
        return await page.$$eval(
          '[data-testid="header-menu-panel"] :is([role="button"], [role="radio"])',
          rows =>
            rows.map(row => ({
              label: row.getAttribute('aria-label')!,
              selected: row.getAttribute('aria-checked'),
              icon: row.querySelector('[data-testid="sort-icon"]') != null
            }))
        )
      }
      const openSort = async (id: string): Promise<void> => {
        await toTop()
        await m.tapOn({ css: `[data-testid="${id}"]` })
      }
      /** A sort is a radio row; Remove sort is a button. */
      const choose = async (option: string): Promise<void> => {
        await tap(m, option, option === 'Remove sort' ? 'button' : 'radio')
        await page.waitForSelector('[data-testid="header-menu-panel"]', {
          hidden: true
        })
      }
      /**
       * Every button of the row the height of the filter button, on its line,
       * and the row no taller than they are.
       */
      const sameLine = async (): Promise<unknown> => {
        const boxes = await page.evaluate(() => {
          const box = (n: Element): DOMRect =>
            n.getBoundingClientRect().toJSON() as DOMRect
          const row = document.querySelector(
            '[data-testid="umpire-filter-row"]'
          )!
          const line = getComputedStyle(row.firstElementChild!)
          return {
            row: box(row),
            // The room the line keeps for its buttons' shadows.
            padding:
              parseFloat(line.paddingTop) + parseFloat(line.paddingBottom),
            scrollWidth: row.scrollWidth,
            clientWidth: row.clientWidth,
            buttons: Array.from(row.firstElementChild!.children).map(n => {
              const { top, height, left, right } = box(n)
              return {
                id: n.getAttribute('data-testid'),
                top,
                height,
                left,
                right
              }
            })
          }
        })
        const [filter, ...rest] = boxes.buttons
        expect(filter.id).equals('settings-pill-button')
        for (const button of rest) {
          expect(button.top, String(button.id)).closeTo(filter.top, 1)
          expect(button.height, String(button.id)).closeTo(filter.height, 1)
        }
        expect(boxes.row.height - boxes.padding).closeTo(filter.height, 1)
        return boxes
      }
      /**
       * The page at its top, where the filter row is: the table opens on its
       * next game, which can be a few rows down.
       */
      const toTop = async (): Promise<void> => {
        for (let turn = 0; turn < 10; turn++) {
          await m.evalBrowserScript({
            script: `(() => {
          let node = document.querySelector('[data-testid="umpire-table"]');
          while (node && getComputedStyle(node).overflowY !== 'auto' && getComputedStyle(node).overflowY !== 'scroll') node = node.parentElement;
          (node ?? document.scrollingElement).scrollTop = 0;
        })()`
          })
          await new Promise(resolve => setTimeout(resolve, 300))
          const top = await page.$eval(
            '[data-testid="umpire-filter-row"]',
            row => row.getBoundingClientRect().top
          )
          if (top >= 0) return
        }
        throw new Error('The filter row stays above the window')
      }
      const DATE_ASC = 'Sort by Date, oldest to newest'
      const SEASON_ASC_2 = 'Then by Season, A to Z'

      // 1. The admin's league view: Division after Date, aligned with its
      //    heading; Filters and the default sort, Date 1→9 then Season A→Z.
      await login(101)
      await open('?view=league')
      await page.waitForSelector('[data-testid="umpire-game-gam_umpire_g1"]')
      const columns = await page.evaluate(() => {
        const header = document.querySelector(
          '[data-testid="umpire-table-header"]'
        )!
        const row = document.querySelector(
          '[data-testid="umpire-game-gam_umpire_g1"]'
        )!
        const place = (n: Element): { left: number; width: number } => {
          const { left, width } = n.getBoundingClientRect()
          return { left, width }
        }
        return {
          headings: Array.from(header.children)
            .slice(0, 7)
            .map(n => (n as HTMLElement).innerText),
          heads: Array.from(header.children).slice(0, 7).map(place),
          cells: Array.from(row.children).slice(0, 7).map(place),
          division: (row.children[1] as HTMLElement).innerText
        }
      })
      expect(columns.headings).deep.equals([
        'Date',
        'Division',
        'Home team',
        'Away team',
        'Venue',
        'Field',
        'Notes'
      ])
      columns.cells.forEach((cell, i) => {
        expect(cell.left, columns.headings[i]).closeTo(columns.heads[i].left, 1)
        expect(cell.width, columns.headings[i]).closeTo(
          columns.heads[i].width,
          1
        )
      })
      expect(columns.division).equals('Demo Regular')
      expect(await rowButtons()).deep.equals([
        'settings-pill-button',
        'umpire-sort-1',
        'umpire-sort-2'
      ])
      expect(await sortLabels()).deep.equals([DATE_ASC, SEASON_ASC_2])
      expect(
        await page.$eval(
          '[data-testid="umpire-sort-1"] [data-testid="sort-icon"]',
          n => (n as HTMLElement).innerText.replace(/\s/g, '')
        )
      ).equals('19')
      log.push(
        'Division and the default sort ' + JSON.stringify(await sameLine())
      )
      expect(
        inOrderOf(
          (await shownRows()).map(row => row.id),
          (await sorted(101, 'schedule')).map(row => row.id)
        )
      ).equals(true)
      await toTop()
      await proof('schedule-sort-after')

      // 2. Slot 2's dropdown: Season and Certification, no Date, Season A→Z
      //    marked, Remove sort last. Remove sort: + Sort, sort=date, Save sort.
      await openSort('umpire-sort-2')
      const second = await menuRows()
      expect(second.map(row => row.label)).deep.equals([
        'Season, A to Z',
        'Season, Z to A',
        'Season, league order, first to last',
        'Season, league order, last to first',
        'Certification, A to Z',
        'Certification, Z to A',
        'Remove sort'
      ])
      expect(second.map(row => row.selected)).deep.equals([
        'true',
        'false',
        'false',
        'false',
        'false',
        'false',
        null
      ])
      expect(second.slice(0, 6).every(row => row.icon)).equals(true)
      await proof('schedule-sort-picker')
      await choose('Remove sort')
      await waitForSort('date')
      await page.waitForSelector('[data-testid="umpire-sort-add"]')
      await page.waitForSelector('[data-testid="umpire-save-sort"]')
      expect(await rowButtons()).deep.equals([
        'settings-pill-button',
        'umpire-sort-1',
        'umpire-sort-add',
        'umpire-save-sort'
      ])

      // 3. Slot 1 lists all eight; Season 1→9 groups by season (by name, as
      //    no priority is saved). + Sort offers no Season.
      await openSort('umpire-sort-1')
      const first = await menuRows()
      expect(first.map(row => row.label)).length(9)
      expect(first[0]).deep.include({
        label: 'Date, oldest to newest',
        selected: 'true'
      })
      await choose('Season, league order, first to last')
      await waitForSort('seasonPriority')
      await page.waitForSelector('[data-testid="umpire-sort-add"]')
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid^="umpire-game-gam_minors_"]') !=
          null
      )
      const grouped = await shownRows()
      const priorityOrder = await sorted(101, 'schedule', 'seasonPriority')
      expect(
        inOrderOf(
          grouped.map(row => row.id),
          priorityOrder.map(row => row.id)
        )
      ).equals(true)
      // Every Demo Regular row before every Fall Minors row.
      const divisions = priorityOrder.map(row => row.seasonName)
      expect(divisions.lastIndexOf('Demo Regular')).lessThan(
        divisions.indexOf('Fall Minors')
      )
      await openSort('umpire-sort-add')
      expect((await menuRows()).map(row => row.label)).deep.equals([
        'Date, oldest to newest',
        'Date, newest to oldest',
        'Certification, A to Z',
        'Certification, Z to A'
      ])
      await choose('Certification, Z to A')
      await waitForSort('seasonPriority,-certification')
      await openSort('umpire-sort-1')
      await menuRows()
      await choose('Remove sort')
      await waitForSort('-certification')
      await page.waitForSelector('[data-testid="umpire-sort-add"]')
      expect(await sortLabels()).deep.equals([
        'Sort by Certification, Z to A',
        'Add a second sort'
      ])
      await openSort('umpire-sort-add')
      await menuRows()
      await choose('Season, league order, first to last')
      await waitForSort('-certification,seasonPriority')
      await page.waitForSelector('[data-testid="umpire-sort-2"]')
      expect(await rowButtons()).deep.equals([
        'settings-pill-button',
        'umpire-sort-1',
        'umpire-sort-2',
        'umpire-save-sort'
      ])
      await sameLine()
      await toTop()
      await proof('schedule-sort-two-save')
      await tap(m, 'Save this sort as the league default')
      await page.waitForSelector('[data-testid="umpire-save-sort"]', {
        hidden: true
      })
      const settings = await (
        await f.h.request('GET', `${api}/umpire-settings`, undefined, 101)
      ).json()
      expect(settings.sort).deep.equals(['-certification', 'seasonPriority'])
      log.push('Saved the default sort ' + JSON.stringify(settings))

      // 4. A non-admin afresh: the saved default, no Save sort. A sort for
      //    the visit survives a remount, not a fresh entry.
      await login(103)
      await open()
      await page.waitForSelector('[data-testid^="umpire-game-"]')
      await page.waitForSelector('[data-testid="umpire-sort-2"]')
      expect(address()).equals(null)
      const DEFAULT_LABELS = [
        'Sort by Certification, Z to A',
        'Then by Season, league order, first to last'
      ]
      expect(await sortLabels()).deep.equals(DEFAULT_LABELS)
      expect(await page.$('[data-testid="umpire-save-sort"]')).equals(null)
      expect(
        inOrderOf(
          (await shownRows()).map(row => row.id),
          (await sorted(103, 'schedule')).map(row => row.id)
        )
      ).equals(true)
      await toTop()
      await proof('schedule-sort-default-nonadmin')
      await openSort('umpire-sort-1')
      const offered = await menuRows()
      expect(offered.map(row => row.label)).includes('Date, newest to oldest')
      expect(offered.map(row => row.label)).not.includes('Season, A to Z')
      await choose('Date, newest to oldest')
      await waitForSort('-date,seasonPriority')
      const VISIT_LABELS = [
        'Sort by Date, newest to oldest',
        'Then by Season, league order, first to last'
      ]
      await page.waitForFunction(
        label => {
          const button = document.querySelector('[data-testid="umpire-sort-1"]')
          return (
            (button === null ? null : button.getAttribute('aria-label')) ===
            label
          )
        },
        {},
        VISIT_LABELS[0]
      )
      await m.tapOn({ css: '[aria-label^="Open game "]' })
      await page.waitForFunction(() => location.pathname.startsWith('/games/'))
      await m.tapOn({ css: '[aria-label="Back"]' })
      await page.waitForFunction(() =>
        location.pathname.startsWith('/umpires/')
      )
      await page.waitForSelector('[data-testid="umpire-sort-2"]')
      expect(address()).equals('-date,seasonPriority')
      expect(await sortLabels()).deep.equals(VISIT_LABELS)
      // Afresh from Home's Umpire Schedule row: the league default.
      await m.openBrowser({ url: f.h.origin + '/' })
      await tap(m, 'Umpire Schedule')
      await page.waitForFunction(
        league => location.pathname === `/umpires/${league}`,
        {},
        f.leagueA
      )
      await page.waitForSelector('[data-testid="umpire-sort-2"]')
      expect(address()).equals(null)
      expect(await sortLabels()).deep.equals(DEFAULT_LABELS)
      log.push(
        'A visit’s sort survives Back, and a fresh entry has the default.'
      )

      // 5. Links with invalid values: only the valid ones, cleaned in the
      //    request; nothing valid is the default; none is the empty sort.
      const links: string[] = []
      const asked: string[] = []
      const onAsk = (request: HTTPRequest): void => {
        const url = new URL(request.url())
        if (url.pathname.endsWith('/umpire-schedule'))
          asked.push(url.pathname + url.search)
      }
      page.on('request', onAsk)
      const openLink = async (
        sort: string,
        labels: string[]
      ): Promise<URLSearchParams> => {
        asked.length = 0
        await open(`?sort=${sort}`)
        await page.waitForSelector('[data-testid^="umpire-game-"]')
        await page.waitForFunction(
          labels =>
            JSON.stringify(
              ['umpire-sort-1', 'umpire-sort-2', 'umpire-sort-add']
                .map(id => document.querySelector(`[data-testid="${id}"]`))
                .filter(node => node != null)
                .map(node => node.getAttribute('aria-label'))
            ) === JSON.stringify(labels),
          {},
          labels
        )
        expect(asked.length, `${sort}: ${asked.join(' ')}`).greaterThan(0)
        links.push(
          `$ open /umpires/<A>?sort=${sort}`,
          `schedule request: ${asked[0].replace(f.leagueA, '<A>')}`,
          `sort pills: ${(await sortLabels()).join(' | ')}`,
          ''
        )
        expect(address()).equals(sort)
        return new URL(asked[0], f.h.origin).searchParams
      }
      const cleaned = await openLink('bogus,season,-season,certification', [
        'Sort by Season, A to Z',
        'Then by Certification, A to Z'
      ])
      expect(cleaned.get('sort')).equals('season,certification')
      await toTop()
      await proof('schedule-sort-link')
      const bogus = await openLink('bogus', DEFAULT_LABELS)
      expect(bogus.has('sort')).equals(false)
      const none = await openLink('none', ['Sort'])
      expect(none.get('sort')).equals('none')
      page.off('request', onAsk)
      expect(await rowButtons()).deep.equals([
        'settings-pill-button',
        'umpire-sort-1'
      ])
      const byTime = await sorted(103, 'schedule', 'none')
      expect(
        byTime.every(
          (row, i) =>
            i === 0 ||
            Date.parse(row.startAt) >= Date.parse(byTime[i - 1].startAt)
        )
      ).equals(true)
      expect(
        inOrderOf(
          (await shownRows()).map(row => row.id),
          byTime.map(row => row.id)
        )
      ).equals(true)
      await toTop()
      await proof('schedule-sort-none')
      await mkdir(proofDir, { recursive: true })
      await writeFile(
        join(proofDir, 'schedule-sort-link.log'),
        links.join('\n')
      )

      // 6. Narrow, with a filter other than the saved one: Filters, Save
      //    filter and both sorts on one line, which scrolls to its last.
      //    The league default saved in step 3 is set aside meanwhile, so the
      //    rows and sorts are the before capture's (Date 1→9 then Season
      //    A→Z), and put back after.
      const leagueSort = async (sort: string[] | null): Promise<void> => {
        const answer = await f.h.request(
          'PUT',
          `${api}/umpire-settings`,
          { sort },
          101
        )
        expect(answer.status).equals(200)
      }
      await leagueSort(null)
      await login(103)
      await page.setViewport({ width: 390, height: 844 })
      await open('?days=5')
      await page.waitForSelector(saveFilter)
      await page.waitForSelector('[data-testid="umpire-sort-2"]')
      await m.waitForAnimationToEnd()
      await toTop()
      expect(await sortLabels()).deep.equals([DATE_ASC, SEASON_ASC_2])
      const narrow = (await sameLine()) as {
        scrollWidth: number
        clientWidth: number
        buttons: Array<{ id: string | null }>
      }
      expect(narrow.buttons.map(button => button.id)).deep.equals([
        'settings-pill-button',
        'umpire-save-filter',
        'umpire-sort-1',
        'umpire-sort-2'
      ])
      expect(narrow.scrollWidth).greaterThan(narrow.clientWidth)
      await toTop()
      await proof('schedule-row-narrow-after')
      await m.evalBrowserScript({
        script: `(() => { const row = document.querySelector('[data-testid="umpire-filter-row"]'); row.scrollLeft = row.scrollWidth })()`
      })
      // Scrolled to its end, both sorts whole on the screen.
      await page.waitForFunction(() =>
        ['umpire-sort-1', 'umpire-sort-2'].every(id => {
          const box = document
            .querySelector(`[data-testid="${id}"]`)!
            .getBoundingClientRect()
          return box.right <= innerWidth && box.left >= 0
        })
      )
      await proof('schedule-row-narrow-scrolled')
      await leagueSort(['-certification', 'seasonPriority'])
      log.push('Narrow row ' + JSON.stringify(narrow))
      await page.setViewport({ width: 1440, height: 900 })

      // 7. Paging under Season A→Z then Certification A→Z: every game once.
      await login(101)
      const pages: string[][] = []
      const onPage = (response: HTTPResponse): void => {
        const url = new URL(response.url())
        if (
          url.pathname.endsWith('/umpire-schedule') &&
          url.searchParams.get('sort') === 'season,certification'
        )
          response
            .json()
            .then((body: { items: Array<{ id: string }> }) => {
              pages.push(body.items.map(item => item.id))
            })
            .catch(() => undefined)
      }
      page.on('response', onPage)
      await open('?view=league&sort=season,certification')
      await page.waitForSelector('[data-testid^="umpire-game-"]')
      const everyGame = await sorted(101, 'schedule', 'season,certification')
      // A wheel at a time, as a reader scrolls, down to the end and back up
      // to the start, until every game is read or nothing more comes.
      await page.mouse.move(860, 600)
      for (const deltaY of [500, -500]) {
        let quiet = 0
        for (
          let wheel = 0;
          wheel < 400 &&
          quiet < 40 &&
          new Set(pages.flat()).size < everyGame.length;
          wheel++
        ) {
          const before = pages.length
          await page.mouse.wheel({ deltaY })
          await new Promise(resolve => setTimeout(resolve, 60))
          quiet = pages.length === before ? quiet + 1 : 0
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
      const read = pages.flat()
      expect(new Set(read).size, JSON.stringify(pages)).equals(read.length)
      expect([...read].sort()).deep.equals(everyGame.map(row => row.id).sort())
      page.off('response', onPage)
      log.push(
        `Paged under season,certification: ${pages.length} reads, ${read.length} games, none twice.`
      )

      // 8. The API: sorted reads, a paged walk, the admin's save, refusals.
      const lines: string[] = []
      const call = async (
        method: 'GET' | 'PUT',
        path: string,
        as: number,
        body?: unknown
      ): Promise<{ status: number; body: any }> => {
        const answer = await f.h.request(method, path, body, as)
        const json = await answer.json().catch(() => null)
        lines.push(
          `$ ${method} /api/v1${path.replace(f.leagueA, '<A>')}${body == null ? '' : ' ' + JSON.stringify(body)} (as ${as})`,
          `HTTP ${answer.status}`
        )
        return { status: answer.status, body: json }
      }
      const listRows = (body: {
        items: Array<{ id: string; seasonName: string; startAt: string }>
      }): void => {
        for (const row of body.items)
          lines.push(`  ${row.id}  ${row.seasonName}  ${row.startAt}`)
        lines.push('')
      }
      const full = `${api}/umpire-schedule?view=schedule&paged=1&limit=500`
      const bySeasonDown = await call('GET', `${full}&sort=-season`, 101)
      expect(bySeasonDown.status).equals(200)
      listRows(bySeasonDown.body)
      const seasonsDown = (
        bySeasonDown.body.items as Array<{ seasonName: string }>
      ).map(row => row.seasonName)
      expect(seasonsDown.lastIndexOf('Fall Minors')).lessThan(
        seasonsDown.indexOf('Demo Regular')
      )
      const byPriority = await call('GET', `${full}&sort=seasonPriority`, 101)
      listRows(byPriority.body)
      const byNone = await call('GET', `${full}&sort=none`, 101)
      listRows(byNone.body)
      const noneRows = byNone.body.items as Array<{ startAt: string }>
      expect(
        noneRows.every(
          (row, i) =>
            i === 0 ||
            Date.parse(row.startAt) >= Date.parse(noneRows[i - 1].startAt)
        )
      ).equals(true)
      const walked: string[] = []
      let cursor: string | null = null
      for (let turn = 0; turn < 200; turn++) {
        const step: { status: number; body: any } = await call(
          'GET',
          `${api}/umpire-schedule?view=schedule&paged=1&limit=2${cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
          101
        )
        expect(step.status).equals(200)
        const ids = (step.body.items as Array<{ id: string }>).map(
          row => row.id
        )
        lines.push(`  page ${turn + 1}: ${ids.join(' ')}`)
        walked.push(...ids)
        cursor = step.body.nextCursor
        if (cursor == null) break
      }
      lines.push('')
      expect(new Set(walked).size).equals(walked.length)
      expect(walked).deep.equals(
        (await sorted(101, 'schedule'))
          .map(row => row.id)
          .filter(id => walked.includes(id))
      )
      const saved = await call('PUT', `${api}/umpire-settings`, 101, {
        sort: ['season', '-certification']
      })
      expect(saved.status).equals(200)
      lines.push(JSON.stringify(saved.body), '')
      const refused = await call('PUT', `${api}/umpire-settings`, 104, {
        sort: ['season', '-certification']
      })
      expect(refused.status).equals(403)
      lines.push('')
      const priority = await call('PUT', `${api}/umpire-season-priority`, 104, {
        seasonIds: [FALL, f.seasonA]
      })
      expect(priority.status).equals(403)
      lines.push('')
      const bad = await call('GET', `${full}&sort=bogus`, 101)
      expect(bad.status).equals(400)
      lines.push(JSON.stringify(bad.body), '')

      // 9. Back to no league default.
      const reset = await call('PUT', `${api}/umpire-settings`, 101, {
        sort: null
      })
      expect(reset.status).equals(200)
      expect(reset.body.sort).equals(null)
      await writeFile(join(proofDir, 'schedule-sort-api.log'), lines.join('\n'))
      log.push('Sort steps 1–9 passed.')
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
      // Seven fixed columns: Date, Division, Home and Away team, Venue,
      // Field and Notes.
      expect(
        geometry.widths.slice(0, 7).every(w => w === geometry.widths[0])
      ).equals(true)
      expect(geometry.widths[0]).closeTo(
        Math.ceil(Math.max(98, geometry.dates) + 16),
        1
      )
      expect(geometry.widths[7]).closeTo(Math.ceil(geometry.pill + 32), 1)
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
      await savedFilterSteps()
      await sortSteps()
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
      // Before the step that makes it, a failure still leaves its state here.
      await mkdir(join(artifacts, 'support'), { recursive: true })
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
