// Set TS_MANAGER_ARTIFACTS to the proof directory and run after build.web:
// node -r sucrase/register src/app/headCoach.e2e.ts
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer from 'puppeteer'

import { userIdOfGumbo } from '../common/userId'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  autoSchedulerFixture,
  G1,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { recordBrowserCoverage } from './browserCoverage.e2e'

async function main(): Promise<void> {
  const dir = process.env.TS_MANAGER_ARTIFACTS
  if (dir == null) throw new Error('Set TS_MANAGER_ARTIFACTS')
  await mkdir(dir, { recursive: true })
  const places = await googlePlacesStub()
  const fx = await autoSchedulerFixture(resolve('dist'), {
    cityLookup: googlePlaces({ apiKey: 'test', baseUrl: places.baseUrl })
  })
  const { f } = fx
  const browser = await puppeteer.launch({ headless: true })
  try {
    await seedThrough(fx, 'E7')
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
      await page.$eval(selector, el => {
        ;(el as HTMLElement).click()
      })
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
    await publicContext.close()
    await visit(`/games/${G1}?tab=info`)
    const teamChoice =
      '[data-testid="event-attendance-teams"] [aria-label="Demo Hawks"]'
    if ((await page.$(teamChoice)) != null) await press(teamChoice)
    await shot('attendance-after', label)
    const log = ['$ node -r sucrase/register src/app/headCoach.e2e.ts']
    for (const [method, user, body] of [
      ['PUT', second, {}],
      ['PUT', second, { expectedHeadCoach: first }],
      ['DELETE', second, undefined]
    ] as const) {
      const path = `/manage/team/${f.teamA}/people/${user}/roles/headCoach`
      const response = await f.h.request(method, path, body, 101)
      log.push(
        `${method} ${path} ${JSON.stringify(body) ?? ''}\n${response.status} ${await response.text()}`
      )
      expect(response.status).equals(
        method === 'PUT' && !('expectedHeadCoach' in (body ?? {})) ? 409 : 200
      )
    }
    if (coverage != null)
      await recordBrowserCoverage([page], f.h.origin, coverage)
    await writeFile(join(dir, 'roles.log'), log.join('\n') + '\n')
  } finally {
    await browser.close()
    await f.h.close()
    await places.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
