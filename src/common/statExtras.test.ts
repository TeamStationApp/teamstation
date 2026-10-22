import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  addStatCount,
  asStatCount,
  asStatExtras,
  emptyStatExtras,
  inningsPitched
} from './statExtras'

describe('expanded statistic details', function () {
  it('retains complete counts and cleans absent detail as unknown', function () {
    const extra = emptyStatExtras()
    expect(asStatExtras(extra)).deep.equals(extra)
    expect(asStatExtras({}).pitches).equals(null)
    expect(asStatCount(0)).equals(0)
    for (const value of [-1, 0.5, NaN, Infinity, '1'])
      expect(() => asStatCount(value)).throws()
  })
  it('propagates unknown totals', function () {
    expect(addStatCount(2, 3)).equals(5)
    expect(addStatCount(null, 3)).equals(null)
    expect(addStatCount(2, undefined)).equals(null)
  })
})

describe('innings pitched', function () {
  it('writes innings the way a box score does', function () {
    expect(inningsPitched(0)).equals('0.0')
    expect(inningsPitched(5)).equals('1.2')
    expect(inningsPitched(18)).equals('6.0')
  })
})
