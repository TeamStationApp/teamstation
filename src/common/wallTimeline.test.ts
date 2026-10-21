import { expect } from 'chai'
import { describe, it } from 'mocha'

import { mediaAt, type WallAnchor, wallAt } from './wallTimeline'

describe('the wall time of a position in a video (U21)', function () {
  const T0 = 1_791_800_000_000
  // A stream that ran 60 s, dropped out for 20 s and came back: media time
  // carries on from 60 s while the wall clock has moved on 80 s.
  const anchors: WallAnchor[] = [
    [0, T0],
    [500, T0 + 500],
    [60_000, T0 + 80_000]
  ]

  it('is the anchor itself on an anchor', function () {
    expect(wallAt(anchors, 0)).equals(T0)
    expect(wallAt(anchors, 60_000)).equals(T0 + 80_000)
  })

  it('runs at 1× from the last anchor at or before it', function () {
    expect(wallAt(anchors, 250)).equals(T0 + 250)
    expect(wallAt(anchors, 59_999)).equals(T0 + 59_999)
  })

  it('jumps across the outage at the anchor after it', function () {
    expect(wallAt(anchors, 60_001)).equals(T0 + 80_001)
    expect(wallAt(anchors, 90_000)).equals(T0 + 110_000)
    expect(wallAt(anchors, 60_000)! - wallAt(anchors, 59_999)!).equals(20_001)
  })

  it('runs back from the first anchor before it', function () {
    expect(wallAt([[2_000, T0]], 500)).equals(T0 - 1_500)
  })

  it('has nothing to say without an anchor', function () {
    expect(wallAt([], 1_000)).equals(null)
  })

  it('finds its anchor among many', function () {
    const many: WallAnchor[] = Array.from({ length: 10_000 }, (_, i) => [
      i * 500,
      T0 + i * 500 + (i >= 5_000 ? 20_000 : 0)
    ])
    expect(wallAt(many, 2_499_999)).equals(T0 + 2_499_999)
    expect(wallAt(many, 2_500_000)).equals(T0 + 2_520_000)
    expect(wallAt(many, 10_000_000)).equals(T0 + 10_020_000)
  })
})

describe('the position in a video of a wall time, the inverse (U20)', function () {
  // Ten seconds from the wall's 1000, then a 34 s gap, then on.
  const anchors: WallAnchor[] = [
    [0, 1000],
    [10_000, 45_000]
  ]

  it('inverts wallAt inside each stretch', function () {
    for (const ms of [0, 2500, 9999, 10_000, 30_000])
      expect(mediaAt(anchors, wallAt(anchors, ms)!)).equals(ms)
  })

  it('puts a wall time in the gap at the first picture after it, and extrapolates outside', function () {
    expect(mediaAt(anchors, 20_000)).equals(10_000)
    expect(mediaAt(anchors, 500)).equals(-500)
    expect(mediaAt([], 500)).equals(null)
  })
})
