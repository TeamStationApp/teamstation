import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { PLAYER_NAME_PRIVACY } from '../../common/playerNamePrivacy'
import { asGroupDetail } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  currentFormats,
  loadPlayerNamePrivacy,
  teamFormats
} from './playerNamePrivacy'

describe('player name privacy from the database', function () {
  this.timeout(60000)
  let f: GroupFixture

  const set = async (
    table: 'leagues' | 'seasons' | 'teams',
    id: string,
    value: string | null
  ): Promise<void> => {
    await f.h.db
      .updateTable(table)
      .set({ player_name_privacy: value })
      .where('id', '=', id)
      .execute()
  }
  const team = async (): ReturnType<typeof loadPlayerNamePrivacy> =>
    await loadPlayerNamePrivacy(f.h.db, { kind: 'team', id: f.teamA })

  before(async function () {
    f = await groupFixture()
    await f.h.db
      .insertInto('season_team_parents')
      .values({ season_id: f.playoffs, team_id: f.teamA })
      .execute()
  })
  after(async function () {
    await f.h.close()
  })
  beforeEach(async function () {
    for (const table of ['leagues', 'seasons', 'teams'] as const)
      await f.h.db
        .updateTable(table)
        .set({ player_name_privacy: null })
        .execute()
  })

  it('reads the built-in format with nothing stored', async function () {
    expect(await team()).deep.equals({
      format: 'firstLastInitial',
      stored: null,
      inheritedFrom: []
    })
    expect(
      await loadPlayerNamePrivacy(f.h.db, { kind: 'league', id: f.leagueA })
    ).deep.equals({
      format: 'firstLastInitial',
      stored: null,
      inheritedFrom: []
    })
  })

  it('takes the stricter of two managing seasons and names it', async function () {
    await set('seasons', f.seasonA, 'full')
    await set('seasons', f.playoffs, 'firstLastInitial')
    const resolved = await team()
    expect(resolved.format).equals('firstLastInitial')
    expect(resolved.inheritedFrom).deep.equals([
      { kind: 'season', id: f.playoffs, name: 'Demo Playoffs' }
    ])
  })

  it('reaches a league through a season on Default', async function () {
    await set('leagues', f.leagueA, 'full')
    const resolved = await team()
    expect(resolved.format).equals('full')
    expect(resolved.inheritedFrom.map(from => from.kind)).deep.equals([
      'league'
    ])
    expect(
      (await loadPlayerNamePrivacy(f.h.db, { kind: 'season', id: f.seasonA }))
        .format
    ).equals('full')
  })

  it('ignores a season the team only competes in', async function () {
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonB, team_id: f.teamA })
      .execute()
    await set('seasons', f.seasonB, 'full')
    await set('leagues', f.leagueB, 'full')
    expect((await team()).format).equals('firstLastInitial')
  })

  it('reads a merged team as its survivor, keyed by the id asked', async function () {
    await set('teams', f.teamB, 'initials')
    await set('teams', f.standaloneTeam, 'full')
    await f.h.db
      .updateTable('teams')
      .set({ merged_into: f.teamB })
      .where('id', '=', f.standaloneTeam)
      .execute()
    const formats = await teamFormats(f.h.db, [
      f.standaloneTeam,
      f.teamB,
      'tem_nobody'
    ])
    expect(formats.get(f.standaloneTeam)).equals('initials')
    expect(formats.get(f.teamB)).equals('initials')
    expect(formats.has('tem_nobody')).equals(false)
    expect((await teamFormats(f.h.db, [])).size).equals(0)
    expect(
      (
        await loadPlayerNamePrivacy(f.h.db, {
          kind: 'team',
          id: f.standaloneTeam
        })
      ).format
    ).equals('initials')
    await f.h.db
      .updateTable('teams')
      .set({ merged_into: null })
      .where('id', '=', f.standaloneTeam)
      .execute()
  })

  it('stores what an administrator chooses, and clears it', async function () {
    const put = async (body: unknown, userId = 101): Promise<Response> =>
      await f.h.request('PUT', `/groups/team/${f.teamA}`, body, userId)
    for (const value of PLAYER_NAME_PRIVACY) {
      expect((await put({ playerNamePrivacy: value })).status).equals(200)
      expect((await team()).stored).equals(value)
    }
    expect((await put({ name: 'Demo Hawks' })).status).equals(200)
    expect((await team()).stored).equals('full')
    expect((await put({ playerNamePrivacy: null })).status).equals(200)
    expect((await team()).stored).equals(null)
  })

  it('refuses an unknown value', async function () {
    const answer = await f.h.request(
      'PUT',
      `/groups/team/${f.teamA}`,
      { playerNamePrivacy: 'everything' },
      101
    )
    expect(answer.status).equals(400)
    expect((await team()).stored).equals(null)
  })

  it('refuses anybody but an administrator', async function () {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(103),
        scope_type: 'team',
        scope_id: f.teamA,
        role: 'coach',
        granted_by: userIdOfGumbo(101),
        granted_at: new Date()
      })
      .execute()
    const answer = await f.h.request(
      'PUT',
      `/groups/team/${f.teamA}`,
      { playerNamePrivacy: 'full' },
      103
    )
    expect(answer.status).equals(403)
    expect((await team()).stored).equals(null)
  })

  it('answers the value, the format and its source on group detail', async function () {
    await set('seasons', f.seasonA, 'full')
    await set('seasons', f.playoffs, 'firstLastInitial')
    const detail = asGroupDetail(
      await (await f.h.request('GET', `/teams/${f.teamA}`)).json()
    )
    expect(detail.playerNamePrivacy).equals(null)
    expect(detail.playerNamePrivacyFormat).equals('firstLastInitial')
    expect(detail.playerNamePrivacyInheritedFrom).deep.equals([
      { kind: 'season', id: f.playoffs, name: 'Demo Playoffs' }
    ])
  })

  it('takes the most restrictive of the teams somebody plays on now', async function () {
    const both = userIdOfGumbo(401)
    const none = userIdOfGumbo(402)
    await insertFixtureUsers(f.h.db, [
      { id: 401, legacyId: 'usr_privacy_both', display_name: 'Alex Lee' },
      { id: 402, legacyId: 'usr_privacy_none', display_name: 'Riley Chen' }
    ])
    await f.h.db
      .insertInto('memberships')
      .values(
        [f.teamA, f.teamB].map(teamId => ({
          id: makeId('membership'),
          user_id: both,
          team_id: teamId,
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
    await set('teams', f.teamA, 'full')
    await set('teams', f.teamB, 'initialLast')
    const formats = await currentFormats(f.h.db, [both, none])
    expect(formats.get(both)).equals('initialLast')
    expect(formats.get(none)).equals('firstLastInitial')
    expect((await currentFormats(f.h.db, [])).size).equals(0)
  })
})
