import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { umpireFixture } from '../../test/umpireFixture'
import { publicGames } from '../groups/publicSummary'
import { gameUmpires } from './assignments'
import { assignedUmpireGames } from './presence'

describe('personal umpire presence on existing schedules', function () {
  this.timeout(60000)
  let f: GroupFixture
  before(async () => {
    f = await umpireFixture()
  })
  after(async () => {
    await f?.h.close()
  })
  const games = ['gam_umpire']
  it('never infers a personal assignment from guardian or administrator access', async () => {
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: games[0],
        slot: 'uty_plate:1',
        user_id: userIdOfGumbo(104),
        assigned_by: userIdOfGumbo(101)
      })
      .execute()
    expect([
      ...(await assignedUmpireGames(f.h.db, undefined, games))
    ]).deep.equals([])
    expect([
      ...(await assignedUmpireGames(f.h.db, actor(104), []))
    ]).deep.equals([])
    expect([
      ...(await assignedUmpireGames(f.h.db, actor(101), games))
    ]).deep.equals([])
    expect([
      ...(await assignedUmpireGames(f.h.db, actor(103), games))
    ]).deep.equals([])
    expect([
      ...(await assignedUmpireGames(f.h.db, actor(104), games))
    ]).deep.equals(games)
    expect([
      ...(await assignedUmpireGames(f.h.db, actor(104), ['missing']))
    ]).deep.equals([])
    for (const user of [101, 104]) {
      const response = await f.h.request(
        'GET',
        `/teams/${f.teamA}/games`,
        undefined,
        user
      )
      expect(response.status).equals(200)
      const rows = await response.json()
      expect(
        rows.find((g: { id: string }) => g.id === games[0]).isUmpire
      ).equals(user === 104)
      const published = await publicGames(
        f.h.db,
        { kind: 'team', id: f.teamA },
        actor(user)
      )
      expect(published.find(g => g.id === games[0])!.isUmpire).equals(
        user === 104
      )
    }
    expect(
      (await publicGames(f.h.db, { kind: 'team', id: f.teamA })).find(
        g => g.id === games[0]
      )!.isUmpire
    ).equals(false)
  })
  it('resolves old assignment ids and the canonical avatar, without changing assignments', async () => {
    await f.h.db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(103) })
      .where('id', '=', userIdOfGumbo(104))
      .execute()
    expect([
      ...(await assignedUmpireGames(f.h.db, actor(103), games))
    ]).deep.equals(games)
    expect((await gameUmpires(f.h.db, games[0]))!.positions[0].person).includes(
      { userId: userIdOfGumbo(103), avatarUrl: null }
    )
    await f.h.db
      .updateTable('users')
      .set({ avatar_path: 'images/fixture-avatar' })
      .where('id', '=', userIdOfGumbo(103))
      .execute()
    const response = await f.h.request(
      'GET',
      `/games/${games[0]}`,
      undefined,
      101
    )
    expect(response.status).equals(200)
    const detail = await response.json()
    expect(detail.umpires.positions[0].person.userId).equals(userIdOfGumbo(103))
    expect(detail.umpires.positions[0].person.avatarUrl).contains(
      'fixture-avatar'
    )
  })
  it('removes the marker for cancellations, withdrawal, disabled management and revoked assignments', async () => {
    for (const status of ['inProgress', 'final', 'scheduled'] as const) {
      await f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', games[0])
        .execute()
      expect(
        (await assignedUmpireGames(f.h.db, actor(103), games)).size
      ).equals(1)
    }
    await f.h.db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', games[0])
      .execute()
    expect((await assignedUmpireGames(f.h.db, actor(103), games)).size).equals(
      0
    )
    await f.h.db
      .updateTable('games')
      .set({ status: 'scheduled' })
      .where('id', '=', games[0])
      .execute()
    const assign = async (): Promise<void> => {
      await f.h.db
        .insertInto('umpire_assignments')
        .values({
          game_id: games[0],
          slot: 'uty_plate:1',
          user_id: userIdOfGumbo(103),
          assigned_by: userIdOfGumbo(101)
        })
        .execute()
    }
    await assign()
    await f.h.db
      .updateTable('games')
      .set({ withdrawn_at: new Date() })
      .where('id', '=', games[0])
      .execute()
    expect((await assignedUmpireGames(f.h.db, actor(103), games)).size).equals(
      0
    )
    await f.h.db
      .updateTable('games')
      .set({ withdrawn_at: null })
      .where('id', '=', games[0])
      .execute()
    await assign()
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: false })
      .where('id', '=', f.leagueA)
      .execute()
    expect((await assignedUmpireGames(f.h.db, actor(103), games)).size).equals(
      0
    )
    await f.h.db
      .updateTable('leagues')
      .set({ umpire_management: true })
      .where('id', '=', f.leagueA)
      .execute()
    await f.h.db
      .deleteFrom('umpire_assignments')
      .where('game_id', '=', games[0])
      .execute()
    expect((await assignedUmpireGames(f.h.db, actor(103), games)).size).equals(
      0
    )
  })
})
