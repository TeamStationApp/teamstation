import React, { useLayoutEffect, useMemo, useState } from 'react'
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
  const [keyboardOwnsBand] = useState(
    () => new Animated.Value(following ? 1 : 0)
  )
  useLayoutEffect(() => {
    keyboardOwnsBand.setValue(following ? 1 : 0)
  }, [following, keyboardOwnsBand])
  const translateY = useMemo(() => {
    const lift = Animated.add(
      height,
      Animated.multiply(progress, bottom - gap)
    ).interpolate({
      inputRange: [-1, 0],
      outputRange: [-1, 0],
      extrapolateRight: 'clamp'
    })
    // Android may already have resized part of the window for this keyboard.
    const remaining =
      consumed <= 0
        ? lift
        : Animated.add(
            lift,
            Animated.multiply(height, -1).interpolate({
              inputRange: [0, consumed],
              outputRange: [0, consumed],
              extrapolate: 'clamp'
            })
          )
    // Keep the native transform attached so the drawer can clear an in-flight IME offset.
    return Animated.multiply(remaining, keyboardOwnsBand)
  }, [bottom, consumed, gap, height, keyboardOwnsBand, progress])
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
