import { expect } from 'chai'
import { describe, it } from 'mocha'

import { emptyStatExtras } from '../../common/statExtras'
import { statsDatabase } from '../../test/statsDatabase'
import { bothPlayedTogether } from './playedTogether'

describe('co-appearance with expanded stat rows', function () {
  this.timeout(60000)
  const fixture = statsDatabase('together')
  it('retains the count fallback and direct event evidence', async function () {
    const { db, ids } = fixture
    await db
      .insertInto('game_player_stats')
      .values(
        ids.map((id, i) => ({
          id: `gps_${i}`,
          game_id: 'gam_demo',
          team_id: 'tem_home',
          user_id: id,
          pa: i === 0 ? 1 : 0,
          pitch_outs: i === 1 ? 1 : 0,
          extra: JSON.stringify({ ...emptyStatExtras(), appeared: true })
        }))
      )
      .execute()
    const together = await bothPlayedTogether(db, ids)
    expect(together.has(`${ids[0]}|${ids[1]}`)).equals(true)
    expect(together.has(`${ids[0]}|${ids[2]}`)).equals(false)
    await db
      .insertInto('events')
      .values({
        id: 'evt_demo',
        gameId: 'gam_demo',
        gumbo: JSON.stringify({
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: { batter: { id: ids[0] }, pitcher: { id: ids[2] } }
        })
      })
      .execute()
    expect(
      (await bothPlayedTogether(db, ids)).has(`${ids[0]}|${ids[2]}`)
    ).equals(true)
  })
})
