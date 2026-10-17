import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { BoardStep } from '../../../common/api'
import { SAMPLE_SCOREBOARD } from '../../../common/scoreboard'
import type { WallTimeline } from '../../../common/wallTimeline'
import { boardAt, mergeSteps } from './boardAt'
import {
  angleWallMs,
  appendPoll,
  pollAfter,
  timeFrame,
  wallAt,
  windowStart
} from './wallTimeline'

const T0 = Date.parse('2026-10-12T18:00:00Z')

function timeline(
  anchors: Array<[number, number]>,
  live = false,
  source: WallTimeline['source'] = 'sei'
): WallTimeline {
  return {
    anchors,
    source,
    confidence: source === 'sei' ? 'frame' : 'approximate',
    live,
    startAt: new Date(T0).toISOString()
  }
}

function step(at: number, balls = 0): BoardStep {
  return { at, state: { ...SAMPLE_SCOREBOARD, balls } }
}

describe('the frame’s wall time (U28)', function () {
  // Two points a minute apart in media and eighty seconds apart on the
  // wall: an outage of twenty seconds between them.
  const anchors: Array<[number, number]> = [
    [0, T0],
    [60_000, T0 + 80_000]
  ]

  it('is the point’s own time on a point', function () {
    expect(wallAt(anchors, 0)).equals(T0)
    expect(wallAt(anchors, 60_000)).equals(T0 + 80_000)
  })

  it('runs at 1x between points and after the last', function () {
    expect(wallAt(anchors, 30_000)).equals(T0 + 30_000)
    expect(wallAt(anchors, 59_999)).equals(T0 + 59_999)
    expect(wallAt(anchors, 90_000)).equals(T0 + 110_000)
  })

  it('jumps across the outage', function () {
    expect(wallAt(anchors, 60_000)! - wallAt(anchors, 59_000)!).equals(21_000)
  })

  it('runs back from the first point before it, and is null with none', function () {
    expect(wallAt([[1000, T0 + 1000]], 0)).equals(T0)
    expect(wallAt([], 5000)).equals(null)
  })

  it('starts the board window at media zero, or nowhere without points', function () {
    expect(windowStart(timeline(anchors))).equals(T0)
    expect(windowStart(timeline([[500, T0 + 700]]))).equals(T0 + 200)
    expect(windowStart(timeline([]))).equals(null)
    expect(windowStart(null)).equals(null)
  })

  it('grows a live timeline by the points after the last one held', function () {
    const held = timeline([[0, T0]], true)
    expect(pollAfter(held)).equals(0)
    expect(pollAfter(timeline([]))).equals(undefined)
    // The server answers only later points, but a repeated one is ignored.
    const grown = appendPoll(
      held,
      timeline(
        [
          [0, T0],
          [500, T0 + 500],
          [1000, T0 + 1000]
        ],
        true
      )
    )
    expect(grown.anchors).deep.equals([
      [0, T0],
      [500, T0 + 500],
      [1000, T0 + 1000]
    ])
    expect(grown.live).equals(true)
    // Nothing new keeps the same points, and takes the answer's liveness.
    const same = appendPoll(grown, timeline([], false))
    expect(same.anchors).equals(grown.anchors)
    expect(same.live).equals(false)
  })

  it('asks for the whole timeline while it holds only the start, and takes the stream’s first point at zero', function () {
    // Fetched before the stream stored any point: the start's stand-in.
    const start = timeline([[0, T0 - 3000]], true, 'start')
    expect(pollAfter(start)).equals(undefined)
    expect(pollAfter(timeline([], true, 'start'))).equals(undefined)
    // Still nothing stored: the stand-in again.
    expect(appendPoll(start, start)).deep.equals(start)
    // The stream's own points, the first at media time zero, replace it.
    const arrived = timeline(
      [
        [0, T0 - 1200],
        [2000, T0 + 800]
      ],
      true,
      'arrival'
    )
    const grown = appendPoll(start, arrived)
    expect(grown).deep.equals(arrived)
    expect(windowStart(grown)).equals(T0 - 1200)
    // From then on, only the points after the last.
    expect(pollAfter(grown)).equals(2000)
    expect(
      appendPoll(grown, timeline([[4000, T0 + 2800]], true, 'arrival')).anchors
    ).deep.equals([
      [0, T0 - 1200],
      [2000, T0 + 800],
      [4000, T0 + 2800]
    ])
  })
})

describe('the grid’s wall time (U35)', function () {
  const angle = {
    startAt: new Date(T0).toISOString(),
    syncOffsetSec: 2,
    durationSec: 600
  }

  it('reads the angle’s own timeline when it has one', function () {
    const own = timeline([
      [0, T0 + 5000],
      [10_000, T0 + 40_000]
    ])
    expect(angleWallMs(angle, own, 5)).equals(T0 + 10_000)
    expect(angleWallMs(angle, own, 12)).equals(T0 + 42_000)
  })

  it('falls back to the angle’s start, as the grid places it', function () {
    expect(angleWallMs(angle, undefined, 12)).equals(T0 + 10_000)
    expect(angleWallMs(angle, timeline([]), 12)).equals(T0 + 10_000)
    expect(angleWallMs({ ...angle, startAt: null }, undefined, 12)).equals(null)
  })
})

describe('the board at a wall time (U29)', function () {
  const steps = [step(T0, 0), step(T0 + 1000, 1), step(T0 + 5000, 2)]

  it('is nothing before the first step', function () {
    expect(boardAt(steps, T0 - 1)).equals(null)
    expect(boardAt(steps, null)).equals(null)
    expect(boardAt([], T0)).equals(null)
  })

  it('is the step itself on a step', function () {
    expect(boardAt(steps, T0)).equals(steps[0])
    expect(boardAt(steps, T0 + 1000)).equals(steps[1])
    expect(boardAt(steps, T0 + 5000)).equals(steps[2])
  })

  it('is the step before, between steps', function () {
    expect(boardAt(steps, T0 + 999)).equals(steps[0])
    expect(boardAt(steps, T0 + 4999)).equals(steps[1])
  })

  it('is the last step after the last', function () {
    expect(boardAt(steps, T0 + 3_600_000)).equals(steps[2])
  })

  it('finds its step among many', function () {
    const many = Array.from({ length: 1001 }, (unused, i) => step(T0 + i * 10))
    for (const i of [0, 1, 499, 500, 999, 1000])
      expect(boardAt(many, T0 + i * 10 + 5)).equals(many[i])
  })

  it('keeps the steps before a refetch and replaces the rest', function () {
    const held = [step(T0), step(T0 + 1000), step(T0 + 2000), step(T0 + 3000)]
    // From T0 + 2500 the server answers the step in effect then (T0 + 2000,
    // now with a different board) and what follows.
    const fetched = [step(T0 + 2000, 3), step(T0 + 4000, 3)]
    expect(mergeSteps(held, T0 + 2500, fetched)).deep.equals([
      held[0],
      held[1],
      ...fetched
    ])
    // With nothing to say from there on, only what came before stays.
    expect(mergeSteps(held, T0 + 1500, [])).deep.equals([held[0], held[1]])
  })
})

describe('the time frame some videos cover', function () {
  const at = (seconds: number): number => T0 + seconds * 1000
  const placed = timeline([[0, T0]])

  it('runs from the earliest start to the latest end, by the server’s lengths', function () {
    expect(
      timeFrame([
        { live: false, timeline: placed, durationSec: 600 },
        {
          live: false,
          timeline: timeline([[0, at(90)]]),
          durationSec: 600
        }
      ])
    ).deep.equals({ fromMs: T0, toMs: at(690) })
  })

  it('is open-ended only while one is live', function () {
    expect(
      timeFrame([
        { live: false, timeline: placed, durationSec: 600 },
        { live: true, timeline: undefined, durationSec: null }
      ])
    ).deep.equals({ fromMs: T0, toMs: Number.POSITIVE_INFINITY })
    expect(
      timeFrame([
        { live: false, timeline: timeline([[0, T0]], true), durationSec: null }
      ])
    ).deep.equals({ fromMs: T0, toMs: Number.POSITIVE_INFINITY })
  })

  it('leaves out a recording it cannot place, and says nothing when none can be', function () {
    const unplaced = [
      { live: false, timeline: undefined, durationSec: 600 },
      { live: false, timeline: null, durationSec: 600 },
      { live: false, timeline: timeline([]), durationSec: 600 },
      { live: false, timeline: placed, durationSec: null }
    ]
    for (const video of unplaced)
      expect(timeFrame([video]), JSON.stringify(video)).equals(null)
    expect(timeFrame(unplaced)).equals(null)
    expect(timeFrame([])).equals(null)
    // With one it can place, the rest add nothing.
    expect(
      timeFrame([
        ...unplaced,
        { live: false, timeline: placed, durationSec: 60 }
      ])
    ).deep.equals({ fromMs: T0, toMs: at(60) })
    // A live video with no timeline yet opens the end but starts nothing.
    expect(
      timeFrame([{ live: true, timeline: undefined, durationSec: null }])
    ).equals(null)
  })
})
