import React, { type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

/** On a phone or tablet the layer covers the pane it is drawn in. */
export function TessOverlayLayer({
  children
}: {
  children: ReactNode
}): React.ReactElement {
  return (
    <View testID="Tess overlay" style={[StyleSheet.absoluteFill, LAYER]}>
      {children}
    </View>
  )
}

/** Above the pane's header and banner, which float over the pane too. */
const LAYER = { zIndex: 10 }
