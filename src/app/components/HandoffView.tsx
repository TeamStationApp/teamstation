import React from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import Animated, { type SharedValue } from 'react-native-reanimated'

import { useHandoffStyle } from './useHandoff'

export interface HandoffViewProps {
  progress: SharedValue<number>
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}

/**
 * The copy that lives in the header, fading up as the original leaves.
 *
 * A component rather than a style a screen applies itself, because the style
 * comes from `useAnimatedStyle` and is a fresh object on every render. A screen
 * that put one in the dependencies of the node it hands to the header would
 * hand over a new node every render, which sets state in the shell, which
 * renders the screen again: the app hangs on the first paint. Keeping the hook
 * inside here means a screen memoises on its own data and nothing else.
 */
export function HandoffView(props: HandoffViewProps): React.ReactElement {
  const { progress, style, children } = props
  const animated = useHandoffStyle(progress)
  // Named so a test can find it: this is the piece whose timing is the whole
  // point, and it has no text of its own to search for.
  return (
    <Animated.View nativeID="headerHandoff" style={[style, animated]}>
      {children}
    </Animated.View>
  )
}
