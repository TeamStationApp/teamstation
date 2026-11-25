import React from 'react'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'

import { dockShift } from '../screens/SearchDock.native'
import type { ChatComposerBandProps } from './ChatViewport'

/** The list and the composer read the same keyboard frames on the UI thread. */
export function ChatComposerBand({
  viewport,
  active,
  style,
  ...rest
}: ChatComposerBandProps): React.ReactElement {
  const { height, progress } = useReanimatedKeyboardAnimation()
  const { bottom, gap, consumed } = viewport.composerDock
  const follow = active && viewport.composerDock.follow
  const ride = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateY: follow
            ? dockShift(height.value, progress.value, bottom - gap) +
              Math.min(consumed, Math.max(0, -height.value))
            : 0
        }
      ]
    }),
    [bottom, gap, consumed, follow]
  )
  return (
    <Animated.View
      {...rest}
      style={[
        style,
        { bottom: follow ? bottom : viewport.composerBottom },
        ride
      ]}
    />
  )
}
