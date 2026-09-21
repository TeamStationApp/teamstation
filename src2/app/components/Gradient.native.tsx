import React from 'react'
import { View } from 'react-native'
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg'

import type { GradientProps } from './gradientProps'

export type { GradientProps }

/**
 * The scrim: transparent at the top, seven-tenths black at the bottom.
 *
 * The same two stops the web file writes as a CSS gradient. `react-native-svg`
 * rather than a gradient library, because the mark already needs it — one
 * dependency doing two jobs rather than two doing one each.
 *
 * The `Svg` fills the `View` rather than being sized directly, so the caller
 * goes on positioning a box in the ordinary way — `bottom: 0`, a percentage
 * height — and this file is only ever asked what colour it is.
 */
export function Gradient(props: GradientProps): React.ReactElement {
  return (
    <View pointerEvents="none" style={props.style}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={0.7} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#scrim)" />
      </Svg>
    </View>
  )
}
