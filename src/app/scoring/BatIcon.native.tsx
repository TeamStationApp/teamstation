import React from 'react'
import { View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

/** A bat, knob down and barrel up, drawn where a lineup row's remove control was: this slot bats. */
export const BAT_ICON_PATH =
  'M5.60 19.60 L10.71 14.49 L17.14 10.11 L21.23 6.03 A2.30 2.30 0 0 0 17.97 2.77 L13.89 6.86 L9.51 13.29 L4.40 18.40 Z M2.88 19.42 a1.7 1.7 0 1 0 3.4 0 a1.7 1.7 0 1 0 -3.4 0 Z'

/** The bat icon, as a native `Svg`. */
export function BatIcon({
  label,
  color,
  size = 24
}: {
  label: string
  color: string
  size?: number
}): React.ReactElement {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      testID="batIcon"
      style={{ margin: 4 }}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={BAT_ICON_PATH} fill={color} />
      </Svg>
    </View>
  )
}
