import { expect } from 'chai'
import { it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { UMPIRE_TEST_NOW, umpireFixture } from '../../test/umpireFixture'
import { fixtureCounts } from '../../test/umpireTypes'
it('cleans every umpire client response and persists each management action', async function () {
  const previous = process.env.TS_UMPIRE_NOW
  process.env.TS_UMPIRE_NOW = UMPIRE_TEST_NOW
  const f = await umpireFixture()
  const client = new TeamStationClient({
    baseUrl: f.h.origin + '/api/v1',
    token: f.h.tokens.get(101)!
  })
  try {
    expect((await client.umpireSettings(f.leagueA)).management).equals(true)
    expect(
      (await client.setUmpireSettings(f.leagueA, { credits: false })).credits
    ).equals(false)
    const level = await client.addUmpireLevel(f.leagueA, 'minors')
    expect((await client.umpireLevels(f.leagueA)).length).equals(2)
    const seasons = await client.umpireRequirements(f.leagueA)
    expect(seasons.some(s => s.id === f.seasonA)).equals(true)
    await client.setUmpireRequirements(f.leagueA, {
      seasonIds: [f.seasonA],
      levelId: level.id,
      types: fixtureCounts(true, 2)
    })
    expect((await client.umpirePeople(f.leagueA)).length).equals(2)
    await client.umpirePeople(f.leagueA, 'Demo')
    await client.revokeUmpire(f.leagueA, userIdOfGumbo(104))
    await client.grantUmpire(f.leagueA, userIdOfGumbo(104))
    await client.certifyUmpire(f.leagueA, userIdOfGumbo(101), {
      levelId: level.id,
      typeId: 'uty_plate',
      enabled: true
    })
    expect((await client.umpireLeagues()).length).equals(1)
    expect((await client.umpireSchedule(f.leagueA)).games.length).equals(1)
    expect(
      (
        await client.umpireSchedule(
          f.leagueA,
          `days=0,4&levels=missing,${level.id}`
        )
      ).games
    ).length(1)
    await client.assignUmpire('gam_umpire', {
      slot: 'uty_plate:1',
      userId: userIdOfGumbo(101)
    })
    expect(
      (await client.umpireLeaderboard(f.leagueA)).scheduled[0].count
    ).equals(1)
    await client.removeUmpire('gam_umpire', 'uty_plate:1')
    await client.removeUmpireLevel(f.leagueA, level.id)
  } finally {
    await f.h.close()
    if (previous == null) delete process.env.TS_UMPIRE_NOW
    else process.env.TS_UMPIRE_NOW = previous
  }
})
