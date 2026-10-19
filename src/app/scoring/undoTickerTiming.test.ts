import { expect } from 'chai'
import { describe, it } from 'mocha'

import { undoTickerTiming } from './undoTickerTiming'

describe('undo ticker timing', () => {
  it('keeps fitted, unmeasured and nonfinite text still', () => {
    for (const [width, content] of [
      [0, 200],
      [-1, 200],
      [100, 100],
      [100, 101],
      [200, 100],
      [NaN, 200],
      [100, Infinity]
    ])
      expect(undoTickerTiming(width, content)).equals(undefined)
  })
  it('moves at a steady reading pace and holds the full end for two seconds', () => {
    const short = undoTickerTiming(120, 240)!
    const long = undoTickerTiming(120, 360)!
    expect(short.distance).equals(120)
    expect(short.duration).equals(5000)
    expect(long.duration).equals(short.duration * 2)
    expect(short.endPause).equals(2000)
    expect(short.startPause).equals(1000)
  })
})
