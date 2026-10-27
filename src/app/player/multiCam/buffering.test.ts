import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  acrossStartHole,
  AHEAD_SEC,
  BEHIND_SEC,
  canStart,
  heldAhead,
  isDry,
  isReady,
  LEAVE_OUT_MS,
  neededSec,
  readyWhereItStands,
  RECORDED_START_GAP_SEC,
  START_AHEAD_SEC,
  START_GAP_SEC,
  strayed,
  TILE_BUFFER,
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

describe('how far ahead every player loads (U29)', function () {
  it('is half a minute ahead and twenty seconds behind, and the phone tiles say so', function () {
    expect(AHEAD_SEC).equals(30)
    expect(BEHIND_SEC).equals(20)
    expect(TILE_BUFFER).deep.include({
      aheadSec: 30,
      behindSec: 20,
      heapShare: 0.15
    })
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

  it('says a tile strayed when it holds nothing where it is wanted and stands elsewhere', function () {
    // Holds where it stands, not where it is wanted.
    expect(strayed([[150, 152]], 150, 145.4)).equals(true)
    expect(strayed([], 150, 145.4)).equals(true)
    // Holds where it is wanted, within a sliver of a stretch's start.
    expect(strayed([[145.2, 152]], 150, 145.4)).equals(false)
    expect(strayed([[140, 152]], 150, 145.4)).equals(false)
    // Already there.
    expect(strayed([], 145.5, 145.4)).equals(false)
  })

  it('holds what is past a hole at the very place it starts, up to the gap its player steps over', function () {
    expect(START_GAP_SEC).equals(5)
    // Four seconds of nothing, then thirty-two.
    expect(heldAhead([[2013, 2045]], 2009)).equals(32)
    // A hole wider than that is a hole.
    expect(heldAhead([[2015, 2045]], 2009)).equals(0)
  })

  it('sends a recording standing in a start hole wider than its player jumps across it', function () {
    expect(RECORDED_START_GAP_SEC).equals(2)
    // Three seconds of nothing, then the footage: to its start.
    expect(acrossStartHole([[2012, 2045]], 2009)).equals(2012)
    // Within the two its player steps over, or past the five a hole can be,
    // it stays.
    expect(acrossStartHole([[2010.5, 2045]], 2009)).equals(null)
    expect(acrossStartHole([[2015, 2045]], 2009)).equals(null)
    // In footage, or before nothing at all, it stays.
    expect(acrossStartHole([[2000, 2045]], 2009)).equals(null)
    expect(acrossStartHole([], 2009)).equals(null)
  })

  it('trusts a player that can play where it stands, once the gate has waited long enough', function () {
    const ready = { waitedMs: 2000, readyState: 4, aheadSec: 2.5 }
    expect(readyWhereItStands(ready)).equals(true)
    expect(readyWhereItStands({ ...ready, waitedMs: 1999 })).equals(false)
    expect(readyWhereItStands({ ...ready, readyState: 2 })).equals(false)
    expect(readyWhereItStands({ ...ready, aheadSec: 0.5 })).equals(false)
    // A phone's player says nothing of its buffer; its word is its readiness.
    expect(readyWhereItStands({ ...ready, aheadSec: null })).equals(true)
    // The only angle: its player's word decides at once.
    expect(readyWhereItStands({ ...ready, waitedMs: 0, alone: true })).equals(
      true
    )
    expect(readyWhereItStands({ ...ready, waitedMs: 0, alone: false })).equals(
      false
    )
  })
})
