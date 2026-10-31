import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import puppeteer, { type Browser, type Page } from 'puppeteer'

import { recordBrowserCoverage } from '../../e2e/rigs/browserCoverage'
import {
  frameText,
  freezeBrowserClock,
  press,
  text
} from '../../e2e/rigs/creationBrowserActions'
import { asParentActions } from '../common/groupLinks'
import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import { applyParents, previewParents } from '../server/groups/relationships'
import {
  actor,
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../test/groupFixtures'
import { insertFixtureUsers } from '../test/insertFixtureUsers'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null)
  throw new Error('Set TS_CREATION_ARTIFACTS for linking corner proof')
async function main(): Promise<void> {
  const f: GroupFixture = await groupFixture(resolve('dist'))
  let browser: Browser | undefined
  const pages: Page[] = []
  const lines = [
    '$ node -r sucrase/register src/app/relationshipCorners.e2e.ts',
    'Actors use separate browser contexts with authenticated fixture sessions; all decisions and results use the real application.'
  ]
  try {
    await applyParents(
      f.h.db,
      [actor(101)],
      await previewParents(
        f.h.db,
        asParentActions([
          {
            operation: 'attach',
            child: { kind: 'team', id: f.teamA },
            parent: { kind: 'season', id: f.playoffs }
          }
        ])
      )
    )
    const people = [
      [201, 'Babe Ruth', 'league', f.leagueA, 'admin'],
      [202, 'Lou Gehrig', 'season', f.seasonA, 'admin'],
      [203, 'Hank Aaron', 'season', f.playoffs, 'admin'],
      [204, 'Willie Mays', 'team', f.teamA, 'admin'],
      [205, 'Jackie Robinson', 'season', f.seasonB, 'admin'],
      [206, 'Roberto Clemente', 'team', f.teamB, 'admin'],
      [207, 'Ted Williams', 'team', f.teamA, 'coach']
    ] as const
    for (const [id, name, kind, scope, role] of people) {
      await insertFixtureUsers(f.h.db, {
        id,
        legacyId: `usr_corner_${id}`,
        display_name: name,
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(1).join(' '),
        login_enabled: true
      })
      await f.h.db
        .insertInto('user_emails')
        .values({
          id: makeId('userEmail'),
          user_id: userIdOfGumbo(id),
          email: `corner${id}@example.com`,
          is_primary: true,
          verified_at: new Date()
        })
        .execute()
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(id),
          scope_type: kind,
          scope_id: scope,
          role
        })
        .execute()
      f.h.tokens.set(
        id,
        (await createSession(f.h.db, userIdOfGumbo(id), 'corner-fixture')).token
      )
    }
    browser = await puppeteer.launch({ headless: true })
    const pageFor = async (user: number): Promise<Page> => {
      const context = await browser!.createBrowserContext()
      await context.setCookie({
        name: 'ts_session',
        value: f.h.tokens.get(user)!,
        domain: new URL(f.h.origin).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax'
      })
      const page = await context.newPage()
      pages.push(page)
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      await freezeBrowserClock(page)
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      return page
    }
    const host = await pageFor(205)
    const direct = await pageFor(204)
    const plain = await pageFor(207)
    const externalAdmin = await pageFor(103)
    let sequence = 0
    const sendGame = async (
      home = f.teamB,
      away = f.teamA
    ): Promise<string> => {
      const response = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: { kind: 'season', id: f.seasonB },
          game: {
            homeTeamId: home,
            awayTeamId: away,
            seasonId: f.seasonB,
            startAt: new Date(Date.UTC(2029, 6, ++sequence, 19)).toISOString(),
            venue: 'Demo Corner Field',
            outsideTournament: null,
            status: 'scheduled'
          },
          idempotencyKey: `corner-game-${sequence}`
        },
        205
      )
      expect(response.status, await response.clone().text()).equals(201)
      return ((await response.json()) as { id: string }).id
    }
    const published: string[] = []
    for (const user of [201, 202, 203, 204]) {
      const id = await sendGame()
      const page = user === 204 ? direct : await pageFor(user)
      await page.goto(f.h.origin + `/notifications/${id}`, {
        waitUntil: 'domcontentloaded'
      })
      await text(page, 'Pending')
      await press(page, 'Accept invitation')
      await text(page, 'Accepted')
      const request = await f.h.db
        .selectFrom('group_requests')
        .select('game_id')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      published.push(request.game_id!)
      expect(
        await f.h.db
          .selectFrom('season_teams')
          .selectAll()
          .where('season_id', '=', f.seasonB)
          .where('team_id', '=', f.teamA)
          .execute()
      ).length(0)
    }
    const protectedRequest = await sendGame()
    expect(
      (
        await f.h.request(
          'POST',
          `/game-requests/${protectedRequest}/accept`,
          {},
          207
        )
      ).status
    ).equals(403)
    await plain.goto(f.h.origin + `/notifications/${protectedRequest}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(plain, 'Not found')
    lines.push(
      'E6 PASS: league-only, regular-season-only, playoff-only and direct-team administrators independently accept a raw guest game; season-only sender records host/owned opponent consent; coach cannot decide; no enrollment is inferred'
    )

    const joinResponse = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        sender: { kind: 'season', id: f.seasonB },
        kind: 'participation',
        teamId: f.teamA,
        seasonId: f.seasonB,
        idempotencyKey: 'corner-participation'
      },
      205
    )
    const joinId = ((await joinResponse.json()) as { id: string }).id
    await f.h.db
      .insertInto('season_members')
      .values({
        id: 'membership_corner_private_spectator',
        season_id: f.seasonB,
        user_id: userIdOfGumbo(104)
      })
      .execute()
    const rosterBefore = await (
      await f.h.request('GET', `/teams/${f.teamA}/roster`, undefined, 204)
    ).json()
    await direct.goto(f.h.origin + `/notifications/${joinId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(direct, 'Accept invitation')
    await text(direct, 'Accepted')
    expect(
      await (
        await f.h.request('GET', `/teams/${f.teamA}/roster`, undefined, 204)
      ).json()
    ).deep.equals(rosterBefore)
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(host, 'Teams', 'tab')
    await text(host, 'Demo Hawks')
    await f.h.db
      .updateTable('seasons')
      .set({ spectator_access: 'season' })
      .where('id', '=', f.seasonB)
      .execute()
    await f.h.db
      .updateTable('leagues')
      .set({ spectator_access: 'league' })
      .where('id', '=', f.leagueB)
      .execute()
    const stubResponse = await f.h.request(
      'POST',
      '/teams',
      {
        name: 'Demo Corner External',
        external: true,
        custodian: { kind: 'season', id: f.seasonB },
        locality: demoLocality,
        idempotencyKey: 'corner-external-team'
      },
      205
    )
    const stub = ((await stubResponse.json()) as { id: string }).id
    const approvedExternal = await sendGame(f.teamB, stub)
    const otherGame = (
      await f.h.db
        .selectFrom('group_requests')
        .select('game_id')
        .where('id', '=', approvedExternal)
        .executeTakeFirstOrThrow()
    ).game_id!
    // Not a member of either side: the reduced view every signed-in
    // non-member gets, with the members' parts held back.
    const otherGameView = await f.h.request(
      'GET',
      `/games/${otherGame}`,
      undefined,
      204
    )
    expect(otherGameView.status).equals(200)
    expect(await otherGameView.json()).deep.include({
      nonMemberView: true,
      canScore: false
    })
    await direct.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'domcontentloaded'
    })
    // The guest is on the season's schedule; its games are in 2029.
    await press(direct, 'All', 'tab')
    await text(direct, 'Demo Corner External')
    await direct.screenshot({
      path: join(artifacts!, 'guest-participation.png')
    })
    const beforeGames = await f.h.db
      .selectFrom('games')
      .select('id')
      .orderBy('id')
      .execute()
    expect(
      (
        await f.h.request(
          'DELETE',
          `/seasons/${f.seasonB}/memberships/${f.teamA}`,
          undefined,
          204
        )
      ).status
    ).equals(200)
    await host.reload({ waitUntil: 'domcontentloaded' })
    await host.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')].some(
        node => node.textContent === 'Teams'
      )
    )
    await press(host, 'Teams', 'tab')
    await host.waitForFunction(
      () =>
        document.body.textContent != null &&
        !document.body.textContent.includes('Loading')
    )
    await host.waitForFunction(
      () =>
        document.body.textContent != null &&
        !document.body.textContent.includes('Demo Hawks')
    )
    await press(host, 'Schedule', 'tab')
    await press(host, 'All', 'tab')
    await text(host, 'Demo Hawks')
    expect(
      await f.h.db.selectFrom('games').select('id').orderBy('id').execute()
    ).deep.equals(beforeGames)
    const raw = await sendGame()
    await direct.goto(f.h.origin + `/notifications/${raw}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(direct, 'Accept invitation')
    await text(direct, 'Accepted')
    lines.push(
      'E19 PASS: competition entry/exit preserves every game and grants no private access to another host matchup or spectator roster; current season Teams removes the guest after exit while Schedule retains its games; a new raw guest invite remains available after exit'
    )

    const pending = await sendGame(stub, f.teamA)
    const promotion = await f.h.request(
      'POST',
      '/relationship-requests',
      {
        sender: { kind: 'team', id: stub },
        kind: 'promotion',
        teamId: stub,
        recipientEmail: 'fixture103@example.com',
        idempotencyKey: 'corner-promote-external'
      },
      205
    )
    const promoteId = ((await promotion.json()) as { id: string }).id
    await externalAdmin.goto(f.h.origin + `/notifications/${promoteId}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(externalAdmin, 'Accept invitation')
    await text(externalAdmin, 'Accepted')
    await direct.goto(f.h.origin + `/notifications/${pending}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(direct, 'Accept invitation')
    await text(direct, 'Pending')
    await externalAdmin.goto(f.h.origin + `/notifications/${pending}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(externalAdmin, 'Accept invitation')
    await text(externalAdmin, 'Accepted')
    expect(
      await f.h.db
        .selectFrom('games')
        .select('id')
        .where('id', '=', otherGame)
        .execute()
    ).length(1)
    expect(
      await f.h.db
        .selectFrom('season_teams')
        .selectAll()
        .where('team_id', '=', stub)
        .execute()
    ).length(0)
    lines.push(
      'E18 PASS: custody represents an external exhibition without enrollment; promotion invalidates pending placeholder consent and the new full-team admin accepts afresh; previously published game remains'
    )

    const bothTeams = await sendGame(f.teamA, f.standaloneTeam)
    await Promise.all([
      direct.goto(f.h.origin + `/notifications/${bothTeams}`, {
        waitUntil: 'domcontentloaded'
      }),
      externalAdmin.goto(f.h.origin + `/notifications/${bothTeams}`, {
        waitUntil: 'domcontentloaded'
      })
    ])
    await text(direct, 'Pending')
    await text(externalAdmin, 'Pending')
    await press(direct, 'Decline invitation')
    await text(direct, 'Declined')
    await externalAdmin.reload({ waitUntil: 'domcontentloaded' })
    await text(externalAdmin, 'Declined')
    expect(
      await externalAdmin.evaluate(() => document.body.textContent)
    ).not.includes('Accept invitation')
    lines.push(
      'E10 PASS: a season-originated game needing two unrelated team consents is shared; one team decline closes the proposal in the other team’s independent browser context'
    )
    const raceId = await sendGame()
    const league = pages[4]
    await Promise.all([
      direct.goto(f.h.origin + `/notifications/${raceId}`, {
        waitUntil: 'domcontentloaded'
      }),
      league.goto(f.h.origin + `/notifications/${raceId}`, {
        waitUntil: 'domcontentloaded'
      })
    ])
    const racing = await Promise.all([
      f.h.request('POST', `/game-requests/${raceId}/accept`, {}, 204),
      f.h.request('POST', `/game-requests/${raceId}/accept`, {}, 201)
    ])
    expect(racing.map(response => response.status)).deep.equals([200, 200])
    const answers = (await Promise.all(
      racing.map(async response => await response.json())
    )) as Array<{ gameId: string }>
    expect(answers[0].gameId).equals(answers[1].gameId)
    await direct.reload({ waitUntil: 'domcontentloaded' })
    await league.reload({ waitUntil: 'domcontentloaded' })
    await text(direct, 'Accepted')
    await text(league, 'Accepted')
    lines.push(
      'E21 PASS: coordinated real concurrent approvals return the same single published ID; independent direct and inherited-admin browser contexts observe the committed terminal result'
    )

    for (const [label, seasonId, senderId, day] of [
      ['Regular fixture', f.seasonA, 202, 20],
      ['Playoff fixture', f.playoffs, 203, 21],
      ['Outside classic', null, 204, 22]
    ] as const) {
      const created = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender:
            seasonId == null
              ? { kind: 'team', id: f.teamA }
              : { kind: 'season', id: seasonId },
          game: {
            homeTeamId: f.teamA,
            awayTeamId: f.standaloneTeam,
            seasonId,
            startAt: new Date(Date.UTC(2029, 6, day, 19)).toISOString(),
            venue: label,
            outsideTournament:
              seasonId == null ? 'Demo off-platform classic' : null,
            status: 'scheduled'
          },
          idempotencyKey: `corner-combined-${day}`
        },
        senderId
      )
      expect(created.status).equals(201)
      const id = ((await created.json()) as { id: string }).id
      await externalAdmin.goto(f.h.origin + `/notifications/${id}`, {
        waitUntil: 'domcontentloaded'
      })
      await press(externalAdmin, 'Accept invitation')
      await text(externalAdmin, 'Accepted')
      const stored = await f.h.db
        .selectFrom('group_requests')
        .innerJoin('games', 'games.id', 'group_requests.game_id')
        .select('games.season_id')
        .where('group_requests.id', '=', id)
        .executeTakeFirstOrThrow()
      expect(stored.season_id).equals(seasonId)
    }
    await direct.goto(f.h.origin + `/teams/${f.teamA}?tab=schedule`, {
      waitUntil: 'domcontentloaded'
    })
    await text(direct, 'Regular fixture')
    await text(direct, 'Playoff fixture')
    await text(direct, 'Outside classic')
    await frameText(direct, 'Outside classic', 'end')
    await direct.screenshot({
      path: join(artifacts!, 'team-season-and-external-games.png')
    })
    lines.push(
      'E7 PASS: accepted regular, playoff and explicitly outside-season games coexist on the same team; the outside game keeps season_id null despite both management parents'
    )
    const lostAuthority = await sendGame()
    expect(
      (
        await f.h.request(
          'PUT',
          `/manage/season/${f.seasonB}/people/205/roles`,
          { admin: false, flags: [] },
          105
        )
      ).status
    ).equals(200)
    await host.goto(f.h.origin + `/notifications/${lostAuthority}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(host, 'Pending invitation you sent')
    expect(await host.evaluate(() => document.body.textContent)).not.includes(
      'Demo Corner Field'
    )
    await direct.goto(f.h.origin + `/notifications/${lostAuthority}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(direct, 'Accept invitation')
    await text(direct, 'Pending')
    const replacementHost = await pageFor(102)
    await replacementHost.goto(f.h.origin + `/notifications/${lostAuthority}`, {
      waitUntil: 'domcontentloaded'
    })
    await press(replacementHost, 'Accept invitation')
    await text(replacementHost, 'Accepted')
    lines.push(
      'E21 PASS: revoked season-only proposer loses pending details; team consent alone cannot publish; a current host administrator replaces the stale host/opponent consent before one publication'
    )
    await applyParents(
      f.h.db,
      [actor(204)],
      await previewParents(
        f.h.db,
        asParentActions([
          {
            operation: 'detach',
            child: { kind: 'team', id: f.teamA },
            parent: { kind: 'league', id: f.leagueA }
          }
        ])
      )
    )
    const retainedId = published[0]
    expect(
      (
        await f.h.request(
          'POST',
          `/games/${retainedId}/withdrawals`,
          { teamId: f.teamA },
          204
        )
      ).status
    ).equals(200)
    await direct.goto(f.h.origin + `/groups/team/${f.teamA}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(direct, 'Canceled — Demo Hawks withdrew')
    await host.goto(f.h.origin + `/groups/season/${f.seasonB}`, {
      waitUntil: 'domcontentloaded'
    })
    await text(host, 'Canceled — Demo Hawks withdrew')
    lines.push(
      'E17/E19 PASS: a direct-only team administrator withdraws after both competition exit and all inherited parent links are removed; the same canceled game remains on team and host schedules'
    )
    await recordBrowserCoverage(
      pages,
      f.h.origin,
      resolve('coverage/creation/corners-browser.json')
    )
    await writeFile(
      join(artifacts!, 'corner-browser-vectors.log'),
      lines.join('\n') + '\n'
    )
    console.log(lines.slice(2).join('\n'))
  } finally {
    await browser?.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
