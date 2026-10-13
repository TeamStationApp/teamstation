import { act } from 'react'
import { Animated } from 'react-native'

/**
 * A mouse drag through react-native-web's responder system, which is how a
 * PanResponder sees a finger in the browser: down on `target`, a move to
 * each later point, then up at the last one. Points are [x, y] page
 * coordinates. It returns as the release animation begins, so a caller can
 * read where the pill was let go.
 */
export async function responderDrag(
  target: HTMLElement,
  points: Array<[number, number]>
): Promise<void> {
  // PanResponder skips a move stamped the same as the last one it counted,
  // so each event gets its own later time, a frame apart.
  let time = performance.now()
  const send = (type: string, [x, y]: [number, number]): void => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      clientX: x,
      clientY: y
    })
    Object.defineProperty(event, 'pageX', { value: x })
    Object.defineProperty(event, 'pageY', { value: y })
    time += 16
    Object.defineProperty(event, 'timeStamp', { value: time })
    target.dispatchEvent(event)
  }
  await act(async () => {
    send('mousedown', points[0])
    for (const point of points.slice(1)) send('mousemove', point)
    send('mouseup', points[points.length - 1])
  })
}

/**
 * Records the value every `Animated.timing` starts from, until `restore`:
 * where a pill was when it began to slide.
 */
export function recordAnimationStarts(): {
  starts: number[]
  restore: () => void
} {
  const descriptor = Object.getOwnPropertyDescriptor(Animated, 'timing')!
  const original = Animated.timing
  const starts: number[] = []
  const timing = (
    ...args: Parameters<typeof Animated.timing>
  ): ReturnType<typeof Animated.timing> => {
    const value = args[0] as unknown as { __getValue: () => number }
    starts.push(value.__getValue())
    return original(...args)
  }
  Object.defineProperty(Animated, 'timing', { ...descriptor, value: timing })
  return {
    starts,
    restore: () => {
      Object.defineProperty(Animated, 'timing', descriptor)
    }
  }
}
