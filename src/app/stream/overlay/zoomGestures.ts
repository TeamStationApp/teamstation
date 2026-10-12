import type { GestureResponderEvent } from 'react-native'

import type { PhoneZoomScale } from '../phoneStreamClient'
import { SYSTEM_EDGE_BAND, ZOOM } from './overlayTheme'
import { zoomDraggedFrom } from './zoomRail'

export interface Point {
  x: number
  y: number
}

/** The zoom rail's extent on the screen, top pill to bottom pill. */
export interface RailBand {
  top: number
  bottom: number
}

export interface ZoomGestureHost {
  /** The engine's pinch, multiplicative against the zoom when it began. */
  pinch: (scale: number, ended: boolean) => void
  setZoom: (displayed: number) => void
  scale: () => PhoneZoomScale | null
  /** The zoom now, which a drag is measured from. */
  displayed: () => number
  /** Null before the rail has been laid out, when any drag may zoom. */
  railBand: () => RailBand | null
  /** Centre to centre, from one pill to the next. */
  pointsPerSegment: () => number
  /** The screen's height, for the system's edge bands. */
  screenHeight: () => number
}

export interface ZoomGesture {
  start: (touches: Point[]) => void
  move: (touches: Point[]) => void
  end: () => void
}

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

/**
 * The preview's two ways to zoom, as TS Cameraman has them.
 *
 * - **Pinch** with two fingers, passed to the engine as the ratio of the
 *   fingers' spread to their spread when the second came down. A pinch that
 *   starts in the top or bottom half inch is on its way to the system, and
 *   leaves the zoom alone.
 * - **A vertical drag** with one finger that starts between the rail's top and
 *   bottom pills, anywhere across the screen. Up zooms in, and a drag as long
 *   as one pill-to-pill gap walks one segment, so the rail's whole height
 *   walks the whole range.
 */
export function zoomGesture(host: ZoomGestureHost): ZoomGesture {
  let origin: Point | null = null
  let pinchFrom: number | null = null
  let lastScale = 1
  let pinchAllowed = false
  let dragFrom: number | null = null

  const finishPinch = (): void => {
    if (pinchFrom == null) return
    pinchFrom = null
    if (pinchAllowed) host.pinch(lastScale, true)
  }

  const inRail = (y: number): boolean => {
    const band = host.railBand()
    return band == null || (y >= band.top && y <= band.bottom)
  }

  const inEdgeBand = (y: number): boolean =>
    y < SYSTEM_EDGE_BAND || y > host.screenHeight() - SYSTEM_EDGE_BAND

  return {
    start: touches => {
      origin = touches[0] ?? null
      dragFrom = null
      if (touches.length >= 2) {
        pinchFrom = distance(touches[0], touches[1])
        lastScale = 1
        pinchAllowed = !inEdgeBand(touches[0].y)
      }
    },
    move: touches => {
      if (touches.length >= 2) {
        if (pinchFrom == null) {
          pinchFrom = distance(touches[0], touches[1])
          lastScale = 1
          pinchAllowed = !inEdgeBand(touches[0].y)
          return
        }
        if (!pinchAllowed || pinchFrom <= 0) return
        lastScale = distance(touches[0], touches[1]) / pinchFrom
        host.pinch(lastScale, false)
        return
      }
      // A pinch that loses a finger is over; it does not become a drag.
      if (pinchFrom != null) {
        finishPinch()
        origin = null
        return
      }
      const touch = touches[0]
      if (origin == null || touch == null || !inRail(origin.y)) return
      if (dragFrom == null && distance(origin, touch) < ZOOM.dragMinimum) return
      const scale = host.scale()
      if (scale == null) return
      dragFrom ??= host.displayed()
      host.setZoom(
        zoomDraggedFrom(
          scale,
          dragFrom,
          origin.y - touch.y,
          host.pointsPerSegment()
        )
      )
    },
    end: () => {
      finishPinch()
      origin = null
      dragFrom = null
    }
  }
}

/** The fingers on the screen, in page coordinates. */
export function touchesOf(event: GestureResponderEvent): Point[] {
  const { touches } = event.nativeEvent
  return touches.map(touch => ({ x: touch.pageX, y: touch.pageY }))
}

/** A view's responder props that hand every touch on it to `gesture`. */
export function zoomResponder(gesture: ZoomGesture): {
  onStartShouldSetResponder: () => boolean
  onMoveShouldSetResponder: () => boolean
  onResponderTerminationRequest: () => boolean
  onResponderGrant: (event: GestureResponderEvent) => void
  onResponderMove: (event: GestureResponderEvent) => void
  onResponderRelease: () => void
  onResponderTerminate: () => void
} {
  return {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: event => {
      gesture.start(touchesOf(event))
    },
    onResponderMove: event => {
      gesture.move(touchesOf(event))
    },
    onResponderRelease: () => {
      gesture.end()
    },
    onResponderTerminate: () => {
      gesture.end()
    }
  }
}
