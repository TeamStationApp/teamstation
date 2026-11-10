// Set TS_MANAGER_ARTIFACTS to the proof directory and run after build.web:
// node -r sucrase/register src/app/headCoach.e2e.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer from 'puppeteer'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import type { SchedulePreview } from '../common/schedulePreviews'
import { userIdOfGumbo } from '../common/userId'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  autoSchedulerFixture,
  G1,
  seedHarborField,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'

async function main(): Promise<void> {
  const dir = process.env.TS_MANAGER_ARTIFACTS
  if (dir == null) throw new Error('Set TS_MANAGER_ARTIFACTS')
  await mkdir(dir, { recursive: true })
  const places = await googlePlacesStub()
  const cleanup: Array<() => Promise<void>> = [places.close]
  try {
    const fx = await autoSchedulerFixture(resolve('dist'), {
      cityLookup: googlePlaces({ apiKey: 'test', baseUrl: places.baseUrl })
    })
    const { f } = fx
    cleanup.push(async () => {
      await f.h.close()
    })
    const browser = await puppeteer.launch({ headless: true })
    cleanup.push(async () => {
      await browser.close()
    })
    const { fieldId } = await seedThrough(fx, 'E7')
    await api(fx, 101, 'PUT', `/leagues/${f.leagueA}/schedule-setup`, {
      seasonIds: [f.seasonA],
      fieldIds: [fieldId!, await seedHarborField(fx)]
    })
    const first = userIdOfGumbo(104)
    const second = userIdOfGumbo(106)
    for (const userId of [first, second]) {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: `mem_${userId}`,
          team_id: f.teamA,
          user_id: userId,
          is_player: userId === first
        })
        .execute()
    }
    await f.h.db
      .insertInto('game_rsvps')
      .values({ event_id: G1, user_id: first, response: 'yes' })
      .execute()
    const page = await browser.newPage()
    const coverage = process.env.TS_MANAGER_BROWSER_COVERAGE
    if (coverage != null)
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
    const press = async (selector: string): Promise<void> => {
      await page.waitForSelector(selector, { visible: true })
      await page.locator(selector).click()
    }
    await page.setViewport({ width: 640, height: 980 })
    await browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(101)!,
      domain: new URL(f.h.origin).hostname,
      path: '/'
    })
    const visit = async (path: string): Promise<void> => {
      await page.goto(f.h.origin + path, { waitUntil: 'networkidle0' })
    }
    const shot = async (name: string, word: string): Promise<void> => {
      await page.waitForFunction(
        (w: string) => document.body.innerText.includes(w),
        {},
        word
      )
      await page.evaluate((w: string) => {
        const el = [...document.querySelectorAll('div,span')].find(
          e => e.childNodes.length === 1 && e.textContent === w
        )
        if (el != null) el.scrollIntoView({ block: 'center' })
      }, word)
      // Wait for the bottom sheet and role switch to finish their entrance.
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter(
              animation =>
                animation.playState === 'running' &&
                Number.isFinite(
                  animation.effect === null
                    ? 0
                    : animation.effect.getTiming().iterations
                )
            )
            .map(
              async animation => await animation.finished.catch(() => undefined)
            )
        )
      })
      await page.screenshot({ path: join(dir, name + '.png') })
    }
    const profile = (id: string): string => `/teams/${f.teamA}/people/${id}`
    const toggle = '[data-testid="role-team-headCoach-switch"]'
    const label = 'Manager/Head Coach'
    await visit(profile(first))
    await press(toggle)
    await page.waitForSelector(toggle + '[aria-checked="true"]')
    await shot('profile-after', label)
    await visit(profile(second))
    await press(toggle)
    await shot('replacement', 'Replace Manager/Head Coach?')
    await press('[aria-label="Cancel confirmation"]')
    await page.waitForSelector(toggle + '[aria-checked="false"]')
    await press(toggle)
    await press('[aria-label="Confirm replacement"]')
    await page.waitForSelector(toggle + '[aria-checked="true"]')
    await visit(profile(first))
    await page.waitForSelector(toggle + '[aria-checked="false"]')
    await page.waitForSelector(
      '[data-testid="role-team-coach-switch"][aria-checked="true"]'
    )
    await press(toggle)
    await press('[aria-label="Confirm replacement"]')
    await page.waitForSelector(toggle + '[aria-checked="true"]')
    await visit(`/players/${first}?tab=settings&onTeam=${f.teamA}`)
    await shot('player-after', label)
    await visit(`/teams/${f.teamA}?tab=team`)
    await shot('team-after', label)
    const publicContext = await browser.createBrowserContext()
    const publicPage = await publicContext.newPage()
    if (coverage != null)
      await publicPage.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
    await publicPage.setViewport({ width: 640, height: 980 })
    await publicPage.goto(f.h.origin + `/teams/${f.teamA}?tab=team`, {
      waitUntil: 'networkidle0'
    })
    await publicPage.waitForFunction(
      (name: string) => document.body.innerText.includes(name),
      {},
      label
    )
    await publicPage.screenshot({ path: join(dir, 'people-after.png') })
    await visit(`/games/${G1}?tab=info`)
    const teamChoice =
      '[data-testid="event-attendance-teams"] [aria-label="Demo Hawks"]'
    if ((await page.$(teamChoice)) != null) await press(teamChoice)
    await shot('attendance-after', label)
    await visit(`/groups/league/${f.leagueA}/scheduler`)
    const constraint = '[aria-label="Avoid manager/head coach double bookings"]'
    await page.waitForSelector(constraint)
    const checked = async (): Promise<boolean> =>
      await page.$eval(constraint, el => (el as HTMLInputElement).checked)
    expect(await checked()).equals(true)
    await shot('scheduler-after', 'Avoid manager/head coach double bookings')
    await page.setViewport({ width: 375, height: 812 })
    const readable = await page.evaluate(() => {
      const label = [
        ...document.querySelectorAll<HTMLElement>('div,span')
      ].find(
        el =>
          el.firstChild !== null &&
          el.firstChild.nodeType === Node.TEXT_NODE &&
          el.textContent === 'Avoid manager/head coach double bookings'
      )
      return label != null && label.scrollWidth <= label.clientWidth
    })
    expect(readable, 'The full constraint label fits at phone width').equals(
      true
    )
    await press(constraint)
    await page.waitForNetworkIdle()
    await page.reload({ waitUntil: 'networkidle0' })
    expect(await checked()).equals(false)
    await page.setViewport({ width: 1100, height: 1100 })
    const setupPath = `/groups/league/${f.leagueA}/scheduler`
    const button = (text: string): string =>
      `::-p-aria([role="button"][name="${text}"])`
    const generate = async (): Promise<SchedulePreview> => {
      await press(button('Build schedule'))
      await press(button('Work around them'))
      await page.waitForSelector('[data-testid="preview-game"]')
      const id = new URL(page.url()).pathname.split('/').at(-1)!
      const response = await f.h.request(
        'GET',
        `/schedule-previews/${id}`,
        undefined,
        101
      )
      expect(response.status).equals(200)
      return (await response.json()) as SchedulePreview
    }
    const baseline = await generate()
    const managed = (
      g: SchedulePreview['options'][number]['games'][number]
    ): boolean => [g.homeTeamId, g.awayTeamId].includes(f.teamA)
    const firstGame = baseline.options[0].games.find(managed)!
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'outside_manager',
        role: 'coach',
        scope_type: 'team',
        scope_id: f.teamB,
        is_head_coach: true,
        user_id: first
      })
      .execute()
    const outsideGame = async (
      id: string,
      game: typeof firstGame
    ): Promise<void> => {
      await f.h.db
        .insertInto('games')
        .values({
          id,
          season_id: f.seasonB,
          home_team_id: f.teamB,
          away_team_id: 'tem_account',
          start_at: new Date(game.startAt),
          end_at: new Date(game.endAt),
          status: 'scheduled'
        })
        .execute()
    }
    await outsideGame('browser_external', firstGame)
    await visit(setupPath)
    const unchecked = await generate()
    expect(
      unchecked.options[0].games.some(
        g => managed(g) && g.startAt === firstGame.startAt
      )
    ).equals(true)
    await visit(setupPath)
    await press(constraint)
    await page.waitForNetworkIdle()
    expect(await checked()).equals(true)
    const protectedPreview = await generate()
    for (const option of protectedPreview.options)
      for (const game of option.games.filter(managed))
        expect(
          game.startAt < firstGame.endAt && firstGame.startAt < game.endAt
        ).equals(false)
    // Edit the preview through the schedule screen before another league books the manager.
    await press('[aria-label^="Reject "]')
    await press(button('Reject'))
    const notice = async (message: string): Promise<void> => {
      await page.waitForFunction(
        (text: string) => document.body.innerText.includes(text),
        {},
        message
      )
    }
    await notice('Game rejected.')
    const edited = (await (
      await f.h.request(
        'GET',
        `/schedule-previews/${protectedPreview.id}`,
        undefined,
        101
      )
    ).json()) as SchedulePreview
    const stale = edited.options[0].games.find(
      g => managed(g) && !edited.edits.rejectedGameKeys.includes(g.key)
    )!
    await outsideGame('browser_stale', stale)
    const [refusal] = await Promise.all([
      page.waitForResponse(reply =>
        reply
          .url()
          .endsWith(`/schedule-previews/${protectedPreview.id}/publications`)
      ),
      press(button('Publish this option'))
    ])
    expect(refusal.status()).equals(409)
    expect(await refusal.text()).includes('Manager/Head Coach')
    await shot(
      'scheduler-stale-publication',
      'Something changed since this preview was built. Build it again.'
    )
    expect(
      await f.h.db
        .selectFrom('games')
        .select('id')
        .where('schedule_preview_id', '=', protectedPreview.id)
        .execute()
    ).deep.equals([])

    const log = ['$ node -r sucrase/register src/app/headCoach.e2e.ts']
    for (const [method, user, actor, body, status] of [
      ['PUT', second, 102, {}, 404],
      ['PUT', second, 101, {}, 409],
      ['PUT', second, 101, { expectedHeadCoach: first }, 200],
      ['DELETE', second, 101, undefined, 200]
    ] as const) {
      const path = `/manage/team/${f.teamA}/people/${user}/roles/headCoach`
      const response = await f.h.request(method, path, body, actor)
      log.push(`${method} ${path} as ${userIdOfGumbo(actor)} ${JSON.stringify(body) ?? ''}
${response.status} ${await response.text()}`)
      expect(response.status).equals(status)
    }
    if (coverage != null)
      await recordBrowserCoverage([page, publicPage], f.h.origin, coverage)
    await publicContext.close()
    await writeFile(join(dir, 'roles.log'), log.join('\n') + '\n')
  } finally {
    await Promise.all(
      cleanup.reverse().map(async close => {
        await close()
      })
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
