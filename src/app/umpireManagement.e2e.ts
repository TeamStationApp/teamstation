import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { umpireDate } from '../common/umpireTime'
import { userIdOfGumbo } from '../common/userId'
import {
  type BrowserSession,
  browserSession,
  capture,
  contains,
  fill,
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
  process.env.TS_UMPIRE_NOW = UMPIRE_BROWSER_NOW
  const web = join(artifacts, 'support/umpire-web')
  await mkdir(web, { recursive: true })
  await cp(resolve('dist'), web, { recursive: true })
  const instant = Date.parse(UMPIRE_BROWSER_NOW)
  const clock = `<script>window.Date=new Proxy(Date,{construct(t,a){return Reflect.construct(t,a.length?a:[${instant}])},get(t,p){return p==='now'?()=>${instant}:Reflect.get(t,p)}})</script>`
  await writeFile(
    join(web, 'index.html'),
    (await readFile(join(web, 'index.html'), 'utf8')).replace(
      '<head>',
      '<head>' + clock
    )
  )
  const daemon = await maestro('umpireManagement2Browser')
  const only = process.argv.includes('--only')
    ? Number(process.argv[process.argv.indexOf('--only') + 1])
    : undefined
  try {
    for (const scenario of [1, 2, 3, 4, 5, 6, 7, 8]) {
      if (only != null && scenario !== only) continue
      console.log(`Starting scenario ${scenario}`)
      const f = await umpireBrowserFixture(web)
      let b: BrowserSession | undefined
      try {
        if (scenario >= 3) await readyUmpireBrowser(f)
        if (scenario === 4) {
          await f.h.db
            .insertInto('teams')
            .values({ id: 'tem_umpire_owls', name: 'Demo Owls' })
            .execute()
          await f.h.db
            .insertInto('season_teams')
            .values({
              season_id: f.seasonA,
              team_id: 'tem_umpire_owls',
              active: true
            })
            .execute()
          await f.h.db
            .insertInto('memberships')
            .values({
              id: 'mem_bobby',
              team_id: 'tem_umpire_owls',
              user_id: userIdOfGumbo(106),
              is_player: true,
              role: 'member'
            })
            .execute()
          await f.h.db
            .insertInto('league_umpires')
            .values({
              league_id: f.leagueA,
              user_id: userIdOfGumbo(106),
              granted_by: userIdOfGumbo(101)
            })
            .execute()
          await f.h.db
            .insertInto('umpire_certifications')
            .values({
              user_id: userIdOfGumbo(106),
              level_id: 'ulv_browser_majors',
              type_id: 'uty_field',
              enabled: true
            })
            .execute()
          await f.h.db
            .insertInto('games')
            .values({
              id: 'gam_umpire_g2',
              season_id: f.seasonA,
              home_team_id: f.teamA,
              away_team_id: f.teamB,
              start_at: new Date('2027-04-03T21:50:00Z'),
              end_at: new Date('2027-04-03T23:50:00Z'),
              timezone: 'America/Los_Angeles'
            })
            .execute()
        }
        if (scenario === 5 || scenario === 6) {
          const id = scenario === 5 ? 'gam_umpire_g4' : 'gam_umpire_g3'
          await f.h.db
            .insertInto('games')
            .values({
              id,
              season_id: f.seasonA,
              home_team_id: f.teamA,
              away_team_id: f.teamB,
              start_at: new Date(
                scenario === 5 ? '2027-04-01T11:00:00Z' : '2027-03-22T12:00:00Z'
              ),
              end_at: new Date(
                scenario === 5 ? '2027-04-01T13:00:00Z' : '2027-03-22T14:00:00Z'
              ),
              timezone: 'America/Los_Angeles',
              status: scenario === 5 ? 'scheduled' : 'final'
            })
            .execute()
          await f.h.db
            .insertInto('umpire_assignments')
            .values(
              (scenario === 5 ? [id, 'gam_umpire_g1'] : [id]).map(gameId => ({
                game_id: gameId,
                slot: 'uty_plate:1',
                user_id: userIdOfGumbo(103),
                assigned_by: userIdOfGumbo(103),
                credit_team_id: f.teamA
              }))
            )
            .execute()
        }
        if (scenario === 7) {
          await f.h.db
            .insertInto('scope_roles')
            .values({
              id: 'rol_browser_switch',
              user_id: userIdOfGumbo(103),
              scope_type: 'league',
              scope_id: f.leagueA,
              role: 'admin'
            })
            .execute()
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
        }
        b = await browserSession(
          daemon,
          `umpire-browser-${scenario}`,
          1280,
          800,
          artifacts
        )
        const { m, page, browser } = b
        // Hidden browser windows can suspend animation-frame polling.
        const waitForFunction = page.waitForFunction.bind(page)
        page.waitForFunction = async (fn, options, ...args) =>
          await waitForFunction(fn, { polling: 100, ...options }, ...args)
        const chooseTime = async (
          label: string,
          time: string
        ): Promise<void> => {
          const [hour, minute] = time.split(':').map(Number)
          await tap(m, label)
          await tap(
            m,
            `Hour ${String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0')}`
          )
          await tap(m, `Minute ${String(minute).padStart(2, '0')}`)
          await tap(m, `Period ${hour < 12 ? 'AM' : 'PM'}`)
          await tap(m, 'Use time')
        }
        const signIn = async (id: number, path: string): Promise<void> => {
          await browser.setCookie({
            name: 'ts_session',
            value: f.h.tokens.get(id)!,
            domain: new URL(f.h.origin).hostname,
            path: '/',
            httpOnly: true
          })
          await m.openBrowser({ url: f.h.origin + path })
        }
        const settings = `/groups/league/${f.leagueA}/settings`
        const open = async (path: string): Promise<void> => {
          await m.openBrowser({ url: f.h.origin + path })
        }
        const shot = async (name: string): Promise<void> => {
          await capture(m, artifacts, name)
        }
        if (scenario <= 2) {
          await signIn(101, settings)
          await contains(page, 'Enable umpire management')
          await m.tapOn({
            css: '[role="switch"][aria-label="Enable umpire management"]',
            timeout: 10000
          })
          await tap(m, 'Manage Umpire Types')
          await fill(m, 'Type name', 'Field')
          await page.waitForFunction(() =>
            [...document.querySelectorAll('[role="button"]')].some(
              n =>
                n.textContent === 'Add Type' &&
                n.getAttribute('aria-disabled') !== 'true'
            )
          )
          await tap(m, 'Add Type')
          await page.waitForFunction(() => {
            const input = document.querySelector<HTMLInputElement>(
              '[aria-label="Type name"]:is(input,textarea)'
            )
            return input !== null && input.value === ''
          })
          await open(settings)
          await tap(m, 'Manage Umpire Levels')
          await page.waitForSelector(
            '[aria-label="Level name"]:is(input,textarea)'
          )
          await fill(m, 'Level name', scenario === 1 ? 'majors' : 'minors')
          await tap(m, 'Add Level')
          await page.waitForFunction(() => {
            const input = document.querySelector<HTMLInputElement>(
              '[aria-label="Level name"]:is(input,textarea)'
            )
            return input !== null && input.value === ''
          })
          if (scenario === 1) {
            await shot('level-editor-after.png')
            await fill(m, 'Level name', 'minors')
            await tap(m, 'Add Level')
            await open(settings)
            await tap(m, 'Set Season Requirements')
            await contains(page, 'Demo Regular')
            await m.tapOn({ text: 'Select Demo Regular', role: 'checkbox' })
            await tap(m, 'Next')
            await contains(
              page,
              'Apply umpire requirements to the below seasons'
            )
            await shot('requirements-apply-after.png')
            await tap(m, 'Apply umpire requirements to the below seasons')
            await contains(page, 'majors')
            await shot('requirements-checklist-after.png')
            await open(settings)
            await contains(page, 'Enable umpire management')
            await shot('league-settings-after.png')
          } else {
            await open(settings)
            await tap(m, 'Manage Umpires')
            await fill(m, 'Search affiliated people', 'Uma')
            await tap(m, 'Uma L')
            await m.tapOn({ text: 'Uma L, minors, Field', role: 'button' })
            await page.waitForFunction(() => {
              const cell = document.querySelector(
                '[aria-label="Uma L, minors, Field"]'
              )
              return (
                cell !== null && cell.getAttribute('aria-pressed') === 'true'
              )
            })
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
            await fill(m, 'Search affiliated people', 'Billy')
            await shot('add-umpires-after.png')
          }
        } else if (scenario === 3) {
          await signIn(103, '/')
          await page.waitForSelector('[aria-label="Umpire Schedule"]')
          expect(await page.$('[aria-label="Umpire schedule"]')).equals(null)
          await shot('header-wide-after.png')
          await tap(m, 'Umpire Schedule')
          await contains(
            page,
            umpireDate('2027-04-04T00:00:00Z', 'America/Los_Angeles')
          )
          await shot('schedule-after.png')
          await m.tapOn({
            css: '[aria-label^="Sign Up, Plate"]',
            timeout: 10000
          })
          await contains(page, 'already playing then')
          await shot('signup-modal-after.png')
          await tap(m, 'Confirm')
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Uma L, uty_plate:1"]'
          )
          expect(
            (
              await f.h.db
                .selectFrom('umpire_assignments')
                .selectAll()
                .execute()
            ).length
          ).equals(1)
          await open('/games/gam_umpire_g1')
          await contains(page, 'Plate: Uma L')
          await m.scrollUntilVisible({
            element: { text: 'Plate: Uma L' },
            direction: 'down'
          })
          await shot('game-screen-after.png')
          await recordBrowserCoverage(
            [page],
            f.h.origin,
            join(artifacts, 'support/browser-3-wide.json'),
            web
          )
          await browser.close()
          await m.detach()
          b = undefined
          b = await browserSession(
            daemon,
            'umpire-browser-narrow',
            390,
            844,
            artifacts
          )
          await b.browser.setCookie({
            name: 'ts_session',
            value: f.h.tokens.get(103)!,
            domain: new URL(f.h.origin).hostname,
            path: '/',
            httpOnly: true
          })
          await b.m.openBrowser({ url: f.h.origin })
          await b.page.waitForSelector('[aria-label="Umpire Schedule"]')
          await capture(b.m, artifacts, 'header-narrow-after.png')
        } else if (scenario === 4) {
          await signIn(103, `/umpires/${f.leagueA}`)
          await contains(page, 'Field')
          await shot('schedule-conflict-after.png')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Conflict"]'
          })
          await contains(page, 'Billy L')
          await shot('conflict-modal-after.png')
          await tap(m, 'Cancel')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g1"] [aria-label^="Sign Up, Field"]'
          })
          await contains(page, 'Bobby L')
          await contains(page, 'not certified for Field')
          await tap(m, 'Demo Hawks')
          await tap(m, 'Confirm')
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Bobby L, uty_field:1"]'
          )
          const row = await f.h.db
            .selectFrom('umpire_assignments')
            .selectAll()
            .where('game_id', '=', 'gam_umpire_g1')
            .executeTakeFirstOrThrow()
          expect(row.user_id).equals(userIdOfGumbo(106))
          expect(row.credit_team_id).equals(f.teamA)
        } else if (scenario === 5) {
          await signIn(103, `/umpires/${f.leagueA}`)
          await contains(page, 'Uma L')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Uma L, uty_plate:1"]'
          })
          await tap(m, 'Remove assignment')
          await page.waitForFunction(
            () =>
              document.querySelector(
                '[data-testid="umpire-game-gam_umpire_g1"] [aria-label^="Sign Up, Plate"]'
              ) !== null
          )
          expect(
            await page.$eval(
              '[data-testid="umpire-game-gam_umpire_g4"] [aria-label="Uma L, uty_plate:1"]',
              n => n.getAttribute('aria-disabled')
            )
          ).equals('true')
          await signIn(101, `/umpires/${f.leagueA}?view=league`)
          await contains(page, 'Uma L')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g4"] [aria-label="Uma L, uty_plate:1"]'
          })
          await tap(m, 'Remove assignment')
          await page.waitForFunction(
            () =>
              document.querySelector(
                '[data-testid="umpire-game-gam_umpire_g4"] [aria-label^="Sign Up, Plate"]'
              ) !== null
          )
          expect(
            await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
          ).deep.equals([])
        } else if (scenario === 6) {
          await signIn(101, settings)
          await tap(m, 'Umpire schedule')
          await tap(m, 'Leaderboard', 'tab')
          await contains(page, 'COMPLETED GAMES')
          await contains(page, 'Uma L')
          await shot('leaderboard-after.png')
        } else if (scenario === 7) {
          await signIn(103, '/')
          await tap(m, 'Umpire Schedule')
          await contains(page, 'Demo Visitors')
          await tap(m, 'League view', 'tab')
          await shot('league-switcher-after.png')
          await tap(m, 'Schedule filters')
          await tap(m, 'majors')
          await tap(m, 'Apply filters')
          await tap(m, 'Demo Visitors')
          await contains(page, 'No games match this schedule.')
          const switched = new URL(page.url())
          expect(switched.searchParams.get('view')).equals('umpire')
          expect(switched.searchParams.has('levels')).equals(false)
          await tap(m, 'Schedule filters')
          await chooseTime('Start time', '18:00')
          await chooseTime('End time', '17:00')
          await contains(page, 'End time must be after start time.')
          await tap(m, 'Cancel')
        }
        if (scenario === 8) {
          await f.h.db
            .updateTable('seasons')
            .set({
              starts_on: '2027-03-02',
              ends_on: '2027-06-30',
              name: 'Demo Playoffs with a long regional tournament season name'
            })
            .where('id', '=', f.playoffs)
            .execute()
          const base = `/groups/league/${f.leagueA}`
          const toggle =
            '[role="switch"][aria-label="Enable umpire management"]'
          await signIn(101, settings)
          await page.waitForSelector(toggle)
          const settingsLayout = await page.evaluate(() => {
            const leaf = (text: string): HTMLElement =>
              [...document.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
                n => n.textContent === text
              )!
            const details = leaf('LEAGUE DETAILS')
            const umpire = leaf('UMPIRE MANAGEMENT')
            return {
              last:
                leaf('LEAGUE MANAGEMENT').compareDocumentPosition(umpire) &
                Node.DOCUMENT_POSITION_FOLLOWING,
              detailsGap: getComputedStyle(
                details.parentElement!.parentElement!
              ).gap,
              umpireGap: getComputedStyle(umpire.parentElement!.parentElement!)
                .gap,
              sectionGap:
                umpire.parentElement!.parentElement!.getBoundingClientRect()
                  .top -
                leaf(
                  'LEAGUE MANAGEMENT'
                ).parentElement!.parentElement!.getBoundingClientRect().bottom,
              expectedSectionGap: parseFloat(
                getComputedStyle(
                  umpire.parentElement!.parentElement!.parentElement!
                ).gap
              ),
              rowColor: getComputedStyle(leaf('Manage Umpire Levels')).color
            }
          })
          expect(settingsLayout.last).not.equals(0)
          expect(settingsLayout.umpireGap).equals(settingsLayout.detailsGap)
          expect(settingsLayout.sectionGap).equals(
            settingsLayout.expectedSectionGap
          )
          await m.tapOn({ css: toggle, timeout: 10000 })
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLInputElement>(
                '[aria-label="Enable umpire management"]'
              )!.checked
          )
          for (const label of [
            'Manage Umpire Levels',
            'Set Season Requirements',
            'Manage Umpires',
            'Umpire schedule'
          ]) {
            expect(
              await page.$eval(`[aria-label="${label}"]`, n =>
                n.getAttribute('aria-disabled')
              )
            ).equals('true')
          }
          expect(
            await page.$eval(
              '[aria-label="Enable Team Credits"]',
              n => (n as HTMLInputElement).disabled
            )
          ).equals(true)
          const muted = await page.$eval(
            '[aria-label="Manage Umpire Levels"]',
            n => getComputedStyle(n.firstElementChild!.firstElementChild!).color
          )
          expect(muted).not.equals(settingsLayout.rowColor)
          await m.tapOn({ css: toggle, timeout: 10000 })
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLInputElement>(
                '[aria-label="Enable Team Credits"]'
              )!.disabled
          )
          expect(
            await page.$eval(
              '[aria-label="Enable Team Credits"]',
              n => (n as HTMLInputElement).checked
            )
          ).equals(true)
          console.log('E1 settings passed')
          await tap(m, 'Manage Umpire Levels')
          await page.setViewport(null)
          await page.setViewport({ width: 390, height: 844 })
          await page.waitForSelector('[aria-label="Remove majors"]')
          const editor = await page.evaluate(() => {
            const remove = document.querySelector<HTMLElement>(
              '[aria-label="Remove majors"]'
            )!
            const input = document.querySelector<HTMLInputElement>(
              '[aria-label="Level name"]'
            )!
            const add = [
              ...document.querySelectorAll<HTMLElement>('[role="button"]')
            ].find(n => n.textContent === 'Add Level')!
            return {
              rowHeight: remove.parentElement!.getBoundingClientRect().height,
              targetHeight: remove.getBoundingClientRect().height,
              hint: input.placeholder,
              caps: input.autocapitalize,
              ordered:
                add.getBoundingClientRect().bottom <=
                remove.parentElement!.getBoundingClientRect().top
            }
          })
          expect(editor.rowHeight).within(50, 64)
          expect(editor.targetHeight).at.least(48)
          expect(editor.hint).equals('ie. Majors, Minors, AA, AAA')
          expect(editor.caps).equals('words')
          expect(editor.ordered).equals(true)
          await fill(m, 'Level name', 'AA')
          await tap(m, 'Add Level')
          await page.waitForSelector('[aria-label="Remove AA"]')
          await tap(m, 'Remove AA')
          await page.waitForSelector('[aria-label="Remove AA"]', {
            hidden: true
          })
          await tap(m, 'Remove majors')
          await contains(page, 'Removing level “majors”')
          await tap(m, 'Cancel')
          await fill(m, 'Level name', 'AAA')
          await tap(m, 'Add Level')
          await page.waitForSelector('[aria-label="Remove AAA"]')
          await fill(m, 'Level name', 'AAA')
          await tap(m, 'Add Level')
          await page.waitForSelector('[role="alert"]')
          await fill(
            m,
            'Level name',
            'AAA advanced certification for regional tournament games'
          )
          await tap(m, 'Add Level')
          await page.waitForSelector(
            '[aria-label="Remove AAA advanced certification for regional tournament games"]'
          )
          await page.setViewport(null)
          await page.setViewport({ width: 390, height: 844 })
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).equals(true)
          console.log('E2 levels passed')
          await open(base + '/umpire-requirements')
          const season = '[aria-label="Select Demo Regular"]'
          await page.waitForSelector(season)
          const check = await page.$eval(season, n => ({
            text: n.textContent,
            target: n.getBoundingClientRect().width,
            box: n
              .querySelector('[data-testid="checkbox-square"]')!
              .getBoundingClientRect().width
          }))
          expect(check).deep.equals({ text: '', target: 48, box: 24 })
          const paddedPoint = await page.$eval(season, n => {
            const r = n.getBoundingClientRect()
            return { x: Math.round(r.x + 2), y: Math.round(r.y + r.height / 2) }
          })
          await m.command('tapOnPoint', paddedPoint)
          expect(
            await page.$eval(season, n => n.getAttribute('aria-checked'))
          ).equals('true')
          await m.pressKey({ key: 'SPACE' })
          await page.waitForFunction(
            () =>
              document
                .querySelector('[aria-label="Select Demo Regular"]')!
                .getAttribute('aria-checked') === 'false'
          )
          await m.pressKey({ key: 'ENTER' })
          await page.waitForFunction(
            () =>
              document
                .querySelector('[aria-label="Select Demo Regular"]')!
                .getAttribute('aria-checked') === 'true'
          )
          await m.tapOn({
            css: '[aria-label="Select Demo Playoffs with a long regional tournament season name"]',
            timeout: 10000
          })
          await tap(m, 'Next')
          await tap(m, 'Required Plate')
          await tap(m, 'Required Plate 0')
          await tap(m, 'Done')
          await tap(m, 'Apply umpire requirements to the below seasons')
          await contains(page, 'Select seasons to apply umpire needs.')
          const requirements = await f.h.db
            .selectFrom('season_umpire_type_requirements')
            .selectAll()
            .where('type_id', '=', 'uty_plate')
            .where('season_id', 'in', [f.seasonA, f.playoffs])
            .execute()
          expect(requirements).length(2)
          expect(requirements.every(r => r.required_count === 0)).equals(true)
          console.log('E3 selection passed')
          // Restore the shared schedule fixture after testing the persisted selection.
          await seedUmpireCounts(f.h.db, f.seasonA, true, 1)
          await signIn(103, `/umpires/${f.leagueA}`)
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"]'
          )
          for (const width of [1920, 1280, 390]) {
            await page.setViewport({ width, height: width === 390 ? 844 : 800 })
            await page.waitForFunction(() => {
              const row = document.querySelector(
                '[data-testid="umpire-game-gam_umpire_g1"]'
              )!
              const viewport = document.querySelector(
                '[data-testid="umpire-table-body-scroll"]'
              )!
              return (
                Math.abs(
                  row.children[0].getBoundingClientRect().width -
                    Math.max(
                      160,
                      viewport.getBoundingClientRect().width /
                        row.children.length
                    )
                ) < 2
              )
            })
            const geometry = await page.evaluate(() => {
              const row = document.querySelector(
                '[data-testid="umpire-game-gam_umpire_g1"]'
              )!
              const header = document.querySelector(
                '[data-testid="umpire-table-header"]'
              )!
              const viewport = document.querySelector(
                '[data-testid="umpire-table-body-scroll"]'
              )!
              const funnel = document.querySelector(
                '[aria-label="Schedule filters"]'
              )!
              return {
                widths: [...row.children].map((n, i) => [
                  n.getBoundingClientRect().width,
                  header.children[i].getBoundingClientRect().width
                ]),
                table: row.getBoundingClientRect().width,
                viewport: viewport.getBoundingClientRect().width,
                funnel: funnel.getBoundingClientRect().width,
                overflow: document.documentElement.scrollWidth > innerWidth,
                action: document
                  .querySelector('[aria-label^="Sign Up, Plate"]')!
                  .getBoundingClientRect().height,
                pills: [
                  ...row.querySelectorAll(
                    '[data-testid="text-width-button-pill"]'
                  )
                ].map(n => ({
                  width: n.getBoundingClientRect().width,
                  height: n.getBoundingClientRect().height,
                  cell: n.parentElement!.parentElement!.getBoundingClientRect()
                    .width,
                  padding: getComputedStyle(n).paddingLeft
                }))
              }
            })
            expect(
              geometry.widths.every(([a, b]) => Math.abs(a - b) < 1)
            ).equals(true)
            expect(geometry.funnel).lessThan(100)
            expect(geometry.overflow).equals(false)
            expect(geometry.action).equals(48)
            expect(geometry.pills.length).greaterThan(0)
            for (const pill of geometry.pills) {
              expect(pill.height).equals(36)
              expect(pill.width).lessThan(pill.cell - 20)
              expect(pill.padding).equals('18px')
            }
            if (width === 1920)
              expect(Math.abs(geometry.table - geometry.viewport)).lessThan(2)
            if (width === 390)
              expect(geometry.table).greaterThan(geometry.viewport)
            console.log('E4 measured layout', width, JSON.stringify(geometry))
          }
          await tap(m, 'Schedule filters')
          await page.setViewport({ width: 320, height: 844 })
          await page.waitForFunction(() => {
            const first = document.querySelector('[aria-label="Monday"]')!
            const last = document.querySelector('[aria-label="Sunday"]')!
            return (
              last.getBoundingClientRect().right <=
              first.parentElement!.parentElement!.parentElement!.getBoundingClientRect()
                .right
            )
          })
          const narrowDays = await page.evaluate(() => {
            const monday = document.querySelector('[aria-label="Monday"]')!
            const sunday = document.querySelector('[aria-label="Sunday"]')!
            const clip =
              monday.parentElement!.parentElement!.parentElement!.getBoundingClientRect()
            return {
              left: monday.getBoundingClientRect().left,
              right: sunday.getBoundingClientRect().right,
              clipLeft: clip.left,
              clipRight: clip.right,
              width: sunday.getBoundingClientRect().width
            }
          })
          expect(narrowDays.left).at.least(narrowDays.clipLeft)
          expect(narrowDays.right).at.most(narrowDays.clipRight)
          expect(narrowDays.width).at.least(40)
          await page.setViewport({ width: 390, height: 844 })
          const filterGeometry = await page.evaluate(() => {
            const names = [
              'Monday',
              'Tuesday',
              'Wednesday',
              'Thursday',
              'Friday',
              'Saturday',
              'Sunday'
            ]
            const days = names.map(name => {
              const n = document.querySelector(`[aria-label="${name}"]`)!
              const r = n.getBoundingClientRect()
              return {
                text: n.textContent,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                circle: n.firstElementChild!.getBoundingClientRect().width
              }
            })
            const a = document
              .querySelector('[aria-label="Start time"]')!
              .getBoundingClientRect()
            const b = document
              .querySelector('[aria-label="End time"]')!
              .getBoundingClientRect()
            return { days, timeY: [a.y, b.y], timeWidth: [a.width, b.width] }
          })
          expect(filterGeometry.days.map(d => d.text)).deep.equals([
            'M',
            'T',
            'W',
            'T',
            'F',
            'S',
            'S'
          ])
          expect(new Set(filterGeometry.days.map(d => d.y)).size).equals(1)
          expect(
            filterGeometry.days.every(
              d => d.width >= 40 && d.height >= 44 && d.circle === 32
            )
          ).equals(true)
          expect(filterGeometry.timeY[0]).equals(filterGeometry.timeY[1])
          expect(filterGeometry.timeWidth[0]).closeTo(
            filterGeometry.timeWidth[1],
            1
          )
          await tap(m, 'Monday')
          await tap(m, 'Sunday')
          await tap(m, 'majors')
          await tap(m, 'AAA')
          await tap(
            m,
            'AAA advanced certification for regional tournament games'
          )
          expect(
            await page.$eval(
              '[aria-label="AAA advanced certification for regional tournament games"]',
              n => n.getBoundingClientRect().right <= innerWidth
            )
          ).equals(true)
          await chooseTime('Start time', '08:00')
          await chooseTime('End time', '18:00')
          await page.setViewport(null)
          await page.setViewport({ width: 390, height: 844 })
          await tap(m, 'Apply filters')
          await contains(page, 'No games match this schedule.')
          const applied = new URL(page.url()).search
          expect(new URL(page.url()).searchParams.get('days')).equals('0,6')
          await tap(m, 'Schedule filters')
          await tap(m, 'Monday')
          await chooseTime('Start time', '10:00')
          await tap(m, 'Cancel')
          expect(new URL(page.url()).search).equals(applied)
          await tap(m, 'Schedule filters')
          await chooseTime('End time', '07:00')
          await page.setViewport(null)
          await page.setViewport({ width: 390, height: 844 })
          await contains(page, 'End time must be after start time.')
          await tap(m, 'Clear filters')
          await tap(m, 'Apply filters')
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"]'
          )
          for (const key of ['days', 'levels', 'from', 'to'])
            expect(new URL(page.url()).searchParams.has(key)).equals(false)
          await tap(m, 'Schedule filters')
          expect(
            await page.$eval('[aria-label="Monday"]', n =>
              n.getAttribute('aria-pressed')
            )
          ).equals('false')
          expect(
            await page.$eval('[aria-label="Start time"]', n => n.textContent)
          ).contains('Any time')
          await shot('support/filters-clear-integration.png')
          await tap(m, 'Cancel')
          await m.command('back')
          await contains(page, 'No games match this schedule.')
          await open(`/umpires/${f.leagueA}?days=5&from=08%3A00&to=18%3A00`)
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"]'
          )
          await f.h.db
            .updateTable('season_umpire_type_requirements')
            .set({ required_count: 2 })
            .where('type_id', '=', 'uty_field')
            .where('season_id', '=', f.seasonA)
            .execute()
          await page.setViewport({ width: 1920, height: 800 })
          await open(`/umpires/${f.leagueA}`)
          await contains(page, 'Field 2')
          await page.waitForFunction(() => {
            const row = document.querySelector(
              '[data-testid="umpire-game-gam_umpire_g1"]'
            )!
            return (
              row.children.length === 9 &&
              Math.abs(row.getBoundingClientRect().width - 1872) < 2
            )
          })
          await signIn(101, base + '/umpire-levels')
          await page.waitForSelector('[aria-label="Remove AAA"]')
          await tap(m, 'Remove AAA')
          await tap(
            m,
            'Remove AAA advanced certification for regional tournament games'
          )
          await tap(m, 'Remove majors')
          await tap(m, 'Remove level')
          await page.waitForSelector('[aria-label="Remove majors"]', {
            hidden: true
          })
          await open(settings)
          await page.waitForSelector(
            '[aria-label="Set Season Requirements"][aria-disabled="true"]'
          )
          await open(`/umpires/${f.leagueA}?view=league`)
          await tap(m, 'Schedule filters')
          expect(await page.$$('[aria-pressed]')).length(7)
          await tap(m, 'Clear filters')
          await tap(m, 'Apply filters')
          console.log(
            'E1–E6 follow-up settings, selection, geometry, filters, persistence, and history passed'
          )
        }
        console.log(`Scenario ${scenario} passed`)
      } catch (error) {
        if (b != null)
          await writeFile(
            join(artifacts, `scenario-${scenario}-failure.txt`),
            await b.page.evaluate(() => document.body.innerText)
          )
        throw error
      } finally {
        try {
          if (b != null) {
            try {
              await recordBrowserCoverage(
                [b.page],
                f.h.origin,
                join(artifacts, `support/browser-${scenario}.json`),
                web
              )
            } finally {
              await b.browser.close()
              await b.m.detach()
            }
          }
        } finally {
          await f.h.close()
        }
      }
    }
  } finally {
    await daemon.shutdown()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
