import React from 'react'
import { View } from 'react-native'

/** Draws `children` in `box`, given as fractions of the sample's frame. */
export function OverlayAt({
  box,
  children,
  testID
}: {
  box: { x: number; y: number; width: number; height: number }
  children: React.ReactNode
  testID?: string
}): React.ReactElement {
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`
      }}
    >
      {children}
    </View>
  )
}
