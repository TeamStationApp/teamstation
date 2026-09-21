import React from 'react'
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  View
} from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import type { GlassViewProps } from './glassViewProps'

export type { GlassViewProps }

/**
 * The system's own glass, on iOS; a filled surface on Android.
 *
 * iOS 26 draws `UIGlassEffect` — the material its own bars are made of, which
 * refracts and highlights what passes beneath rather than merely blurring it —
 * and earlier versions draw `systemThinMaterial`, which is what the web app's
 * `backdrop-filter` was imitating. `GSGlassView.mm` decides between them.
 *
 * Android gets `theme.glassFallbackColor` and an elevation, and that is not a
 * shortfall: it is exactly the branch `glassStyle` already takes in a browser
 * without `backdrop-filter`, so it is a rendering the design already has.
 * Blurring a view's backdrop on Android means compositing that backdrop to a
 * bitmap every frame, under a scrolling list, for a tint that is already
 * legible without it.
 *
 * The glass is drawn **behind** the children rather than around them, so it
 * never takes part in React's child ordering and nothing can end up beneath
 * the material by accident.
 */
const NativeGlass =
  Platform.OS === 'ios'
    ? requireNativeComponent<{
        style?: unknown
        glassInteractive?: boolean
        glassClear?: boolean
        glassRadius?: number
      }>('GSGlassView')
    : null

export function GlassView(props: GlassViewProps): React.ReactElement {
  const {
    children,
    style,
    opaque = false,
    interactive = false,
    radius = 0,
    clear = false,
    fallbackFill = true,
    ...rest
  } = props
  const theme = useTheme()

  // Android, or a reader who has asked for less transparency. Both want the
  // same thing — the filled surface `glassStyle` falls back to in a browser
  // that cannot blur — and neither wants a colour crossing the bridge.
  if (NativeGlass == null || opaque) {
    // `opaque` is somebody asking for a filled surface, so it always gets
    // one; `fallbackFill` is about a surface that is already on glass and
    // only wants the real thing.
    const plain = !fallbackFill && !opaque
    return (
      <View
        {...rest}
        style={[
          style,
          !plain && {
            backgroundColor: theme.glassFallbackColor,
            elevation: Platform.OS === 'android' ? 3 : 0
          }
        ]}
      >
        {children}
      </View>
    )
  }

  return (
    <View {...rest} style={style}>
      <NativeGlass
        style={StyleSheet.absoluteFill}
        glassInteractive={interactive}
        glassClear={clear}
        glassRadius={radius}
      />
      {children}
    </View>
  )
}
