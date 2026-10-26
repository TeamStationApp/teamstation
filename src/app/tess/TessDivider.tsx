import React, { useEffect, useRef } from 'react'
import { View, type ViewStyle } from 'react-native'

import { frameThrottle } from '../field/frameThrottle'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  clampTessWidth,
  TESS_MIN_WIDTH,
  TESS_WIDTH_STEP,
  type TessDividerProps
} from './tessLayout'

/**
 * The right edge of Tess's column on a wide window: a 3-point line with a
 * grip halfway down and a 12-point grab area over it that drags the column
 * wider or narrower, at most once a frame. Focused, ← and → move it 16 points. A screen reader
 * hears a separator called "Resize Tess" with its width.
 *
 * The web's: pointer events, followed on the window while a drag lasts, so
 * a pointer that outruns the line keeps dragging it. `.native.tsx` drags
 * with a PanResponder.
 */
export function TessDivider({
  width,
  max,
  onResize
}: TessDividerProps): React.ReactElement {
  const styles = getStyles(useTheme())
  // The drag reads the latest limits; a window resized mid-drag moves them.
  const latest = useRef({ max, onResize })
  latest.current = { max, onResize }
  const stop = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => stop.current?.(), [])

  /** A drag from `x`, followed on the window until the pointer is let go. */
  const begin = (x: number): void => {
    stop.current?.()
    const from = { x, width }
    const widthAt = (at: number): number =>
      clampTessWidth(from.width + at - from.x, latest.current.max)
    const throttled = frameThrottle((next: number) => {
      latest.current.onResize(next, false)
    })
    const move = (moved: PointerEvent): void => {
      throttled(widthAt(moved.clientX))
    }
    const end = (ended: PointerEvent): void => {
      cleanUp()
      latest.current.onResize(widthAt(ended.clientX), true)
    }
    const cleanUp = (): void => {
      throttled.cancel()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      stop.current = undefined
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    stop.current = cleanUp
  }

  return (
    <View
      testID="Tess divider"
      role="separator"
      aria-label={lstrings.tess_resize}
      {...VERTICAL}
      aria-valuenow={width}
      aria-valuemin={TESS_MIN_WIDTH}
      aria-valuemax={max}
      focusable
      style={styles.divider}
      onPointerDown={event => {
        // The primary button, a finger or a pen, and not a second finger: a
        // right-click's menu takes its release, which would leave the drag
        // following the pointer until some later click.
        const { button, isPrimary } = event.nativeEvent as {
          button?: number
          isPrimary?: boolean
        }
        if (button !== 0 || isPrimary === false) return
        // No text selected while the pointer drags.
        event.preventDefault()
        begin(event.nativeEvent.clientX)
      }}
      onKeyDown={event => {
        const key = (event.nativeEvent as { key?: string }).key
        const step =
          key === 'ArrowLeft'
            ? -TESS_WIDTH_STEP
            : key === 'ArrowRight'
              ? TESS_WIDTH_STEP
              : 0
        if (step === 0) return
        event.preventDefault()
        onResize(clampTessWidth(width + step, max), true)
      }}
    >
      <View style={styles.line} />
      <View testID="Tess divider grip" style={styles.grip} />
    </View>
  )
}

// The web's own attribute, which react-native's types leave out: a separator
// is horizontal unless it says otherwise.
const VERTICAL: Record<string, string> = { 'aria-orientation': 'vertical' }

const getStyles = cacheStyles((theme: Theme) => ({
  // Half the grab area each side of the line, which is the column's last
  // two points: it reaches five points over the pane.
  divider: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -5,
    width: 12,
    zIndex: 2,
    cursor: 'col-resize',
    touchAction: 'none'
  } as unknown as ViewStyle,
  // A 3-point line in the secondary text colour, dimmed so it reads as a
  // border rather than text, and a grip halfway down that says it drags.
  line: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 4.5,
    width: 3,
    backgroundColor: theme.secondaryTextColor,
    opacity: 0.45
  },
  grip: {
    position: 'absolute',
    top: '50%',
    marginTop: -22,
    left: 2,
    width: 8,
    height: 44,
    borderRadius: 4,
    backgroundColor: theme.secondaryTextColor,
    opacity: 0.8
  }
}))
