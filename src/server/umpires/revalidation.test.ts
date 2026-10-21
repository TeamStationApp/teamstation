import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { closeInto } from '../admin/people'
import { updateEventInfo } from '../events/eventInfo'
import { setScopeRoles } from '../invites/people'
import { leaderboard, recheckUmpireAssignments } from './assignments'

describe('umpire assignment revalidation through game editors', function () {
  this.timeout(60000)
  let f: GroupFixture
  let previous: string | undefined
  const person = userIdOfGumbo(104)
  beforeEach(async () => {
    previous = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    await f.h.db
      .updateTable('games')
      .set({
        home_team_id: f.teamB,
        away_team_id: f.standaloneTeam
      })
      .where('id', '=', 'gam_umpire')
      .execute()
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_playing',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2027-04-02T20:00:00Z'),
        end_at: new Date('2027-04-02T22:00:00Z')
      })
      .execute()
    const saved = await f.h.request(
      'POST',
      '/games/gam_umpire/umpire-slots',
      {
        slot: 'plate',
        userId: person
      },
      101
    )
    expect(saved.status, await saved.clone().text()).equals(200)
  })
  afterEach(async () => {
    await f?.h.close()
    if (previous == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = previous
  })
  const expectCleared = async (): Promise<void> => {
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(0)
    const response = await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-leaderboard`,
      undefined,
      101
    )
    expect(
      (await response.json()).teams.every((t: any) => t.count === 0)
    ).equals(true)
  }
  it('clears assignments and credits when a playing game without umpires is extended', async () => {
    await updateEventInfo(f.h.db, actor(101), 'gam_playing', {
      endAt: '2027-04-03T01:00:00Z'
    })
    await expectCleared()
  })
  it('rechecks an accepted game-time proposal from the editor API', async () => {
    const snapshot = await (
      await f.h.request('GET', '/games/gam_playing/scheduling', undefined, 101)
    ).json()
    const response = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        gameId: 'gam_playing',
        expected: snapshot.version,
        idempotencyKey: 'umpire-reschedule',
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-04-03T00:30:00Z',
          endAt: '2027-04-03T02:30:00Z',
          venue: 'Demo Field',
          outsideTournament: null,
          timezone: 'UTC'
        }
      },
      101
    )
    expect(response.status, await response.clone().text()).equals(201)
    const proposal = await response.json()
    if (proposal.status !== 'accepted') {
      const accepted = await f.h.request(
        'POST',
        `/game-requests/${proposal.id}/accept`,
        {},
        102
      )
      expect(accepted.status, await accepted.clone().text()).equals(200)
    }
    await expectCleared()
  })
  it('removes the edited assignment when it overlaps another umpiring commitment', async () => {
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_other_umpiring',
        home_team_id: f.teamB,
        away_team_id: f.standaloneTeam,
        season_id: f.seasonA,
        start_at: new Date('2027-04-03T04:00:00Z'),
        end_at: new Date('2027-04-03T06:00:00Z')
      })
      .execute()
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_other_umpiring',
        slot: 'plate',
        user_id: person,
        assigned_by: userIdOfGumbo(101),
        credit_team_id: f.teamA
      })
      .execute()
    await f.h.db.transaction().execute(async trx => {
      await trx
        .updateTable('games')
        .set({ end_at: new Date('2027-04-03T05:00:00Z') })
        .where('id', '=', 'gam_umpire')
        .execute()
      await recheckUmpireAssignments(trx, 'gam_umpire')
    })
    const remaining = await f.h.db
      .selectFrom('umpire_assignments')
      .select(['game_id', 'credit_team_id'])
      .execute()
    expect(remaining).deep.equals([
      { game_id: 'gam_other_umpiring', credit_team_id: f.teamA }
    ])
  })
  it('rechecks overlapping playing games created through the bulk scheduling API', async () => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamB,
      userIdOfGumbo(101),
      { admin: true, flags: [] },
      userIdOfGumbo(102)
    )
    const response = await f.h.request(
      'POST',
      `/teams/${f.teamA}/games`,
      {
        games: [
          {
            opponent: { teamId: f.teamB },
            side: 'home',
            seasonId: f.seasonA,
            startAt: '2027-04-03T00:30:00Z'
          }
        ]
      },
      101
    )
    expect(response.status, await response.clone().text()).equals(200)
    const result = await response.json()
    expect(result.counts, JSON.stringify(result)).includes({
      created: 1,
      error: 0
    })
    await expectCleared()
  })
  for (const status of ['scheduled', 'final'] as const)
    it(`rechecks opponent-only bulk replacements for ${status} games`, async () => {
      await setScopeRoles(
        f.h.db,
        'team',
        f.teamB,
        userIdOfGumbo(101),
        { admin: true, flags: [] },
        userIdOfGumbo(102)
      )
      await f.h.db
        .updateTable('teams')
        .set({
          kind: 'external',
          custodian_type: 'team',
          custodian_id: f.teamB
        })
        .where('id', '=', f.standaloneTeam)
        .execute()
      await f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', 'gam_umpire')
        .execute()
      await f.h.db
        .insertInto('external_ids')
        .values({
          id: 'external_umpire_replacement',
          entity_type: 'game',
          entity_id: 'gam_umpire',
          system: 'otherLeague',
          kind: 'event',
          external_id: 'umpire-replacement'
        })
        .execute()
      const response = await f.h.request(
        'POST',
        `/teams/${f.teamB}/games`,
        {
          games: [
            {
              opponent: { teamId: f.teamA },
              startAt: '2027-04-03T00:00:00Z',
              externalId: {
                system: 'otherLeague',
                kind: 'event',
                id: 'umpire-replacement'
              }
            }
          ]
        },
        101
      )
      expect(response.status, await response.clone().text()).equals(200)
      const result = await response.json()
      expect(result.counts, JSON.stringify(result)).includes({
        updated: 1,
        error: 0
      })
      await expectCleared()
    })
  it('preserves a valid assignment when a bulk row changes both opponent and time', async () => {
    await setScopeRoles(
      f.h.db,
      'team',
      f.teamB,
      userIdOfGumbo(101),
      { admin: true, flags: [] },
      userIdOfGumbo(102)
    )
    await f.h.db
      .updateTable('teams')
      .set({ kind: 'external', custodian_type: 'team', custodian_id: f.teamB })
      .where('id', '=', f.standaloneTeam)
      .execute()
    await f.h.db
      .updateTable('games')
      .set({
        home_team_id: f.teamB,
        away_team_id: f.standaloneTeam,
        start_at: new Date('2027-04-03T00:00:00Z'),
        end_at: new Date('2027-04-03T02:00:00Z')
      })
      .where('id', '=', 'gam_playing')
      .execute()
    await f.h.db
      .insertInto('external_ids')
      .values({
        id: 'external_combined_edit',
        entity_type: 'game',
        entity_id: 'gam_playing',
        system: 'otherLeague',
        kind: 'event',
        external_id: 'combined-edit'
      })
      .execute()
    const before = await f.h.db
      .selectFrom('umpire_assignments')
      .selectAll()
      .execute()
    const response = await f.h.request(
      'POST',
      `/teams/${f.teamB}/games`,
      {
        games: [
          {
            opponent: { teamId: f.teamA },
            startAt: '2027-04-04T00:00:00Z',
            externalId: {
              system: 'otherLeague',
              kind: 'event',
              id: 'combined-edit'
            }
          }
        ]
      },
      101
    )
    expect(response.status, await response.clone().text()).equals(200)
    const result = await response.json()
    expect(result.counts, JSON.stringify(result)).includes({
      updated: 1,
      error: 0
    })
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).deep.equals(before)
    expect(
      (await leaderboard(f.h.db, actor(101), f.leagueA)).teams![0].count
    ).equals(1)
  })
  it('clears league-specific umpire data when a season is moved through parent links', async () => {
    const move = async (
      operation: 'attach' | 'detach',
      league: string
    ): Promise<void> => {
      const actions = [
        {
          operation,
          child: { kind: 'season', id: f.seasonA },
          parent: { kind: 'league', id: league }
        }
      ]
      const previewResponse = await f.h.request(
        'POST',
        '/parent-previews',
        { actions },
        105
      )
      expect(
        previewResponse.status,
        await previewResponse.clone().text()
      ).equals(200)
      const preview = await previewResponse.json()
      if (preview.effects.length > 0)
        expect(preview.explanation.join(' ')).includes(
          'clears its umpire requirements, assignments and credits'
        )
      const result = await f.h.request(
        'PUT',
        '/parent-links',
        { actions, expected: preview.expected },
        105
      )
      expect(result.status, await result.clone().text()).equals(200)
    }
    await move('attach', f.leagueA)
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(1)
    await move('detach', f.leagueA)
    await expectCleared()
    expect(
      await f.h.db
        .selectFrom('season_umpire_requirements')
        .selectAll()
        .where('season_id', '=', f.seasonA)
        .execute()
    ).length(0)
    await move('attach', f.leagueB)
    await f.h.db
      .insertInto('umpire_levels')
      .values({
        id: 'ulv_destination',
        league_id: f.leagueB,
        name: 'Destination level',
        position: 0
      })
      .execute()
    await f.h.db
      .insertInto('season_umpire_requirements')
      .values({
        season_id: f.seasonA,
        level_id: 'ulv_destination',
        plate: true,
        field_count: 0
      })
      .execute()
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_umpire',
        slot: 'plate',
        user_id: person,
        assigned_by: userIdOfGumbo(102),
        credit_team_id: f.teamA
      })
      .execute()
    const removed = await f.h.request(
      'DELETE',
      `/leagues/${f.leagueA}/umpire-levels/ulv_majors`,
      undefined,
      101
    )
    expect(removed.status, await removed.clone().text()).equals(200)
    expect(
      await f.h.db
        .selectFrom('season_umpire_requirements')
        .select('level_id')
        .where('season_id', '=', f.seasonA)
        .execute()
    ).deep.equals([{ level_id: 'ulv_destination' }])
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(1)
  })
  it('loads leaderboard identities once per person, including aliases across a large history', async () => {
    const survivor = userIdOfGumbo(103)
    await f.h.db
      .updateTable('users')
      .set({ merged_into: survivor })
      .where('id', '=', person)
      .execute()
    const games = Array.from({ length: 1000 }, (_, i) => ({
      id: `gam_history_${i}`,
      home_team_id: f.teamB,
      away_team_id: f.standaloneTeam,
      season_id: f.seasonA,
      start_at: new Date('2027-03-01T12:00:00Z'),
      status: 'final' as const
    }))
    await f.h.db.insertInto('games').values(games).execute()
    await f.h.db
      .insertInto('umpire_assignments')
      .values(
        games.map((g, i) => ({
          game_id: g.id,
          slot: 'plate',
          user_id: i % 2 === 0 ? person : survivor,
          assigned_by: userIdOfGumbo(101),
          credit_team_id: f.teamA
        }))
      )
      .execute()
    let queries = 0
    const db = f.h.db.withPlugin({
      transformQuery({ node }) {
        queries += 1
        return node
      },
      async transformResult({ result }) {
        return result
      }
    })
    const board = await leaderboard(db, actor(101), f.leagueA)
    expect(board.scheduled).length(1)
    expect(board.scheduled[0]).includes({ userId: survivor, count: 1001 })
    expect(board.completed[0].count).equals(1000)
    expect(queries).lessThan(80)
  })
  it('refuses a person merge with two slots on one game until the assignment is resolved', async () => {
    const second = await f.h.request(
      'POST',
      '/games/gam_umpire/umpire-slots',
      {
        slot: 'field:1',
        userId: userIdOfGumbo(101)
      },
      101
    )
    expect(second.status, await second.clone().text()).equals(200)
    const before = await f.h.db
      .selectFrom('umpire_assignments')
      .selectAll()
      .orderBy('slot')
      .execute()
    expect(
      await closeInto(f.h.db, person, userIdOfGumbo(101)).then(
        () => null,
        (e: unknown) => e
      )
    ).property('code', 'conflict')
    expect(
      await f.h.db
        .selectFrom('umpire_assignments')
        .selectAll()
        .orderBy('slot')
        .execute()
    ).deep.equals(before)
    expect(
      (
        await f.h.db
          .selectFrom('users')
          .select('merged_into')
          .where('id', '=', person)
          .executeTakeFirstOrThrow()
      ).merged_into
    ).equals(null)
    const removed = await f.h.request(
      'DELETE',
      '/games/gam_umpire/umpire-slots',
      { slot: 'plate' },
      101
    )
    expect(removed.status, await removed.clone().text()).equals(200)
    expect((await closeInto(f.h.db, person, userIdOfGumbo(101))).closed).equals(
      true
    )
    const board = await leaderboard(f.h.db, actor(101), f.leagueA)
    expect(board.scheduled).length(1)
    expect(board.scheduled[0]).includes({
      userId: userIdOfGumbo(101),
      count: 1
    })
    expect(board.teams!.reduce((sum, team) => sum + team.count, 0)).equals(1)
  })
  it('rejects a stale signup choice after its canonical child is disabled', async () => {
    await f.h.db.deleteFrom('umpire_assignments').execute()
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', person)
      .execute()
    const response = await f.h.request(
      'POST',
      '/games/gam_umpire/umpire-slots',
      { slot: 'plate', userId: person },
      101
    )
    expect(response.status).equals(403)
    await expectCleared()
  })
})
