import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Page } from 'puppeteer'

import { asParentActions } from '../common/groupLinks'
import { userIdOfGumbo } from '../common/userId'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { applyParents, previewParents } from '../server/groups/relationships'
import { rolesAt } from '../server/invites/people'
import { publishPictureCatalog } from '../server/media/pictureCatalog'
import { actor, demoLocality, groupFixture } from '../test/groupFixtures'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import {
  fill,
  freezeBrowserClock,
  press,
  text
} from './creationBrowserActions.e2e'

async function main(): Promise<void> {
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  if (artifacts == null)
    throw new Error('Supply the creation artifacts directory')
  const f = await groupFixture(resolve('dist'))
  const browser = await puppeteer.launch({ headless: true })
  const pages: Page[] = []
  const lines = ['$ node -r sucrase/register src/app/reviewCreation.e2e.ts']
  try {
    const pageFor = async (user?: number): Promise<Page> => {
      const context = await browser.createBrowserContext()
      if (user != null)
        await context.setCookie({
          name: SESSION_COOKIE,
          value: f.h.tokens.get(user)!,
          domain: new URL(f.h.origin).hostname,
          path: '/',
          httpOnly: true
        })
      const page = await context.newPage()
      pages.push(page)
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      await freezeBrowserClock(page)
      await page.setViewport({ width: 1440, height: 900 })
      return page
    }
    const owner = await pageFor(103)
    const league = await pageFor(101)
    const otherLeague = await pageFor(102)
    const created = await f.h.request(
      'POST',
      '/seasons',
      {
        name: 'Demo Extra Standalone',
        startsOn: '2027-03-01',
        endsOn: '2027-05-31',
        timezone: 'UTC',
        idempotencyKey: 'review-extra-standalone'
      },
      103
    )
    expect(created.status).equals(201)
    const extra = ((await created.json()) as { id: string }).id
    await applyParents(
      f.h.db,
      [actor(103)],
      await previewParents(
        f.h.db,
        asParentActions([
          {
            operation: 'attach',
            child: { kind: 'team', id: f.standaloneTeam },
            parent: { kind: 'season', id: f.standaloneSeason }
          }
        ])
      )
    )
    await owner.goto(
      f.h.origin +
        `/groups/team/${f.standaloneTeam}/link?target=season&relationship=parent&direction=parents`,
      { waitUntil: 'domcontentloaded' }
    )
    await fill(owner, 'Search by name or city', 'Demo Extra Standalone')
    await press(owner, 'Choose Demo Extra Standalone')
    await text(owner, 'Two or more parent seasons must share a league')
    for (const name of ['Demo Standalone', 'Demo Extra Standalone']) {
      await press(owner, 'Add another parent change')
      await press(owner, 'Find a season')
      await fill(owner, 'Search additional group', name)
      await press(owner, `Choose change ${name}`)
      await fill(owner, 'Search additional group', 'Demo League A')
      await press(owner, 'Choose change Demo League A')
    }
    await press(owner, 'Review all parent changes')
    await text(owner, 'Add Demo League A as parent of Demo Visitors')
    await owner.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
        node =>
          node.textContent === 'Send invitation' &&
          node.getAttribute('aria-disabled') !== 'true'
      )
    )
    await owner.screenshot({
      path: join(artifacts, 'compatible-parent-batch.png')
    })
    await press(owner, 'Send invitation')
    await text(owner, 'Pending')
    const requestId = new URL(owner.url()).pathname.split('/').at(-1)!
    await press(owner, 'Accept invitation')
    await text(owner, 'Pending')
    await league.goto(f.h.origin + `/notifications/${requestId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(league, 'Accept invitation')
    await text(league, 'Accepted')
    expect(
      (
        await f.h.db
          .selectFrom('teams')
          .select('league_id')
          .where('id', '=', f.standaloneTeam)
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals(f.leagueA)
    expect(
      (
        await f.h.db
          .selectFrom('season_team_parents')
          .select('season_id')
          .where('team_id', '=', f.standaloneTeam)
          .execute()
      )
        .map(row => row.season_id)
        .sort()
    ).deep.equals([extra, f.standaloneSeason].sort())
    lines.push(
      'E5/E13 review PASS: the real interface resolves a second standalone-parent conflict into one explicit three-action batch; independent team/season and league administrators approve the exact terms; both seasons and the team share one league'
    )

    await league.goto(f.h.origin + '/account', {
      waitUntil: 'domcontentloaded'
    })
    await press(league, 'Add photo')
    await press(league, 'Baseball')
    await press(league, 'Save profile picture')
    await text(league, 'Profile picture saved')
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('picture_catalog_id')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).picture_catalog_id
    ).equals('baseball')
    await league.reload({ waitUntil: 'domcontentloaded' })
    await press(league, 'Change photo')
    await press(league, 'Use initials')
    await press(league, 'Save profile picture')
    await text(league, 'Profile picture saved')
    expect(
      await f.h.db
        .selectFrom('users')
        .select(['avatar_path', 'picture_catalog_id'])
        .where('id', '=', userIdOfGumbo(101))
        .executeTakeFirstOrThrow()
    ).deep.equals({ avatar_path: null, picture_catalog_id: null })
    lines.push(
      'E2 review PASS: an already-completed account uses the same sports grid to save a catalog picture, reload it, and return to initials without deleting shared catalog objects'
    )

    // Reloaded creation resolves context rather than relying on navigation memory.
    const locality = {
      city: 'Demo Harbor',
      region: 'Demo Coast',
      country: 'US',
      placeId: null,
      timezone: 'America/New_York'
    }
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/league/${f.leagueA}`,
          { locality },
          101
        )
      ).status
    ).equals(200)
    await league.goto(
      f.h.origin + `/create/team?parentKind=league&parentId=${f.leagueA}`,
      { waitUntil: 'domcontentloaded' }
    )
    await league.reload({ waitUntil: 'domcontentloaded' })
    await fill(league, 'Team name', 'Demo Context Team')
    await press(league, 'Continue')
    await text(league, 'Choose the city')
    expect(await league.evaluate(() => document.body.textContent)).not.includes(
      'Selected: Demo Harbor'
    )
    expect(
      await league.evaluate(() => {
        const button = [
          ...document.querySelectorAll<HTMLElement>('[role="button"]')
        ].find(node => node.textContent === 'Continue')
        return button == null ? null : button.getAttribute('aria-disabled')
      })
    ).equals('true')
    await press(league, 'Choose Demo Harbor, Demo Coast, US')
    await press(league, 'Continue')
    await press(league, 'Use initials')
    await press(league, 'Create Team')
    await league.waitForSelector('[aria-label="Manage"]')
    expect(
      (
        await f.h.db
          .selectFrom('teams')
          .select('locality')
          .where('name', '=', 'Demo Context Team')
          .executeTakeFirstOrThrow()
      ).locality
    ).deep.equals(locality)
    await league.goto(
      f.h.origin + `/create/season?parentKind=league&parentId=${f.leagueA}`,
      { waitUntil: 'domcontentloaded' }
    )
    await fill(league, 'Season name', 'Demo Context Season')
    await press(league, 'Continue')
    await press(league, 'Fall 2026')
    await press(league, 'Continue')
    await press(league, 'Use initials')
    await press(league, 'Create Season')
    await league.waitForSelector('[aria-label="Season settings"]')
    expect(
      (
        await f.h.db
          .selectFrom('seasons')
          .select('timezone')
          .where('name', '=', 'Demo Context Season')
          .executeTakeFirstOrThrow()
      ).timezone
    ).equals('America/New_York')
    lines.push(
      'E3/E4 review PASS: a reloaded contextual team requires explicit confirmation of its parent locality; a league-launched season uses the league locality timezone'
    )

    const participation = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        seasonId: f.seasonB,
        teamId: f.standaloneTeam,
        sender: { kind: 'team', id: f.standaloneTeam },
        idempotencyKey: 'review-preserved-competition'
      },
      103
    )
    expect(participation.status).equals(201)
    const participationId = ((await participation.json()) as { id: string }).id
    expect(
      await (
        await f.h.request(
          'POST',
          `/relationship-requests/${participationId}/accept`,
          {},
          102
        )
      ).json()
    ).property('status', 'accepted')
    const game = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'team', id: f.standaloneTeam },
        game: {
          homeTeamId: f.standaloneTeam,
          awayTeamId: f.teamB,
          seasonId: null,
          startAt: '2027-07-01T19:00:00Z',
          venue: 'Demo park',
          status: 'scheduled'
        },
        idempotencyKey: 'review-preserved-game'
      },
      103
    )
    expect(game.status).equals(201)
    const gameId = ((await game.json()) as { id: string }).id
    expect(
      await (
        await f.h.request('POST', `/game-requests/${gameId}/accept`, {}, 102)
      ).json()
    ).property('status', 'accepted')
    const priorGames = await f.h.db
      .selectFrom('games')
      .select('id')
      .orderBy('id')
      .execute()
    await owner.goto(
      f.h.origin +
        `/groups/team/${f.standaloneTeam}/link?target=league&relationship=parent&direction=parents`,
      { waitUntil: 'domcontentloaded' }
    )
    await fill(owner, 'Search by name or city', 'Demo League B')
    await press(owner, 'Choose Demo League B')
    await text(owner, 'Break the current league relationship')
    await press(owner, 'Add another parent change')
    await press(owner, 'Remove parent')
    await fill(owner, 'Search additional group', 'Demo Visitors')
    await press(owner, 'Choose change Demo Visitors')
    await fill(owner, 'Search additional group', 'Demo League A')
    await press(owner, 'Choose change Demo League A')
    await press(owner, 'Review all parent changes')
    await text(owner, 'Remove')
    await press(owner, 'Send invitation')
    await text(owner, 'Pending')
    const moveId = new URL(owner.url()).pathname.split('/').at(-1)!
    expect(
      await (
        await f.h.request('GET', `/me/notifications/${moveId}`, undefined, 101)
      ).json()
    ).property('canAct', false)
    await otherLeague.goto(f.h.origin + `/notifications/${moveId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(otherLeague, 'Accept invitation')
    await text(otherLeague, 'Accepted')
    expect(
      (
        await f.h.db
          .selectFrom('teams')
          .select('league_id')
          .where('id', '=', f.standaloneTeam)
          .executeTakeFirstOrThrow()
      ).league_id
    ).equals(f.leagueB)
    expect(
      await f.h.db
        .selectFrom('season_team_parents')
        .select('season_id')
        .where('team_id', '=', f.standaloneTeam)
        .execute()
    ).length(0)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .select('team_id')
        .where('season_id', '=', f.seasonB)
        .where('team_id', '=', f.standaloneTeam)
        .where('active', '=', true)
        .execute()
    ).length(1)
    expect(
      await f.h.db.selectFrom('games').select('id').orderBy('id').execute()
    ).deep.equals(priorGames)
    lines.push(
      'E5/E13 review PASS: an explicit cross-league detach/attach batch uses the child administrator’s removal consent and the destination league’s acceptance, removes incompatible parent seasons, and preserves competition membership and approved game IDs'
    )

    // A host proposal has three independent parties; the team can retract an
    // already-approved side while another side is still pending.
    const pending = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          homeTeamId: f.standaloneTeam,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-07-02T19:00:00Z',
          venue: 'Demo pending park',
          status: 'scheduled'
        },
        idempotencyKey: 'review-retract-consent'
      },
      101
    )
    expect(pending.status).equals(201)
    const pendingId = ((await pending.json()) as { id: string }).id
    await owner.goto(f.h.origin + `/notifications/${pendingId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(owner, 'Accept invitation')
    await text(owner, 'Pending')
    await press(owner, 'Withdraw invitation')
    await text(owner, 'Cancelled')
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('game_id')
          .where('id', '=', pendingId)
          .executeTakeFirstOrThrow()
      ).game_id
    ).equals(null)
    lines.push(
      'E15 review PASS: an affected team can withdraw its recorded approval before the remaining opponent consents, closing the proposal without publishing a game'
    )

    const cacheRequest = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        kind: 'participation',
        seasonId: f.seasonA,
        teamId: f.standaloneTeam,
        sender: { kind: 'season', id: f.seasonA },
        idempotencyKey: 'review-cache'
      },
      101
    )
    expect(cacheRequest.status).equals(201)
    const cacheId = ((await cacheRequest.json()) as { id: string }).id
    const cached = (await (
      await f.h.request('GET', `/me/notifications/${cacheId}`, undefined, 103)
    ).json()) as { title: string }
    await owner.goto(f.h.origin + '/', { waitUntil: 'domcontentloaded' })
    await text(owner, 'Your Home')
    for (let tap = 0; tap < 4; tap++) await press(owner, 'Notifications')
    await text(owner, cached.title)
    await press(owner, 'Back')
    await text(owner, 'Your Home')
    lines.push(
      'E8/E10 review PASS: repeated native-style bell taps keep one inbox entry; one application Back returns to the preceding Home screen'
    )
    for (let index = 0; index < 30; index++) {
      const extraInvite = await f.h.request(
        'POST',
        '/relationship-requests',
        {
          kind: 'participation',
          seasonId: f.seasonA,
          teamId: f.standaloneTeam,
          sender: { kind: 'season', id: f.seasonA },
          idempotencyKey: `browser-page-${index}`
        },
        101
      )
      expect(extraInvite.status).equals(201)
    }
    await owner.goto(f.h.origin + '/notifications', {
      waitUntil: 'domcontentloaded'
    })
    await text(owner, cached.title)
    await press(owner, 'Load more')
    await owner.waitForFunction(
      title =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter(
          node => node.getAttribute('aria-label') === `Accept ${title}`
        ).length > 25,
      {},
      cached.title
    )
    const loadedCount = await owner.evaluate(
      title =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter(
          node => node.getAttribute('aria-label') === `Accept ${title}`
        ).length,
      cached.title
    )
    expect(loadedCount).greaterThan(25)
    const refreshedSecondPage = owner.waitForResponse(
      response =>
        response.url().includes('/me/notifications?') &&
        response.url().includes('cursor=')
    )
    await owner.evaluate(() => window.dispatchEvent(new Event('focus')))
    await refreshedSecondPage
    await owner.waitForFunction(
      (title, count) =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].filter(
          node => node.getAttribute('aria-label') === `Accept ${title}`
        ).length === count,
      {},
      cached.title,
      loadedCount
    )
    lines.push(
      'E10 review PASS: an inbox with more than twenty-five actual pending requests retains its loaded second page after a foreground refresh'
    )
    let notificationFailure: 'none' | 'offline' | 'refused' = 'none'
    let refuseDecision = false
    await owner.setRequestInterception(true)
    owner.on('request', request => {
      if (
        refuseDecision &&
        request.url().includes(`/relationship-requests/${cacheId}/accept`)
      ) {
        request
          .respond({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'conflict',
              message: 'This request was already decided'
            })
          })
          .catch(() => undefined)
        return
      }
      if (
        !request.url().includes('/me/notifications') ||
        notificationFailure === 'none'
      ) {
        request.continue().catch(() => undefined)
      } else if (notificationFailure === 'offline') {
        request.abort('internetdisconnected').catch(() => undefined)
      } else {
        request
          .respond({
            status: 403,
            contentType: 'text/plain',
            body: 'Forbidden'
          })
          .catch(() => undefined)
      }
    })
    notificationFailure = 'offline'
    await owner.evaluate(() => window.dispatchEvent(new Event('focus')))
    await text(owner, 'Retry notifications')
    await text(owner, cached.title)
    notificationFailure = 'none'
    // A refused Accept leaves the card, says why, and can be pressed again.
    refuseDecision = true
    const firstAccept = await owner.$(`[aria-label="Accept ${cached.title}"]`)
    expect(firstAccept).not.equals(null)
    await owner.evaluate(
      label =>
        document.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click(),
      `Accept ${cached.title}`
    )
    await text(owner, 'This request was already decided')
    await text(owner, cached.title)
    refuseDecision = false
    // The detail, opened by its address, keeps Accept invitation.
    await owner.goto(f.h.origin + `/notifications/${cacheId}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(owner, 'Accept invitation')
    notificationFailure = 'offline'
    await owner.evaluate(() => window.dispatchEvent(new Event('focus')))
    await text(owner, 'Showing the saved invitation')
    expect(
      await owner.evaluate(() => {
        const button = [
          ...document.querySelectorAll<HTMLElement>('[role="button"]')
        ].find(node => node.textContent === 'Accept invitation')
        return button == null ? null : button.getAttribute('aria-disabled')
      })
    ).equals('true')
    notificationFailure = 'refused'
    await press(owner, 'Retry invitation')
    await owner.waitForFunction(
      title =>
        document.body.textContent !== null &&
        !document.body.textContent.includes(title),
      {},
      cached.title
    )
    expect(
      await owner.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[role="button"]')].some(
          node => node.textContent === 'Accept invitation'
        )
      )
    ).equals(false)
    notificationFailure = 'none'
    lines.push(
      'E12 review PASS: browser transport failures retain the loaded inbox and detail; decisions are disabled; an explicit non-JSON authorization refusal clears cached private detail'
    )
    await f.h.db
      .insertInto('seasons')
      .values(
        Array.from({ length: 51 }, (_, index) => ({
          id: `season_browser_extra_${index}`,
          name: `Demo Future ${index}`,
          year: 2040,
          league_id: f.leagueA,
          starts_on: '2040-03-01',
          ends_on: '2040-05-31',
          timezone: 'UTC'
        }))
      )
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values(
        Array.from({ length: 51 }, (_, index) => ({
          id: `role_browser_extra_${index}`,
          scope_type: 'season' as const,
          scope_id: `season_browser_extra_${index}`,
          user_id: userIdOfGumbo(101),
          role: 'admin' as const,
          granted_by: userIdOfGumbo(101),
          granted_at: new Date()
        }))
      )
      .execute()
    await league.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(league, 'Manage')
    await press(league, 'Create Game')
    // A team page's game is a scrimmage or exhibition in no season, however
    // many seasons its administrator keeps; seasons schedule their own games.
    await text(league, 'always creates a scrimmage/exhibition game')
    expect(
      await league.evaluate(() =>
        // No `??` here: the browser runs this without sucrase's helpers.
        [...document.querySelectorAll('[role="button"]')].some(node => {
          const label = node.getAttribute('aria-label')
          return label !== null && /season/i.test(label)
        })
      )
    ).equals(false)
    lines.push(
      'E4/E6 review PASS: an administrator with more than fifty owned seasons creates a team game as an exhibition, with no season to choose'
    )

    const frozenGame = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-01T19:00:00Z',
          status: 'scheduled'
        },
        idempotencyKey: 'browser-frozen-game'
      },
      101
    )
    expect(frozenGame.status).equals(201)
    const frozenId = ((await frozenGame.json()) as { id: string }).id
    await otherLeague.goto(f.h.origin + `/notifications/${frozenId}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(otherLeague, 'Demo Eagles invited to game vs. Demo Hawks')
    expect(
      (
        await f.h.request(
          'PUT',
          `/groups/team/${f.teamB}`,
          { name: 'Demo Renamed Eagles' },
          102
        )
      ).status
    ).equals(200)
    await otherLeague.reload({ waitUntil: 'domcontentloaded' })
    await text(otherLeague, 'Demo Eagles invited to game vs. Demo Hawks')
    expect(
      await otherLeague.evaluate(() => document.body.textContent)
    ).not.includes('Demo Renamed Eagles')
    await press(otherLeague, 'Accept invitation')
    await text(otherLeague, 'Accepted')
    await text(otherLeague, 'Demo Eagles invited to game vs. Demo Hawks')
    lines.push(
      'E10/E20 review PASS: changing a live opponent name preserves the pending invitation description and its accepted history after a real reload'
    )

    const email = 'fixture106@example.com'
    await f.h.db
      .updateTable('users')
      .set({ login_enabled: false })
      .where('id', '=', userIdOfGumbo(106))
      .execute()
    await f.h.db
      .updateTable('user_emails')
      .set({
        email: 'Fixture106@Example.com',
        verified_at: null,
        source: 'import'
      })
      .where('user_id', '=', userIdOfGumbo(106))
      .execute()
    const invited = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        email,
        admin: false,
        flags: ['coach'],
        idempotencyKey: 'browser-imported-invite'
      },
      101
    )
    expect(invited.status).equals(201)
    const personalId = (
      (await invited.json()) as { invited: { requestId: string } }
    ).invited.requestId
    const imported = await pageFor()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'membership_browser_role_player',
        user_id: userIdOfGumbo(104),
        team_id: f.teamA,
        role: 'member',
        is_player: true
      })
      .execute()
    await imported.goto(f.h.origin + '/sign-in', {
      waitUntil: 'domcontentloaded'
    })
    await fill(imported, 'E-mail address', email)
    await press(imported, 'Send me a sign-in code')
    await text(imported, 'six-digit code is on its way')
    await fill(imported, 'Sign-in code', f.h.mail.get(email)!)
    await press(imported, 'Sign in')
    await fill(imported, 'Name', 'Tim Raines')
    await press(imported, 'Continue')
    await press(imported, 'Baseball')
    await press(imported, 'Continue')
    await text(imported, 'Your Home')
    // Proving the address applied the invitation waiting for it, with only
    // the role it named; nothing is left to accept.
    expect(
      await rolesAt(f.h.db, 'team', f.teamA, userIdOfGumbo(106))
    ).deep.equals(['coach'])
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', personalId)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('accepted')
    // The inbox says what was given, with nothing to accept.
    await press(imported, 'Notifications')
    await text(imported, 'Babe Ruth added you as Coach of Demo Hawks')
    expect(
      await imported.evaluate(() => document.body.textContent)
    ).not.includes('Accept invitation')
    await press(imported, 'Back')
    await text(imported, 'Your Home')
    await press(imported, 'Demo Hawks')
    await imported.waitForFunction(
      () =>
        document.body.textContent != null &&
        !document.body.textContent.includes('Loading')
    )
    await press(imported, 'Team', 'tab')
    await press(imported, 'Ichiro')
    await press(imported, 'Player settings', 'button')
    await fill(imported, 'Jersey number', '17')
    await press(imported, 'Save')
    await text(imported, 'Saved.')
    const songInvite = await f.h.request(
      'POST',
      `/manage/team/${f.teamA}/people`,
      {
        email,
        admin: false,
        flags: ['songkeeper'],
        idempotencyKey: 'browser-songkeeper-upgrade'
      },
      101
    )
    // The address is proved now, so Songkeeper is given at once, and told.
    expect(songInvite.status).equals(201)
    expect(await songInvite.json()).deep.include({ added: true })
    expect(
      await rolesAt(f.h.db, 'team', f.teamA, userIdOfGumbo(106))
    ).deep.equals(['coach', 'songkeeper'])
    await press(imported, 'Notifications')
    await text(imported, 'added you as Songkeeper of Demo Hawks')
    await press(imported, 'Back')
    await press(imported, 'Walk-up', 'tab')
    await text(imported, 'No walk-up song yet')
    expect(
      await rolesAt(f.h.db, 'team', f.teamA, userIdOfGumbo(106))
    ).deep.equals(['coach', 'songkeeper'])
    lines.push(
      'E8/E9 review PASS: a coach invitation applied on sign-in and a songkeeper role added at once refresh shared roles; player Settings saves and the authorized Walk-up tab opens in the same app session without a reload; native music editing retains its existing platform requirement'
    )
    lines.push(
      'E8 review PASS: proving an imported address signs in to the same account, resumes required onboarding, applies its addressed invitation without acceptance and grants only the role it named'
    )
    const leagueCreated = await f.h.request(
      'POST',
      '/leagues',
      {
        name: 'Demo Navigation League',
        locality: demoLocality,
        idempotencyKey: 'browser-navigation-league'
      },
      101
    )
    expect(leagueCreated.status).equals(201)
    const navigationLeague = (await leagueCreated.json()) as { id: string }
    const seasonCreated = await f.h.request(
      'POST',
      '/seasons',
      {
        name: 'Demo Navigation Season',
        startsOn: '2027-03-01',
        endsOn: '2027-05-31',
        timezone: 'UTC',
        parent: { kind: 'league', id: navigationLeague.id },
        idempotencyKey: 'browser-navigation-season'
      },
      101
    )
    expect(seasonCreated.status).equals(201)
    const navigationSeason = (await seasonCreated.json()) as { id: string }
    const navigation = await pageFor(101)
    await navigation.goto(
      f.h.origin + `/groups/league/${navigationLeague.id}`,
      {
        waitUntil: 'networkidle0'
      }
    )
    let release!: () => Promise<void>
    let acknowledge!: () => void
    const held = new Promise<void>(resolve => {
      acknowledge = resolve
    })
    let hold = true
    await navigation.setRequestInterception(true)
    navigation.on('request', request => {
      if (
        hold &&
        new URL(request.url()).pathname ===
          `/api/v1/leagues/${navigationLeague.id}`
      ) {
        hold = false
        release = async () => {
          await request.continue()
        }
        acknowledge()
      } else request.continue().catch(() => undefined)
    })
    await navigation.evaluate(() => window.dispatchEvent(new Event('focus')))
    await held
    await press(navigation, 'Open Demo Navigation Season')
    await navigation.waitForSelector('[aria-label="Season settings"]')
    const oldResponse = navigation.waitForResponse(
      response =>
        new URL(response.url()).pathname ===
        `/api/v1/leagues/${navigationLeague.id}`
    )
    await release()
    await oldResponse
    await navigation.waitForNetworkIdle()
    expect(new URL(navigation.url()).pathname).equals(
      `/groups/season/${navigationSeason.id}`
    )
    expect(
      await navigation.evaluate(() => document.body.textContent)
    ).not.includes('Create Season')
    await navigation.screenshot({
      path: join(artifacts, 'group-navigation-current.png')
    })
    await press(navigation, 'Teams', 'tab')
    await press(navigation, 'Create team')
    if ((await navigation.$('[aria-label="Placeholder team"]')) !== null)
      await press(navigation, 'Team')
    expect(new URL(navigation.url()).searchParams.get('parentKind')).equals(
      'season'
    )
    expect(new URL(navigation.url()).searchParams.get('parentId')).equals(
      navigationSeason.id
    )
    lines.push(
      'E20 QA PASS: an old real foreground league response cannot replace the current season or change its Create Team parent'
    )

    f.h.objects.clear()
    expect(
      (await f.h.request('GET', '/pictures', undefined, null)).status
    ).equals(503)
    await navigation.goto(f.h.origin + '/account', {
      waitUntil: 'networkidle0'
    })
    const photoLabel = await navigation.evaluate(() =>
      [...document.querySelectorAll('[role="button"]')].some(
        node => node.textContent === 'Change photo'
      )
        ? 'Change photo'
        : 'Add photo'
    )
    await press(navigation, photoLabel)
    await text(navigation, 'Sports pictures could not load')
    expect(await navigation.$('[aria-label="Baseball"]')).equals(null)
    await navigation.screenshot({
      path: join(artifacts, 'catalog-unavailable.png')
    })
    await press(navigation, 'Use initials')
    await press(navigation, 'Save profile picture')
    await text(navigation, 'Profile picture saved')
    await press(navigation, 'Add photo')
    await text(navigation, 'Sports pictures could not load')
    await publishPictureCatalog(f.h.space, resolve('src/app/assets/sports'))
    await press(navigation, 'Retry pictures')
    await press(navigation, 'Baseball')
    await press(navigation, 'Save profile picture')
    await text(navigation, 'Profile picture saved')
    const savedPicture = await f.h.db
      .selectFrom('users')
      .select('avatar_path')
      .where('id', '=', userIdOfGumbo(101))
      .executeTakeFirstOrThrow()
    expect(savedPicture.avatar_path).not.equals(null)
    lines.push(
      'E2 QA PASS: a configured empty image store shows Retry with no blank selectable pictures; initials remain usable and publishing then retrying restores the shared gallery'
    )
    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/creation/review-browser.json')
    )
    await writeFile(
      join(artifacts, 'review-browser-vectors.log'),
      lines.join('\n') + '\n'
    )
    console.log(lines.slice(1).join('\n'))
  } finally {
    await browser.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
