import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { asLocality } from '../common/locality'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { googlePlaces } from '../server/location/googlePlaces'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { groupFixture } from '../test/groupFixtures'
import {
  browserSession,
  capture,
  contains,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Set TS_CREATION_ARTIFACTS')

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const cityStub = await googlePlacesStub()
  const live = process.argv.includes('E27')
  const keyFile = process.env.TS_GOOGLE_PLACES_KEY_FILE
  if (live && keyFile == null)
    throw new Error('Supply TS_GOOGLE_PLACES_KEY_FILE')
  const keys = live
    ? (JSON.parse(await readFile(keyFile!, 'utf8')) as Record<string, string>)
    : {}
  const f = await groupFixture(
    resolve('dist'),
    undefined,
    undefined,
    googlePlaces(
      live
        ? { apiKey: keys['Places API'] }
        : { apiKey: 'placeholder-key', baseUrl: cityStub.baseUrl }
    )
  )
  const daemon = await maestro(`settingsCleanup-${process.pid}`)
  const session = await browserSession(
    daemon,
    `settingsCleanup-chromium-${process.pid}`,
    402,
    874,
    artifacts!
  )
  const { browser, page, m } = session
  try {
    await f.h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', 101)
      .execute()
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true
    })
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    if (process.argv.includes('E14')) {
      for (const kind of ['team', 'league'] as const) {
        const noun = kind === 'team' ? 'Team' : 'League'
        const name = kind === 'team' ? 'Orchard Owls' : 'Lakeshore League'
        await m.openLink({ link: f.h.origin + `/create/${kind}` })
        await contains(page, `Create ${noun}`)
        await fill(m, `${noun} name`, name)
        await tap(m, 'Continue')
        await tap(m, 'Location not set, Add a city')
        await fill(m, 'City', kind === 'team' ? 'tor' : 'aus')
        await m.tapOn({
          css: `[aria-label^="Choose ${kind === 'team' ? 'Toronto' : 'Austin'},"]`,
          timeout: 10000
        })
        await contains(page, 'Save to use')
        await tap(m, 'Save')
        await contains(
          page,
          kind === 'team' ? 'Toronto, Ontario' : 'Austin, Texas'
        )
        await tap(m, 'Continue')
        await tap(m, 'Use initials')
        if (kind === 'team') {
          await tap(m, 'Continue')
          await contains(page, 'Add Team to Season or League')
        }
        await tap(m, `Create ${noun}`)
        await page.waitForFunction(
          () => !location.pathname.startsWith('/create/')
        )
        const made = await f.h.db
          .selectFrom(kind === 'team' ? 'teams' : 'leagues')
          .select(['id', 'locality'])
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
        expect(asLocality(made.locality).timezone).equals(
          kind === 'team' ? 'America/Toronto' : 'America/Chicago'
        )
        await m.openLink({
          link: f.h.origin + `/groups/${kind}/${made.id}/settings`
        })
        await contains(page, name)
        await page.reload()
        await contains(page, name)
        await capture(m, artifacts!, `created-${kind}-reload.png`)
      }
      console.log(
        'E14 PASS: full team and league creation through shared city search, initials and reload; stored time zones retained'
      )
      return
    }
    if (process.argv.includes('E11')) {
      const locality = {
        city: 'Toronto',
        region: 'Ontario',
        country: 'Canada',
        placeId: null,
        timezone: 'America/Toronto'
      }
      await f.h.db
        .updateTable('teams')
        .set({ name: 'Bluebirds', locality })
        .where('id', '=', f.teamA)
        .execute()
      await f.h.db
        .updateTable('leagues')
        .set({ name: 'Harbor League', locality })
        .where('id', '=', f.leagueA)
        .execute()
      await f.h.db
        .updateTable('seasons')
        .set({ name: 'Spring 2026' })
        .where('id', '=', f.seasonA)
        .execute()
      await f.h.db
        .insertInto('season_teams')
        .values({ season_id: f.seasonA, team_id: f.teamA, active: true })
        .onConflict(conflict =>
          conflict.columns(['season_id', 'team_id']).doNothing()
        )
        .execute()
      await f.h.db
        .insertInto('memberships')
        .values(
          [103, 104, 106].map(userId => ({
            id: `mem_settings_people_${userId}`,
            user_id: userId,
            team_id: f.teamA,
            is_player: userId !== 106
          }))
        )
        .execute()
      await f.h.db
        .deleteFrom('user_emails')
        .where('user_id', '=', 103)
        .execute()
      await f.h.request(
        'POST',
        `/manage/team/${f.teamA}/people`,
        {
          email: 'invite@example.com',
          admin: false,
          flags: [],
          idempotencyKey: 'settings-invitation'
        },
        101
      )
      const go = async (path: string, expected: string): Promise<void> => {
        await m.openLink({ link: f.h.origin + path })
        await contains(page, expected)
      }
      const near = async (label: string): Promise<void> => {
        await m.scrollUntilVisible({ element: { text: label } })
      }
      const settings = `/groups/team/${f.teamA}/settings`
      await go(settings, 'TEAM DETAILS')
      await capture(m, artifacts!, 'team-settings-top-after.png')
      await fill(m, 'Name', 'Bluebirds Updated')
      await tap(m, 'Save name')
      await contains(page, 'Name saved')
      expect(page.url()).includes('/settings')
      await fill(m, 'Name', 'Bluebirds')
      await tap(m, 'Save name')
      await near('Add Person to Team')
      await capture(m, artifacts!, 'team-settings-management-after.png')
      await tap(m, 'Add Person to Team')
      await contains(page, 'Add People')
      await m.openBrowser({ url: page.url() })
      await contains(page, 'Add People')
      await fill(
        m,
        'E-mail addresses',
        'fixture104@example.com, invalid-address'
      )
      await contains(page, 'Invalid addresses: invalid-address')
      await capture(m, artifacts!, 'add-people.png')
      await fill(
        m,
        'E-mail addresses',
        'fixture104@example.com, new-parent@example.com'
      )
      await near('Send invites')
      await m.command('scroll', { direction: 'down' })
      await m.waitForAnimationToEnd()
      await capture(m, artifacts!, 'add-people-actions.png')
      const sendPoint = await page.evaluate(() => {
        const node = [...document.querySelectorAll('[role="button"]')].find(
          node => node.textContent === 'Send invites'
        )!
        const box = node.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      })
      await m.command('tapOnPoint', sendPoint)
      await contains(page, 'TEAM DETAILS')
      await near('Withdraw invitation')
      await capture(m, artifacts!, 'team-settings-people-after.png')
      await tap(m, 'Resend')
      await contains(page, 'Sent again')
      await near('MANAGE PLAYERS')
      await contains(page, 'Mike Trout')
      await contains(page, 'Ichiro')
      await capture(m, artifacts!, 'manage-players.png')
      const result = await f.h.request(
        'GET',
        `/manage/team/${f.teamA}`,
        undefined,
        101
      )
      const managed = (await result.json()) as {
        people: Array<{
          userId: number
          emails: string[]
          teams: Array<{ id: string; isPlayer: boolean }>
        }>
      }
      expect(
        managed.people.find(person => person.userId === 103)!.emails
      ).length(0)
      expect(
        managed.people.find(person => person.userId === 104)!.emails
      ).not.length(0)
      for (const id of [103, 104, 106])
        expect(
          managed.people
            .find(person => person.userId === id)!
            .teams.find(team => team.id === f.teamA)!.isPlayer
        ).equals(id !== 106)
      await tap(m, 'Remove Mike Trout')
      await contains(page, 'Remove Mike Trout from Bluebirds?')
      await capture(m, artifacts!, 'manage-players-remove-modal.png')
      await tap(m, 'Cancel')
      await tap(m, 'Remove Mike Trout')
      await m.tapOn({
        css: '[aria-modal="true"] [data-testid="settings-pill-button"]',
        timeout: 10000
      })
      await contains(page, 'Mike Trout was removed from Bluebirds')
      await go(`/groups/team/${f.teamA}/settings/invites`, 'Invite Spectators')
      await tap(m, 'Create invite link')
      await fill(m, 'Label', 'Families')
      await tap(m, 'Create')
      await contains(page, 'Families')
      await f.h.db
        .updateTable('invites')
        .set({ uses: 13 })
        .where('scope_id', '=', f.teamA)
        .where('label', '=', 'Families')
        .execute()
      await go(settings, 'TEAM DETAILS')
      await go(`/groups/team/${f.teamA}/settings/invites`, 'Used 13 times')
      await capture(m, artifacts!, 'invite-spectators.png')
      await tap(m, 'Disable')
      await go(settings, 'TEAM DETAILS')
      expect(
        await page.evaluate(() => {
          const copy = document.body.textContent!
          return (
            copy.indexOf('SEASON PARTICIPATION') <
            copy.indexOf('PARENT ORGANIZATIONS')
          )
        })
      ).equals(true)
      await near('Leave Harbor League')
      await capture(m, artifacts!, 'team-settings-bottom-after.png')
      await tap(m, 'Leave Harbor League')
      await contains(page, 'will no longer manage Bluebirds')
      await capture(m, artifacts!, 'leave-parent-modal.png')
      await tap(m, 'Cancel')
      await tap(m, 'Leave Harbor League')
      await m.tapOn({
        css: '[aria-label="Review relationship changes"] [data-testid="settings-pill-button"]',
        timeout: 10000
      })
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Leave Harbor League"]') == null
      )
      await go(`/groups/season/${f.seasonA}/settings`, 'SEASON DETAILS')
      await capture(m, artifacts!, 'season-settings-details-after.png')
      expect(await page.$('[aria-label="Toronto, Ontario, Canada"]')).equals(
        null
      )
      await go(`/groups/league/${f.leagueA}/settings`, 'LEAGUE DETAILS')
      await capture(m, artifacts!, 'league-settings-top-after.png')
      for (const [kind, id] of [
        ['season', f.seasonA],
        ['league', f.leagueA]
      ] as const) {
        await go(
          `/groups/${kind}/${id}?tab=teams`,
          kind === 'season' ? 'Spring 2026' : 'Harbor League'
        )
        await near('Create team')
        await tap(m, 'Create team')
        await tap(m, 'Placeholder team')
        await contains(page, 'Create Placeholder Team')
        await fill(
          m,
          'Team name',
          `${kind === 'season' ? 'Season' : 'League'} Placeholder`
        )
        await tap(m, 'Continue')
        await contains(page, 'Choose this team')
        expect(
          await page.$('[aria-label="Toronto, Ontario, Canada"]')
        ).not.equals(null)
        await capture(m, artifacts!, `placeholder-${kind}-location.png`)
        await tap(m, 'Previous step')
        await tap(m, 'Cancel')
      }
      console.log(
        'E25 PASS: league and season Create Placeholder Team use the shared creation and Location screens'
      )
      await go('/create/team', 'Create Team')
      await fill(m, 'Team name', 'Wrens')
      await tap(m, 'Continue')
      await tap(m, 'Location not set, Add a city')
      await fill(m, 'City', 'tor')
      await m.tapOn({ css: '[aria-label^="Choose Toronto"]', timeout: 10000 })
      await contains(page, 'Save to use Toronto')
      await tap(m, 'Save')
      await contains(page, 'Toronto, Ontario')
      await capture(m, artifacts!, 'create-team-location-after.png')
      console.log(
        'E11–E25 core settings flows PASS: individual name save, routed Add People, invitations, every player, spectator links, parent confirmation and all group kinds'
      )
      return
    }
    if (process.argv.includes('E8') || live) {
      await f.h.db
        .updateTable('teams')
        .set({
          name: 'Bluebirds',
          locality: {
            city: 'Toronto',
            region: 'Ontario',
            country: 'Canada',
            placeId: null,
            timezone: 'America/Toronto'
          }
        })
        .where('id', '=', f.teamA)
        .execute()
      await m.openLink({
        link: f.h.origin + `/groups/team/${f.teamA}/settings`
      })
      await contains(page, 'TEAM DETAILS')
      await capture(m, artifacts!, 'team-settings-top-after.png')
      await tap(m, 'Toronto, Ontario, Canada')
      await page.waitForSelector('[aria-label="City"]')
      await m.openBrowser({ url: page.url() })
      await page.waitForSelector('[aria-label="City"]')
      await fill(m, 'City', live ? 'austin' : 'au')
      await contains(page, 'Powered by Google')
      await capture(m, artifacts!, 'location-screen-after.png')
      if (!live) {
        await m.command('scroll', { direction: 'down' })
        await m.waitForAnimationToEnd()
        expect(
          await page.$eval(
            '[data-testid="city-suggestions"]',
            element => element.scrollTop
          )
        ).greaterThan(0)
        await capture(m, artifacts!, 'location-list-scrolled.png')
        expect(
          await page.evaluate(() =>
            document.activeElement == null
              ? null
              : document.activeElement.getAttribute('aria-label')
          )
        ).not.equals('City')
      }
      await fill(m, 'City', 'austin')
      if (live)
        await m.tapOn({
          css: '[role="button"][aria-label^="Choose Austin,"]',
          timeout: 15000,
          waitToSettleTimeoutMs: 500
        })
      else await tap(m, 'Choose Austin, Texas, United States')
      await contains(page, 'Save to use Austin')
      await capture(m, artifacts!, 'location-chosen.png')
      await tap(m, 'Save')
      await contains(page, 'TEAM DETAILS')
      await contains(page, 'Austin, Texas')
      const saved = await f.h.db
        .selectFrom('teams')
        .select('locality')
        .where('id', '=', f.teamA)
        .executeTakeFirstOrThrow()
      expect(saved.locality).include({
        city: 'Austin',
        timezone: 'America/Chicago'
      })
      if (live) {
        const lines = [
          '$ E27 through the fixture server with the private Places API key'
        ]
        for (const query of ['austin', 'toronto']) {
          const suggestions = await f.h.request(
            'GET',
            `/locations?query=${query}&session=live-proof-${query}`,
            undefined,
            101
          )
          lines.push(
            `$ GET /api/v1/locations?query=${query}&session=<fixture>`,
            `${suggestions.status} ${JSON.stringify(await suggestions.json())}`
          )
        }
        lines.push('Austin saved ' + JSON.stringify(saved.locality))
        await tap(m, 'Austin, Texas, United States')
        await fill(m, 'City', 'toronto')
        await m.tapOn({
          css: '[role="button"][aria-label^="Choose Toronto,"]',
          timeout: 15000,
          waitToSettleTimeoutMs: 500
        })
        await contains(page, 'Save to use Toronto')
        await tap(m, 'Save')
        await contains(page, 'TEAM DETAILS')
        await contains(page, 'Toronto, Ontario')
        const toronto = await f.h.db
          .selectFrom('teams')
          .select('locality')
          .where('id', '=', f.teamA)
          .executeTakeFirstOrThrow()
        expect(toronto.locality).include({
          city: 'Toronto',
          timezone: 'America/Toronto'
        })
        lines.push(
          'Toronto saved ' + JSON.stringify(toronto.locality),
          'E27 PASS'
        )
        await writeFile(
          join(artifacts!, 'google-places-live.log'),
          lines.join('\n') + '\n'
        )
        console.log(
          'E27 PASS: live Google city search and saved Austin/Toronto time zones'
        )
        return
      }
      console.log(
        'E8/E9 PASS: shared Location screen, independent scrolling, keyboard blur and stored time zone'
      )
      cityStub.controls.fail = true
      await tap(m, 'Austin, Texas, United States')
      await page.waitForSelector('[aria-label="City"]')
      await m.openBrowser({ url: page.url() })
      await page.waitForSelector('[aria-label="City"]')
      await fill(m, 'City', 'aus')
      await contains(page, 'City lookup is unavailable. Try again.')
      await capture(m, artifacts!, 'location-unavailable.png')
      cityStub.controls.fail = false
      await fill(m, 'City', 'austin')
      await tap(m, 'Choose Austin, Texas, United States')
      await contains(page, 'Save to use Austin')
      await tap(m, 'Cancel')
      console.log(
        'E10 PASS: provider failure remains in the suggestion surface and a fresh search recovers'
      )
      return
    }
    if (process.argv.includes('E4')) {
      await f.h.db
        .updateTable('teams')
        .set({ name: 'Bluebirds' })
        .where('id', '=', f.teamA)
        .execute()
      for (let index = 0; index < 3; index++)
        await f.h.db
          .insertInto('games')
          .values({
            id: `gam_settings_fixture_${index}`,
            home_team_id: f.teamA,
            away_team_id: f.teamB,
            season_id: null,
            start_at: new Date(`2027-03-${20 + index}T19:00:00Z`),
            status: 'scheduled'
          })
          .execute()
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: 'role_card_coach',
          scope_type: 'team',
          scope_id: f.teamA,
          user_id: 103,
          role: 'coach'
        })
        .execute()
      await f.h.db
        .insertInto('memberships')
        .values({
          id: 'mem_card_member',
          team_id: f.teamA,
          user_id: 106,
          is_player: false
        })
        .execute()
      const scheduleUrl = f.h.origin + `/teams/${f.teamA}?tab=schedule`
      await m.openLink({ link: scheduleUrl })
      await contains(page, 'Add Event')
      await m.scrollUntilVisible({ element: { text: 'Add Event' } })
      await capture(m, artifacts!, 'team-schedule-end-after.png')
      const size = await page.evaluate(() => {
        const card = document
          .querySelector('[data-testid="add-event-card"]')!
          .getBoundingClientRect()
        const row = document
          .querySelector('[data-testid="scheduleGame"]')!
          .getBoundingClientRect()
        return { width: card.width, rowWidth: row.width, height: card.height }
      })
      expect(Math.abs(size.width - size.rowWidth)).lessThan(1)
      expect(size.height).within(52, 60)
      await tap(m, 'Add Event')
      await contains(page, 'Create Game')
      await capture(m, artifacts!, 'create-game-from-card.png')
      await tap(m, 'Back')
      await contains(page, 'Add Event')
      for (const [user, file, allowed] of [
        [103, 'team-schedule-coach.png', true],
        [106, 'team-schedule-member.png', false]
      ] as const) {
        await page.evaluate(() => {
          localStorage.clear()
        })
        await browser.setCookie({
          name: SESSION_COOKIE,
          value: f.h.tokens.get(user)!,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true
        })
        await m.openLink({ link: scheduleUrl })
        await contains(page, 'Bluebirds')
        await page.waitForSelector('[data-testid="scheduleGame"]')
        expect((await page.$('[data-testid="add-event-card"]')) != null).equals(
          allowed
        )
        await capture(m, artifacts!, file)
      }
      console.log(
        'E4/E6 PASS: schedule card geometry, navigation and staff/member visibility',
        size
      )
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: f.h.tokens.get(103)!,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true
      })
      await page.evaluate(() => {
        localStorage.clear()
      })
      await m.openLink({ link: scheduleUrl })
      await contains(page, 'Add Event')
      await m.scrollUntilVisible({ element: { text: 'Add Event' } })
      await tap(m, 'Add Event')
      await contains(page, 'Create Game')
      await m.tapOn({
        css: '[role="radio"][aria-label*="Practice"]',
        timeout: 10000
      })
      await contains(page, 'Create Practice')
      await m.scrollUntilVisible({ element: { text: 'Create event' } })
      await m.command('scroll', { direction: 'down' })
      await m.waitForAnimationToEnd()
      await tap(m, 'Create event')
      await page.waitForFunction(() => location.pathname.startsWith('/games/'))
      await contains(page, 'Practice')
      expect(
        await f.h.db
          .selectFrom('team_events')
          .select('id')
          .where('team_id', '=', f.teamA)
          .where('event_type', '=', 'practice')
          .execute()
      ).length(1)
      await m.openLink({ link: scheduleUrl })
      await contains(page, 'Practice')
      await capture(m, artifacts!, 'team-schedule-coach-practice.png')
      await f.h.db
        .updateTable('teams')
        .set({ name: 'Wrens' })
        .where('id', '=', f.standaloneTeam)
        .execute()
      await m.openLink({
        link: f.h.origin + `/teams/${f.standaloneTeam}?tab=schedule`
      })
      await contains(page, 'No games scheduled')
      await contains(page, 'Add Event')
      await capture(m, artifacts!, 'team-schedule-empty-after.png')
      console.log(
        'E5/E7 PASS: coach creates practice through Add Event; empty schedule retains the card'
      )
      return
    }
    await m.openLink({ link: f.h.origin + '/account' })
    await contains(page, 'Save name')
    const label = await page.evaluateHandle(() =>
      [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node => node.textContent === 'Save name'
      )!
    )
    const button = label.asElement()!
    const geometry = await button.evaluate(node => {
      const element = node as HTMLElement
      const css = getComputedStyle(element)
      return {
        height: element.getBoundingClientRect().height,
        left: parseFloat(css.paddingLeft),
        right: parseFloat(css.paddingRight)
      }
    })
    expect(geometry.left).at.least(geometry.height / 2)
    expect(geometry.right).at.least(geometry.height / 2)
    await button.screenshot({
      path: join(artifacts!, 'account-save-name-after.png')
    })
    await writeFile(
      join(artifacts!, 'settingsCleanup-e2e.log'),
      '$ node -r sucrase/register src/app/settingsCleanup.e2e.ts --only E1\nE1 PASS: Save name label clears both pill arcs\n'
    )
    console.log('E1 PASS', geometry)
    if (process.argv.includes('E1')) return
    await capture(m, artifacts!, 'account-top-after.png')
    expect(await page.evaluate(() => document.body.textContent)).not.includes(
      'PROFILE'
    )
    await tap(m, 'Add photo')
    await contains(page, 'Save photo')
    await capture(m, artifacts!, 'account-photo-sheet.png')
    await tap(m, 'Baseball')
    await tap(m, 'Save photo')
    await contains(page, 'Photo saved')
    await tap(m, 'Change photo')
    await tap(m, 'Cancel')
    await fill(m, 'Name', 'Mookie Betts')
    await tap(m, 'Save name')
    await contains(page, 'Name saved')
    await m.scrollUntilVisible({ element: { text: 'Node administration' } })
    await capture(m, artifacts!, 'account-bottom-after.png')
    const order = await page.evaluate(() => {
      const actions = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ]
      const signOut = actions.find(
        node => node.getAttribute('aria-label') === 'Sign out'
      )!
      const administration = actions.find(
        node => node.textContent === 'Node administration'
      )!
      return {
        follows: Boolean(
          signOut.compareDocumentPosition(administration) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
        background: getComputedStyle(signOut).backgroundColor
      }
    })
    expect(order.follows).equals(true)
    expect(order.background).equals('rgba(0, 0, 0, 0)')
    await tap(m, 'Sign out')
    await contains(page, 'Sign in')
    console.log(
      'E2/E3 PASS: hero photo, name save, red sign out and administration order'
    )
  } finally {
    await recordBrowserCoverage(
      [page],
      f.h.origin,
      resolve(
        `coverage/creation/settings-${process.argv.at(-1) ?? 'account'}-browser.json`
      )
    )
    await m.detach()
    await browser.disconnect()
    await daemon.shutdown()
    await f.h.close()
    await cityStub.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
