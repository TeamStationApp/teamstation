import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  moveAssignDrag,
  pickerHit,
  type PickerTarget,
  releaseAssignDrag,
  startAssignDrag
} from './planGesture'

/** Three of the picker's targets, side by side, 40 wide and 26 tall. */
const TARGETS: PickerTarget[] = [
  { value: 'LF', rect: { x: 100, y: 300, width: 40, height: 26 } },
  { value: 'CF', rect: { x: 160, y: 280, width: 40, height: 26 } },
  { value: '-', rect: { x: 220, y: 300, width: 60, height: 30 } }
]
const cell = { row: 2, inning: 4 }

describe('the game plan hold-and-drag', function () {
  it('finds the target under a point, edges included, and none between them', function () {
    expect(pickerHit({ x: 120, y: 310 }, TARGETS)).equals('LF')
    expect(pickerHit({ x: 160, y: 280 }, TARGETS)).equals('CF')
    expect(pickerHit({ x: 200, y: 306 }, TARGETS)).equals('CF')
    expect(pickerHit({ x: 250, y: 329 }, TARGETS)).equals('-')
    expect(pickerHit({ x: 150, y: 310 }, TARGETS)).equals(null)
    expect(pickerHit({ x: 120, y: 310 }, [])).equals(null)
  })

  it('starts over nothing, follows the finger and writes the target it lets go on', function () {
    const start = startAssignDrag(cell, { x: 40, y: 500 })
    expect(start).deep.equals({
      cell,
      start: { x: 40, y: 500 },
      over: null,
      moved: false
    })
    // A tremble is not a move.
    const still = moveAssignDrag(start, { x: 43, y: 503 }, TARGETS)
    expect(still.moved).equals(false)
    const over = moveAssignDrag(still, { x: 180, y: 290 }, TARGETS)
    expect(over).deep.include({ cell, over: 'CF', moved: true })
    const away = moveAssignDrag(over, { x: 10, y: 10 }, TARGETS)
    expect(away).deep.include({ over: null, moved: true })
    expect(releaseAssignDrag(away, { x: 180, y: 290 }, TARGETS)).deep.equals({
      write: 'CF',
      close: true
    })
  })

  it('changes nothing let go elsewhere: closing after a move, staying open where it held', function () {
    const start = startAssignDrag(cell, { x: 40, y: 500 })
    const moved = moveAssignDrag(start, { x: 120, y: 420 }, TARGETS)
    expect(releaseAssignDrag(moved, { x: 120, y: 420 }, TARGETS)).deep.equals({
      write: null,
      close: true
    })
    // Let go where it was held, the picker stays for a tap.
    expect(releaseAssignDrag(start, { x: 41, y: 501 }, TARGETS)).deep.equals({
      write: null,
      close: false
    })
    // A release far from the hold with no move reported first still moved.
    expect(releaseAssignDrag(start, { x: 300, y: 100 }, TARGETS)).deep.equals({
      write: null,
      close: true
    })
  })
})
