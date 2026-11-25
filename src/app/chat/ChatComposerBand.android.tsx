import React, { useMemo } from 'react'
import { Animated } from 'react-native'
import { useKeyboardContext } from 'react-native-keyboard-controller'

import type { ChatComposerBandProps } from './ChatViewport'

/** Bind the transform to the native IME event, in the same pass as the inset. */
export function ChatComposerBand({
  viewport,
  active,
  frame: _frame,
  tabletLift: _tabletLift,
  style,
  ...rest
}: ChatComposerBandProps): React.ReactElement {
  const { height, progress } = useKeyboardContext().animated
  const { bottom, gap, consumed, follow } = viewport.composerDock
  const following = active && follow
  const translateY = useMemo(() => {
    if (!following) return 0
    const lift = Animated.add(
      height,
      Animated.multiply(progress, bottom - gap)
    ).interpolate({
      inputRange: [-1, 0],
      outputRange: [-1, 0],
      extrapolateRight: 'clamp'
    })
    if (consumed <= 0) return lift
    // Android may already have resized part of the window for this keyboard.
    return Animated.add(
      lift,
      Animated.multiply(height, -1).interpolate({
        inputRange: [0, consumed],
        outputRange: [0, consumed],
        extrapolate: 'clamp'
      })
    )
  }, [bottom, consumed, following, gap, height, progress])
  return (
    <Animated.View
      {...rest}
      style={[
        style,
        {
          bottom: following ? bottom : viewport.composerBottom,
          transform: [{ translateY }]
        }
      ]}
    />
  )
}
