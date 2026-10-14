import React from 'react'
import {
  Platform,
  processColor,
  requireNativeComponent,
  StyleSheet,
  View
} from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import { backdropOf } from './glassBackdrop'
import type { GlassViewProps } from './glassViewProps'

export type { GlassViewProps }

/**
 * The system's own glass, on iOS; a filled surface on Android.
 *
 * iOS 26 draws `UIGlassEffect` — the material its own bars are made of, which
 * refracts and highlights what passes beneath rather than merely blurring it —
 * and earlier versions draw `systemThinMaterial`, which is what the web app's
 * `backdrop-filter` was imitating. `TSGlassView.mm` decides between them.
 *
 * Android gets `theme.glassFallbackColor` and an elevation, which is exactly
 * the branch `glassStyle` already takes in a browser without
 * `backdrop-filter`. Blurring a view's backdrop on Android means recording
 * that backdrop again every frame, under a scrolling list, for a tint that is
 * already legible without it — so only a surface that asks (`androidBlur`)
 * gets `TSBlurView`, the web's blur and tint drawn over a recording of what
 * is behind it.
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
        glassDark?: boolean
        glassBackdropBlur?: boolean
      }>('TSGlassView')
    : null
const NativeBlur =
  Platform.OS === 'android'
    ? requireNativeComponent<{
        style?: unknown
        blurRadius?: number
        blurTint?: number
        blurSaturation?: number
        blurCornerRadius?: number
      }>('TSBlurView')
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
    androidBlur = false,
    backdropBlur = false,
    dark = false,
    ...rest
  } = props
  const appTheme = useTheme()
  const theme = dark ? tsDark : appTheme

  // Android, asked to blur: the backdrop, blurred, under the web's tint.
  if (NativeBlur != null && androidBlur && !opaque) {
    const { radius: blur, saturation } = backdropOf(theme.glassBlur)
    const tint = processColor(theme.glassBackgroundColor)
    return (
      <View {...rest} style={style}>
        <NativeBlur
          style={StyleSheet.absoluteFill}
          blurRadius={blur}
          blurTint={typeof tint === 'number' ? tint : 0}
          blurSaturation={saturation}
          blurCornerRadius={radius}
        />
        {children}
      </View>
    )
  }

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
        glassBackdropBlur={backdropBlur}
        // The app's theme, not the phone's Dark Mode: see `TSGlassView.mm`.
        glassDark={theme.isDark}
      />
      {children}
    </View>
  )
}
