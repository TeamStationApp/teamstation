import React, { useMemo, useRef } from 'react'
import { PanResponder, View } from 'react-native'

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
 * The right edge of Tess's column on an iPad or a wide tablet: see
 * `TessDivider.tsx`. A finger drags it with a PanResponder, at most once a
 * frame; VoiceOver and TalkBack adjust it 16 points a swipe.
 */
export function TessDivider({
  width,
  max,
  onResize
}: TessDividerProps): React.ReactElement {
  const styles = getStyles(useTheme())
  // The responder is made once; it reads the latest props from here.
  const latest = useRef({ width, max, onResize })
  latest.current = { width, max, onResize }
  const responder = useMemo(() => {
    let from = 0
    const throttled = frameThrottle((next: number) => {
      latest.current.onResize(next, false)
    })
    const widthAt = (dx: number): number =>
      clampTessWidth(from + dx, latest.current.max)
    const end = (dx: number): void => {
      throttled.cancel()
      latest.current.onResize(widthAt(dx), true)
    }
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // A list or a sheet under the finger does not take the drag away.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        from = latest.current.width
      },
      onPanResponderMove: (_event, gesture) => {
        throttled(widthAt(gesture.dx))
      },
      onPanResponderRelease: (_event, gesture) => {
        end(gesture.dx)
      },
      onPanResponderTerminate: (_event, gesture) => {
        end(gesture.dx)
      }
    })
  }, [])
  return (
    <View
      testID="Tess divider"
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={lstrings.tess_resize}
      accessibilityValue={{ min: TESS_MIN_WIDTH, max, now: width }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={event => {
        const step =
          event.nativeEvent.actionName === 'increment'
            ? TESS_WIDTH_STEP
            : -TESS_WIDTH_STEP
        onResize(clampTessWidth(width + step, max), true)
      }}
      hitSlop={{ left: 8, right: 8 }}
      style={styles.divider}
      {...responder.panHandlers}
    >
      <View style={styles.line} />
      <View testID="Tess divider grip" style={styles.grip} />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // As on the web: a 12-point grab area centred on the column's last two
  // points.
  divider: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -5,
    width: 12,
    zIndex: 2
  },
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
