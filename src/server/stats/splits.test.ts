import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type SplitCounts, splitRates } from './splits'

describe('split rates with unavailable detailed pitch counts', function () {
  const counts: SplitCounts = {
    games: 1,
    pa: 5,
    ab: 4,
    h: 2,
    singles: 1,
    doubles: 1,
    triples: 0,
    hr: 0,
    bb: 1,
    k: 1,
    hbp: 0,
    ci: 0,
    sf: 0,
    sh: 0,
    rbi: 1,
    outsMade: 3,
    pitches: 20,
    pitchedPa: 5,
    firstPitchKnown: 5,
    firstPitchBalls: 2,
    firstPitchStrikes: 2,
    firstPitchInPlay: 1
  }
  it('preserves batting and pitching rates without inventing strike details', function () {
    const rates = splitRates(counts)
    expect(rates).includes({
      avg: 0.5,
      obp: 0.6,
      slg: 0.75,
      ops: 1.35,
      ip: '1.0',
      whip: 3,
      kRate: 0.2,
      bbRate: 0.2,
      firstPitchStrikeRate: 0.6,
      firstPitchBallRate: 0.4,
      pitchesPerPa: 4
    })
  })
  it('keeps rates unknown when there were no opportunities', function () {
    const empty = Object.fromEntries(
      Object.keys(counts).map(key => [key, 0])
    ) as unknown as SplitCounts
    expect(splitRates(empty)).includes({
      avg: null,
      obp: null,
      slg: null,
      ops: null,
      whip: null,
      kRate: null,
      bbRate: null,
      firstPitchStrikeRate: null,
      firstPitchBallRate: null,
      pitchesPerPa: null
    })
  })
})
