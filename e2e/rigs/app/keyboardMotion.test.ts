import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  fieldTopPerFrame,
  type Frame,
  motionFile,
  motionOf,
  restRow
} from './keyboardMotion'

/** A frame dark above `edge` and light from it down, with a little noise. */
function frame(edge: number, noise = 0, width = 20, height = 200): Frame {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[y * width + x] =
        (y < edge ? 40 : 220) + (noise === 0 ? 0 : (x * 7 + y * 13) % noise)
  return { width, height, data }
}

describe('keyboard motion in a recording of the screen', function () {
  it('places an element at rest in the recording’s picture, scaled from points', function () {
    // An iPhone: 852 points tall, recorded at 2556 pixels.
    expect(restRow(700, 852, 2556)).equals(2100)
    // Kept inside the picture, so the edge search has a row above it.
    expect(restRow(0, 852, 2556)).equals(1)
    expect(restRow(900, 852, 2556)).equals(2555)
    expect(() => restRow(10, 0, 100)).throws('no height')
  })

  it('follows the edge down the centre column, frame to frame', function () {
    const edges = [150, 150, 140, 120, 100, 90, 90]
    expect(
      fieldTopPerFrame(
        edges.map(e => frame(e)),
        150
      )
    ).deep.equals(edges)
    // Webcam shimmer does not move it.
    expect(
      fieldTopPerFrame(
        edges.map(e => frame(e, 9)),
        150
      )
    ).deep.equals(edges)
  })

  it('keeps up with a fast keyboard on a tall crop', function () {
    // 1500 rows tall: 120 rows a frame, more than a fixed 60 could follow.
    const edges = [1300, 1300, 1180, 1060, 940, 820, 760, 760]
    expect(
      fieldTopPerFrame(
        edges.map(e => frame(e, 0, 20, 1500)),
        1300
      )
    ).deep.equals(edges)
  })

  it('calls a ramp up and back animated, and a jump not', function () {
    const ramp = [150, 150, 140, 125, 110, 95, 90, 90, 100, 115, 130, 145, 150]
    const animated = motionOf(ramp)
    expect(animated.up.animated).equals(true)
    expect(animated.down.animated).equals(true)
    expect(animated.up.between).deep.equals([140, 125, 110, 95])
    const snap = motionOf([150, 150, 90, 90, 90, 150, 150])
    expect(snap.up.animated).equals(false)
    expect(snap.down.animated).equals(false)
    // Up animated, down snapped: each way is judged on its own.
    const half = motionOf([150, 140, 125, 110, 90, 90, 150])
    expect([half.up.animated, half.down.animated]).deep.equals([true, false])
    expect(() => motionOf([])).throws('no frames')
  })

  it('keeps a motion’s recording beside the run’s other evidence', function () {
    expect(motionFile('/run', 'open')).equals('/run/open.mp4')
  })
})
