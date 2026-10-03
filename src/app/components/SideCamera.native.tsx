import React from 'react'
import Svg, { Path } from 'react-native-svg'

import { useTheme } from '../theme/ThemeContext'

/**
 * The same side-view camera as the web file, drawn with `react-native-svg`.
 */
export function SideCamera(): React.ReactElement {
  const theme = useTheme()
  const width = theme.rem(1.25)
  const height = theme.rem(1)
  const color = theme.secondaryTextColor
  return (
    <Svg
      width={width}
      height={height}
      viewBox="0 0 20 16"
      accessibilityLabel="Video"
      pointerEvents="none"
      fill={color}
    >
      <Path d="M4 4.2V2.7A1.2 1.2 0 0 1 5.2 1.5h2.6A1.2 1.2 0 0 1 9 2.7v1.5z" />
      <Path d="M1.2 5.2A1.6 1.6 0 0 1 2.8 3.6h8.4A1.6 1.6 0 0 1 12.8 5.2v6.2A1.6 1.6 0 0 1 11.2 13H2.8A1.6 1.6 0 0 1 1.2 11.4z" />
      <Path d="M12.8 6.3 18.2 4.4a.7.7 0 0 1 1 .6v6.6a.7.7 0 0 1-1 .6l-5.4-1.9z" />
    </Svg>
  )
}
