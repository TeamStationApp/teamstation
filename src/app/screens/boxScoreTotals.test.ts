import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asBattingRow, asPitchingRow } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { battingTotals, pitchingTotals } from './boxScoreTotals'

const batter = (
  id: number,
  line: { ab: number; h: number; r?: number; bb?: number; k?: number },
  seasonAvg: number | null = null
): ReturnType<typeof asBattingRow> =>
  asBattingRow({
    userId: userIdOfGumbo(id),
    shortName: `Batter ${id}`,
    teamId: 'away',
    pa: line.ab + (line.bb ?? 0),
    ab: line.ab,
    h: line.h,
    singles: line.h,
    doubles: 0,
    triples: 0,
    hr: id === 1 ? 1 : 0,
    bb: line.bb ?? 0,
    k: line.k ?? 0,
    r: line.r ?? 0,
    hbp: id === 2 ? 1 : 0,
    rbi: id,
    rates: {},
    seasonAvg
  })

const pitcher = (
  id: number,
  outs: number,
  ip: string
): ReturnType<typeof asPitchingRow> =>
  asPitchingRow({
    userId: userIdOfGumbo(id),
    teamId: 'home',
    ip,
    outs,
    bf: outs + 2,
    h: 1,
    hr: id === 10 ? 1 : 0,
    hbp: 0,
    r: id === 10 ? 2 : 0,
    er: id === 10 ? 1 : 0,
    bb: 1,
    k: outs - 1,
    rates: {}
  })

describe('box score totals arithmetic', function () {
  it('sums each batting count, and averages the summed hits over the summed at-bats', function () {
    const total = battingTotals([
      batter(1, { ab: 3, h: 2, r: 1, k: 1 }, 0.4),
      batter(2, { ab: 4, h: 1, bb: 1, k: 2 }, 0.1),
      batter(3, { ab: 2, h: 0, r: 1 }, 0.25)
    ])
    expect(total).deep.include({
      userId: null,
      teamId: 'away',
      ab: 9,
      h: 3,
      r: 2,
      rbi: 6,
      bb: 1,
      k: 3,
      hr: 1,
      hbp: 1,
      pa: 10
    })
    expect(total.seasonAvg).equals(3 / 9)
    // Not the mean of the season averages on the rows.
    expect(total.seasonAvg).not.equals((0.4 + 0.1 + 0.25) / 3)
  })

  it('adds nothing for a batter in the order who has not come to the plate', function () {
    // The empty line the box score draws for a batter yet to bat.
    const waiting = {
      ...batter(7, { ab: 0, h: 0 }),
      userId: null,
      hr: 0,
      rbi: 0
    }
    const total = battingTotals([batter(1, { ab: 3, h: 1 }), waiting])
    expect(total).deep.include({ ab: 3, h: 1, pa: 3, hr: 1, rbi: 1 })
    expect(total.seasonAvg).equals(1 / 3)
  })

  it('has no average with no at-bats', function () {
    const total = battingTotals([batter(4, { ab: 0, h: 0, bb: 2 })])
    expect(total.seasonAvg).equals(null)
    expect(total.bb).equals(2)
    expect(battingTotals([]).teamId).equals(null)
  })

  it('sums pitching counts and adds innings as outs', function () {
    const total = pitchingTotals([pitcher(10, 4, '1.1'), pitcher(11, 5, '1.2')])
    expect(total).deep.include({
      ip: '3.0',
      outs: 9,
      bf: 13,
      h: 2,
      r: 2,
      er: 1,
      bb: 2,
      k: 7,
      hr: 1,
      hbp: 0,
      teamId: 'home'
    })
    expect(pitchingTotals([pitcher(12, 7, '2.1')]).ip).equals('2.1')
    expect(pitchingTotals([]).ip).equals('0.0')
  })
})
