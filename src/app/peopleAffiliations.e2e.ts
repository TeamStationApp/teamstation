/**
 * The People sections of a league, a season and a team, with their Add
 * Staff, Add Spectator and Add Player actions, and the Affiliations section
 * of a person's account, in Chromium through maestro-d against a real API
 * and web app on a fresh database (`groupFixture`).
 *
 *   npm run build.web
 *   TS_PEOPLE_AFFILIATIONS_ARTIFACTS=<dir> TS_PEOPLE_AFFILIATIONS_WORK=<dir> \
 *     TS_MAESTRO_D_CLIENT=<maestro-d npm package> MAESTRO_D_BIN=<maestro-d> \
 *     node -r sucrase/register src/app/peopleAffiliations.e2e.ts
 *
 * `TS_PEOPLE_AFFILIATIONS_CAPTURE=before` takes only the screenshots that
 * have a before state, for a checkout without this work.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  absent,
  browserSession,
  contains,
  fill,
  maestro,
  tap
} from '../../e2e/rigs/refinementsMaestro'
import { makeId } from '../common/ids'
import { userIdOfGumbo } from '../common/userId'
import { createSession } from '../server/auth/sessions'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { groupFixture } from '../test/groupFixtures'
import { insertFixtureUsers } from '../test/insertFixtureUsers'

const PLAYER = 400
const GUARDIAN = 401
const MEMBER = 402
const FOLLOWER = 403
const NEWCOMER = 404

async function main(): Promise<void> {
  const artifacts = process.env.TS_PEOPLE_AFFILIATIONS_ARTIFACTS
  const work = process.env.TS_PEOPLE_AFFILIATIONS_WORK
  if (artifacts == null || work == null)
    throw new Error(
      'Supply TS_PEOPLE_AFFILIATIONS_ARTIFACTS and TS_PEOPLE_AFFILIATIONS_WORK'
    )
  const before = process.env.TS_PEOPLE_AFFILIATIONS_CAPTURE === 'before'
  await mkdir(artifacts, { recursive: true })
  const f = await groupFixture(resolve('dist'))
  const daemon = await maestro('peopleAffiliations')
  const log = [
    `$ ${before ? 'TS_PEOPLE_AFFILIATIONS_CAPTURE=before ' : ''}node -r sucrase/register src/app/peopleAffiliations.e2e.ts`
  ]
  const pass = (line: string): void => {
    log.push(`PASS: ${line}`)
    console.log(`PASS: ${line}`)
  }
  try {
    const db = f.h.db
    await insertFixtureUsers(
      db,
      [
        [PLAYER, 'Mookie', 'Betts'],
        [GUARDIAN, 'Freddie', 'Freeman'],
        [MEMBER, 'Aaron', 'Judge'],
        [FOLLOWER, 'Shohei', 'Ohtani'],
        [NEWCOMER, 'Mike', 'Piazza']
      ].map(([id, first, last]) => ({
        id: id as number,
        display_name: `${first} ${last}`,
        first_name: first as string,
        last_name: last as string,
        login_enabled: true,
        email: `affiliations${id}@example.test`
      }))
    )
    const tokens = new Map<number, string>()
    for (const id of [101, 104, 106, GUARDIAN, FOLLOWER])
      tokens.set(
        id,
        f.h.tokens.get(id) ??
          (await createSession(db, userIdOfGumbo(id), 'affiliations-e2e')).token
      )
    // Somebody who only plays on Demo Hawks, and their guardian.
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        team_id: f.teamA,
        user_id: userIdOfGumbo(PLAYER),
        role: 'member',
        is_player: true
      })
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(GUARDIAN),
        related_user_id: userIdOfGumbo(PLAYER),
        kind: 'guardian',
        can_manage: true
      })
      .execute()
    // A spectator of the league, and somebody who only follows it.
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        league_id: f.leagueA,
        user_id: userIdOfGumbo(MEMBER),
        role: 'member',
        source: 'manual'
      })
      .execute()
    await db
      .insertInto('follows')
      .values({
        user_id: userIdOfGumbo(FOLLOWER),
        group_type: 'league',
        group_id: f.leagueA
      })
      .execute()
    // Tim Raines coaches and keeps score on Demo Regular and only follows
    // Demo Eagles. Ichiro administers Demo League A and nothing under it.
    await db
      .insertInto('scope_roles')
      .values([
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(106),
          scope_type: 'season',
          scope_id: f.seasonA,
          role: 'coach',
          granted_by: userIdOfGumbo(101),
          granted_at: new Date()
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(106),
          scope_type: 'season',
          scope_id: f.seasonA,
          role: 'scorekeeper',
          granted_by: userIdOfGumbo(101),
          granted_at: new Date()
        },
        {
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(104),
          scope_type: 'league',
          scope_id: f.leagueA,
          role: 'admin',
          granted_by: userIdOfGumbo(101),
          granted_at: new Date()
        }
      ])
      .execute()
    await db
      .insertInto('follows')
      .values({
        user_id: userIdOfGumbo(106),
        group_type: 'team',
        group_id: f.teamB
      })
      .execute()

    const session = await browserSession(
      daemon,
      'peopleAffiliations-browser',
      1280,
      900,
      work
    )
    const { m, page, browser } = session
    const host = new URL(f.h.origin).hostname
    const signIn = async (id: number): Promise<void> => {
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: tokens.get(id)!,
        domain: host,
        path: '/'
      })
    }
    const shoot = async (name: string): Promise<void> => {
      await m.waitForAnimationToEnd()
      await writeFile(join(artifacts, name), await m.screenshot())
    }
    const open = async (path: string): Promise<void> => {
      await m.openBrowser({ url: `${f.h.origin}${path}` })
    }
    const scrollTo = async (text: string): Promise<void> => {
      await page.evaluate(text => {
        const node = [...document.querySelectorAll<HTMLElement>('*')].find(
          candidate =>
            candidate.childElementCount === 0 && candidate.textContent === text
        )
        if (node !== undefined) node.scrollIntoView({ block: 'start' })
      }, text)
    }
    // No row of theirs: a guardian's line may still name them.
    const noRow = async (name: string): Promise<void> => {
      const rows = await page.evaluate(
        name =>
          [...document.querySelectorAll('*')].filter(
            node => node.childElementCount === 0 && node.textContent === name
          ).length,
        name
      )
      assert.equal(rows, 0, `no row for ${name}`)
    }
    const labelled = async (label: string): Promise<boolean> =>
      (await page.$(`[aria-label="${label}"]`)) != null
    const leaguePeople = `/groups/league/${f.leagueA}?tab=people`
    const teamPeople = `/groups/team/${f.teamA}?tab=team`
    try {
      await signIn(101)
      await open(leaguePeople)
      await contains(page, 'ADMINS')
      if (before) {
        await shoot('league-people-before.png')
        await open(`/groups/season/${f.seasonA}?tab=people`)
        await contains(page, 'ADMINS')
        await shoot('season-people-before.png')
        await open(teamPeople)
        await contains(page, 'ADMINS')
        await shoot('team-people-before.png')
        await signIn(106)
        await open('/account')
        await contains(page, 'Add email address')
        await scrollTo('EMAIL ADDRESSES')
        await shoot('account-affiliations-before.png')
        pass('before screenshots captured')
        return
      }

      // 1. A league's People tab lists no players; family and spectators stay.
      await contains(page, 'STAFF')
      await contains(page, 'SPECTATORS')
      await contains(page, 'FAMILY MEMBERS')
      // The league's administrator reads its people in full.
      await contains(page, 'Freddie Freeman')
      await contains(page, 'Aaron Judge')
      await contains(page, 'FOLLOWERS')
      await absent(page, 'PLAYERS')
      await noRow('Mookie Betts')
      await contains(page, 'Guardian of Mookie Betts')
      await shoot('league-people-after.png')
      pass('league People: no Players, family, spectators and followers stay')
      await open(`/groups/season/${f.seasonA}?tab=people`)
      await contains(page, 'Tim Raines')
      await absent(page, 'PLAYERS')
      await noRow('Mookie Betts')
      assert.ok(await labelled('Add Staff to Demo Regular'))
      await shoot('season-people-after.png')
      pass('season People: no Players; Tim under Staff with Add Staff')

      // 2. An empty Staff section offers the blue pill, which opens Add
      // People with nothing checked and adds a member.
      await open(`/groups/season/${f.playoffs}?tab=people`)
      await contains(page, 'STAFF')
      await page.waitForSelector('[data-testid="people-add-staff"]')
      const staffCount = await page.evaluate(() => {
        const button = document.querySelector(
          '[data-testid="people-add-staff"]'
        )
        let section = button === null ? null : button.parentElement
        while (
          section !== null &&
          section.querySelector('[data-testid="settings-pill-count"]') === null
        )
          section = section.parentElement
        const count =
          section === null
            ? null
            : section.querySelector('[data-testid="settings-pill-count"]')
        return count === null ? null : count.textContent
      })
      assert.equal(staffCount, '0')
      await shoot('season-empty-staff.png')
      await tap(m, 'Add Staff to Demo Playoffs')
      await contains(page, 'Add People')
      assert.equal(
        await page.$$eval('[role="switch"]', switches =>
          switches.some(node => node.getAttribute('aria-checked') === 'true')
        ),
        false
      )
      // Mike holds nothing anybody here can find him by: added by address.
      await fill(m, 'E-mail addresses', `affiliations${NEWCOMER}@example.test`)
      await tap(m, 'Add people')
      await contains(page, 'SPECTATORS')
      await contains(page, 'Mike Piazza')
      const added = await db
        .selectFrom('season_members')
        .select('user_id')
        .where('season_id', '=', f.playoffs)
        .where('user_id', '=', userIdOfGumbo(NEWCOMER))
        .execute()
      assert.equal(added.length, 1)
      pass(
        'empty Staff: 0 count, blue Add Staff pill, Add People unchecked, saved as a spectator'
      )

      // 3. A team: Add Admin, Add Staff and Add Spectator sit left of their
      // counts, and Add Player asks whether to add an existing player or
      // create one.
      await open(teamPeople)
      await contains(page, 'PLAYERS')
      for (const label of [
        'Add Admin to Demo Hawks',
        'Add Staff to Demo Hawks',
        'Add Spectator to Demo Hawks',
        'Add Player to Demo Hawks'
      ]) {
        const place = await page.evaluate(label => {
          const button = document.querySelector(`[aria-label="${label}"]`)
          let row = button === null ? null : button.parentElement
          while (
            row !== null &&
            row.querySelector('[data-testid="settings-pill-count"]') === null
          )
            row = row.parentElement
          const count =
            row === null
              ? null
              : row.querySelector('[data-testid="settings-pill-count"]')
          if (button === null || count === null) return null
          const a = button.getBoundingClientRect()
          const b = count.getBoundingClientRect()
          return {
            leftOf: a.right <= b.left + 1,
            gap: b.left - a.right,
            sameRow: a.top < b.bottom && b.top < a.bottom
          }
        }, label)
        assert.ok(place?.leftOf === true && place.sameRow, label)
        assert.ok(place.gap < 24, `${label} sits immediately left of the count`)
      }
      // From Staff down: Staff, Players, Family members and Spectators.
      await scrollTo('STAFF')
      await shoot('team-people-after.png')
      await tap(m, 'Add Player to Demo Hawks')
      await contains(page, 'Add existing player')
      await contains(page, 'Create new player')
      await shoot('team-add-player-sheet.png')
      await tap(m, 'Create new player')
      await page.waitForFunction(() =>
        location.pathname.endsWith('/settings/create-player')
      )
      await open(teamPeople)
      await tap(m, 'Add Player to Demo Hawks')
      await tap(m, 'Add existing player')
      await page.waitForFunction(() =>
        location.pathname.endsWith('/settings/add-player')
      )
      pass(
        'team: adds left of the counts; Add Player opens Create Player or the Add Player search'
      )

      // Add Admin opens Add People with Admin checked; every Add People
      // ends with Spectator, on and locked, and says nothing of "Adds them as".
      await open(teamPeople)
      await tap(m, 'Add Admin to Demo Hawks')
      await page.waitForFunction(
        () =>
          location.pathname.endsWith('/settings/people') &&
          location.search.includes('role=admin')
      )
      await contains(page, 'Add People')
      const switches = await page.$$eval('[role="switch"]', nodes =>
        nodes.map(node => ({
          label: node.getAttribute('aria-label'),
          on: (node as HTMLInputElement).checked,
          locked: (node as HTMLInputElement).disabled
        }))
      )
      assert.equal(switches[0].on, true, 'Admin is checked')
      const spectator = switches.find(row => row.label === 'Spectator')
      assert.ok(
        spectator?.on === true && spectator.locked,
        'Spectator locked on'
      )
      assert.equal(switches.at(-1)?.label, 'Spectator')
      await contains(
        page,
        'View all team members, see stats, and watch videos.'
      )
      await absent(page, 'Adds them as')
      await scrollTo('Spectator')
      await shoot('add-people-spectator.png')
      pass(
        'Add Admin opens Add People with Admin checked; Spectator last, on and locked'
      )

      // 4. Somebody who only follows sees no add.
      await signIn(FOLLOWER)
      await open(teamPeople)
      await contains(page, 'ADMINS')
      for (const label of [
        'Add Admin to Demo Hawks',
        'Add Staff to Demo Hawks',
        'Add Spectator to Demo Hawks',
        'Add Player to Demo Hawks'
      ])
        assert.equal(await labelled(label), false, label)
      pass(
        'a non-member sees no Add Admin, Add Staff, Add Spectator or Add Player'
      )

      // 5. Affiliations: direct places only, pills, a confirmed unfollow.
      await signIn(104)
      await open('/account')
      await contains(page, 'AFFILIATIONS')
      const ichiro = await page.$eval(
        '[data-testid="account-affiliations"]',
        node => node.textContent
      )
      assert.ok(ichiro?.includes('Demo League A') === true)
      assert.ok(ichiro.includes('Admin'))
      assert.ok(
        !ichiro.includes('Demo Regular') && !ichiro.includes('Demo Hawks')
      )
      pass('a league admin has a row for the league and none for what it holds')

      await signIn(106)
      await open('/account')
      await contains(page, 'AFFILIATIONS')
      const order = await page.evaluate(() => {
        const add = [...document.querySelectorAll('[role="button"]')].find(
          node => node.textContent === 'Add email address'
        )
        const list = document.querySelector(
          '[data-testid="account-affiliations"]'
        )
        return (
          add !== undefined &&
          list !== null &&
          add.getBoundingClientRect().bottom <= list.getBoundingClientRect().top
        )
      })
      assert.ok(order, 'Affiliations sits below Add email address')
      const tim = await page.$eval(
        '[data-testid="account-affiliations"]',
        node => node.textContent
      )
      assert.ok(tim?.includes('Demo Regular') === true)
      assert.ok(tim.includes('Coach'))
      assert.ok(tim.includes('Scorekeeper'))
      assert.ok(tim.includes('Demo Eagles'))
      // Framed as the before screenshot: from the Email addresses header.
      await scrollTo('EMAIL ADDRESSES')
      await shoot('account-affiliations-after.png')
      await tap(m, 'Following Demo Eagles')
      await contains(page, 'Stop following Demo Eagles?')
      await shoot('unfollow-confirm.png')
      await tap(m, 'Stop Following')
      await page.waitForFunction(() => {
        const list = document.querySelector(
          '[data-testid="account-affiliations"]'
        )
        return (
          list !== null && !String(list.textContent).includes('Demo Eagles')
        )
      })
      const follows = await db
        .selectFrom('follows')
        .select('user_id')
        .where('user_id', '=', userIdOfGumbo(106))
        .where('group_id', '=', f.teamB)
        .execute()
      assert.equal(follows.length, 0)
      await tap(m, 'Open Demo Regular')
      await page.waitForFunction(
        seasonId => location.pathname.includes(seasonId),
        {},
        f.seasonA
      )
      pass(
        'staff pills, Following confirmed and removed, a row opens its season'
      )

      // 6. A guardian's player.
      await signIn(GUARDIAN)
      await open('/account')
      await contains(page, 'AFFILIATIONS')
      const freddie = await page.$eval(
        '[data-testid="account-affiliations"]',
        node => node.textContent
      )
      assert.ok(freddie?.includes('Mookie') === true)
      assert.ok(freddie.includes('Guardian'))
      assert.ok(freddie.includes('Demo Hawks'))
      // Named as the roster names him to his guardian.
      const mookie = await page.$eval(
        '[data-testid="account-affiliations"] [aria-label^="Open Mookie"]',
        node => node.getAttribute('aria-label')
      )
      assert.ok(mookie !== null)
      await tap(m, mookie)
      await page.waitForFunction(
        player => location.pathname.includes(player),
        {},
        userIdOfGumbo(PLAYER)
      )
      pass('a guardian has a row for their player that opens the player')
    } finally {
      await writeFile(
        join(
          artifacts,
          before
            ? 'people-affiliations-before.log'
            : 'people-affiliations-e2e.log'
        ),
        log.join('\n') + '\n'
      )
      await browser.disconnect()
    }
  } finally {
    await daemon.shutdown()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
