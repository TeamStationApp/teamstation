import type { GestureResponderEvent, PressableProps } from 'react-native'

/** Native responders expose a point directly; browser TouchEvents carry lists. */
export function pressPoint(event: {
  pageX?: number
  pageY?: number
  touches?: ArrayLike<{ pageX: number; pageY: number }>
  changedTouches?: ArrayLike<{ pageX: number; pageY: number }>
}): { x: number; y: number } | undefined {
  const point = event.touches?.[0] ?? event.changedTouches?.[0] ?? event
  return Number.isFinite(point.pageX) && Number.isFinite(point.pageY)
    ? { x: point.pageX!, y: point.pageY! }
    : undefined
}

/** Native touch stamps share a monotonic clock; never compare them to JS time. */
export function pressStamp(event: {
  timestamp?: unknown
  identifier?: unknown
  touches?: ArrayLike<{ timestamp?: unknown; identifier?: unknown }>
  changedTouches?: ArrayLike<{ timestamp?: unknown; identifier?: unknown }>
}): { timestamp: number; identifier: string | number } | undefined {
  for (const touch of [event, event.changedTouches?.[0], event.touches?.[0]]) {
    const timestamp = touch?.timestamp
    const identifier = touch?.identifier
    if (
      typeof timestamp === 'number' &&
      Number.isFinite(timestamp) &&
      timestamp >= 0 &&
      (typeof identifier === 'string' ||
        (typeof identifier === 'number' && Number.isFinite(identifier)))
    )
      return { timestamp, identifier }
  }
  return undefined
}

export interface ChatBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Keep a popup in the viewport, preferring the space below its trigger. */
export function menuPosition(
  anchor: ChatBounds,
  panel: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  const margin = 8
  const left = Math.max(
    margin,
    Math.min(
      anchor.x + anchor.width - panel.width,
      viewport.width - panel.width - margin
    )
  )
  const below = anchor.y + anchor.height + margin
  const top =
    below + panel.height <= viewport.height - margin
      ? below
      : anchor.y - panel.height - margin
  return {
    left,
    top: Math.max(
      margin,
      Math.min(top, viewport.height - panel.height - margin)
    )
  }
}

/** Nested quote/file controls share the containing message's hold state. */
export interface MessagePressGesture {
  pressProps: Pick<
    PressableProps,
    | 'onPressIn'
    | 'onPress'
    | 'onTouchMove'
    | 'onTouchCancel'
    | 'onLongPress'
    | 'delayLongPress'
  >
  canOpen: (event?: GestureResponderEvent) => boolean
}
