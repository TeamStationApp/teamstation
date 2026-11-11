import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  enlargedRect,
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
  { value: '', rect: { x: 220, y: 300, width: 60, height: 30 } }
]
const cell = { row: 2, inning: 4 }

describe('the game plan hold-and-drag', function () {
  it('finds the target under a point, edges included, and none between them', function () {
    expect(pickerHit({ x: 120, y: 310 }, TARGETS)).equals('LF')
    expect(pickerHit({ x: 160, y: 280 }, TARGETS)).equals('CF')
    expect(pickerHit({ x: 200, y: 306 }, TARGETS)).equals('CF')
    expect(pickerHit({ x: 250, y: 329 }, TARGETS)).equals('')
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

  it('starts a hold on one of the picker’s targets over it', function () {
    expect(startAssignDrag(cell, { x: 180, y: 290 }, 'CF')).deep.equals({
      cell,
      start: { x: 180, y: 290 },
      over: 'CF',
      moved: false
    })
  })

  it('draws the enlarged box half as large again, three quarters of a box above its target, inside the card', function () {
    const card = { x: 0, y: 0, width: 270, height: 260 }
    const box = enlargedRect({ x: 100, y: 120, width: 44, height: 26 }, card)
    expect(box).deep.equals({ x: 89, y: 61.5, width: 66, height: 39 })
    // Its bottom, 19.5 points above the target's top.
    expect(120 - (box.y + box.height)).equals(0.75 * 26)
    // Kept inside the card at its edges.
    expect(
      enlargedRect({ x: 2, y: 10, width: 44, height: 26 }, card)
    ).deep.equals({ x: 0, y: 0, width: 66, height: 39 })
    expect(
      enlargedRect({ x: 240, y: 200, width: 30, height: 30 }, card).x
    ).equals(270 - 45)
  })

  it('finds the lower target under a finger moving up beneath the enlarged box, which is only drawn', function () {
    // SS's box, enlarged above it, covers CF's target.
    const ss = { x: 160, y: 340, width: 40, height: 26 }
    const targets: PickerTarget[] = [...TARGETS, { value: 'SS', rect: ss }]
    const box = enlargedRect(ss, { x: 0, y: 0, width: 400, height: 600 })
    const underBox = { x: 180, y: 295 }
    expect(
      underBox.x >= box.x &&
        underBox.x <= box.x + box.width &&
        underBox.y >= box.y &&
        underBox.y <= box.y + box.height
    ).equals(true)
    const held = startAssignDrag(cell, { x: 180, y: 353 }, 'SS')
    const up = moveAssignDrag(held, underBox, targets)
    expect(up.over).equals('CF')
    expect(releaseAssignDrag(up, underBox, targets)).deep.equals({
      write: 'CF',
      close: true
    })
  })
})
