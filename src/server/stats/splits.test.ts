import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type SplitCounts, splitRates } from './splits'

const empty: SplitCounts = {
  games: 0,
  pa: 0,
  ab: 0,
  h: 0,
  singles: 0,
  doubles: 0,
  triples: 0,
  hr: 0,
  bb: 0,
  k: 0,
  hbp: 0,
  ci: 0,
  sf: 0,
  sh: 0,
  rbi: 0,
  outsMade: 0,
  pitches: 0,
  pitchedPa: 0,
  firstPitchKnown: 0,
  firstPitchBalls: 0,
  firstPitchStrikes: 0,
  firstPitchInPlay: 0
}
describe('split statistic rates', function () {
  it('keeps rates independent of unavailable called-strikeout detail', function () {
    expect(
      splitRates({
        ...empty,
        games: 1,
        pa: 5,
        ab: 4,
        h: 2,
        singles: 1,
        doubles: 1,
        bb: 1,
        k: 1,
        outsMade: 6,
        pitches: 20,
        pitchedPa: 5,
        firstPitchKnown: 5,
        firstPitchBalls: 2,
        firstPitchStrikes: 2,
        firstPitchInPlay: 1
      })
    ).deep.equals({
      avg: 0.5,
      obp: 0.6,
      slg: 0.75,
      ops: 1.35,
      kRate: 0.2,
      bbRate: 0.2,
      ip: '2.0',
      whip: 1.5,
      firstPitchStrikeRate: 0.6,
      firstPitchBallRate: 0.4,
      pitchesPerPa: 4
    })
    expect(splitRates(empty)).deep.equals({
      avg: null,
      obp: null,
      slg: null,
      ops: null,
      kRate: null,
      bbRate: null,
      ip: '0.0',
      whip: null,
      firstPitchStrikeRate: null,
      firstPitchBallRate: null,
      pitchesPerPa: null
    })
  })
})
