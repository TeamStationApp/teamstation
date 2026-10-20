import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import type { LevelPeople, PersonProfile, RosterEntry } from '../../common/api'
import { makeId } from '../../common/ids'
import type { GroupDetail } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { canKeepSongs, roleScopes } from '../access'
import { createSession } from '../auth/sessions'
import { rolesAt } from '../invites/people'

/**
 * People at a team, a season and a league, through the real routes: who may
 * give and take away which role, leaving and stepping down, the season's and
 * league's people lists, and the person profile.
 *
 * One fixture for the suite, built up case by case: Demo Hawks (the creator,
 * 101, administers it, Demo Regular above it and Demo League A above that),
 * and around it a coach, an assistant, a scorekeeper, a member, a player and
 * their guardian, somebody who cannot sign in, a follower, and members of
 * the season and the league.
 */
describe('people at a team, a season and a league', function () {
  this.timeout(60000)
  let f: GroupFixture
  const COACH = 104
  const ASSISTANT = 106
  const MEMBER = 103
  const SCOREKEEPER = 201
  const PLAYER = 202
  const GUARDIAN = 203
  const NO_LOGIN = 204
  const FOLLOWER = 205
  const SEASON_MEMBER = 206
  const LEAGUE_MEMBER = 207

  before(async () => {
    f = await groupFixture()
    const db = f.h.db
    const person = async (
      id: number,
      first: string,
      last: string,
      login = true
    ): Promise<void> => {
      await insertFixtureUsers(db, {
        id,
        legacyId: `usr_people_${id}`,
        display_name: `${first} ${last}`,
        first_name: first,
        last_name: last,
        login_enabled: login
      })
      if (!login) return
      await db
        .insertInto('user_emails')
        .values({
          id: makeId('userEmail'),
          user_id: userIdOfGumbo(id),
          email: `people${id}@example.com`,
          is_primary: true,
          verified_at: new Date()
        })
        .execute()
      f.h.tokens.set(
        id,
        (await createSession(db, userIdOfGumbo(id), 'people')).token
      )
    }
    await person(SCOREKEEPER, 'Sandy', 'Koufax')
    await person(PLAYER, 'Alex', 'Young')
    await person(GUARDIAN, 'Pat', 'Neshek')
    await person(NO_LOGIN, 'Nolan', 'Ryan', false)
    await person(FOLLOWER, 'Frank', 'Francisco')
    await person(SEASON_MEMBER, 'Sam', 'Fuld')
    await person(LEAGUE_MEMBER, 'Lee', 'Smith')
    const role = async (
      userId: number,
      kind: 'team' | 'season' | 'league',
      id: string,
      given: 'coach' | 'assistant' | 'scorekeeper'
    ): Promise<void> => {
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(userId),
          scope_type: kind,
          scope_id: id,
          role: given
        })
        .execute()
    }
    const member = async (userId: number, player = false): Promise<void> => {
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(userId),
          team_id: f.teamA,
          role: 'member',
          is_player: player
        })
        .execute()
    }
    await role(COACH, 'team', f.teamA, 'coach')
    await member(COACH)
    await role(ASSISTANT, 'team', f.teamA, 'assistant')
    await member(ASSISTANT)
    await role(SCOREKEEPER, 'team', f.teamA, 'scorekeeper')
    await member(SCOREKEEPER)
    await member(MEMBER)
    await member(PLAYER, true)
    await member(NO_LOGIN)
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(GUARDIAN),
        related_user_id: userIdOfGumbo(PLAYER),
        kind: 'guardian',
        created_at: new Date()
      })
      .execute()
    await db
      .insertInto('follows')
      .values({
        user_id: userIdOfGumbo(FOLLOWER),
        group_type: 'team',
        group_id: f.teamA
      })
      .execute()
    await db
      .insertInto('follows')
      .values({
        user_id: userIdOfGumbo(FOLLOWER),
        group_type: 'season',
        group_id: f.seasonA
      })
      .execute()
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userIdOfGumbo(SEASON_MEMBER),
        season_id: f.seasonA
      })
      .execute()
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: userIdOfGumbo(LEAGUE_MEMBER),
        league_id: f.leagueA
      })
      .execute()
    // The Hawks are in the playoffs too: two seasons above one team.
    await db
      .insertInto('season_team_parents')
      .values({ season_id: f.playoffs, team_id: f.teamA })
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })

  const call = async (
    method: string,
    path: string,
    user: number,
    body?: unknown
  ): Promise<{ status: number; body: any }> => {
    const response = await f.h.request(method, path, body, user)
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text)
    }
  }
  const role = async (
    method: 'PUT' | 'DELETE',
    userId: number,
    given: string,
    actor: number,
    kind = 'team',
    id = f.teamA
  ): Promise<{ status: number; body: any }> =>
    await call(
      method,
      `/manage/${kind}/${id}/people/${userIdOfGumbo(userId)}/roles/${given}`,
      actor,
      method === 'PUT' ? {} : undefined
    )

  describe('who may change roles', function () {
    it('persists explicit staff assignments beside Admin and removes only the selected role', async () => {
      for (const flag of [
        'coach',
        'assistant',
        'scorekeeper',
        'songkeeper',
        'videographer'
      ]) {
        const added = await role('PUT', 101, flag, 101)
        expect(added.status, flag).equals(200)
        expect(added.body.roles, flag).deep.equals(['admin', flag])
        const read = await call(
          'GET',
          `/teams/${f.teamA}/people/${userIdOfGumbo(101)}`,
          101
        )
        expect(read.body.sections[0].roles, flag).deep.equals(['admin', flag])
        const removed = await role('DELETE', 101, flag, 101)
        expect(removed.status, flag).equals(200)
        expect(removed.body.roles, flag).deep.equals(['admin'])
        expect(removed.body.member, flag).equals(true)
      }
    })

    it('lets a coach or an assistant add and remove every role but Admin, at once', async () => {
      const added = await role('PUT', MEMBER, 'videographer', COACH)
      expect(added.status).equals(200)
      expect(added.body).deep.equals({
        userId: userIdOfGumbo(MEMBER),
        roles: ['videographer'],
        member: true
      })
      const assisted = await role('PUT', MEMBER, 'songkeeper', ASSISTANT)
      expect(assisted.body.roles).deep.equals(['songkeeper', 'videographer'])
      const removed = await role('DELETE', MEMBER, 'videographer', ASSISTANT)
      expect(removed.body.roles).deep.equals(['songkeeper'])
      // A peer's coaching too: everything but Admin.
      expect(
        (await role('DELETE', ASSISTANT, 'assistant', COACH)).status
      ).equals(200)
      expect(
        await rolesAt(f.h.db, 'team', f.teamA, userIdOfGumbo(ASSISTANT))
      ).deep.equals([])
      expect((await role('PUT', ASSISTANT, 'assistant', COACH)).status).equals(
        200
      )
    })

    it('tells somebody each role they are given, and mails them only when they join the level', async () => {
      const notices = await f.h.db
        .selectFrom('notification_events')
        .select(['metadata', 'recorded_recipients'])
        .where('source_type', '=', 'grant')
        .where(eb =>
          eb(
            eb.val(userIdOfGumbo(MEMBER)),
            '=',
            eb.fn.any('recorded_recipients')
          )
        )
        .orderBy('created_at')
        .execute()
      expect(
        notices.map(row => (row.metadata as { title: string }).title)
      ).deep.equals([
        'Ichiro added you as Videographer of Demo Hawks',
        'Tim Raines added you as Songkeeper of Demo Hawks'
      ])
      // Already a member, so no mail.
      expect(f.h.invitations.has(`fixture${MEMBER}@example.com`)).equals(false)
      // A follower made a member of the team hears of it by mail as well.
      const joined = await role('PUT', FOLLOWER, 'member', COACH)
      expect(joined.body).deep.equals({
        userId: userIdOfGumbo(FOLLOWER),
        roles: [],
        member: true
      })
      expect(f.h.invitations.get(`people${FOLLOWER}@example.com`)).deep.include(
        {
          addedBy: 'Ichiro',
          scopeName: 'Demo Hawks',
          roles: ''
        }
      )
      expect(
        (await role('DELETE', FOLLOWER, 'member', COACH)).body.member
      ).equals(false)
    })

    it('keeps Admin to administrators', async () => {
      const refused = await role('PUT', MEMBER, 'admin', COACH)
      expect(refused.status).equals(403)
      expect(refused.body.message).includes('Only an administrator')
      expect((await role('PUT', MEMBER, 'admin', 101)).status).equals(200)
      // Nor may a coach take Admin away, or take an administrator out.
      expect((await role('DELETE', MEMBER, 'admin', COACH)).status).equals(403)
      expect((await role('DELETE', MEMBER, 'member', COACH)).status).equals(403)
      expect(
        (await role('DELETE', MEMBER, 'admin', 101)).body.roles
      ).deep.equals(['songkeeper'])
      // And the whole-set route says the same.
      const set = await call(
        'PUT',
        `/manage/team/${f.teamA}/people/${userIdOfGumbo(MEMBER)}/roles`,
        COACH,
        { admin: true, flags: [] }
      )
      expect(set.status).equals(403)
      const flags = await call(
        'PUT',
        `/manage/team/${f.teamA}/people/${userIdOfGumbo(MEMBER)}/roles`,
        COACH,
        { admin: false, flags: ['coach'] }
      )
      expect(flags.body.roles).deep.equals(['coach'])
      expect(
        (
          await call(
            'PUT',
            `/manage/team/${f.teamA}/people/${userIdOfGumbo(MEMBER)}/roles`,
            COACH,
            { admin: false, flags: [] }
          )
        ).status
      ).equals(200)
    })

    it('turns away a scorekeeper, a member and anybody at another level', async () => {
      expect((await role('PUT', MEMBER, 'coach', SCOREKEEPER)).status).equals(
        404
      )
      expect((await role('PUT', COACH, 'videographer', MEMBER)).status).equals(
        404
      )
      expect((await role('DELETE', COACH, 'coach', PLAYER)).status).equals(404)
      // A team's coach holds nothing over its season: the server checks
      // authority at the role's level, whatever page the app is on.
      expect(
        (await role('PUT', SEASON_MEMBER, 'coach', COACH, 'season', f.seasonA))
          .status
      ).equals(404)
      expect(
        (await role('PUT', SEASON_MEMBER, 'coach', 101, 'season', f.seasonA))
          .status
      ).equals(200)
      expect(
        (await role('DELETE', SEASON_MEMBER, 'coach', 101, 'season', f.seasonA))
          .status
      ).equals(200)
      // Nor a role on a team that is not theirs.
      expect(
        (await role('PUT', MEMBER, 'coach', COACH, 'team', f.teamB)).status
      ).equals(404)
    })

    it('gives a role only to somebody who can sign in, and nothing to anybody off the list', async () => {
      const refused = await role('PUT', NO_LOGIN, 'coach', COACH)
      expect(refused.status).equals(409)
      expect(refused.body.message).includes('can sign in')
      expect((await role('PUT', NO_LOGIN, 'member', COACH)).status).equals(200)
      // Ichiro's season member is not on the Eagles' list.
      expect(
        (await role('PUT', SEASON_MEMBER, 'member', 102, 'team', f.teamB))
          .status
      ).equals(404)
      expect((await role('PUT', MEMBER, 'umpire', COACH)).status).equals(400)
      expect((await role('PUT', 999999, 'member', COACH)).status).equals(404)
    })
    it('refuses a player made so while the removal waits, and takes a member who does not play off the team', async () => {
      const LATE = 209
      const db = f.h.db
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(LATE),
        legacyId: `usr_people_${LATE}`,
        display_name: 'Riley Greene',
        first_name: 'Riley',
        last_name: 'Greene',
        login_enabled: false
      })
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(LATE),
          team_id: f.teamA,
          role: 'member',
          is_player: false
        })
        .execute()
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(LATE),
          scope_type: 'team',
          scope_id: f.teamA,
          role: 'videographer'
        })
        .execute()
      // A roster edit makes them a player and holds the row while the
      // removal, past every check before its delete, waits on it.
      let removal: Promise<{ status: number; body: any }> | undefined
      await db.transaction().execute(async trx => {
        await trx
          .updateTable('memberships')
          .set({ is_player: true })
          .where('team_id', '=', f.teamA)
          .where('user_id', '=', userIdOfGumbo(LATE))
          .execute()
        removal = role('DELETE', LATE, 'member', COACH)
        const deadline = Date.now() + 5000
        while (true) {
          const waiting = await sql<{
            n: number
          }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
            db
          )
          if (waiting.rows[0].n > 0) break
          if (Date.now() > deadline)
            throw new Error('The removal did not wait on the roster edit')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      })
      const refused = await removal
      expect(refused?.status).equals(409)
      expect(refused?.body.message).equals(
        'Riley Greene plays for Demo Hawks, so stays a member while on its roster.'
      )
      // Nothing changed: the membership and the role stay.
      expect(
        await rolesAt(db, 'team', f.teamA, userIdOfGumbo(LATE))
      ).deep.equals(['videographer'])
      const membership = db
        .selectFrom('memberships')
        .select('is_player')
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(LATE))
      expect((await membership.executeTakeFirst())?.is_player).equals(true)

      // Off the roster again, they are an ordinary member, and leave.
      await db
        .updateTable('memberships')
        .set({ is_player: false })
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(LATE))
        .execute()
      const removed = await role('DELETE', LATE, 'member', COACH)
      expect(removed.status).equals(200)
      expect(removed.body).deep.equals({
        userId: userIdOfGumbo(LATE),
        roles: [],
        member: false
      })
      expect(await membership.executeTakeFirst()).equals(undefined)
      expect(
        await rolesAt(db, 'team', f.teamA, userIdOfGumbo(LATE))
      ).deep.equals([])
    })

    it('takes a player off the team only through its roster, never by their membership', async () => {
      for (const actor of [COACH, 101]) {
        const refused = await role('DELETE', PLAYER, 'member', actor)
        expect(refused.status).equals(409)
        expect(refused.body.message).equals(
          'Alex Young plays for Demo Hawks, so stays a member while on its roster.'
        )
      }
      const still = await f.h.db
        .selectFrom('memberships')
        .select('is_player')
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(PLAYER))
        .executeTakeFirst()
      expect(still?.is_player).equals(true)
      // Somebody without a say hears nothing of who plays.
      expect((await role('DELETE', PLAYER, 'member', MEMBER)).status).equals(
        404
      )
    })

    it('takes Songkeeper away with Scorekeeper unless it was given as well', async () => {
      const KEEPER = 208
      const db = f.h.db
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(KEEPER),
        legacyId: `usr_people_${KEEPER}`,
        display_name: 'Kevin Kiermaier',
        first_name: 'Kevin',
        last_name: 'Kiermaier',
        login_enabled: true
      })
      await db
        .insertInto('user_emails')
        .values({
          id: makeId('userEmail'),
          user_id: userIdOfGumbo(KEEPER),
          email: `people${KEEPER}@example.com`,
          is_primary: true,
          verified_at: new Date()
        })
        .execute()
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(KEEPER),
          team_id: f.teamA,
          role: 'member',
          is_player: false
        })
        .execute()
      const keepsSongs = async (): Promise<boolean> =>
        canKeepSongs(
          await roleScopes(db, userIdOfGumbo(KEEPER), false),
          f.teamA
        )
      expect(
        (await role('PUT', KEEPER, 'scorekeeper', COACH)).body.roles
      ).deep.equals(['scorekeeper'])
      expect(await keepsSongs()).equals(true)
      expect(
        (await role('DELETE', KEEPER, 'scorekeeper', COACH)).body.roles
      ).deep.equals([])
      expect(await keepsSongs()).equals(false)
      // Given both, Songkeeper outlasts Scorekeeper.
      await role('PUT', KEEPER, 'songkeeper', COACH)
      await role('PUT', KEEPER, 'scorekeeper', COACH)
      expect(
        (await role('DELETE', KEEPER, 'scorekeeper', COACH)).body.roles
      ).deep.equals(['songkeeper'])
      expect(await keepsSongs()).equals(true)
      expect((await role('DELETE', KEEPER, 'member', COACH)).status).equals(200)
    })
  })

  describe('leaving and stepping down', function () {
    it('steps down from one role and keeps the rest', async () => {
      await role('PUT', SCOREKEEPER, 'videographer', COACH)
      const down = await call(
        'DELETE',
        `/me/groups/team/${f.teamA}/roles/scorekeeper`,
        SCOREKEEPER
      )
      expect(down.body).deep.equals({
        userId: userIdOfGumbo(SCOREKEEPER),
        roles: ['videographer'],
        member: true
      })
      // A role they do not hold changes nothing.
      expect(
        (
          await call(
            'DELETE',
            `/me/groups/team/${f.teamA}/roles/coach`,
            SCOREKEEPER
          )
        ).body.roles
      ).deep.equals(['videographer'])
      expect(
        (
          await call(
            'DELETE',
            `/me/groups/team/${f.teamA}/roles/umpire`,
            SCOREKEEPER
          )
        ).status
      ).equals(400)
    })

    it('leaves a team, every role there with it, and leaves what a level above gives', async () => {
      await role('PUT', SEASON_MEMBER, 'member', COACH)
      await role('PUT', SEASON_MEMBER, 'coach', COACH)
      const gone = await call(
        'DELETE',
        `/me/groups/team/${f.teamA}`,
        SEASON_MEMBER
      )
      expect(gone.body).deep.equals({ removed: true })
      expect(
        await rolesAt(f.h.db, 'team', f.teamA, userIdOfGumbo(SEASON_MEMBER))
      ).deep.equals([])
      // The season's membership is the season's, left where it was given.
      const season = await f.h.db
        .selectFrom('season_members')
        .select('id')
        .where('user_id', '=', userIdOfGumbo(SEASON_MEMBER))
        .where('season_id', '=', f.seasonA)
        .execute()
      expect(season).length(1)
      expect(
        (await call('DELETE', `/me/groups/team/${f.teamA}`, SEASON_MEMBER)).body
      ).deep.equals({ removed: false })
      expect(
        (await call('DELETE', '/me/groups/team/tem_nowhere', MEMBER)).status
      ).equals(404)
    })

    it('keeps the last direct administrator from leaving or stepping down', async () => {
      expect(
        (await call('DELETE', `/me/groups/team/${f.teamA}`, 101)).status
      ).equals(409)
      expect(
        (await call('DELETE', `/me/groups/team/${f.teamA}/roles/admin`, 101))
          .status
      ).equals(409)
    })
  })

  describe('a season’s and a league’s people', function () {
    const sectionOf = (
      people: RosterEntry[],
      userId: number
    ): string | undefined =>
      people.find(person => person.userId === userIdOfGumbo(userId))?.section

    it('lists a season’s people in the roster’s sections, the league’s with their pill', async () => {
      const answer = await call('GET', `/seasons/${f.seasonA}/people`, 101)
      expect(answer.status).equals(200)
      const { people, manages, admin } = answer.body as LevelPeople
      expect({ manages, admin }).deep.equals({ manages: true, admin: true })
      expect(sectionOf(people, 101)).equals('admin')
      expect(sectionOf(people, PLAYER)).equals('player')
      expect(
        people.find(person => person.userId === userIdOfGumbo(PLAYER))
          ?.teamNames
      ).deep.equals(['Demo Hawks'])
      expect(sectionOf(people, GUARDIAN)).equals('family')
      expect(sectionOf(people, SEASON_MEMBER)).equals('spectator')
      const leagueMember = people.find(
        person => person.userId === userIdOfGumbo(LEAGUE_MEMBER)
      )
      expect(leagueMember?.section).equals('spectator')
      expect(leagueMember?.inheritedFrom).deep.equals({
        level: 'league',
        role: 'member'
      })
      expect(sectionOf(people, FOLLOWER)).equals('follower')
      // Team staff hold nothing over the season.
      expect(sectionOf(people, COACH)).equals(undefined)
    })

    it('lists a league’s people, and keeps both lists from anybody outside them', async () => {
      const league = await call(
        'GET',
        `/leagues/${f.leagueA}/people`,
        LEAGUE_MEMBER
      )
      expect(league.status).equals(200)
      const { people, manages } = league.body as LevelPeople
      expect(manages).equals(false)
      expect(sectionOf(people, 101)).equals('admin')
      expect(sectionOf(people, LEAGUE_MEMBER)).equals('spectator')
      expect(
        people.find(person => person.userId === userIdOfGumbo(LEAGUE_MEMBER))
          ?.inheritedFrom
      ).equals(null)
      expect(sectionOf(people, PLAYER)).equals('player')
      expect(sectionOf(people, SEASON_MEMBER)).equals(undefined)
      // A season member reads its season, and the league member reads both.
      expect(
        (await call('GET', `/seasons/${f.seasonA}/people`, SEASON_MEMBER))
          .status
      ).equals(200)
      expect(
        (await call('GET', `/seasons/${f.seasonA}/people`, LEAGUE_MEMBER))
          .status
      ).equals(200)
      expect(
        (await call('GET', `/leagues/${f.leagueA}/people`, SEASON_MEMBER))
          .status
      ).equals(404)
      // A team's coach is not in the season.
      expect(
        (await call('GET', `/seasons/${f.seasonA}/people`, COACH)).status
      ).equals(404)
      expect(
        (await call('GET', `/leagues/${f.leagueB}/people`, LEAGUE_MEMBER))
          .status
      ).equals(404)
      expect(
        (await call('GET', '/seasons/sea_nowhere/people', 105)).status
      ).equals(404)
    })

    it('says on each group who manages its people and who reads them', async () => {
      const detail = async (path: string, user: number): Promise<GroupDetail> =>
        (await call('GET', path, user)).body as GroupDetail
      expect(await detail(`/teams/${f.teamA}`, COACH)).includes({
        canManage: false,
        canManagePeople: true,
        canSeePeople: true
      })
      expect(await detail(`/teams/${f.teamA}`, MEMBER)).includes({
        canManagePeople: false,
        canSeePeople: true
      })
      expect(await detail(`/seasons/${f.seasonA}`, SEASON_MEMBER)).includes({
        canManagePeople: false,
        canSeePeople: true
      })
      expect(await detail(`/leagues/${f.leagueA}`, COACH)).includes({
        canManagePeople: false,
        canSeePeople: false
      })
      expect(await detail(`/leagues/${f.leagueA}`, 101)).includes({
        canManage: true,
        canManagePeople: true,
        canSeePeople: true
      })
    })
  })

  describe('the person profile', function () {
    const profile = async (
      kind: string,
      id: string,
      userId: number,
      viewer: number
    ): Promise<{ status: number; body: PersonProfile }> =>
      await call(
        'GET',
        `/${kind}s/${id}/people/${userIdOfGumbo(userId)}`,
        viewer
      )

    it('shows a team’s profile: the guardian’s child there, and Team, one Season and League sections', async () => {
      const { status, body } = await profile('team', f.teamA, GUARDIAN, COACH)
      expect(status).equals(200)
      expect(body.context).deep.equals({
        kind: 'team',
        id: f.teamA,
        name: 'Demo Hawks'
      })
      expect(body.person).includes({
        userId: userIdOfGumbo(GUARDIAN),
        shortName: 'Pat N',
        fullName: 'Pat Neshek',
        canHoldRoles: true
      })
      expect(body.guardianOf).deep.equals([
        {
          userId: userIdOfGumbo(PLAYER),
          shortName: 'Alex Y',
          avatarUrl: null,
          teamId: f.teamA
        }
      ])
      expect(body.sections.map(section => section.level)).deep.equals([
        'team',
        'season',
        'league'
      ])
      // One Season section for both of the team's seasons.
      expect(body.sections[1].groups.map(group => group.name)).deep.equals([
        'Demo Playoffs',
        'Demo Regular'
      ])
      expect(body.sections.map(section => section.editable)).deep.equals([
        true,
        false,
        false
      ])
      expect(body.viewer).deep.equals({ manages: true, admin: false })
    })

    it('reads what is held at each level, and a follower as a follower', async () => {
      const coach = await profile('team', f.teamA, COACH, 101)
      expect(coach.body.sections[0]).includes({ member: true, follower: false })
      expect(coach.body.sections[0].roles).deep.equals(['coach'])
      expect(coach.body.viewer).deep.equals({ manages: true, admin: true })
      const admin = await profile('team', f.teamA, 101, COACH)
      expect(admin.body.sections.map(section => section.roles)).deep.equals([
        ['admin'],
        ['admin'],
        ['admin']
      ])
      const follower = await profile('season', f.seasonA, FOLLOWER, 101)
      expect(follower.body.sections.map(section => section.level)).deep.equals([
        'season',
        'league'
      ])
      expect(follower.body.sections[0]).includes({
        follower: true,
        member: false
      })
      expect(
        follower.body.sections.map(section => section.editable)
      ).deep.equals([true, false])
      const quiet = await profile('team', f.teamA, NO_LOGIN, COACH)
      expect(quiet.body.person.canHoldRoles).equals(false)
    })

    it('finds a guardian’s child on any team of the season or the league', async () => {
      const season = await profile('season', f.seasonA, GUARDIAN, 101)
      expect(season.body.guardianOf.map(child => child.userId)).deep.equals(
        [PLAYER].map(userIdOfGumbo)
      )
      const league = await profile('league', f.leagueA, GUARDIAN, 101)
      expect(league.body.sections.map(section => section.level)).deep.equals([
        'league'
      ])
      expect(league.body.guardianOf.map(child => child.teamId)).deep.equals([
        f.teamA
      ])
      // Not in another league's.
      await f.h.db
        .insertInto('league_members')
        .values({
          id: makeId('leagueMember'),
          user_id: userIdOfGumbo(GUARDIAN),
          league_id: f.leagueB
        })
        .execute()
      const elsewhere = await profile('league', f.leagueB, GUARDIAN, 102)
      expect(elsewhere.status).equals(200)
      expect(elsewhere.body.guardianOf).deep.equals([])
    })

    it('opens only for the level’s administrators, coaches and assistants, and the person', async () => {
      expect((await profile('team', f.teamA, GUARDIAN, MEMBER)).status).equals(
        404
      )
      expect(
        (await profile('team', f.teamA, GUARDIAN, SCOREKEEPER)).status
      ).equals(404)
      expect(
        (await profile('season', f.seasonA, GUARDIAN, COACH)).status
      ).equals(404)
      const own = await profile('team', f.teamA, MEMBER, MEMBER)
      expect(own.status).equals(200)
      expect(own.body.viewer.manages).equals(false)
      expect(own.body.sections.every(section => !section.editable)).equals(true)
      // Somebody on no list of the team.
      expect((await profile('team', f.teamA, 102, COACH)).status).equals(404)
      expect((await profile('team', f.teamA, 999999, COACH)).status).equals(404)
      expect((await profile('team', 'tem_nowhere', MEMBER, 105)).status).equals(
        404
      )
    })
  })

  describe('taking somebody off a team', function () {
    const teamRoles = async (userId: number): Promise<string[]> =>
      (
        await f.h.db
          .selectFrom('scope_roles')
          .select('role')
          .where('user_id', '=', userIdOfGumbo(userId))
          .where('scope_type', '=', 'team')
          .where('scope_id', '=', f.teamA)
          .execute()
      )
        .map(row => row.role)
        .sort()
    const onTeam = async (userId: number): Promise<boolean> =>
      (await f.h.db
        .selectFrom('memberships')
        .select('id')
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(userId))
        .executeTakeFirst()) != null

    // Last in the suite: Alex leaves the Hawks.
    it('lets only the team’s administrators take off a player who can sign in, with every role they hold there', async () => {
      expect((await role('PUT', PLAYER, 'scorekeeper', 101)).status).equals(200)
      expect((await role('PUT', PLAYER, 'videographer', COACH)).status).equals(
        200
      )
      expect(await teamRoles(PLAYER)).deep.equals([
        'scorekeeper',
        'videographer'
      ])
      const remove = async (
        actor: number
      ): Promise<{ status: number; body: any }> =>
        await call(
          'DELETE',
          `/manage/team/${f.teamA}/people/${userIdOfGumbo(PLAYER)}`,
          actor
        )
      // Not the team's coach or assistant, nor anybody else on it.
      for (const actor of [COACH, ASSISTANT, SCOREKEEPER, MEMBER, GUARDIAN])
        expect((await remove(actor)).status, String(actor)).equals(404)
      expect(await onTeam(PLAYER)).equals(true)
      // A manager's membership makes an administrator of the team.
      await f.h.db
        .updateTable('memberships')
        .set({ role: 'manager' })
        .where('team_id', '=', f.teamA)
        .where('user_id', '=', userIdOfGumbo(MEMBER))
        .execute()
      const gone = await remove(MEMBER)
      expect(gone.status).equals(200)
      expect(gone.body).deep.equals({ removed: true })
      expect(await onTeam(PLAYER)).equals(false)
      expect(await teamRoles(PLAYER)).deep.equals([])
      // Off the roster.
      const roster = await call('GET', `/teams/${f.teamA}/roster`, 101)
      expect(
        (roster.body as RosterEntry[]).map(entry => entry.userId)
      ).not.includes(userIdOfGumbo(PLAYER))
      // Their guardian still guards them; that is not the team's.
      const links = await f.h.db
        .selectFrom('user_links')
        .select('user_id')
        .where('related_user_id', '=', userIdOfGumbo(PLAYER))
        .execute()
      expect(links.map(link => link.user_id)).deep.equals(
        [GUARDIAN].map(userIdOfGumbo)
      )
      expect((await remove(101)).body).deep.equals({ removed: false })
    })
  })
})
