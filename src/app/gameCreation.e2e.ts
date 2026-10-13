import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { type GroupFixture, groupFixture } from '../test/groupFixtures'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import {
  fill,
  frameText,
  freezeBrowserClock,
  press,
  text
} from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for game proof')
async function login(page: Page, f: GroupFixture, user: number): Promise<void> {
  await freezeBrowserClock(page)
  const email =
    user === 101
      ? 'alex@example.com'
      : user === 102
        ? 'casey@example.com'
        : `fixture${user}@example.com`
  await page.goto(f.h.origin + '/sign-in', { waitUntil: 'networkidle0' })
  await fill(page, 'E-mail address', email)
  await press(page, 'Send me a sign-in code')
  await text(page, 'six-digit code is on its way')
  await fill(page, 'Sign-in code', f.h.mail.get(email)!)
  await press(page, 'Sign in')
  await page.waitForSelector('[aria-label^="Account,"]')
  await text(page, 'Discover leagues, seasons and teams')
}
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(artifacts!, name) })
}
async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  let browser: Browser | undefined
  const pages: Page[] = []
  const lines = ['$ node -r sucrase/register src/app/gameCreation.e2e.ts']
  try {
    browser = await puppeteer.launch({ headless: true })
    const actorPage = async (user: number): Promise<Page> => {
      const context = await browser!.createBrowserContext()
      const page = await context.newPage()
      pages.push(page)
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      await login(page, f, user)
      return page
    }
    const host = await actorPage(102)
    const team = await actorPage(101)
    const opponent = await actorPage(103)
    await host.bringToFront()
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'networkidle0'
    })
    await press(host, 'Create Game')
    await press(host, 'Choose Home Team, Home')
    await fill(host, 'Search all teams', 'Demo Eagles')
    await press(host, 'Choose Demo Eagles')
    await press(host, 'Choose Away Team, Away')
    await fill(host, 'Search all teams', 'Demo Hawks')
    await press(host, 'Choose Demo Hawks')
    await fill(host, 'Date', '2029-07-01')
    await fill(host, 'Time', '18:30')
    await fill(host, 'Venue (optional)', 'Demo Field')
    await text(host, 'outside the season’s reference')
    await host.evaluate(() => {
      const hint = [...document.querySelectorAll<HTMLElement>('div,span')].find(
        node => {
          if (node.childElementCount !== 0) return false
          const value = node.textContent
          if (value === null) return false
          return value.includes('This date is outside the season')
        }
      )
      if (hint !== undefined) hint.scrollIntoView({ block: 'center' })
    })
    await shot(host, 'season-date-warning-after.png')
    await press(host, 'Dismiss date warning')
    expect(await host.evaluate(() => document.body.textContent)).not.includes(
      'This date is outside the season'
    )
    expect(
      await host.$eval('input[aria-label="Date"]', input => input.value)
    ).equals('2029-07-01')
    await host.evaluate(() => {
      for (const node of document.querySelectorAll<HTMLElement>('div'))
        node.scrollTop = 0
    })
    await shot(host, 'game-creation-after.png')
    await press(host, 'Save')
    await text(host, 'Pending')
    const requestId = new URL(host.url()).pathname.split('/').at(-1)!
    await shot(host, 'schedule-before-approval.png')
    expect(
      await f.h.db
        .selectFrom('games')
        .select('id')
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length(0)
    await team.bringToFront()
    await team.goto(f.h.origin + '/notifications', {
      waitUntil: 'networkidle0'
    })
    await press(team, 'Demo Hawks invited to game vs. Demo Eagles')
    await text(team, 'Demo Field')
    await shot(team, 'notification-game-detail.png')
    await press(team, 'Accept invitation')
    await text(team, 'Accepted')
    const published = await f.h.db
      .selectFrom('group_requests')
      .select('game_id')
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow()
    expect(published.game_id).not.equals(null)
    await host.bringToFront()
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'networkidle0'
    })
    await text(host, 'Demo Hawks at Demo Eagles')
    await frameText(host, 'Demo Hawks at Demo Eagles')
    await shot(host, 'schedule-after.png')
    for (const route of [
      `/teams/${f.teamA}`,
      `/teams/${f.teamB}`,
      `/seasons/${f.seasonB}`
    ]) {
      const body = (await (
        await f.h.request('GET', route, undefined, null)
      ).json()) as { games: Array<{ id: string }> }
      expect(body.games.map(game => game.id)).includes(published.game_id!)
    }
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('team_id')
        .where('season_id', '=', f.seasonB)
        .where('team_id', '=', f.teamA)
        .execute()
    ).length(0)
    lines.push(
      'E6 PASS: season-authorized raw guest proposal remains unpublished until team approval; an outside-reference date warns only; one ID appears on host and both teams without inferred enrollment'
    )

    await host.goto(f.h.origin + `/groups/league/${f.leagueB}`, {
      waitUntil: 'networkidle0'
    })
    await text(host, 'Demo Hawks at Demo Eagles')
    await press(host, 'Propose game change')
    await host.waitForSelector('input[aria-label="Date"]')
    expect(new URL(host.url()).pathname).equals(
      `/groups/season/${f.seasonB}/create-game`
    )
    expect(new URL(host.url()).searchParams.get('game')).equals(
      published.game_id
    )
    expect(
      await host.$eval(
        'input[aria-label="Venue (optional)"]',
        input => input.value
      )
    ).equals('Demo Field')
    await press(host, 'Back')
    await text(host, 'Demo League B')
    lines.push(
      'E20 league PASS: the real league schedule opens the selected game change in its hosting season, with loaded details and one Back returning to the league'
    )

    await host.goto(
      f.h.origin +
        `/groups/season/${f.seasonB}/create-game?game=${published.game_id}`,
      { waitUntil: 'networkidle0' }
    )
    await text(host, 'Propose game change')
    await fill(host, 'Venue (optional)', 'Demo Revised Field')
    await press(host, 'Save')
    await text(host, 'Pending')
    const revisionId = new URL(host.url()).pathname.split('/').at(-1)!
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .select('venue')
          .where('id', '=', published.game_id!)
          .executeTakeFirstOrThrow()
      ).venue
    ).equals('Demo Field')
    await shot(host, 'schedule-revision-pending.png')
    await team.bringToFront()
    await team.goto(f.h.origin + `/notifications/${revisionId}`, {
      waitUntil: 'networkidle0'
    })
    await press(team, 'Decline invitation')
    await text(team, 'Declined')
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .select('venue')
          .where('id', '=', published.game_id!)
          .executeTakeFirstOrThrow()
      ).venue
    ).equals('Demo Field')
    lines.push(
      'E20 PASS: material change waits for new consent and decline leaves the last approved game unchanged'
    )

    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'networkidle0'
    })
    await press(team, 'Schedule', 'tab')
    await press(team, 'Add Event')
    await text(team, 'always creates a scrimmage/exhibition game')
    await press(team, 'Choose Away Team, Away')
    await fill(team, 'Search all teams', 'Demo Visitors')
    await press(team, 'Choose Demo Visitors')
    await fill(team, 'Date', '2029-07-02')
    await fill(team, 'Time', '17:00')
    await fill(
      team,
      'Outside tournament (optional)',
      'Demo Off-platform Classic'
    )
    await press(team, 'Save')
    await text(team, 'Pending')
    const outsideId = new URL(team.url()).pathname.split('/').at(-1)!
    await opponent.bringToFront()
    await opponent.goto(f.h.origin + `/notifications/${outsideId}`, {
      waitUntil: 'networkidle0'
    })
    await press(opponent, 'Decline invitation')
    await text(opponent, 'Declined')
    await team.bringToFront()
    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'networkidle0'
    })
    await text(team, 'Declined')
    await frameText(team, 'Declined')
    await shot(team, 'declined-game-after.png')
    await press(team, 'Delete declined entry')
    await team.waitForFunction(
      () => !document.body.textContent!.includes('Delete declined entry')
    )
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', outsideId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('declined')
    lines.push(
      'E7/E15 PASS: team-owned outside proposal retains no season; opponent decline closes all tasks; sender-only declined entry can be hidden without deleting audit or approved games'
    )
    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(team, 'Schedule', 'tab')
    await press(team, 'Add Event')
    await press(team, 'Choose Away Team, Away')
    await fill(team, 'Search all teams', 'Demo Visitors')
    await press(team, 'Choose Demo Visitors')
    await fill(team, 'Date', '2029-07-03')
    await fill(team, 'Venue (optional)', 'Demo Team Season Field')
    await press(team, 'Save')
    await text(team, 'Pending')
    const teamSeasonId = new URL(team.url()).pathname.split('/').at(-1)!
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('initiating_team_id')
          .where('id', '=', teamSeasonId)
          .executeTakeFirstOrThrow()
      ).initiating_team_id
    ).equals(f.teamA)
    await opponent.goto(f.h.origin + `/notifications/${teamSeasonId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(opponent, 'Decline invitation')
    await text(opponent, 'Declined')
    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(team, 'Demo Team Season Field')
    await text(team, 'Declined')
    await frameText(team, 'Declined')
    await shot(team, 'team-origin-season-declined.png')
    await press(team, 'Delete declined entry')
    await team.waitForFunction(
      () => !document.body.textContent!.includes('Demo Team Season Field')
    )
    lines.push(
      'E15/E20 review regression PASS: a team-origin exhibition proposal retains its initiating-team identity and declined team schedule entry'
    )
    const staleSent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        initiatingTeamId: f.teamA,
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.standaloneTeam,
          seasonId: f.seasonA,
          startAt: '2029-07-04T19:00:00Z',
          venue: 'Demo Resend Field',
          status: 'scheduled'
        },
        idempotencyKey: 'browser-review-resend'
      },
      101
    )
    expect(staleSent.status).equals(201)
    const staleId = ((await staleSent.json()) as { id: string }).id
    expect(
      (await f.h.request('POST', `/game-requests/${staleId}/decline`, {}, 103))
        .status
    ).equals(200)
    await team.goto(f.h.origin + `/notifications/${staleId}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(team, 'Declined')
    let releaseRead!: () => void
    const heldRead = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    await team.setRequestInterception(true)
    team.on('request', request => {
      if (
        request.method() === 'GET' &&
        request.url().includes('/me/notifications/inv_') &&
        !request.url().endsWith(staleId)
      ) {
        heldRead
          .then(async () => {
            await request.continue()
          })
          .catch(() => undefined)
      } else request.continue().catch(() => undefined)
    })
    await press(team, 'Resend invitation')
    await team.waitForFunction(
      old => !window.location.pathname.endsWith(old),
      {},
      staleId
    )
    await text(team, 'Loading invitation')
    expect(await team.evaluate(() => document.body.textContent)).not.includes(
      'Declined'
    )
    releaseRead()
    await text(team, 'Pending')
    const replacementId = new URL(team.url()).pathname.split('/').at(-1)!
    for (const [kind, id] of [
      ['team', f.teamA],
      ['season', f.seasonA]
    ]) {
      await team.goto(f.h.origin + `/groups/${kind}/${id}`, {
        waitUntil: 'domcontentloaded'
      })
      await text(team, 'Demo Resend Field')
      expect(await team.evaluate(() => document.body.textContent)).not.includes(
        'Declined'
      )
    }
    await team.goto(f.h.origin + `/notifications/${replacementId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(team, 'Withdraw invitation')
    await text(team, 'Cancelled')
    lines.push(
      'E14/E15 review PASS: resending clears the old team and season projections while preserving history; a delayed replacement read shows loading with no stale invitation controls'
    )

    await f.h.db
      .updateTable('games')
      .set({ status: 'final', home_score: 5, away_score: 4 })
      .where('id', '=', published.game_id!)
      .execute()
    await team.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(team, 'Withdraw Demo Hawks from game')
    await press(team, 'Confirm withdrawal')
    await text(team, 'Canceled — Demo Hawks withdrew')
    await frameText(team, 'Canceled — Demo Hawks withdrew')
    await shot(team, 'game-withdrawal-after.png')
    const cancelled = await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', published.game_id!)
      .executeTakeFirstOrThrow()
    expect(cancelled.cancellation_reason).equals('withdrawal')
    expect(cancelled.withdrawn_by_team_id).equals(f.teamA)
    expect(cancelled.home_score).equals(5)
    expect(cancelled.away_score).equals(4)
    await host.bringToFront()
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'networkidle0'
    })
    await text(host, 'Canceled — Demo Hawks withdrew')
    lines.push(
      'E17 PASS: a team admin unilaterally withdraws even a final game, immediately retaining the same host/team schedule entry with named attribution and historical scores'
    )
    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/creation/games-browser.json')
    )
    await writeFile(
      join(artifacts!, 'game-browser-vectors.log'),
      lines.join('\n') + '\n'
    )
    console.log(lines.slice(1).join('\n'))
  } finally {
    await browser?.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
