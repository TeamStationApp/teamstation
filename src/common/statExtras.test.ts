import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  addStatCount,
  asStatCount,
  asStatExtras,
  emptyStatExtras
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
