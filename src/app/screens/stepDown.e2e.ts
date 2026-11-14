// Set TS_STEPDOWN_ARTIFACTS to the proof directory and run after build.web:
// node -r sucrase/register src/app/screens/stepDown.e2e.ts
/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing --
   Puppeteer serializes these functions into the page, and sucrase rewrites ??
   into a helper the page does not have. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { Page } from 'puppeteer'
import puppeteer from 'puppeteer'

import { userIdOfGumbo } from '../../common/userId'
import { groupFixture } from '../../test/groupFixtures'

const SCOREKEEPER = 104
const SONGKEEPER = 103
const VIDEOGRAPHER = 106

async function main(): Promise<void> {
  const dir = process.env.TS_STEPDOWN_ARTIFACTS
  if (dir == null) throw new Error('Set TS_STEPDOWN_ARTIFACTS')
  await mkdir(dir, { recursive: true })
  const lines = ['$ node -r sucrase/register src/app/screens/stepDown.e2e.ts']
  const say = (line: string): void => {
    lines.push(line)
    console.log(line)
  }
  const fx = await groupFixture(resolve('dist'))
  const browser = await puppeteer.launch({ headless: true })
  try {
    const { h, teamA, seasonA, leagueA } = fx
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    const grant = async (
      kind: 'league' | 'season' | 'team',
      id: string,
      user: number,
      flags: string[]
    ): Promise<void> => {
      const response = await h.request(
        'POST',
        `/manage/${kind}/${id}/people`,
        {
          email: `fixture${user}@example.com`,
          flags,
          idempotencyKey: `step-down-${kind}-${user}-${flags.length === 0 ? 'member' : flags.join('-')}`
        },
        101
      )
      const body = await response.text()
      say(
        `POST /manage/${kind}/${id}/people ${user} ${flags.length === 0 ? 'member' : flags.join(',')} ${response.status}`
      )
      expect(response.status, body).equals(201)
    }
    await grant('team', teamA, SCOREKEEPER, ['scorekeeper'])
    await grant('team', teamA, VIDEOGRAPHER, ['videographer'])
    await grant('team', teamA, SONGKEEPER, ['songkeeper'])
    await grant('season', seasonA, SCOREKEEPER, [])
    await grant('season', seasonA, SONGKEEPER, ['videographer'])
    await grant('league', leagueA, VIDEOGRAPHER, ['videographer'])

    const signIn = async (user: number): Promise<void> => {
      const url = new URL(h.origin)
      await browser.setCookie({
        name: 'ts_session',
        value: h.tokens.get(user)!,
        domain: url.hostname,
        path: '/'
      })
    }
    const visit = async (path: string): Promise<void> => {
      await page.goto(h.origin + path, { waitUntil: 'domcontentloaded' })
    }
    // In the page, never the navigation sidebar, whose account row reads
    // the signed-in person's name (develop a0db231a9).
    const clickNamed = async (fragment: string): Promise<void> => {
      await page.waitForFunction(
        (word: string) =>
          [...document.querySelectorAll('[role="button"],[role="tab"]')].some(
            el =>
              (el.textContent || '').includes(word) &&
              el.closest('[data-testid="navigation-sidebar"]') == null
          ),
        {},
        fragment
      )
      await page.evaluate((word: string) => {
        const el = [
          ...document.querySelectorAll<HTMLElement>(
            '[role="button"],[role="tab"]'
          )
        ].find(
          node =>
            (node.textContent || '').includes(word) &&
            node.closest('[data-testid="navigation-sidebar"]') == null
        )
        if (el != null) el.click()
      }, fragment)
    }
    const clickLabel = async (label: string): Promise<void> => {
      const selector = `[aria-label="${label}"]`
      await page.waitForSelector(selector)
      await page.click(selector)
    }
    const shot = async (name: string, word: string): Promise<void> => {
      await page.waitForFunction(
        (w: string) => document.body.innerText.includes(w),
        {},
        word
      )
      await page.evaluate((w: string) => {
        const role =
          w === 'Scorekeeper'
            ? document.querySelector('[data-testid="role-team-scorekeeper"]')
            : null
        const labeled =
          w === 'Step Down'
            ? document.querySelector('[aria-label="Step down as Scorekeeper"]')
            : null
        const el =
          role ||
          labeled ||
          [...document.querySelectorAll('div,span,button')].find(node =>
            (node.textContent || '').includes(w)
          )
        if (el == null) return
        let parent = el.parentElement
        while (parent != null) {
          const style = getComputedStyle(parent)
          const scrolls =
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            parent.scrollHeight > parent.clientHeight
          if (scrolls) {
            const rowBox = el.getBoundingClientRect()
            const box = parent.getBoundingClientRect()
            parent.scrollTop +=
              rowBox.top - box.top - box.height / 2 + rowBox.height / 2
          }
          parent = parent.parentElement
        }
        el.scrollIntoView({ block: 'center' })
      }, word)
      await page.screenshot({ path: join(dir, name) })
    }
    const rowText = async (testId: string): Promise<string> => {
      await page.waitForSelector(`[data-testid="${testId}"]`)
      return await page.$eval(
        `[data-testid="${testId}"]`,
        el => el.textContent || ''
      )
    }
    const roles = async (
      user: number,
      scopeType: 'league' | 'season' | 'team',
      scopeId: string
    ): Promise<string[]> =>
      (
        await h.db
          .selectFrom('scope_roles')
          .select('role')
          .where('user_id', '=', userIdOfGumbo(user))
          .where('scope_type', '=', scopeType)
          .where('scope_id', '=', scopeId)
          .orderBy('role')
          .execute()
      ).map(row => row.role)
    const teamMember = async (user: number): Promise<boolean> =>
      (await h.db
        .selectFrom('memberships')
        .select('user_id')
        .where('user_id', '=', userIdOfGumbo(user))
        .where('team_id', '=', teamA)
        .executeTakeFirst()) != null
    const seasonMember = async (user: number): Promise<boolean> =>
      (await h.db
        .selectFrom('season_members')
        .select('id')
        .where('user_id', '=', userIdOfGumbo(user))
        .where('season_id', '=', seasonA)
        .executeTakeFirst()) != null

    await signIn(SCOREKEEPER)
    await visit(`/teams/${teamA}?tab=team`)
    await shot('roster-own-row-after.png', 'Ichiro')
    await clickNamed('Ichiro')
    await page.waitForFunction(
      (path: string) => location.pathname === path,
      {},
      `/teams/${teamA}/people/${userIdOfGumbo(SCOREKEEPER)}`
    )
    expect(await rowText('role-team-admin')).not.includes('Step Down')
    expect(await rowText('role-team-assistant')).not.includes('Step Down')
    expect(await rowText('role-team-songkeeper')).includes('With Scorekeeper')
    expect(await rowText('role-team-songkeeper')).not.includes('Step Down')
    await shot('profile-scorekeeper-after.png', 'Step Down')
    await clickLabel('Step down as Scorekeeper')
    await page.waitForSelector('[aria-label="Confirm change"]')
    await new Promise(resolve => setTimeout(resolve, 400))
    const box = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Confirm change"]')
      if (el == null) return null
      const rect = el.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        text: el.textContent || ''
      }
    })
    if (box == null) throw new Error('The step-down sheet did not open')
    say(`sheet ${JSON.stringify(box)}`)
    await page.screenshot({
      path: join(dir, 'step-down-modal-after.png'),
      clip: {
        x: Math.max(0, box.x),
        y: Math.max(0, box.y),
        width: box.width,
        height: box.height
      }
    })
    await clickLabel('Cancel confirmation')
    expect(await roles(SCOREKEEPER, 'team', teamA)).includes('scorekeeper')
    say('scenario 1 cancel leaves scorekeeper')
    await clickLabel('Step down as Scorekeeper')
    await confirmStepDown(page)
    await page.waitForFunction(() => {
      const row = document.querySelector(
        '[data-testid="role-team-scorekeeper"]'
      )
      return (
        row != null &&
        !(row.textContent || '').includes('Step Down') &&
        (row.textContent || '').includes('\u2014')
      )
    })
    await shot('profile-scorekeeper-gone-after.png', 'Scorekeeper')
    expect(await roles(SCOREKEEPER, 'team', teamA)).not.includes('scorekeeper')
    expect(await roles(SCOREKEEPER, 'team', teamA)).not.includes('songkeeper')
    expect(await teamMember(SCOREKEEPER)).equals(true)
    say(
      'PASS scenario 1 and 4: scorekeeper stepped down, implied songkeeper gone, membership remains'
    )

    await h.db
      .updateTable('memberships')
      .set({ is_player: true })
      .where('user_id', '=', userIdOfGumbo(SCOREKEEPER))
      .where('team_id', '=', teamA)
      .execute()
    await visit(`/seasons/${seasonA}?tab=people`)
    await clickNamed('Ichiro')
    await page.waitForFunction(
      (path: string) => location.pathname === path,
      {},
      `/seasons/${seasonA}/people/${userIdOfGumbo(SCOREKEEPER)}`
    )
    expect(page.url()).not.includes('/players/')
    await clickLabel('Step down as Member')
    await page.waitForFunction(() =>
      document.body.innerText.includes('Leave Demo Regular?')
    )
    await confirmStepDown(page)
    expect(await seasonMember(SCOREKEEPER)).equals(false)
    expect(await teamMember(SCOREKEEPER)).equals(true)
    say(
      'PASS scenario 5 season: own player row opened the season profile and the team membership remains'
    )

    const again = await h.request(
      'PUT',
      `/manage/team/${teamA}/people/${userIdOfGumbo(SCOREKEEPER)}/roles/scorekeeper`,
      {},
      101
    )
    expect(again.status).equals(200)
    await visit(
      `/players/${userIdOfGumbo(SCOREKEEPER)}?tab=settings&onTeam=${teamA}`
    )
    await page.waitForSelector('[aria-label="Step down as Scorekeeper"]')
    expect(await rowText('role-team-member')).includes('Player')
    expect(await rowText('role-team-member')).not.includes('Step Down')
    await shot('player-settings-after.png', 'Scorekeeper')
    await clickLabel('Step down as Scorekeeper')
    await confirmStepDown(page)
    await page.waitForFunction(() => {
      const row = document.querySelector(
        '[data-testid="role-team-scorekeeper"]'
      )
      return row != null && !(row.textContent || '').includes('Step Down')
    })
    expect(await roles(SCOREKEEPER, 'team', teamA)).not.includes('scorekeeper')
    expect(await teamMember(SCOREKEEPER)).equals(true)
    await visit(`/teams/${teamA}/people/${userIdOfGumbo(SCOREKEEPER)}`)
    expect(await rowText('role-team-member')).includes('Player')
    expect(await rowText('role-team-member')).not.includes('Step Down')
    expect(await teamMember(SCOREKEEPER)).equals(true)
    say(
      'PASS scenario 7: player Settings stepped down from scorekeeper and Member stayed Player'
    )

    await signIn(VIDEOGRAPHER)
    await visit(`/teams/${teamA}/people/${userIdOfGumbo(VIDEOGRAPHER)}`)
    await clickLabel('Step down as Videographer')
    await confirmStepDown(page)
    await page.waitForFunction(() => {
      const row = document.querySelector(
        '[data-testid="role-team-videographer"]'
      )
      return row != null && !(row.textContent || '').includes('Step Down')
    })
    expect(await roles(VIDEOGRAPHER, 'team', teamA)).not.includes(
      'videographer'
    )
    expect(await teamMember(VIDEOGRAPHER)).equals(true)
    await signIn(SONGKEEPER)
    await visit(`/teams/${teamA}/people/${userIdOfGumbo(SONGKEEPER)}`)
    await clickLabel('Step down as Songkeeper')
    await confirmStepDown(page)
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-testid="role-team-songkeeper"]')
      return row != null && !(row.textContent || '').includes('Step Down')
    })
    expect(await roles(SONGKEEPER, 'team', teamA)).not.includes('songkeeper')
    expect(await teamMember(SONGKEEPER)).equals(true)
    expect(await seasonMember(SONGKEEPER)).equals(true)
    say(
      'PASS scenario 2: videographer and songkeeper stepped down and the memberships remain'
    )

    await clickLabel('Step down as Member')
    await confirmStepDown(page)
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-testid="role-team-member"]')
      return row != null && !(row.textContent || '').includes('Step Down')
    })
    expect(await teamMember(SONGKEEPER)).equals(false)
    expect(await roles(SONGKEEPER, 'season', seasonA)).includes('videographer')
    say('PASS scenario 3: team membership is gone and the season role remains')

    const beforeLeague = await roles(SCOREKEEPER, 'team', teamA)
    await signIn(VIDEOGRAPHER)
    await visit(`/leagues/${leagueA}`)
    await clickNamed('People')
    await clickNamed('Tim')
    await page.waitForFunction(
      (path: string) => location.pathname === path,
      {},
      `/leagues/${leagueA}/people/${userIdOfGumbo(VIDEOGRAPHER)}`
    )
    await clickLabel('Step down as Videographer')
    await confirmStepDown(page)
    await page.waitForFunction(() => {
      const row = document.querySelector(
        '[data-testid="role-league-videographer"]'
      )
      return row != null && !(row.textContent || '').includes('Step Down')
    })
    expect(await roles(VIDEOGRAPHER, 'league', leagueA)).not.includes(
      'videographer'
    )
    expect(await teamMember(VIDEOGRAPHER)).equals(true)
    expect(await roles(SCOREKEEPER, 'team', teamA)).deep.equals(beforeLeague)
    say(
      'PASS scenario 5 league: league videographer stepped down and the team is unchanged'
    )

    const coach = await h.request(
      'PUT',
      `/manage/team/${teamA}/people/${userIdOfGumbo(VIDEOGRAPHER)}/roles/coach`,
      {},
      101
    )
    expect(coach.status).equals(200)
    await visit(`/teams/${teamA}/people/${userIdOfGumbo(VIDEOGRAPHER)}`)
    await page.waitForSelector('[data-testid="role-team-coach-switch"]')
    expect(await page.$('[aria-label^="Step down"]')).equals(null)
    await page.locator('[data-testid="role-team-coach-switch"]').click()
    await page.waitForSelector('[aria-label="Confirm removal"]')
    const removed = page.waitForResponse(
      response =>
        response.url().includes('/roles/coach') &&
        response.request().method() === 'DELETE'
    )
    await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(
        '[aria-label="Confirm removal"]'
      )
      if (button != null) button.click()
    })
    const removal = await removed
    const removalBody = await removal.text()
    say(`DELETE coach ${removal.status()} ${removalBody}`)
    expect(removal.status()).equals(200)
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="role-team-coach-switch"]') == null
    )
    expect(await rowText('role-team-coach')).not.includes('Step Down')
    expect(await roles(VIDEOGRAPHER, 'team', teamA)).not.includes('coach')
    say(
      'PASS scenario 6: a coach sees the switch and turning it off removes Coach'
    )

    await writeFile(join(dir, 'step-down-e2e.log'), lines.join('\n') + '\n')
  } finally {
    await browser.close()
    await fx.h.close()
  }
}

async function confirmStepDown(page: Page): Promise<void> {
  await page.waitForSelector(
    '[aria-label="Confirm change"] [aria-label="Step Down"]'
  )
  const sent = page.waitForResponse(response =>
    response.url().includes('/me/groups/')
  )
  await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>(
      '[aria-label="Confirm change"] [aria-label="Step Down"]'
    )
    if (button != null) button.click()
  })
  const response = await sent
  if (response.status() >= 400)
    throw new Error(
      `${response.request().method()} ${response.url()} ${response.status()} ${await response.text()}`
    )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
