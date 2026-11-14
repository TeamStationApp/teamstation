import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  focusCommand,
  focusImagePoint,
  focusLabel,
  focusOpacity,
  type FocusPoint,
  focusTap
} from './cameraFocus'
import type { NativeCameraFocus } from './NativePhoneStream'

const focus: NativeCameraFocus = {
  supported: true,
  phase: 'locked',
  generation: 'camera',
  request: 'tap',
  rotation: 0,
  mirrored: false
}

describe('camera focus', function () {
  it('focuses only a short single-finger tap and never a zoom or cancelled gesture', function () {
    let now = 0
    const taps: FocusPoint[] = []
    const gesture = focusTap(
      point => taps.push(point),
      () => now
    )
    const point = { x: 20, y: 40 }
    gesture.start([point])
    gesture.move([{ x: 22, y: 41 }])
    gesture.end()
    gesture.end()
    expect(taps).deep.equals([point])
    gesture.start([point])
    gesture.move([{ x: 27, y: 40 }])
    gesture.move([point])
    gesture.end()
    gesture.start([point])
    gesture.move([point, point])
    gesture.move([point])
    gesture.end()
    gesture.start([point, point])
    gesture.move([point])
    gesture.end()
    gesture.start([point])
    gesture.move([])
    gesture.end()
    gesture.start([point])
    gesture.cancel()
    gesture.end()
    gesture.start([point])
    now = 351
    gesture.end()
    gesture.start([])
    gesture.end()
    expect(taps).deep.equals([point])
    gesture.start([point])
    now += 350
    gesture.end()
    expect(taps).deep.equals([point, point])
  })
  it('maps the visible image and rejects letterboxes, invalid sizes and outside taps', function () {
    expect(focusImagePoint(0, 50, 200, 200, 200, 100)).deep.equals({
      x: 0,
      y: 0
    })
    expect(focusImagePoint(200, 150, 200, 200, 200, 100, true)).deep.equals({
      x: 0,
      y: 1
    })
    expect(focusImagePoint(100, 100, 200, 200, 200, 100)).deep.equals({
      x: 0.5,
      y: 0.5
    })
    expect(focusImagePoint(0, 0, 200, 200, 200, 100, false, true)).deep.equals({
      x: 0.25,
      y: 0
    })
    expect(
      focusImagePoint(200, 200, 200, 200, 200, 100, true, true)
    ).deep.equals({ x: 0.25, y: 1 })
    expect(focusImagePoint(-1, 100, 200, 200, 200, 100, false, true)).equals(
      null
    )
    for (const [x, y] of [
      [-1, 100],
      [201, 100],
      [100, 49],
      [100, 151],
      [NaN, 0]
    ]) {
      expect(focusImagePoint(x, y, 200, 200, 200, 100)).equals(null)
    }
    for (const sizes of [
      [0, 1, 1, 1],
      [1, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 1, 1, 0]
    ]) {
      expect(
        focusImagePoint(0, 0, sizes[0], sizes[1], sizes[2], sizes[3])
      ).equals(null)
    }
  })

  it('sends validated generation-bound commands and never claims unsupported peers can focus', function () {
    expect(focusCommand(focus, { x: 0.2, y: 0.7 }, 'tap-2')).equals(
      'point:camera:tap-2:0.2:0.7'
    )
    expect(focusCommand(focus, null, 'auto')).equals('auto:camera:auto')
    expect(focusCommand(undefined, null, 'auto')).equals(null)
    expect(focusCommand({ ...focus, supported: false }, null, 'auto')).equals(
      null
    )
    expect(focusCommand({ ...focus, generation: '' }, null, 'auto')).equals(
      null
    )
    expect(focusCommand(focus, null, 'bad token')).equals(null)
    for (const value of [NaN, Infinity, -0.1, 1.1]) {
      expect(focusCommand(focus, { x: value, y: 0.5 }, 'tap')).equals(null)
      expect(focusCommand(focus, { x: 0.5, y: value }, 'tap')).equals(null)
    }
    expect(focusLabel(focus)).equals('Focus locked')
    expect(focusLabel()).equals('Focus unavailable')
    expect(focusLabel({ ...focus, phase: 'constructor' })).equals(
      'Focus unavailable'
    )
  })

  it('pulses for two seconds independently of camera state', function () {
    expect(focusOpacity(-1)).equals(0)
    expect(focusOpacity(0)).equals(1)
    expect(focusOpacity(250)).closeTo(0.35, 0.001)
    expect(focusOpacity(500)).equals(1)
    expect(focusOpacity(1999)).greaterThan(0)
    expect(focusOpacity(2000)).equals(0)
  })
})
