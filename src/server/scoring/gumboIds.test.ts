import { expect } from 'chai'
import { beforeEach, describe, it } from 'mocha'

import type { LineupPerson } from '../../common/scoring/lineupHistory'
import { userIdOfGumbo } from '../../common/userId'
import { statsDatabase } from '../../test/statsDatabase'
import {
  findDuplicatePeople,
  findSamePersonAcrossTeams
} from '../admin/duplicatePeople'
import { UnresolvedAccount } from '../admin/people'
import { creditsForPlayer } from '../events/credits'
import { resolvedDefaultOf } from '../events/teamLineups'
import { gameAvailability } from '../games/rosterAvailability'
import { statRows } from '../stats/rows'
import { levelPeople } from '../teams/teamRoster'
import { gumboIdsOfUsers, resolveGumboIds, scoringUsers } from './gumboIds'

describe('independent account and scoring identities', function () {
  this.timeout(60000)
  const fixture = statsDatabase('gumbo_mapping')
  const scoring = [101, 102, 103]
  beforeEach(async () => {
    const { db, ids } = fixture
    await db.deleteFrom('game_player_stats').execute()
    await db.updateTable('users').set({ merged_into: null }).execute()
    await db.deleteFrom('gumbo_ids').execute()
    await db
      .insertInto('gumbo_ids')
      .values(
        ids.map((userId, i) => ({
          user_id: userIdOfGumbo(userId),
          gumbo_id: scoring[i]
        }))
      )
      .execute()
  })
  const refuses = async (
    read: Promise<unknown>,
    message: string
  ): Promise<void> => {
    let error: unknown
    try {
      await read
    } catch (caught) {
      error = caught
    }
    expect(error).instanceOf(UnresolvedAccount)
    expect(String(error)).includes(message)
  }
  it('maps historical scoring IDs through a chain without rewriting original mappings', async () => {
    const { db, ids } = fixture
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(ids[1]) })
      .where('id', '=', userIdOfGumbo(ids[0]))
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(ids[2]) })
      .where('id', '=', userIdOfGumbo(ids[1]))
      .execute()
    expect([...(await scoringUsers(db, [101, 102, 101]))]).deep.equals([
      [101, userIdOfGumbo(ids[2])],
      [102, userIdOfGumbo(ids[2])]
    ])
    expect([...(await resolveGumboIds(db, [101, 102, 103]))]).deep.equals([
      [101, 103],
      [102, 103],
      [103, 103]
    ])
    expect(
      (
        await gumboIdsOfUsers(db, [
          userIdOfGumbo(ids[0]),
          userIdOfGumbo(ids[1])
        ])
      ).sort((a, b) => a - b)
    ).deep.equals([101, 102])
    expect(
      (
        await db
          .selectFrom('gumbo_ids')
          .selectAll()
          .where('gumbo_id', '=', 101)
          .executeTakeFirstOrThrow()
      ).user_id
    ).equals(userIdOfGumbo(ids[0]))
  })
  it('resolves saved lineup positions through merges without rewriting or collapsing historical turns', async () => {
    const { db, ids } = fixture
    const person = (gumboId: number | null): LineupPerson => ({
      gumboId,
      name: 'Player',
      jersey: ''
    })
    const original = {
      lineup: {
        batters: [person(101), person(102)],
        defense: {
          P: person(101),
          C: person(null),
          '1B': null,
          '2B': null,
          SS: null,
          '3B': null,
          LF: null,
          CF: null,
          RF: null
        }
      },
      fromGameId: 'gam_demo',
      setAt: '2026-01-01T00:00:00Z'
    }
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(ids[1]) })
      .where('id', '=', userIdOfGumbo(ids[0]))
      .execute()
    const resolved = await resolvedDefaultOf(db, original)
    expect(resolved?.lineup?.batters.map(row => row.gumboId)).deep.equals([
      102, 102
    ])
    expect(resolved?.lineup?.defense.P?.gumboId).equals(102)
    expect(resolved?.lineup?.defense.C?.gumboId).equals(null)
    expect(original.lineup.batters[0].gumboId).equals(101)
    expect(await resolvedDefaultOf(db, null)).equals(null)
    expect(await resolvedDefaultOf(db, {})).equals(null)
  })
  it('does not allocate on empty reads or missing original and survivor mappings', async () => {
    const { db, ids } = fixture
    expect([...(await resolveGumboIds(db, []))]).deep.equals([])
    expect(await gumboIdsOfUsers(db, [])).deep.equals([])
    await refuses(resolveGumboIds(db, [999]), 'Missing original')
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(ids[1]) })
      .where('id', '=', userIdOfGumbo(ids[0]))
      .execute()
    await db
      .deleteFrom('gumbo_ids')
      .where('user_id', '=', userIdOfGumbo(ids[1]))
      .execute()
    await refuses(resolveGumboIds(db, [101]), 'Missing surviving')
    expect(await gumboIdsOfUsers(db, [userIdOfGumbo(ids[1])])).deep.equals([])
    expect((await creditsForPlayer(db, userIdOfGumbo(ids[1]))).size).equals(0)
    expect(
      await db.selectFrom('gumbo_ids').select('gumbo_id').execute()
    ).length(2)
  })
  it('refuses merge cycles instead of guessing an account', async () => {
    const { db, ids } = fixture
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(ids[1]) })
      .where('id', '=', userIdOfGumbo(ids[0]))
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: userIdOfGumbo(ids[0]) })
      .where('id', '=', userIdOfGumbo(ids[1]))
      .execute()
    await refuses(scoringUsers(db, [101]), 'Cyclic account merge')
  })
  it('keeps scoring history attached to accounts in duplicate and parent-roster readers', async () => {
    const { db, ids } = fixture
    await db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
      .execute()
    await db
      .insertInto('season_team_parents')
      .values({ season_id: 'sea_demo', team_id: 'tem_away' })
      .execute()
    await db
      .insertInto('memberships')
      .values(
        ids.slice(0, 2).map((userId, i) => ({
          id: `mem_mapping_${i}`,
          team_id: 'tem_away',
          user_id: userIdOfGumbo(userId),
          is_player: true
        }))
      )
      .execute()
    await db
      .updateTable('users')
      .set({
        first_name: 'Hank',
        last_name: 'Aaron',
        display_name: 'Hank Aaron'
      })
      .where('id', 'in', ids.slice(0, 2).map(userIdOfGumbo))
      .execute()
    await db
      .updateTable('users')
      .set({ last_name: '', display_name: 'Hank' })
      .where('id', '=', userIdOfGumbo(ids[1]))
      .execute()
    await db
      .insertInto('events')
      .values({
        id: 'evt_mapping',
        gameId: 'gam_demo',
        gumbo: { about: { atBatIndex: 0 }, matchup: { batter: { id: 101 } } }
      })
      .execute()
    const duplicates = await findDuplicatePeople(db)
    expect(duplicates.pairs).length(1)
    expect(duplicates.pairs[0]).includes({
      keepUserId: userIdOfGumbo(ids[0]),
      keepPlays: 1,
      otherUserId: userIdOfGumbo(ids[1]),
      otherPlays: 0
    })
    await db
      .updateTable('users')
      .set({ last_name: 'Aaron' })
      .where('id', '=', userIdOfGumbo(ids[1]))
      .execute()
    const same = await findSamePersonAcrossTeams(db)
    expect(same).length(1)
    expect(same[0].keepUserId).equals(userIdOfGumbo(ids[0]))
    expect(
      same[0].members.find(row => row.userId === userIdOfGumbo(ids[0]))?.plays
    ).equals(1)
    const roster = await levelPeople(db, undefined, {
      kind: 'season',
      id: 'sea_demo'
    })
    expect(
      roster?.find(row => row.userId === userIdOfGumbo(ids[0]))?.gumboId
    ).equals(101)
    expect(
      roster?.find(row => row.userId === userIdOfGumbo(ids[1]))?.gumboId
    ).equals(102)
  })

  it('returns account IDs in stats and guest profiles while keeping availability numeric', async () => {
    const { db, ids } = fixture
    await db
      .insertInto('game_player_stats')
      .values({
        id: 'gps_mapping',
        game_id: 'gam_demo',
        gumbo_id: 101,
        team_id: 'tem_away',
        pa: 1,
        h: 1
      })
      .execute()
    const rows = await statRows(db, { userId: userIdOfGumbo(ids[0]) })
    expect(rows).length(1)
    expect(rows[0]).includes({ userId: userIdOfGumbo(ids[0]), pa: 1, h: 1 })
    expect(await statRows(db, { userId: userIdOfGumbo(101) })).length(0)
    const available = await gameAvailability(db, {
      id: 'gam_demo',
      home_team_id: 'tem_home',
      away_team_id: 'tem_away',
      guests: { away: [101], home: [] },
      unrostered: { away: [101], home: [] },
      currentPlay: null
    })
    expect(available.guests.away).deep.equals([101])
    expect(available.unrostered.away).deep.equals([101])
    expect(available.guestPlayers.away[0]).includes({
      userId: userIdOfGumbo(ids[0]),
      gumboId: 101
    })
  })
})
