import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('limited public organization profiles', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await groupFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  it('returns every owned season while keeping public discovery capped separately', async () => {
    await f.h.db
      .insertInto('seasons')
      .values(
        Array.from({ length: 51 }, (_, index) => ({
          id: `season_owned_extra_${index}`,
          name: `Demo Extra ${index}`,
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
          id: `role_owned_extra_${index}`,
          scope_type: 'season' as const,
          scope_id: `season_owned_extra_${index}`,
          user_id: 101,
          role: 'admin' as const,
          granted_by: 101,
          granted_at: new Date()
        }))
      )
      .execute()
    const owned = (await (
      await f.h.request('GET', '/me/groups', undefined, 101)
    ).json()) as Array<{ kind: string; id: string }>
    expect(owned.filter(group => group.kind === 'season')).length(53)
    expect(owned.some(group => group.id === f.seasonA)).equals(true)
    const publicRows = (await (
      await f.h.request('GET', '/seasons?view=public', undefined, null)
    ).json()) as unknown[]
    expect(publicRows).length(50)
  })
  it('lets public viewers find all group types and hides private user/team data', async () => {
    const search = await f.h.request(
      'GET',
      '/teams?view=public&query=Demo%20City',
      undefined,
      null
    )
    expect(search.status).equals(200)
    expect(((await search.json()) as unknown[]).length).greaterThan(0)
    const seasonsByCity = await f.h.request(
      'GET',
      '/seasons?view=public&query=Demo%20City',
      undefined,
      null
    )
    expect(((await seasonsByCity.json()) as unknown[]).length).greaterThan(0)
    await f.h.db
      .updateTable('teams')
      .set({ settings: sql`'{"secret":"PRIVATE_TEAM_DATA"}'::jsonb` })
      .where('id', '=', f.teamA)
      .execute()
    const response = await f.h.request(
      'GET',
      `/teams/${f.teamA}`,
      undefined,
      null
    )
    expect(response.status).equals(200)
    const detail = (await response.json()) as {
      staff: Array<{ name: string }>
      canManage: boolean
      parents: unknown[]
      group: unknown
    }
    expect(detail.canManage).equals(false)
    expect(detail.staff[0].name).equals('Babe R.')
    const text = JSON.stringify(detail)
    for (const forbidden of [
      'PRIVATE_TEAM_DATA',
      'Morgan',
      'alex@example.com',
      'userId',
      'roster',
      'stats'
    ])
      expect(text).not.includes(forbidden)
    expect(detail.parents).length(2)
    expect(
      (await f.h.request('GET', '/leagues?view=public', undefined, null)).status
    ).equals(200)
    expect(
      (await f.h.request('GET', '/seasons?view=public', undefined, null)).status
    ).equals(200)
    expect(
      (await f.h.request('GET', `/teams/${f.teamA}/roster`, undefined, null))
        .status
    ).equals(401)
  })
  it('lists the roles staff were given, never the ones those imply', async () => {
    const given = (
      userId: number,
      scopeType: 'season' | 'team',
      scopeId: string,
      role: 'assistant' | 'scorekeeper'
    ): {
      id: string
      scope_type: 'season' | 'team'
      scope_id: string
      user_id: number
      role: 'assistant' | 'scorekeeper'
      granted_by: number
      granted_at: Date
    } => ({
      id: `role_staff_${userId}_${role}`,
      scope_type: scopeType,
      scope_id: scopeId,
      user_id: userId,
      role,
      granted_by: 101,
      granted_at: new Date()
    })
    await f.h.db
      .insertInto('scope_roles')
      .values([
        given(106, 'team', f.teamA, 'scorekeeper'),
        given(103, 'season', f.seasonA, 'assistant')
      ])
      .execute()
    try {
      const detail = (await (
        await f.h.request('GET', `/teams/${f.teamA}`, undefined, null)
      ).json()) as { staff: Array<{ name: string; roles: string[] }> }
      const byName = Object.fromEntries(
        detail.staff.map(person => [person.name, person.roles])
      )
      // The admin is admin alone, the scorekeeper is not also a songkeeper,
      // and an assistant set on the season is listed on its team.
      expect(byName['Babe R.']).deep.equals(['admin'])
      expect(byName['Tim R.']).deep.equals(['scorekeeper'])
      expect(byName['Mike T.']).deep.equals(['assistant'])
    } finally {
      await f.h.db
        .deleteFrom('scope_roles')
        .where('id', 'like', 'role_staff_%')
        .execute()
    }
  })
  it('marks a team page as the non-member view for anybody signed in who is not a member, following it or not', async () => {
    const view = async (
      path: string,
      userId: number | null
    ): Promise<{ nonMemberView: boolean; canViewPrivate: boolean }> =>
      (await (await f.h.request('GET', path, undefined, userId)).json()) as {
        nonMemberView: boolean
        canViewPrivate: boolean
      }
    // Nobody signed in reads the public page.
    expect((await view(`/teams/${f.teamA}`, null)).nonMemberView).equals(false)
    // Signed in and following nothing: the non-member view already.
    const unfollowed = await view(`/teams/${f.teamA}`, 103)
    expect(unfollowed.canViewPrivate).equals(false)
    expect(unfollowed.nonMemberView).equals(true)
    await f.h.db
      .insertInto('follows')
      .values([
        { user_id: 103, group_type: 'team', group_id: f.teamA },
        { user_id: 103, group_type: 'season', group_id: f.seasonA },
        { user_id: 101, group_type: 'team', group_id: f.teamA }
      ])
      .execute()
    try {
      // Following it changes nothing.
      const followed = await view(`/teams/${f.teamA}`, 103)
      expect(followed.canViewPrivate).equals(false)
      expect(followed.nonMemberView).equals(true)
      // A season or a league page is the same for everybody.
      expect((await view(`/seasons/${f.seasonA}`, 103)).nonMemberView).equals(
        false
      )
      expect((await view(`/leagues/${f.leagueA}`, 103)).nonMemberView).equals(
        false
      )
      // A member who follows their own team reads it as a member.
      const own = await view(`/teams/${f.teamA}`, 101)
      expect(own.canViewPrivate).equals(true)
      expect(own.nonMemberView).equals(false)
    } finally {
      await f.h.db
        .deleteFrom('follows')
        .where('user_id', 'in', [101, 103])
        .execute()
    }
  })
  it('includes aggregate results and parent context without private play events or stats', async () => {
    await f.h.db
      .insertInto('games')
      .values({
        id: 'publicGame',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonB,
        start_at: new Date(),
        status: 'final',
        home_score: 3,
        away_score: 2
      })
      .execute()
    const body = (await (
      await f.h.request('GET', `/teams/${f.teamA}`, undefined, 106)
    ).json()) as { games: Array<Record<string, unknown>>; canManage: boolean }
    expect(body.games[0]).property('homeScore', 3)
    expect(body.games[0]).not.property('boxscore')
    expect(body.games[0]).not.property('events')
    expect(body.canManage).equals(false)
    const admin = (await (
      await f.h.request('GET', `/teams/${f.teamA}`, undefined, 101)
    ).json()) as { canManage: boolean }
    expect(admin.canManage).equals(true)
    expect(
      (await f.h.request('GET', '/teams/missing', undefined, null)).status
    ).equals(404)
  })
})
