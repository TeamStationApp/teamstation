import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  canStart,
  ceilingSec,
  heldAhead,
  isDry,
  isReady,
  LEAD_SEC,
  LEAVE_OUT_MS,
  MAX_AHEAD_SEC,
  neededSec,
  START_AHEAD_SEC,
  type TileBuffer,
  toLeaveOut
} from './buffering'

/** A browser tile: it says how much it holds. */
function web(aheadSec: number, leftSec: number | null = 3600): TileBuffer {
  return { aheadSec, leftSec, readyState: 4 }
}

/** A phone tile: it says only whether it is ready. */
function phone(readyState: number): TileBuffer {
  return { aheadSec: null, leftSec: null, readyState }
}

describe('how much a tile must hold to play', function () {
  it('is a few seconds, or what is left of the recording', function () {
    expect(neededSec(web(0))).equals(START_AHEAD_SEC)
    expect(neededSec(web(0, null))).equals(START_AHEAD_SEC)
    // Two seconds from the end, all there is is all it can hold.
    expect(neededSec(web(0, 2))).equals(1.75)
    expect(neededSec(web(0, 0))).equals(0)
  })

  it('is ready from that much on, and not a moment before', function () {
    expect(isReady(web(START_AHEAD_SEC - 0.1))).equals(false)
    expect(isReady(web(START_AHEAD_SEC))).equals(true)
    expect(isReady(web(1.9, 2))).equals(true)
  })

  it('takes a phone at its word', function () {
    expect(isReady(phone(4))).equals(true)
    expect(isReady(phone(2))).equals(false)
    expect(isReady(phone(0))).equals(false)
  })
})

describe('a tile about to run dry', function () {
  it('is one with under half a second left and more to come', function () {
    expect(isDry(web(0.4))).equals(true)
    expect(isDry(web(0.6))).equals(false)
    // Unknown is not plenty.
    expect(isDry(web(0, null))).equals(true)
  })

  it('is not one at the end of what there is', function () {
    // The recording ends here, or this is the live edge: there is nothing
    // to wait for.
    expect(isDry(web(0.3, 0.4))).equals(false)
    expect(isDry(web(0, 0))).equals(false)
  })

  it('is a phone that says it is buffering', function () {
    expect(isDry(phone(2))).equals(true)
    expect(isDry(phone(4))).equals(false)
  })
})

describe('when the grid may start', function () {
  it('waits for every tile, and for nobody when there are none', function () {
    expect(canStart([web(6), web(5), phone(4)])).equals(true)
    expect(canStart([web(6), web(3)])).equals(false)
    expect(canStart([])).equals(true)
  })
})

describe('how far ahead the tiles may load', function () {
  it('is the emptiest tile plus the lead, so the line goes to it', function () {
    expect(ceilingSec([web(2), web(30), web(40)])).equals(2 + LEAD_SEC)
  })

  it('climbs as the emptiest fills, up to the most', function () {
    expect(ceilingSec([web(0), web(0)])).equals(LEAD_SEC)
    expect(ceilingSec([web(52), web(58)])).equals(MAX_AHEAD_SEC)
  })

  it('leaves out a tile that holds all there is, and one that does not say', function () {
    // The first holds the rest of its recording; it is short of nothing.
    expect(ceilingSec([web(3, 3), web(25), phone(4)])).equals(25 + LEAD_SEC)
    expect(ceilingSec([phone(4)])).equals(MAX_AHEAD_SEC)
    expect(ceilingSec([])).equals(MAX_AHEAD_SEC)
  })
})

describe('leaving a tile out', function () {
  const now = 100_000

  it('happens to one that has kept a ready grid waiting too long', function () {
    expect(
      toLeaveOut(
        [
          { id: 'A', ready: true, waitingSinceMs: now },
          { id: 'B', ready: false, waitingSinceMs: now - LEAVE_OUT_MS },
          { id: 'C', ready: false, waitingSinceMs: now - LEAVE_OUT_MS + 1 }
        ],
        now
      )
    ).deep.equals(['B'])
  })

  it('never happens while nobody is ready', function () {
    expect(
      toLeaveOut(
        [
          { id: 'A', ready: false, waitingSinceMs: now - 60_000 },
          { id: 'B', ready: false, waitingSinceMs: now - 60_000 }
        ],
        now
      )
    ).deep.equals([])
  })
})

describe('what a player holds ahead', function () {
  it('counts a recording whose first frame is a moment past nought from the start', function () {
    // What WebKit reports for one of ours: the first stretch starts at the
    // first frame, 0.021 s in.
    expect(heldAhead([[0.021, 12.021]], 0)).closeTo(12.021, 1e-9)
  })

  it('carries on across a sliver between stretches, and stops at a real gap', function () {
    const held: Array<[number, number]> = [
      [0, 6],
      [6.05, 12],
      [20, 30]
    ]
    expect(heldAhead(held, 2)).equals(10)
    expect(heldAhead(held, 25)).equals(5)
  })

  it('holds nothing where it is not, whatever it holds elsewhere', function () {
    expect(heldAhead([[20, 30]], 5)).equals(0)
    expect(heldAhead([], 5)).equals(0)
  })
})
