import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { fixtureCounts } from '../../test/umpireTypes'

describe('league-defined umpire types', function () {
  this.timeout(60000)
  let f: GroupFixture, client: TeamStationClient, clock: string | undefined
  beforeEach(async () => {
    clock = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    client = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
  })
  afterEach(async () => {
    await f?.h.close()
    if (clock == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = clock
  })
  it('creates arbitrary types, defaults configured seasons and preserves unconfigured seasons', async () => {
    const t = await client.addUmpireType(f.leagueA, '  1st  ')
    expect(t.name).equals('1st')
    expect(t.inUse).equals(true)
    expect((await client.umpireTypes(f.leagueA)).map(t => t.name)).deep.equals([
      'Plate',
      'Field',
      '1st'
    ])
    const seasons = await client.umpireRequirements(f.leagueA)
    expect(
      seasons.find(s => s.id === f.seasonA)!.requirement!.types
    ).deep.include({ typeId: t.id, required: 1, optional: 0 })
    expect(
      seasons.filter(s => s.id !== f.seasonA).every(s => s.requirement === null)
    ).equals(true)
    for (const name of ['', ' ', '1ST', 'x'.repeat(101), null])
      expect(
        (
          await f.h.request(
            'POST',
            `/leagues/${f.leagueA}/umpire-types`,
            { name },
            101
          )
        ).status
      ).equals(400)
    expect(
      (
        await f.h.request(
          'GET',
          `/leagues/${f.leagueA}/umpire-types`,
          undefined,
          103
        )
      ).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/leagues/${f.leagueB}/umpire-types/${t.id}`,
          undefined,
          102
        )
      ).status
    ).equals(404)
    await client.removeUmpireType(f.leagueA, t.id)
    expect((await client.umpireTypes(f.leagueA)).length).equals(2)
  })
  it('checks pairwise permissions, rejects stale catalogs, and deletes only the selected type dependencies', async () => {
    const t = await client.addUmpireType(f.leagueA, 'Third base')
    const payload = {
      seasonIds: [f.seasonA],
      levelId: 'ulv_majors',
      types: fixtureCounts(true, 1)
    }
    expect(
      (
        await f.h.request(
          'PUT',
          `/leagues/${f.leagueA}/umpire-requirements`,
          payload,
          101
        )
      ).status
    ).equals(409)
    payload.types.push({ typeId: t.id, required: 2, optional: 1 })
    await client.setUmpireRequirements(f.leagueA, payload)
    let game = (await client.umpireSchedule(f.leagueA)).games[0]
    expect(
      game.positions.filter(p => p.typeId === t.id).map(p => p.required)
    ).deep.equals([true, true, false])
    expect(game.choices[t.id + ':1'][0].reason).equals(
      'not certified for Third base'
    )
    await client.certifyUmpire(f.leagueA, userIdOfGumbo(101), {
      levelId: 'ulv_majors',
      typeId: t.id,
      enabled: true
    })
    game = (await client.umpireSchedule(f.leagueA)).games[0]
    expect(game.choices[t.id + ':1'][0].reason).equals(null)
    await client.assignUmpire(game.id, {
      slot: t.id + ':3',
      userId: userIdOfGumbo(101)
    })
    await client.removeUmpireType(f.leagueA, t.id)
    expect((await client.umpireSchedule(f.leagueA)).games[0].positions).length(
      2
    )
    expect(
      await f.h.db.selectFrom('umpire_assignments').selectAll().execute()
    ).length(0)
    expect(
      (await client.umpirePeople(f.leagueA))[0].certifications.some(
        c => c.typeId === t.id
      )
    ).equals(false)
    expect(
      (
        await f.h.request(
          'DELETE',
          `/leagues/${f.leagueA}/umpire-types/${t.id}`,
          undefined,
          101
        )
      ).status
    ).equals(404)
    expect(
      (
        await f.h.request(
          'PUT',
          `/leagues/${f.leagueA}/umpire-requirements`,
          payload,
          101
        )
      ).status
    ).equals(409)
  })
  it('supports an empty catalog and rejects duplicate or malformed matrix counts', async () => {
    await client.removeUmpireType(f.leagueA, 'uty_plate')
    await client.removeUmpireType(f.leagueA, 'uty_field')
    expect(await client.umpireTypes(f.leagueA)).deep.equals([])
    await f.h.db.deleteFrom('season_umpire_requirements').execute()
    const t = await client.addUmpireType(f.leagueA, 'Ump')
    expect(t.inUse).equals(false)
    for (const types of [
      [null],
      [{ typeId: t.id, required: 7, optional: 0 }],
      [
        { typeId: t.id, required: 1, optional: 0 },
        { typeId: t.id, required: 1, optional: 0 }
      ]
    ])
      expect(
        (
          await f.h.request(
            'PUT',
            `/leagues/${f.leagueA}/umpire-requirements`,
            { seasonIds: [f.seasonA], levelId: 'ulv_majors', types },
            101
          )
        ).status
      ).equals(400)
  })
})
