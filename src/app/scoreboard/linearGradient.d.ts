/**
 * `react-native-linear-gradient` is 1.0's scoreboard's import, which the web
 * build aliases to `react-native-web-linear-gradient`
 * (`scripts/web-build-settings.mjs`), as 1.0's webpack did. That package ships no types, and the native package
 * that does is not installed, because it would be linked into the phone apps
 * that never draw the board. These are the props the board passes it.
 */
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
