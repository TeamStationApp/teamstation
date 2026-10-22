import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asUmpireSchedule } from '../../common/umpireCleaners'
import { userIdOfGumbo } from '../../common/userId'
import type { GroupFixture } from '../../test/groupFixtures'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { parseUmpireFilters } from './schedule'

describe('umpire prior seasons filter', function () {
  this.timeout(60000)
  let f: GroupFixture
  let previous: string | undefined
  before(async () => {
    previous = process.env.TS_UMPIRE_NOW
    process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
    f = await umpireFixture()
  })
  after(async () => {
    await f?.h.close()
    if (previous == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = previous
  })
  const get = async (query = 'view=schedule', user = 101): Promise<Response> =>
    await f.h.request(
      'GET',
      `/leagues/${f.leagueA}/umpire-schedule?${query}`,
      undefined,
      user
    )
  it('validates boolean values and requires the explicit new view', async () => {
    expect(parseUmpireFilters({ priorSeasons: 'false' }).priorSeasons).equals(
      false
    )
    expect(parseUmpireFilters({ priorSeasons: 'true' }).priorSeasons).equals(
      true
    )
    for (const priorSeasons of ['1', '', true, ['true', 'false']])
      expect(() => parseUmpireFilters({ priorSeasons })).throws(
        'Supply one priorSeasons boolean'
      )
    expect((await get('priorSeasons=true')).status).equals(400)
    expect((await get('view=league&priorSeasons=false')).status).equals(400)
  })
  it('includes the season through its local ending day, and expands only for admins', async () => {
    const original = await f.h.db
      .selectFrom('seasons')
      .selectAll()
      .where('id', '=', f.seasonA)
      .executeTakeFirstOrThrow()
    try {
      await f.h.db
        .updateTable('seasons')
        .set({ ends_on: '2027-04-01', timezone: 'America/Los_Angeles' })
        .where('id', '=', f.seasonA)
        .execute()
      expect((await (await get()).json()).games).length(1)
      process.env.TS_UMPIRE_NOW = '2027-04-02T06:59:59Z'
      expect((await (await get()).json()).games).length(1)
      process.env.TS_UMPIRE_NOW = '2027-04-02T07:00:00Z'
      expect((await (await get()).json()).games).length(0)
      expect(
        (await (await get('view=schedule&priorSeasons=true')).json()).games
      ).length(1)
      expect(
        (
          await (
            await get('view=schedule&priorSeasons=true&levels=missing')
          ).json()
        ).games
      ).length(0)
      expect(
        (await (await get('view=schedule&priorSeasons=true&days=0')).json())
          .games
      ).length(0)
      expect(
        (
          await (
            await get(
              'view=schedule&priorSeasons=true&timezone=UTC&from=08:00&to=09:00'
            )
          ).json()
        ).games
      ).length(0)
      expect((await (await get('view=league')).json()).games).length(1)
      expect((await get('view=schedule&priorSeasons=true', 104)).status).equals(
        403
      )
      expect((await get('view=schedule', 104)).status).equals(200)
      expect((await get('view=schedule', 102)).status).equals(403)
    } finally {
      process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
      await f.h.db
        .updateTable('seasons')
        .set({ ends_on: original.ends_on, timezone: original.timezone })
        .where('id', '=', f.seasonA)
        .execute()
    }
  })
  it('admits an admin without an umpire role but preserves signup eligibility', async () => {
    await f.h.db
      .deleteFrom('league_umpires')
      .where('league_id', '=', f.leagueA)
      .where('user_id', '=', userIdOfGumbo(101))
      .execute()
    try {
      const response = await get()
      expect(response.status).equals(200)
      const body = await response.json()
      expect(asUmpireSchedule(body).view).equals('schedule')
      expect(body.games).length(1)
      expect(
        body.games[0].choices['uty_plate:1'].every(
          (c: { reason: string | null }) =>
            c.reason === 'outside your umpire schedule'
        )
      ).equals(true)
      expect((await get('view=umpire')).status).equals(403)
    } finally {
      await f.h.db
        .insertInto('league_umpires')
        .values({
          league_id: f.leagueA,
          user_id: userIdOfGumbo(101),
          granted_by: userIdOfGumbo(101)
        })
        .execute()
    }
  })
})
