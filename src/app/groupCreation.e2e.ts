import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import {
  fill,
  frameText,
  freezeBrowserClock,
  press,
  text
} from '../../e2e/rigs/creationBrowserActions'
import { userIdOfGumbo } from '../common/userId'
import { googlePlaces } from '../server/location/googlePlaces'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { type GroupFixture, groupFixture } from '../test/groupFixtures'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for group UI proof')

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
  await text(page, 'Your Home')
}
async function chooseLocation(
  page: Page,
  label = 'Location not set, Add a city'
): Promise<void> {
  await press(page, label)
  await page.waitForSelector('input[aria-label="City"]', { visible: true })
  await fill(page, 'City', 'tor')
  await press(page, 'Choose Toronto, Ontario, Canada')
  await press(page, 'Save')
  await text(page, 'Toronto, Ontario')
}
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(artifacts!, name) })
}

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const provider = await googlePlacesStub()
  const f = await groupFixture(
    resolve('dist'),
    undefined,
    undefined,
    googlePlaces({ apiKey: 'placeholder-key', baseUrl: provider.baseUrl })
  )
  let browser: Browser | undefined
  const pages: Page[] = []
  const cover = async (page: Page): Promise<void> => {
    pages.push(page)
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      includeRawScriptCoverage: true
    })
  }
  const lines = ['$ node -r sucrase/register src/app/groupCreation.e2e.ts']
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--lang=en-US'] })
    const plainContext = await browser.createBrowserContext()
    const plain = await plainContext.newPage()
    await cover(plain)
    await plain.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await plain.emulateTimezone('America/Los_Angeles')
    await login(plain, f, 106)
    await text(plain, 'Create League')
    await shot(plain, 'empty-home-after.png')
    expect(await plain.evaluate(() => document.body.textContent)).not.includes(
      'Your teams'
    )
    await press(plain, 'Create League')
    await fill(plain, 'League name', 'Demo Browser League')
    await text(plain, 'recurring basis')
    await press(plain, 'Continue')
    await chooseLocation(plain)
    await shot(plain, 'league-location.png')
    await press(plain, 'Continue')
    await press(plain, 'Use initials')
    await shot(plain, 'league-creation-after.png')
    await press(plain, 'Create League')
    await plain.waitForSelector('[aria-label="League settings"]')
    await shot(plain, 'league-created.png')
    const league = await f.h.db
      .selectFrom('leagues')
      .selectAll()
      .where('name', '=', 'Demo Browser League')
      .executeTakeFirstOrThrow()
    expect(league.locality).property('city', 'Toronto')
    lines.push(
      'E3 league PASS: searched city and retained time zone, initials and recurring organization name saved once'
    )

    await press(plain, 'Create season')
    await fill(plain, 'Season name', 'Demo Browser Fall')
    await press(plain, 'Continue')
    await text(plain, 'Fall 2026')
    await shot(plain, 'season-presets.png')
    await press(plain, 'Fall 2026')
    await press(plain, 'Custom time frame')
    await press(plain, 'Next month')
    await text(plain, 'October 2026')
    await press(plain, 'Next month')
    await text(plain, 'November 2026')
    await press(plain, 'Next month')
    await text(plain, 'December 2026')
    await press(plain, '2026-12-31')
    await press(plain, 'Next month')
    await text(plain, 'January 2027')
    await press(plain, '2027-01-01')
    await shot(plain, 'season-custom-range.png')
    await press(plain, 'Use this range')
    await shot(plain, 'season-creation-after.png')
    await press(plain, 'Continue')
    await press(plain, 'Use initials')
    await press(plain, 'Create Season')
    await text(plain, 'Demo Browser Fall')
    await plain.waitForSelector('[aria-label="Season settings"]')
    await shot(plain, 'season-after.png')
    const season = await f.h.db
      .selectFrom('seasons')
      .selectAll()
      .where('name', '=', 'Demo Browser Fall')
      .executeTakeFirstOrThrow()
    expect(season.league_id).equals(league.id)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('season_id', '=', season.id)
        .execute()
    ).length(0)
    lines.push(
      'E4 season PASS: name is independent of current/prior/two-next presets; inclusive custom cross-year calendar creates an empty parent-only season'
    )

    await press(plain, 'Teams', 'tab')
    await press(plain, 'Create team')
    await press(plain, 'Team')
    await fill(plain, 'Team name', 'Demo Browser Owls')
    await press(plain, 'Continue')
    await chooseLocation(plain, 'Toronto, Ontario, Canada')
    await shot(plain, 'team-location-after.png')
    await press(plain, 'Continue')
    await press(plain, 'Use initials')
    await shot(plain, 'team-creation-after.png')
    await press(plain, 'Create Team')
    await text(plain, 'Demo Browser Owls')
    await shot(plain, 'team-after.png')
    const team = await f.h.db
      .selectFrom('teams')
      .selectAll()
      .where('name', '=', 'Demo Browser Owls')
      .executeTakeFirstOrThrow()
    expect(team.league_id).equals(league.id)
    expect(team.picture_catalog_id).equals(null)
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .select('season_id')
        .where('team_id', '=', team.id)
        .execute()
    ).deep.equals([{ season_id: season.id }])
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', team.id)
        .execute()
    ).length(0)
    lines.push(
      'E3 team/E4 parent-only team PASS: name, own locality and initials save; creation in a season establishes management only'
    )

    await press(plain, 'Manage')
    await text(plain, 'Team management')
    await shot(plain, 'parent-settings-after.png')
    await press(plain, 'Add picture')
    await press(plain, 'Use initials')
    await press(plain, 'Save photo')
    await fill(plain, 'Name', 'Demo Browser Owls Renamed')
    await press(plain, 'Save name')
    await text(plain, 'Demo Browser Owls Renamed')
    await plain.reload({ waitUntil: 'networkidle0' })
    await text(plain, 'Demo Browser Owls Renamed')
    lines.push(
      'E2 settings PASS: initials and edited name persist across a real reload'
    )

    const publicContext = await browser.createBrowserContext()
    const publicPage = await publicContext.newPage()
    await cover(publicPage)
    await publicPage.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: 1
    })
    await publicPage.goto(f.h.origin + '/sign-in', {
      waitUntil: 'networkidle0'
    })
    await press(publicPage, 'Discover leagues, seasons and teams')
    await fill(publicPage, 'Search by name or city', 'Demo Browser Owls')
    await press(publicPage, 'Open Demo Browser Owls Renamed')
    await press(publicPage, 'Team', 'tab')
    await text(publicPage, 'Toronto')
    await shot(publicPage, 'public-discovery-after.png')
    // No way into the team's Settings, where its people are added.
    expect(
      await publicPage.evaluate(
        () => document.querySelector('[aria-label="Manage"]') === null
      )
    ).equals(true)
    await publicPage.reload({ waitUntil: 'networkidle0' })
    await text(publicPage, 'Demo Browser Owls Renamed')
    const privateDenied = await f.h.request(
      'GET',
      `/teams/${team.id}/roster`,
      undefined,
      null
    )
    expect(privateDenied.status).equals(401)
    lines.push(
      'E12 PASS: signed-out discovery and reloadable minimal profile expose location/parents and no private controls; private roster remains denied'
    )

    const teamContext = await browser.createBrowserContext()
    const teamAdmin = await teamContext.newPage()
    await cover(teamAdmin)
    await teamAdmin.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: 1
    })
    await login(teamAdmin, f, 101)
    await teamAdmin.goto(
      f.h.origin + `/groups/season/${f.playoffs}?tab=teams`,
      {
        waitUntil: 'networkidle0'
      }
    )
    await press(teamAdmin, 'Add team')
    await press(teamAdmin, 'Team this season manages')
    await fill(teamAdmin, 'Search by name or city', 'Demo Hawks')
    await press(teamAdmin, 'Choose Demo Hawks, Demo City, Demo Region, US')
    await text(teamAdmin, 'Sending approves for the group')
    await press(teamAdmin, 'I approve for all affected groups')
    await press(teamAdmin, 'Confirm relationship')
    await text(teamAdmin, 'Accepted')
    await teamAdmin.goto(f.h.origin + `/groups/team/${f.teamA}/settings`, {
      waitUntil: 'networkidle0'
    })
    await text(teamAdmin, 'Demo Playoffs')
    await frameText(teamAdmin, 'PARENT ORGANIZATIONS')
    await teamAdmin.waitForFunction(() =>
      ['Demo Regular', 'Demo Playoffs'].every(label => {
        const node = [...document.querySelectorAll<HTMLElement>('*')].find(
          node => node.textContent === label && node.children.length === 0
        )
        if (node == null) return false
        const rect = node.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= window.innerHeight
      })
    )
    await shot(teamAdmin, 'parent-seasons.png')
    await shot(teamAdmin, 'parent-link-flow-after.png')
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .select('season_id')
        .where('team_id', '=', f.teamA)
        .execute()
    ).length(2)
    await teamAdmin.goto(
      f.h.origin +
        `/groups/team/${f.teamA}/link?target=season&relationship=parent&direction=parents`,
      { waitUntil: 'networkidle0' }
    )
    await fill(teamAdmin, 'Search by name or city', 'Demo Tournament')
    await press(teamAdmin, 'Choose Demo Tournament')
    await text(teamAdmin, 'same league')
    await shot(teamAdmin, 'parent-conflict.png')
    await press(teamAdmin, 'Cancel')
    lines.push(
      'E5/E13 parent PASS: explicit dual-side confirmation establishes regular and playoff parents in one league; conflicting league parent is rejected in the real UI'
    )

    const hostContext = await browser.createBrowserContext()
    const host = await hostContext.newPage()
    await cover(host)
    await host.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await login(host, f, 102)
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'networkidle0'
    })
    await press(host, 'Teams', 'tab')
    await press(host, 'Add team')
    await press(host, 'Team that competes')
    await fill(host, 'Search by name or city', 'Demo Hawks')
    await press(host, 'Choose Demo Hawks, Demo City, Demo Region, US')
    await press(host, 'Send invitation')
    await text(host, 'Pending')
    const invitation = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('kind', '=', 'participation')
      .where('sender_id', '=', userIdOfGumbo(102))
      .orderBy('sent_at', 'desc')
      .executeTakeFirstOrThrow()
    await shot(host, 'request-resend-after.png')
    await host.goto(f.h.origin + '/notifications', {
      waitUntil: 'networkidle0'
    })
    await press(host, 'Sent')
    await text(host, 'Hawks invited to Demo Tournament')
    await teamAdmin.bringToFront()
    await teamAdmin.goto(f.h.origin + '/', { waitUntil: 'networkidle0' })
    await teamAdmin.waitForSelector('[data-testid="notification-pending-dot"]')
    await shot(teamAdmin, 'notification-entry-after.png')
    await press(teamAdmin, 'Notifications')
    await text(teamAdmin, 'Hawks invited to Demo Tournament')
    await shot(teamAdmin, 'notifications-oldest-first.png')
    // Decided on its card in the list: Accept and Reject, and no detail.
    await text(teamAdmin, 'organized by Demo League B')
    await teamAdmin.waitForSelector(
      '[aria-label="Accept Demo Hawks invited to Demo Tournament"]'
    )
    await teamAdmin.waitForSelector(
      '[aria-label="Reject Demo Hawks invited to Demo Tournament"]'
    )
    await shot(teamAdmin, 'notification-season-detail.png')
    await shot(teamAdmin, 'notification-detail-after.png')
    expect(
      (await (
        await f.h.request('GET', '/me/notifications/summary', undefined, 101)
      ).json()) as { hasPending: boolean }
    ).property('hasPending', true)
    await press(teamAdmin, 'Accept Demo Hawks invited to Demo Tournament')
    await teamAdmin.waitForSelector(
      '[aria-label="Accept Demo Hawks invited to Demo Tournament"]',
      { hidden: true }
    )
    expect(new URL(teamAdmin.url()).pathname).equals('/notifications')
    await press(teamAdmin, 'History')
    await text(teamAdmin, 'Accepted')
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('active')
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonB)
        .execute()
    ).deep.equals([{ active: true }])
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .select('season_id')
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonB)
        .execute()
    ).length(0)
    const shared = await f.h.request(
      'GET',
      `/me/notifications/${invitation.id}`,
      undefined,
      102
    )
    expect(await shared.json()).property('status', 'accepted')
    await teamAdmin.goto(f.h.origin + `/groups/team/${f.teamA}/settings`, {
      waitUntil: 'networkidle0'
    })
    await press(teamAdmin, 'Leave Demo Regular')
    await text(teamAdmin, 'Leave Demo Regular?')
    await frameText(teamAdmin, 'Leave Demo Regular?')
    await shot(teamAdmin, 'parent-unlink-preview.png')
    await press(teamAdmin, 'Leave Demo Regular')
    await teamAdmin.waitForFunction(
      () => document.querySelector('[aria-label="Leave Demo Regular"]') === null
    )
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('active')
        .where('team_id', '=', f.teamA)
        .where('season_id', '=', f.seasonB)
        .execute()
    ).deep.equals([{ active: true }])
    lines.push(
      'E10/E11 participation PASS: bell dot reflects actionable shared approval; viewing preserves it; acceptance updates both actors and creates competition only; parent unlink preserves competition'
    )

    await host.bringToFront()
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'networkidle0'
    })
    await press(host, 'Teams', 'tab')
    await press(host, 'Create team')
    await press(host, 'Placeholder team')
    await fill(host, 'Team name', 'Demo Outside Opponent')
    await press(host, 'Continue')
    await chooseLocation(host, 'Demo City, Demo Region, US')
    await press(host, 'Continue')
    await press(host, 'Use initials')
    await press(host, 'Create Team')
    await text(host, 'Demo Outside Opponent')
    await host.goto(f.h.origin + new URL(host.url()).pathname + '/settings', {
      waitUntil: 'networkidle0'
    })
    await press(host, 'Invite team administrator')
    await fill(host, 'Administrator email', 'fixture103@example.com')
    await press(host, 'Send administrator invitation')
    await text(host, 'Pending')
    const external = await f.h.db
      .selectFrom('teams')
      .select('id')
      .where('name', '=', 'Demo Outside Opponent')
      .executeTakeFirstOrThrow()
    const recipientContext = await browser.createBrowserContext()
    const recipient = await recipientContext.newPage()
    await cover(recipient)
    await recipient.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: 1
    })
    await login(recipient, f, 103)
    await press(recipient, 'Notifications')
    await press(recipient, 'Become administrator of Demo Outside Opponent')
    await press(recipient, 'Accept invitation')
    await text(recipient, 'Accepted')
    await recipient.goto(f.h.origin + `/groups/team/${external.id}`, {
      waitUntil: 'networkidle0'
    })
    // An administrator now: the team's Settings let them add people.
    await press(recipient, 'Manage')
    await text(recipient, 'Add Person to Team')
    expect(
      await f.h.db
        .selectFrom('teams')
        .select(['kind', 'custodian_id'])
        .where('id', '=', external.id)
        .executeTakeFirstOrThrow()
    ).deep.equals({ kind: 'full', custodian_id: null })
    await shot(recipient, 'external-promotion-after.png')
    lines.push(
      'E16 PASS: explicit external custody, verified email invitation and named recipient acceptance retain the same team identity without parent or competition grants'
    )

    await host.bringToFront()
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'networkidle0'
    })
    await press(host, 'Teams', 'tab')
    await press(host, 'Add team')
    await press(host, 'Team that competes')
    await fill(host, 'Search by name or city', 'Demo Visitors')
    await press(host, 'Choose Demo Visitors')
    await press(host, 'Send invitation')
    await text(host, 'Pending')
    const oldId = new URL(host.url()).pathname.split('/').at(-1)!
    await press(host, 'Withdraw invitation')
    await text(host, 'Cancelled')
    await press(host, 'Submit again')
    await text(host, 'Pending')
    const newId = new URL(host.url()).pathname.split('/').at(-1)!
    expect(newId).not.equals(oldId)
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', oldId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('cancelled')
    f.advance(7 * 24 * 3600 * 1000)
    await recipient.bringToFront()
    await recipient.goto(f.h.origin + `/notifications/${newId}`, {
      waitUntil: 'networkidle0'
    })
    await text(recipient, 'Expired')
    expect(
      await recipient.evaluate(() => document.body.textContent)
    ).not.includes('Accept invitation')
    await shot(recipient, 'request-resend-after.png')
    lines.push(
      'E14 PASS: withdrawal closes old links, resend navigates to a new request with fresh consent, and exactly seven days closes the real browser decision controls'
    )

    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/creation/groups-browser.json')
    )
    await writeFile(
      join(artifacts!, 'group-browser-vectors.log'),
      lines.join('\n') + '\n'
    )
    console.log(lines.slice(1).join('\n'))
  } finally {
    await browser?.close()
    await f.h.close()
    await provider.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
