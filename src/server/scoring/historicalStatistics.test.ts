import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import { importedStatistics } from './historicalStatistics'

const game = {
  id: 'game',
  homeTeamId: 'home',
  awayTeamId: 'away',
  homeTeamName: 'Owls',
  awayTeamName: 'Herons'
}
const hitByPitch: GumboPlay = {
  about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
  result: { eventType: 'hit_by_pitch' },
  count: { outs: 0 },
  matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
  playEvents: [{ index: 0, isPitch: true, details: { call: { code: 'H' } } }],
  runners: [
    {
      movement: { start: null, end: '1B', isOut: false },
      details: { runner: { id: 1 }, eventType: 'hit_by_pitch' }
    }
  ]
}

describe('imported pitching hit-by-pitch counts', function () {
  it('counts an imported hit batter and preserves an unrecorded template pitcher’s known or unknown count', function () {
    const result = importedStatistics(game, [hitByPitch])
    expect(result.message).equals(null)
    expect(result.box!.home.pitching[0]).includes({ id: 11, hbp: 1, pc: 1 })
    const template = result.box!
    expect(
      importedStatistics(game, [], template).box!.home.pitching[0].hbp
    ).equals(1)
    template.home.pitching[0].hbp = null
    expect(
      importedStatistics(game, [], template).box!.home.pitching[0].hbp
    ).equals(null)
  })
})
