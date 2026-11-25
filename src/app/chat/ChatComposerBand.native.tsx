import React from 'react'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'

import { dockShift } from '../screens/SearchDock.native'
import type { ChatComposerBandProps } from './ChatViewport'

/** The list and the composer read the same keyboard frames on the UI thread. */
export function ChatComposerBand({
  viewport,
  active,
  frame,
  tabletLift,
  style,
  ...rest
}: ChatComposerBandProps): React.ReactElement {
  const { bottom, gap, consumed } = viewport.composerDock
  const follow = active && viewport.composerDock.follow
  const ride = useAnimatedStyle(() => {
    if (tabletLift != null)
      return { transform: [{ translateY: follow ? -tabletLift.value : 0 }] }
    const position = frame?.value
    const lift =
      follow && position != null
        ? dockShift(-position.height, position.progress, bottom - gap) +
          Math.min(consumed, Math.max(0, position.height))
        : 0
    return { transform: [{ translateY: lift }] }
  }, [bottom, gap, consumed, follow, frame, tabletLift])
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
