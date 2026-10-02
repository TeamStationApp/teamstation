import React from 'react'
import { View } from 'react-native'

import { webStyle } from './glass'
import type { GradientProps } from './gradientProps'

export type { GradientProps }

/**
 * The scrim: transparent at the top, seven-tenths black at the bottom.
 *
 * One fade, not a general-purpose gradient. It exists so that a score or a
 * duration set in white over a photograph can be read whether the photograph
 * is a bright sky or a dark dugout, and it belongs to the picture in a way a
 * pill behind the text does not — a pill reads as pasted on.
 *
 * A browser draws it with a CSS gradient, which React Native has no name for;
 * `Gradient.native.tsx` draws the same two stops with `react-native-svg`.
 * Nothing above this component knows which.
 */
export function Gradient(props: GradientProps): React.ReactElement {
  return (
    <View
      pointerEvents="none"
      style={[
        props.style,
        webStyle({
          backgroundImage:
            'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%)'
        })
      ]}
    />
  )
}
