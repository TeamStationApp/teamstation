import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { gameUmpires } from './assignments'

describe('optional field umpire positions', function () {
  this.timeout(60000)
  let f: GroupFixture, old: string | undefined
  const person = userIdOfGumbo(103)
  const set = async (
    fieldCount: number,
    optionalFieldCount?: unknown,
    plate = true
  ): Promise<Response> =>
    await f.h.request(
      'PUT',
      `/leagues/${f.leagueA}/umpire-requirements`,
      {
        seasonIds: [f.seasonA],
        levelId: 'ulv_majors',
        types: [
          { typeId: 'uty_plate', required: plate ? 1 : 0, optional: 0 },
          {
            typeId: 'uty_field',
            required: fieldCount,
            optional: optionalFieldCount === undefined ? 0 : optionalFieldCount
          }
        ]
      },
      101
    )
  const schedule = async (filter = ''): Promise<any> =>
    await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-schedule?view=league${filter}`,
        undefined,
        101
      )
    ).json()
  before(async () => {
    old = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
    await f.h.db
      .insertInto('user_links')
      .values({
        id: 'lnk_optional',
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
        type_id: 'uty_field',
        enabled: true
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
    if (old == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = old
  })
  it('validates optional counts and explicitly replaces them', async () => {
    for (const n of [-1, 7, 1.5, '1', null])
      expect((await set(1, n)).status).equals(400)
    expect((await set(1, 2)).status).equals(200)
    expect((await set(2)).status).equals(200)
    const rows = await (
      await f.h.request(
        'GET',
        `/leagues/${f.leagueA}/umpire-requirements`,
        undefined,
        101
      )
    ).json()
    expect(rows.seasons.find((s: any) => s.id === f.seasonA).requirement)
      .property('types')
      .deep.equals([
        { typeId: 'uty_plate', required: 1, optional: 0 },
        { typeId: 'uty_field', required: 2, optional: 0 }
      ])
    await f.h.db
      .deleteFrom('season_umpire_requirements')
      .where('season_id', '=', f.seasonA)
      .execute()
    expect((await set(1)).status).equals(200)
    expect(
      (await schedule()).games[0].positions.every((p: any) => p.required)
    ).equals(true)
  })
  it('offers optional-only games without marking them as needing umpires', async () => {
    expect((await set(0, 1, false)).status).equals(200)
    const games = (await schedule()).games
    expect(games).length(1)
    expect(games[0].choices).has.property('uty_field:1')
    expect((await schedule('&levels=ulv_majors')).games).length(0)
    expect(
      (
        await f.h.request(
          'POST',
          '/games/gam_umpire/umpire-slots',
          { slot: 'uty_field:1', userId: person },
          103
        )
      ).status
    ).equals(200)
    const block = await gameUmpires(f.h.db, 'gam_umpire')
    expect(block!.positions).length(1)
    expect(block!.positions[0].required).equals(false)
    expect(block!.positions[0].person!.userId).equals(person)
  })
  it('keeps required needs distinct and retains valid assignments when counts shrink', async () => {
    expect((await set(1, 1, false)).status).equals(200)
    expect((await schedule('&levels=ulv_majors')).games).length(0)
    expect((await gameUmpires(f.h.db, 'gam_umpire'))!.positions).length(2)
    await f.h.db
      .insertInto('umpire_assignments')
      .values({
        game_id: 'gam_umpire',
        slot: 'uty_field:2',
        user_id: userIdOfGumbo(101),
        assigned_by: userIdOfGumbo(101)
      })
      .execute()
    expect((await set(1, 0, false)).status).equals(200)
    const rows = await f.h.db
      .selectFrom('umpire_assignments')
      .selectAll()
      .execute()
    expect(rows.map(r => r.slot)).deep.equals(['uty_field:1'])
    expect((await set(0, 0, false)).status).equals(200)
    expect(await gameUmpires(f.h.db, 'gam_umpire')).equals(null)
    expect((await schedule()).games).length(0)
  })
  it('accepts the twelfth field slot and enforces the same signup conflict and capacity rules', async () => {
    expect((await set(6, 6)).status).equals(200)
    expect(Object.keys((await schedule()).games[0].choices)).length(13)
    const body = { slot: 'uty_field:12', userId: person }
    expect(
      (await f.h.request('POST', '/games/gam_umpire/umpire-slots', body, 103))
        .status
    ).equals(200)
    expect(
      (await f.h.request('POST', '/games/gam_umpire/umpire-slots', body, 103))
        .status
    ).equals(409)
    expect(
      (
        await f.h.request(
          'POST',
          '/games/gam_umpire/umpire-slots',
          { ...body, slot: 'uty_field:13' },
          103
        )
      ).status
    ).equals(403)
    expect((await schedule('&levels=ulv_majors')).games).length(1)
    expect(
      (
        await f.h.request(
          'DELETE',
          '/games/gam_umpire/umpire-slots',
          { slot: 'uty_field:12' },
          103
        )
      ).status
    ).equals(200)
  })
})
