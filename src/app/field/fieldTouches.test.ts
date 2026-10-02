import { expect } from 'chai'
import { describe, it } from 'mocha'
import type {
  GestureResponderEvent,
  PanResponderGestureState
} from 'react-native'

import { fieldTouchHandlers } from './fieldTouches'

/** A touch at (x, y) on the field, which sits lower down the page. */
function touch(x: number, y: number, id = 3): GestureResponderEvent {
  return {
    nativeEvent: {
      pageX: x,
      pageY: y + 200,
      locationX: x,
      locationY: y,
      identifier: String(id)
    }
  } as unknown as GestureResponderEvent
}
function moved(dx: number, dy: number): PanResponderGestureState {
  return { dx, dy } as unknown as PanResponderGestureState
}

describe('the phone field touch bridge', function () {
  it('claims every touch and does not give it up', function () {
    const handlers = fieldTouchHandlers(() => undefined)
    const event = touch(0, 0)
    const gesture = moved(0, 0)
    expect(handlers.onStartShouldSetPanResponder?.(event, gesture)).equals(true)
    expect(handlers.onMoveShouldSetPanResponder?.(event, gesture)).equals(true)
    expect(handlers.onPanResponderTerminationRequest?.(event, gesture)).equals(
      false
    )
  })
  it('sends a drag as pointer events at the touch on the field, and a short one as a click', function () {
    const sent: Array<Record<string, unknown>> = []
    const handlers = fieldTouchHandlers(() => ({
      dispatchEvent: event => sent.push(event as Record<string, unknown>)
    }))
    handlers.onPanResponderGrant?.(touch(10, 20), moved(0, 0))
    handlers.onPanResponderMove?.(touch(40, 60), moved(30, 40))
    handlers.onPanResponderRelease?.(touch(40, 60), moved(30, 40))
    expect(sent.map(event => event.type)).deep.equals([
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointerleave'
    ])
    expect(sent[0]).deep.equals({
      type: 'pointerdown',
      offsetX: 10,
      offsetY: 20,
      pointerType: 'touch',
      pointerId: 3
    })
    sent.length = 0
    handlers.onPanResponderGrant?.(touch(5, 5), moved(0, 0))
    handlers.onPanResponderRelease?.(touch(8, 9), moved(3, 4))
    expect(sent.map(event => event.type)).deep.equals([
      'pointerdown',
      'pointerup',
      'click',
      'pointerleave'
    ])
  })
  it('cancels a touch taken away, and sends nothing before the field exists', function () {
    const sent: string[] = []
    let ready = false
    const handlers = fieldTouchHandlers(() =>
      ready
        ? {
            dispatchEvent: event => sent.push((event as { type: string }).type)
          }
        : null
    )
    handlers.onPanResponderGrant?.(touch(1, 1), moved(0, 0))
    expect(sent).deep.equals([])
    ready = true
    handlers.onPanResponderTerminate?.(touch(1, 1), moved(0, 0))
    expect(sent).deep.equals(['pointercancel', 'lostpointercapture'])
  })
})
