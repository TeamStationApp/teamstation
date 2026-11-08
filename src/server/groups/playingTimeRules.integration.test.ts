import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import {
  DEFAULT_PLAYING_TIME_RULES,
  type PlayingTimeRules
} from '../../common/playingTimeRules'
import { asGroupDetail, type GroupDetail } from '../../common/publicGroups'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

const rules = (changes: Partial<PlayingTimeRules>): PlayingTimeRules => ({
  ...DEFAULT_PLAYING_TIME_RULES,
  ...changes
})

describe('Playing Time Rules on seasons and teams', function () {
  this.timeout(60000)
  let f: GroupFixture

  const put = async (
    kind: 'league' | 'season' | 'team',
    id: string,
    body: unknown,
    userId = 101
  ): Promise<Response> =>
    await f.h.request('PUT', `/groups/${kind}/${id}`, body, userId)
  const raw = async (
    kind: 'season' | 'team',
    id: string,
    userId = 101
  ): Promise<Record<string, unknown>> => {
    const answer = await f.h.request(
      'GET',
      `/${kind === 'season' ? 'seasons' : 'teams'}/${id}`,
      undefined,
      userId
    )
    expect(answer.status).equals(200)
    return (await answer.json()) as Record<string, unknown>
  }
  const detail = async (
    kind: 'season' | 'team',
    id: string,
    userId = 101
  ): Promise<GroupDetail> => asGroupDetail(await raw(kind, id, userId))
  const stored = async (
    table: 'seasons' | 'teams',
    id: string
  ): Promise<unknown> =>
    (
      await f.h.db
        .selectFrom(table)
        .select('playing_time_rules')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).playing_time_rules

  before(async function () {
    f = await groupFixture()
    // Mike Trout coaches the Hawks without administering them.
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
  })
  after(async function () {
    await f.h.close()
  })
  beforeEach(async function () {
    for (const table of ['seasons', 'teams'] as const)
      await f.h.db
        .updateTable(table)
        .set({ playing_time_rules: null })
        .execute()
    await f.h.db
      .deleteFrom('season_team_parents')
      .where('team_id', '=', f.teamA)
      .where('season_id', '!=', f.seasonA)
      .execute()
  })

  it('stores a season’s set and answers it to its administrator', async function () {
    const season = rules({ mandatoryPlay: true, defensiveOutsRequired: 9 })
    const answer = await put('season', f.seasonA, {
      playingTimeRules: { mandatoryPlay: true, defensiveOutsRequired: 9 }
    })
    expect(answer.status).equals(200)
    // The whole set is stored, every missing rule at its default.
    expect(await stored('seasons', f.seasonA)).deep.equals(season)
    const read = await detail('season', f.seasonA)
    expect(read.playingTimeRules).deep.equals(season)
    expect(read.seasonPlayingTimeRules).equals(null)
    // A season that has none answers null.
    expect((await raw('season', f.playoffs)).playingTimeRules).equals(null)
  })

  it('gives a team its managing season’s set, and none of its own', async function () {
    const season = rules({ continuousBatting: true })
    expect(
      (await put('season', f.seasonA, { playingTimeRules: season })).status
    ).equals(200)
    const read = await detail('team', f.teamA)
    expect(read.playingTimeRules).equals(null)
    expect(read.seasonPlayingTimeRules).deep.equals({
      season: { id: f.seasonA, name: 'Demo Regular' },
      rules: season
    })
    // A team whose seasons have no rules has nothing to follow.
    const other = await raw('team', f.teamB, 102)
    expect(other.playingTimeRules).equals(null)
    expect(other.seasonPlayingTimeRules).equals(null)
  })

  it('follows the latest-starting managing season that has rules', async function () {
    await f.h.db
      .insertInto('season_team_parents')
      .values({ season_id: f.playoffs, team_id: f.teamA })
      .execute()
    await f.h.db
      .updateTable('seasons')
      .set({ starts_on: '2027-06-01', ends_on: '2027-06-30' })
      .where('id', '=', f.playoffs)
      .execute()
    // A season the team only competes in is not one it follows.
    await f.h.db
      .insertInto('season_teams')
      .values({ season_id: f.seasonB, team_id: f.teamA })
      .onConflict(oc => oc.doNothing())
      .execute()
    await f.h.db
      .updateTable('seasons')
      .set({
        playing_time_rules: rules({ rotateLeadoff: true }),
        starts_on: '2028-01-01',
        ends_on: '2028-02-01'
      })
      .where('id', '=', f.seasonB)
      .execute()
    const regular = rules({ mandatoryPlay: true })
    const playoffs = rules({ enforceSittingLimits: true })
    await put('season', f.seasonA, { playingTimeRules: regular })
    await put('season', f.playoffs, { playingTimeRules: playoffs })
    expect((await detail('team', f.teamA)).seasonPlayingTimeRules).deep.equals({
      season: { id: f.playoffs, name: 'Demo Playoffs' },
      rules: playoffs
    })
    // The later season without rules gives way to the earlier one with them.
    await put('season', f.playoffs, { playingTimeRules: null })
    expect((await detail('team', f.teamA)).seasonPlayingTimeRules).deep.equals({
      season: { id: f.seasonA, name: 'Demo Regular' },
      rules: regular
    })
    await f.h.db
      .updateTable('seasons')
      .set({ starts_on: '2027-03-01', ends_on: '2027-05-31' })
      .where('id', 'in', [f.playoffs, f.seasonB])
      .execute()
    await f.h.db
      .deleteFrom('season_teams')
      .where('season_id', '=', f.seasonB)
      .where('team_id', '=', f.teamA)
      .execute()
  })

  it('keeps a team’s override whole when its season changes later', async function () {
    const season = rules({ mandatoryPlay: true })
    await put('season', f.seasonA, { playingTimeRules: season })
    const override = { ...season, mustBeConsecutive: true }
    expect(
      (await put('team', f.teamA, { playingTimeRules: override })).status
    ).equals(200)
    expect(await stored('teams', f.teamA)).deep.equals(override)
    await put('season', f.seasonA, {
      playingTimeRules: rules({ mandatoryPlay: false, rotateLeadoff: true })
    })
    const read = await detail('team', f.teamA)
    expect(read.playingTimeRules).deep.equals(override)
    expect(read.seasonPlayingTimeRules?.rules).deep.equals(
      rules({ rotateLeadoff: true })
    )
    // Another field's save leaves the rules alone.
    expect((await put('team', f.teamA, { name: 'Demo Hawks' })).status).equals(
      200
    )
    expect(await stored('teams', f.teamA)).deep.equals(override)
  })

  it('refuses anybody but an administrator, and tells them nothing', async function () {
    await put('season', f.seasonA, {
      playingTimeRules: rules({ mandatoryPlay: true })
    })
    await put('team', f.teamA, {
      playingTimeRules: rules({ continuousBatting: true })
    })
    const refused = await put(
      'team',
      f.teamA,
      { playingTimeRules: rules({}) },
      103
    )
    expect(refused.status).equals(403)
    expect(
      (await put('season', f.seasonA, { playingTimeRules: null }, 103)).status
    ).equals(403)
    expect(await stored('teams', f.teamA)).deep.equals(
      rules({ continuousBatting: true })
    )
    for (const read of [
      await raw('team', f.teamA, 103),
      await raw('season', f.seasonA, 103),
      await raw('team', f.teamA, 102)
    ]) {
      expect(read).not.has.property('playingTimeRules')
      expect(read).not.has.property('seasonPlayingTimeRules')
    }
    const guest = await f.h.request('GET', `/teams/${f.teamA}`, undefined, null)
    expect(await guest.json()).not.has.property('playingTimeRules')
  })

  it('refuses rules on a league', async function () {
    const answer = await put('league', f.leagueA, {
      playingTimeRules: rules({})
    })
    expect(answer.status).equals(400)
    expect(((await answer.json()) as { message: string }).message).equals(
      'Playing time rules belong to a season or team'
    )
    // Even to clear them.
    expect(
      (await put('league', f.leagueA, { playingTimeRules: null })).status
    ).equals(400)
  })

  it('refuses a value out of range or off its choices, storing nothing', async function () {
    for (const playingTimeRules of [
      { largeRosterPlayers: 26 },
      { maxSitsPerGame: -1 },
      { defensiveOutsRequired: 4 },
      { infieldPositions: ['LF'] },
      'all of them'
    ]) {
      const answer = await put('team', f.teamA, {
        name: 'Renamed Hawks',
        playingTimeRules
      })
      expect(answer.status, JSON.stringify(playingTimeRules)).equals(400)
    }
    expect(await stored('teams', f.teamA)).equals(null)
    const team = await f.h.db
      .selectFrom('teams')
      .select('name')
      .where('id', '=', f.teamA)
      .executeTakeFirstOrThrow()
    expect(team.name).equals('Demo Hawks')
  })

  it('clears with null: a season has none, a team follows its season again', async function () {
    const season = rules({ mandatoryPlay: true })
    await put('season', f.seasonA, { playingTimeRules: season })
    await put('team', f.teamA, {
      playingTimeRules: rules({ rotateLeadoff: true })
    })
    expect(
      (await put('team', f.teamA, { playingTimeRules: null })).status
    ).equals(200)
    expect(await stored('teams', f.teamA)).equals(null)
    const team = await detail('team', f.teamA)
    expect(team.playingTimeRules).equals(null)
    expect(team.seasonPlayingTimeRules?.rules).deep.equals(season)
    expect(
      (await put('season', f.seasonA, { playingTimeRules: null })).status
    ).equals(200)
    expect((await detail('season', f.seasonA)).playingTimeRules).equals(null)
    expect((await detail('team', f.teamA)).seasonPlayingTimeRules).equals(null)
  })
})
