/**
 * The two gradient packages the board can be drawn with, neither of which
 * ships types this app can use.
 *
 * `react-native-web-linear-gradient` draws the board's gradients in a browser
 * (`linearGradient.tsx`), as 1.0's webpack did. `react-native-linear-gradient`
 * is 1.0's own import, which the web build still aliases to the web package
 * (`scripts/web-build-settings.mjs`) for anything else that names it; the
 * native package is not installed, because a phone draws the board's
 * gradients with `react-native-svg` instead (`linearGradient.native.tsx`).
 *
 * Its own file, not `linearGradient.d.ts`: a declaration file beside a
 * same-named `.tsx` is dropped by tsc. These are the props the board passes.
 */
declare module 'react-native-web-linear-gradient' {
  import type { ComponentType, ReactNode } from 'react'
  import type { StyleProp, ViewStyle } from 'react-native'

  interface LinearGradientProps {
    colors: string[]
    start?: { x: number; y: number }
    end?: { x: number; y: number }
    style?: StyleProp<ViewStyle>
    children?: ReactNode
  }
  const LinearGradient: ComponentType<LinearGradientProps>
  export default LinearGradient
}

declare module 'react-native-linear-gradient' {
  import type { ComponentType, ReactNode } from 'react'
  import type { StyleProp, ViewStyle } from 'react-native'

  interface LinearGradientProps {
    colors: string[]
    start?: { x: number; y: number }
    end?: { x: number; y: number }
    style?: StyleProp<ViewStyle>
    children?: ReactNode
  }
  const LinearGradient: ComponentType<LinearGradientProps>
  export default LinearGradient
}
