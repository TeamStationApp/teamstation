import { expect } from 'chai'
import { describe, it } from 'mocha'
import type { GestureResponderEvent } from 'react-native'

import type { PhoneZoomScale } from '../phoneStreamClient'
import {
  type RailBand,
  zoomGesture,
  type ZoomGestureHost,
  zoomResponder
} from './zoomGestures'

const SCALE: PhoneZoomScale = {
  presets: [0.5, 1, 3, 9, 18],
  switchOvers: [1, 3],
  digitalFrom: 9,
  minimum: 0.5,
  maximum: 18,
  current: 1
}

function host(
  options: { band?: RailBand | null; scale?: PhoneZoomScale | null } = {}
): ZoomGestureHost & {
  pinches: Array<[number, boolean]>
  zooms: number[]
} {
  const pinches: Array<[number, boolean]> = []
  const zooms: number[] = []
  return {
    pinches,
    zooms,
    pinch: (scale, ended) => {
      pinches.push([scale, ended])
    },
    setZoom: displayed => {
      zooms.push(displayed)
    },
    scale: () => (options.scale === undefined ? SCALE : options.scale),
    displayed: () => 1,
    railBand: () =>
      options.band === undefined ? { top: 24, bottom: 345 } : options.band,
    pointsPerSegment: () => 72,
    screenHeight: () => 390
  }
}

const event = (
  touches: Array<{ x: number; y: number }>
): GestureResponderEvent =>
  ({
    nativeEvent: {
      touches: touches.map(touch => ({ pageX: touch.x, pageY: touch.y }))
    }
  }) as unknown as GestureResponderEvent

describe('zooming the preview', function () {
  it('pinches against the spread when the second finger came down, and ends the pinch', function () {
    const h = host()
    const gesture = zoomGesture(h)
    gesture.start([{ x: 300, y: 200 }])
    gesture.move([
      { x: 300, y: 200 },
      { x: 400, y: 200 }
    ])
    gesture.move([
      { x: 300, y: 200 },
      { x: 500, y: 200 }
    ])
    gesture.end()
    expect(h.pinches).deep.equals([
      [2, false],
      [2, true]
    ])
    expect(h.zooms).deep.equals([])
  })

  it('leaves the zoom alone for a pinch that starts in the system edge bands', function () {
    const h = host()
    const gesture = zoomGesture(h)
    gesture.start([
      { x: 300, y: 20 },
      { x: 400, y: 20 }
    ])
    gesture.move([
      { x: 300, y: 20 },
      { x: 500, y: 20 }
    ])
    gesture.end()
    expect(h.pinches).deep.equals([])
  })

  it('ends a pinch that loses a finger without turning it into a drag', function () {
    const h = host()
    const gesture = zoomGesture(h)
    gesture.start([
      { x: 300, y: 200 },
      { x: 400, y: 200 }
    ])
    gesture.move([
      { x: 300, y: 200 },
      { x: 350, y: 200 }
    ])
    gesture.move([{ x: 300, y: 100 }])
    gesture.move([{ x: 300, y: 50 }])
    gesture.end()
    expect(h.pinches).deep.equals([
      [0.5, false],
      [0.5, true]
    ])
    expect(h.zooms).deep.equals([])
  })

  it('zooms by a vertical drag that starts level with the rail, past a 12 pt slop', function () {
    const h = host()
    const gesture = zoomGesture(h)
    gesture.start([{ x: 400, y: 200 }])
    gesture.move([{ x: 400, y: 195 }])
    expect(h.zooms).deep.equals([])
    gesture.move([{ x: 400, y: 128 }])
    gesture.move([{ x: 400, y: 164 }])
    gesture.end()
    expect(h.zooms).deep.equals([3, 2])
  })

  it('ignores a drag that starts above or below the rail, and needs a scale', function () {
    const h = host()
    const above = zoomGesture(h)
    above.start([{ x: 400, y: 10 }])
    above.move([{ x: 400, y: 200 }])
    above.end()
    const noScale = host({ scale: null })
    const waiting = zoomGesture(noScale)
    waiting.start([{ x: 400, y: 200 }])
    waiting.move([{ x: 400, y: 100 }])
    waiting.move([])
    waiting.end()
    expect(h.zooms).deep.equals([])
    expect(noScale.zooms).deep.equals([])
    // Before the rail has been laid out, any drag may zoom.
    const early = host({ band: null })
    const anywhere = zoomGesture(early)
    anywhere.start([{ x: 400, y: 10 }])
    anywhere.move([{ x: 400, y: -62 }])
    expect(early.zooms).deep.equals([3])
    anywhere.move([{ x: 400, y: -62 }])
    // A move with no start is nothing.
    const stray = zoomGesture(h)
    stray.move([{ x: 1, y: 1 }])
    expect(h.zooms).deep.equals([])
  })

  it('hands the responder’s touches to the gesture in page coordinates', function () {
    const h = host()
    const props = zoomResponder(zoomGesture(h))
    expect(props.onStartShouldSetResponder()).equals(true)
    expect(props.onMoveShouldSetResponder()).equals(true)
    expect(props.onResponderTerminationRequest()).equals(false)
    props.onResponderGrant(event([{ x: 300, y: 200 }]))
    props.onResponderMove(
      event([
        { x: 300, y: 200 },
        { x: 400, y: 200 }
      ])
    )
    props.onResponderMove(
      event([
        { x: 300, y: 200 },
        { x: 450, y: 200 }
      ])
    )
    props.onResponderRelease()
    props.onResponderGrant(
      event([
        { x: 300, y: 200 },
        { x: 400, y: 200 }
      ])
    )
    props.onResponderMove(
      event([
        { x: 300, y: 200 },
        { x: 300, y: 200 }
      ])
    )
    props.onResponderTerminate()
    expect(h.pinches).deep.equals([
      [1.5, false],
      [1.5, true],
      [0, false],
      [0, true]
    ])
  })
})
