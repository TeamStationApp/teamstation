import React from 'react'
import { View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { canBlur, glassStyle } from './glass'
import type { GlassViewProps } from './glassViewProps'

export type { GlassViewProps }

/**
 * A pane of glass: translucent, with the content blurred behind it.
 *
 * A component rather than the style `glassStyle` returns, because on a phone
 * glass is a **view** — a piece of the system's own material — and not a set
 * of properties. Here it is still the style, applied to the `View` it always
 * was, so the DOM this renders is unchanged.
 */
export function GlassView(props: GlassViewProps): React.ReactElement {
  const { children, style, opaque = false, fallbackFill = true, ...rest } =
    props
  const theme = useTheme()
  // A surface that is already on glass and cannot have real glass draws
  // nothing, rather than a flat tint over the blur beneath it. Where this
  // browser *can* blur there is no fallback to skip, so nothing changes.
  const plain = !fallbackFill && !opaque && !canBlur
  return (
    <View {...rest} style={[style, !plain && glassStyle(theme, opaque)]}>
      {children}
    </View>
  )
}
