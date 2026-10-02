import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  battingLines,
  battingRates,
  inningsPitched,
  pitchingLines,
  pitchingRates,
  type StatRow
} from './stats'

const ROBIN = 1
const SAM = 2
const TEAM = 'tem_one'

/** One game's stored line, with only the figures a test is about. */
function game(over: Partial<StatRow> = {}): StatRow {
  return {
    userId: ROBIN,
    teamId: TEAM,
    pa: 0,
    ab: 0,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    r: 0,
    rbi: 0,
    hbp: 0,
    ci: 0,
    sf: 0,
    sh: 0,
    sb: 0,
    cs: 0,
    pitchBf: 0,
    pitchOuts: 0,
    pitchH: 0,
    pitchHr: 0,
    pitchBb: 0,
    pitchHbp: 0,
    pitchK: 0,
    pitchR: 0,
    pitchEr: 0,
    eraInnings: 6,
    ...over
  }
}

describe('stats', function () {
  it('adds a player’s games together', function () {
    const [line] = battingLines([
      game({ pa: 4, ab: 3, h: 2, bb: 1, rbi: 2 }),
      game({ pa: 3, ab: 3, h: 1, k: 2 })
    ])
    expect(line.g).equals(2)
    expect(line.pa).equals(7)
    expect(line.ab).equals(6)
    expect(line.h).equals(3)
    expect(line.bb).equals(1)
    expect(line.k).equals(2)
    expect(line.rbi).equals(2)
  })

  it('leaves out somebody who never came to bat or ran', function () {
    expect(battingLines([game({ pitchOuts: 9, pitchBf: 12 })])).deep.equals([])
  })

  it('keeps a runner who scored but never batted', function () {
    // A pinch runner has no plate appearance and a run all the same.
    const [line] = battingLines([game({ r: 1 })])
    expect(line.r).equals(1)
  })

  it('keeps players apart, and sorts by who batted most', function () {
    const lines = battingLines([game({ pa: 2 }), game({ userId: SAM, pa: 1 })])
    expect(lines.map(line => line.userId)).deep.equals([ROBIN, SAM])
  })

  it('drops the team when a total spans two of them', function () {
    const [line] = battingLines([
      game({ pa: 1 }),
      game({ teamId: 'tem_two', pa: 1 })
    ])
    expect(line.teamId).equals(null)
  })

  it('works out the usual rates from the counts', function () {
    const [line] = battingLines([
      game({ pa: 5, ab: 4, h: 2, singles: 1, doubles: 1, bb: 1 })
    ])
    const rates = battingRates(line)
    expect(rates.avg).equals(0.5)
    // Three total bases over four at-bats.
    expect(rates.slg).equals(0.75)
    // Three times on base out of five chances.
    expect(rates.obp).equals(0.6)
    expect(rates.ops).equals(1.35)
  })

  it('counts a sacrifice against an on-base percentage', function () {
    const [line] = battingLines([game({ pa: 2, ab: 1, h: 1, sf: 1 })])
    expect(battingRates(line).obp).equals(0.5)
  })

  it('gives a walk an on-base percentage but still no average', function () {
    const [line] = battingLines([game({ pa: 1, bb: 1 })])
    const rates = battingRates(line)
    // Not zero: no at-bats is not the same as batting .000.
    expect(rates.avg).equals(undefined)
    expect(rates.obp).equals(1)
  })

  it('adds a pitcher’s games together, most work first', function () {
    const lines = pitchingLines([
      game({ pitchBf: 10, pitchOuts: 6, pitchEr: 1, pitchR: 2, pitchH: 3 }),
      game({ userId: SAM, pitchBf: 4, pitchOuts: 3 })
    ])
    expect(lines.map(line => line.userId)).deep.equals([ROBIN, SAM])
    expect(lines[0].outs).equals(6)
    expect(lines[0].er).equals(1)
    expect(lines[0].r).equals(2)
  })

  it('divides an ERA by the innings a game here runs', function () {
    // Six innings, not nine: two earned runs in three innings is 4.00 in this
    // league and 6.00 in the majors, and the published figures divide by six.
    const [line] = pitchingLines([
      game({
        pitchOuts: 9,
        pitchEr: 2,
        pitchH: 4,
        pitchBb: 2,
        eraInnings: 6
      })
    ])
    expect(pitchingRates(line).era).equals(4)
    expect(pitchingRates(line).whip).equals(2)
  })

  it('has no ERA for a pitcher who got nobody out', function () {
    const [line] = pitchingLines([game({ pitchBf: 2, pitchEr: 2 })])
    expect(pitchingRates(line).era).equals(undefined)
  })

  it('weights the divisor by the innings thrown under it', function () {
    // Three innings in a six-inning league and three in a nine-inning one: the
    // divisor lands between them rather than on whichever came last.
    const [line] = pitchingLines([
      game({ pitchOuts: 9, pitchEr: 1, eraInnings: 6 }),
      game({ pitchOuts: 9, pitchEr: 1, eraInnings: 9 })
    ])
    expect(line.eraInnings).equals(7.5)
    expect(pitchingRates(line).era).equals(2.5)
  })

  it('writes innings the way a box score does', function () {
    expect(inningsPitched(0)).equals('0.0')
    expect(inningsPitched(5)).equals('1.2')
    expect(inningsPitched(18)).equals('6.0')
  })
})
