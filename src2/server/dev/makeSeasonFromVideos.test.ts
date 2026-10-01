import { expect } from 'chai'
import { describe, it } from 'mocha'

import { readTitle } from './makeSeasonFromVideos'

describe('reading a season out of video titles', function () {
  it('takes the day and the opponent from a main recording', function () {
    expect(
      readTitle('2025-10-26 Seagulls vs Cedar Lakes', 'Seagulls')
    ).deep.equals({
      day: '2025-10-26',
      opponent: 'Cedar Lakes',
      composite: false
    })
  })

  it('marks the raw and combined recordings as composites', function () {
    for (const title of [
      '2025-10-26 Seagulls vs Cedar Lakes - Raw Videos',
      '2025-10-26 Seagulls vs Cedar Lakes raw',
      '2025-10-26 Seagulls vs Cedar Lakes Combined'
    ]) {
      expect(readTitle(title, 'Seagulls'), title).deep.equals({
        day: '2025-10-26',
        opponent: 'Cedar Lakes',
        composite: true
      })
    }
  })

  it("reads past a league's name and a dotted vs", function () {
    expect(
      readTitle('2025-11-02-QPLL Seagulls vs. Cyclones', 'Seagulls')
    ).deep.equals({ day: '2025-11-02', opponent: 'Cyclones', composite: false })
  })

  it('reads nothing from a title with no date or no game', function () {
    expect(readTitle('Seagulls vs Cedar Lakes', 'Seagulls')).equals(null)
    expect(readTitle('2025-10-26 Practice', 'Seagulls')).equals(null)
    expect(readTitle('2025-10-26 Hawks vs Cedar Lakes', 'Seagulls')).equals(
      null
    )
  })
})
