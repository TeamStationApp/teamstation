import { expect } from 'chai'
import { describe, it } from 'mocha'

import { emptyStatExtras } from '../../common/statExtras'
import { statsDatabase } from '../../test/statsDatabase'
import { sampleBatter } from './demoStats'

describe('demo sample batter', function () {
  this.timeout(60000)
  const fixture = statsDatabase('demo')
  it('ignores pitchers who have never batted and selects a batter', async function () {
    const { db, ids } = fixture
    await db
      .insertInto('game_player_stats')
      .values({
        id: 'gps_pitcher',
        game_id: 'gam_demo',
        team_id: 'tem_home',
        gumbo_id: ids[0],
        extra: JSON.stringify({ ...emptyStatExtras(), appeared: true })
      })
      .execute()
    expect(await sampleBatter(db, 'tem_home')).equals(null)
    await db
      .insertInto('game_player_stats')
      .values({
        id: 'gps_batter',
        game_id: 'gam_demo',
        team_id: 'tem_home',
        gumbo_id: ids[1],
        pa: 2
      })
      .execute()
    expect(await sampleBatter(db, 'tem_home')).equals(ids[1])
  })
})
