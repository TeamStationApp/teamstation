import type {
  GestureResponderEvent,
  PanResponderCallbacks,
  PanResponderGestureState
} from 'react-native'

/** What the phone's field sends touches to: the Canvas's stand-in element. */
export interface FieldTouchTarget {
  dispatchEvent: (event: object) => void
}

/** A touch that moved less than this is also a click, as Fiber counts one. */
const CLICK_SLOP = 20

/**
 * The phone field's touch bridge: a pan responder that turns one finger into
 * the DOM pointer events Fiber's event system raycasts from.
 *
 * Fiber's native Canvas has a responder of its own, but it sends
 * `pointerdown` from `onPanResponderStart`. On the iPhone 13 Pro that press
 * never reached the scene — a count on the device showed its moves and
 * releases arriving and no press — so nothing on the field could be picked
 * up. The grant is delivered on both platforms, and the press goes from there.
 */
export function fieldTouchHandlers(
  target: () => FieldTouchTarget | null | undefined
): PanResponderCallbacks {
  const send = (type: string, event: GestureResponderEvent): void => {
    const { locationX, locationY, identifier } = event.nativeEvent
    target()?.dispatchEvent({
      type,
      offsetX: locationX,
      offsetY: locationY,
      pointerType: 'touch',
      pointerId: Number(identifier)
    })
  }
  return {
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => {
      send('pointerdown', event)
    },
    onPanResponderMove: event => {
      send('pointermove', event)
    },
    onPanResponderRelease: (
      event: GestureResponderEvent,
      gesture: PanResponderGestureState
    ) => {
      send('pointerup', event)
      if (Math.hypot(gesture.dx, gesture.dy) < CLICK_SLOP) send('click', event)
      send('pointerleave', event)
    },
    onPanResponderTerminate: event => {
      send('pointercancel', event)
      send('lostpointercapture', event)
    }
  }
}
