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
  const daemon = await maestro('umpireManagementBrowser')
  const only = process.argv.includes('--only')
    ? Number(process.argv[process.argv.indexOf('--only') + 1])
    : undefined
  try {
    for (const scenario of [1, 2, 3, 4, 5, 6, 7]) {
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
              plate: false,
              field: true
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
                slot: 'plate',
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
          await contains(page, 'Umpire management')
          await m.tapOn({
            css: '[role="switch"][aria-label="Umpire management"]',
            timeout: 10000
          })
          await tap(m, 'Create Umpire Levels')
          await page.waitForSelector('input[aria-label="Level name"]')
          await fill(m, 'Level name', scenario === 1 ? 'majors' : 'minors')
          await tap(m, 'Add level')
          await page.waitForFunction(() => {
            const input = document.querySelector<HTMLInputElement>(
              'input[aria-label="Level name"]'
            )
            return input !== null && input.value === ''
          })
          if (scenario === 1) {
            await shot('level-editor-after.png')
            await fill(m, 'Level name', 'minors')
            await tap(m, 'Add level')
            await open(settings)
            await tap(m, 'Set Requirements')
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
            await contains(page, 'Umpire management')
            await shot('league-settings-after.png')
          } else {
            await open(settings)
            await tap(m, 'Add Umpires')
            await fill(m, 'Search affiliated people', 'Uma')
            await tap(m, 'Uma L')
            await m.tapOn({ text: 'Uma L, minors, field', role: 'checkbox' })
            await page.waitForFunction(() => {
              const cell = document.querySelector(
                '[aria-label="Uma L, minors, field"]'
              )
              return (
                cell !== null && cell.getAttribute('aria-checked') === 'true'
              )
            })
            await fill(m, 'Search affiliated people', 'Billy')
            await shot('add-umpires-after.png')
          }
        } else if (scenario === 3) {
          await signIn(103, '/')
          await page.waitForSelector('[aria-label="Umpire schedule"]')
          await shot('header-wide-after.png')
          await tap(m, 'Umpire schedule')
          await contains(
            page,
            umpireDate('2027-04-04T00:00:00Z', 'America/Los_Angeles')
          )
          await shot('schedule-after.png')
          await tap(m, 'Plate umpire')
          await contains(page, 'already playing then')
          await shot('signup-modal-after.png')
          await tap(m, 'Confirm')
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Uma L, plate"]'
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
          await contains(page, 'Plate umpire: Uma L')
          await m.scrollUntilVisible({
            element: { text: 'Plate umpire: Uma L' },
            direction: 'down'
          })
          await shot('game-screen-after.png')
          await recordBrowserCoverage(
            [page],
            f.h.origin,
            join(artifacts, 'support/browser-3-wide.json'),
            web
          )
          await browser.disconnect()
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
          await b.page.waitForSelector('[aria-label="Umpire schedule"]')
          await capture(b.m, artifacts, 'header-narrow-after.png')
        } else if (scenario === 4) {
          await signIn(103, `/umpires/${f.leagueA}`)
          await contains(page, 'Field ump 1')
          await shot('schedule-conflict-after.png')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Conflict"]'
          })
          await contains(page, 'Billy L')
          await shot('conflict-modal-after.png')
          await tap(m, 'Cancel')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Field ump 1"]'
          })
          await contains(page, 'Bobby L')
          await contains(page, 'not certified for field ump')
          await tap(m, 'Demo Hawks')
          await tap(m, 'Confirm')
          await page.waitForSelector(
            '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Bobby L, field:1"]'
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
            css: '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Uma L, plate"]'
          })
          await tap(m, 'Remove assignment')
          await page.waitForFunction(
            () =>
              document.querySelector(
                '[data-testid="umpire-game-gam_umpire_g1"] [aria-label="Plate umpire"]'
              ) !== null
          )
          expect(
            await page.$eval(
              '[data-testid="umpire-game-gam_umpire_g4"] [aria-label="Uma L, plate"]',
              n => n.getAttribute('aria-disabled')
            )
          ).equals('true')
          await signIn(101, `/umpires/${f.leagueA}?view=league`)
          await contains(page, 'Uma L')
          await m.tapOn({
            css: '[data-testid="umpire-game-gam_umpire_g4"] [aria-label="Uma L, plate"]'
          })
          await tap(m, 'Remove assignment')
          await page.waitForFunction(
            () =>
              document.querySelector(
                '[data-testid="umpire-game-gam_umpire_g4"] [aria-label="Plate umpire"]'
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
        } else {
          await signIn(103, '/')
          await tap(m, 'Umpire schedule')
          await contains(page, 'Demo Visitors')
          await tap(m, 'League view', 'tab')
          await shot('league-switcher-after.png')
          await tap(m, 'Filters')
          await tap(m, 'majors', 'checkbox')
          await tap(m, 'Apply filters')
          await tap(m, 'Demo Visitors')
          await contains(page, 'No games match this schedule.')
          const switched = new URL(page.url())
          expect(switched.searchParams.get('view')).equals('umpire')
          expect(switched.searchParams.has('levels')).equals(false)
          await tap(m, 'Filters')
          await fill(m, 'Start time', '18:00')
          await fill(m, 'End time', '17:00')
          await contains(page, 'End time must be after start time.')
          await tap(m, 'Cancel')
        }
        console.log(`Scenario ${scenario} passed`)
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
              await b.browser.disconnect()
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
