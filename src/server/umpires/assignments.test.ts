import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { gameUmpires, recheckUmpireAssignments } from './assignments'

describe('umpire signup, credits, removal and leaderboard', function () {
  this.timeout(60000)
  let f: GroupFixture, old: string | undefined
  const person = userIdOfGumbo(103)
  const save = async (
    body: unknown,
    user = 103,
    game = 'gam_umpire'
  ): Promise<Response> =>
    await f.h.request('POST', `/games/${game}/umpire-slots`, body, user)
  const remove = async (slot = 'plate', user = 103): Promise<Response> =>
    await f.h.request(
      'DELETE',
      '/games/gam_umpire/umpire-slots',
      { slot },
      user
    )
  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: 'lnk_other_ump',
        user_id: person,
        related_user_id: userIdOfGumbo(104),
        kind: 'guardian'
      })
      .execute()
    await f.h.db
      .insertInto('league_umpires')
      .values({
        league_id: f.leagueA,
        user_id: person,
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    await f.h.db
      .insertInto('umpire_certifications')
      .values({
        user_id: person,
        level_id: 'ulv_majors',
        plate: true,
        field: true
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
  it('validates a choice and stores an assignment with a single automatic team credit, never an RSVP', async () => {
    for (const body of [
      {},
      { slot: 'plate', userId: 1 },
      { slot: 'plate', userId: person, creditTeamId: 4 }
    ])
      expect((await save(body)).status).equals(400)
    expect((await save({ slot: 'field:6', userId: person })).status).equals(403)
    expect(
      (await save({ slot: 'plate', userId: userIdOfGumbo(104) })).status
    ).equals(409)
    expect(
      (await save({ slot: 'plate', userId: person, creditTeamId: 'other' }))
        .status
    ).equals(400)
    expect((await save({ slot: 'plate', userId: person })).status).equals(200)
    expect((await save({ slot: 'plate', userId: person })).status).equals(409)
    expect((await save({ slot: 'field:1', userId: person })).status).equals(409)
    const rows = await f.h.db
      .selectFrom('umpire_assignments')
      .selectAll()
      .execute()
    expect(rows).length(1)
    expect(rows[0].credit_team_id).equals(f.teamA)
    expect(await f.h.db.selectFrom('game_rsvps').selectAll().execute()).length(
      0
    )
    const block = await gameUmpires(f.h.db, 'gam_umpire')
    expect(block?.plate?.userId).equals(person)
    expect(block?.field).deep.equals([null])
    const schedule = await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-schedule`,
        undefined,
        103
      )
    ).json()
    expect(schedule.games[0].assignments.plate.canRemove).equals(true)
    const board = await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-leaderboard`,
        undefined,
        103
      )
    ).json()
    expect(board.completed).length(0)
    expect(board.scheduled[0]).includes({
      userId: person,
      count: 1,
      symbol: '🏆'
    })
    expect(board.teams.find((t: any) => t.id === f.teamA).count).equals(1)
    expect((await remove()).status).equals(200)
    expect((await remove()).status).equals(404)
    expect((await gameUmpires(f.h.db, 'gam_umpire'))?.plate).equals(null)
  })
  it('enforces the exact cutoff for a nonadmin and lets the admin remove afterwards', async () => {
    expect((await save({ slot: 'plate', userId: person })).status).equals(200)
    process.env.TS_UMPIRE_NOW = '2027-04-02T23:46:00Z'
    expect((await remove()).status).equals(403)
    const schedule = await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-schedule`,
        undefined,
        103
      )
    ).json()
    expect(schedule.games[0].assignments.plate.canRemove).equals(false)
    expect((await remove('plate', 101)).status).equals(200)
    process.env.TS_UMPIRE_NOW = '2027-04-02T23:44:00Z'
    expect((await save({ slot: 'plate', userId: person })).status).equals(200)
    expect((await remove()).status).equals(200)
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
  })
  it('counts final and in-progress distinctly and hides only the credit table when credits turn off', async () => {
    await save({ slot: 'plate', userId: person })
    for (const [status, completed] of [
      ['inProgress', 0],
      ['final', 1]
    ] as const) {
      await f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', 'gam_umpire')
        .execute()
      const board = await (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/umpire-leaderboard`,
          undefined,
          101
        )
      ).json()
      expect(board.completed).length(completed)
      expect(board.scheduled[0].count).equals(1)
    }
    expect(
      (await save({ slot: 'field:1', userId: userIdOfGumbo(101) }, 101)).status
    ).equals(400)
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_credits: false })
      .where('id', '=', f.leagueA)
      .execute()
    expect(
      (
        await (
          await f.h.request(
            'GET',
            `/leagues/${f.leagueA}/umpire-leaderboard`,
            undefined,
            101
          )
        ).json()
      ).teams
    ).equals(null)
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(1)
    await f.h.db
      .updateTable('games')
      .set({ status: 'scheduled' })
      .where('id', '=', 'gam_umpire')
      .execute()
    await remove('plate', 101)
  })
  it('rechecks assignments after a changed matchup or overlapping game and removes its credit', async () => {
    await save({ slot: 'plate', userId: person })
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_becomes_player',
        user_id: person,
        team_id: f.teamA,
        is_player: true,
        role: 'member'
      })
      .execute()
    await f.h.db.transaction().execute(async trx => {
      await recheckUmpireAssignments(trx, 'gam_umpire')
    })
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(0)
    await f.h.db
      .deleteFrom('memberships')
      .where('id', '=', 'mem_becomes_player')
      .execute()
    await f.h.db.transaction().execute(async trx => {
      await recheckUmpireAssignments(trx, 'gam_umpire')
    })
  })
  it('denies disabled management and omits the game block without needs', async () => {
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: false })
      .where('id', '=', f.leagueA)
      .execute()
    expect((await save({ slot: 'plate', userId: person })).status).equals(403)
    expect((await remove()).status).equals(403)
    expect(
      (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/umpire-leaderboard`,
          undefined,
          103
        )
      ).status
    ).equals(403)
    expect(await gameUmpires(f.h.db, 'gam_umpire')).equals(null)
    expect(await gameUmpires(f.h.db, 'missing')).equals(null)
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: true })
      .where('id', '=', f.leagueA)
      .execute()
    await f.h.db
      .updateTable('season_umpire_requirements')
      .set({ plate: false, field_count: 0 })
      .where('season_id', '=', f.seasonA)
      .execute()
    expect(await gameUmpires(f.h.db, 'gam_umpire')).equals(null)
  })
})
