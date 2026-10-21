import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  fromAnchors,
  fromFragments,
  fromMedia,
  fromStart,
  fromStartDate
} from './wallMapping'

const T0 = Date.parse('2026-10-19T18:00:00Z')

describe('one player’s mapping onto the wall clock (U20)', function () {
  // Four-second fragments, then a discontinuity: the next is dated 34 s on.
  const fragments = [
    { start: 0, duration: 4, programDateTime: T0 },
    { start: 4, duration: 4, programDateTime: T0 + 4000 },
    { start: 8, duration: 4, programDateTime: T0 + 8000 + 34_000 },
    { start: 12, duration: 4, programDateTime: T0 + 12_000 + 34_000 }
  ]

  it('maps fragment by fragment, one second a second inside each, across a gap', function () {
    const mapping = fromFragments(fragments)
    expect(mapping.source).equals('pdt')
    expect(mapping.wallAt(2)).equals(T0 + 2000)
    expect(mapping.wallAt(7.5)).equals(T0 + 7500)
    expect(mapping.wallAt(8)).equals(T0 + 42_000)
    expect(mapping.wallAt(10)).equals(T0 + 44_000)
    // And back again, exactly.
    for (const sec of [0, 3.25, 4, 8, 11.5, 15])
      expect(mapping.secAt(mapping.wallAt(sec)!)).closeTo(sec, 1e-9)
    // A wall time in the gap is the first picture after it.
    expect(mapping.secAt(T0 + 20_000)).equals(8)
    // Past the newest fragment, on from it; before the first, back from it.
    expect(mapping.wallAt(20)).equals(T0 + 54_000)
    expect(mapping.secAt(T0 - 1000)).equals(-1)
    expect(mapping.newestWall()).equals(T0 + 50_000)
    // Out of order is the same mapping.
    expect(fromFragments([...fragments].reverse()).wallAt(10)).equals(
      T0 + 44_000
    )
    const empty = fromFragments([])
    expect(empty.wallAt(1)).equals(null)
    expect(empty.secAt(T0)).equals(null)
    expect(empty.newestWall()).equals(null)
  })

  it('maps Safari’s start date, and reads its seekable end each time', function () {
    let end: number | null = null
    const mapping = fromStartDate(T0, () => end)
    expect(mapping.wallAt(30)).equals(T0 + 30_000)
    expect(mapping.secAt(T0 + 30_000)).equals(30)
    expect(mapping.newestWall()).equals(null)
    end = 60
    expect(mapping.newestWall()).equals(T0 + 60_000)
  })

  it('maps the server’s wall timeline, with its inverse and the media past it', function () {
    let end: number | null = null
    const mapping = fromAnchors(
      [
        [0, T0],
        [10_000, T0 + 44_000]
      ],
      () => end
    )
    expect(mapping.source).equals('timeline')
    expect(mapping.wallAt(12)).equals(T0 + 46_000)
    expect(mapping.secAt(T0 + 46_000)).equals(12)
    expect(mapping.newestWall()).equals(T0 + 44_000)
    end = 30
    expect(mapping.newestWall()).equals(T0 + 64_000)
    expect(fromAnchors([]).newestWall()).equals(null)
    expect(fromAnchors([]).secAt(T0)).equals(null)
  })

  it('maps a start time and its sync offset, and a lone recording’s own media time', function () {
    let end: number | null = null
    const video = {
      startAt: new Date(T0).toISOString(),
      syncOffsetSec: 2,
      durationSec: 600
    }
    const start = fromStart(video, () => end)
    expect(start.source).equals('start')
    expect(start.wallAt(12)).equals(T0 + 10_000)
    expect(start.secAt(T0 + 10_000)).equals(12)
    expect(start.newestWall()).equals(null)
    end = 62
    expect(start.newestWall()).equals(T0 + 60_000)
    const none = fromStart({ startAt: null, syncOffsetSec: 0, durationSec: 1 })
    expect(none.wallAt(1)).equals(null)
    expect(none.secAt(1)).equals(null)
    expect(none.newestWall()).equals(null)
    const bad = fromStart({
      startAt: 'nonsense',
      syncOffsetSec: 0,
      durationSec: 1
    })
    expect(bad.wallAt(1)).equals(null)

    const media = fromMedia(() => end)
    expect(media.wallAt(5)).equals(5000)
    expect(media.secAt(5000)).equals(5)
    expect(media.newestWall()).equals(62_000)
    expect(fromMedia().newestWall()).equals(null)
  })
})
