import React, { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { View } from 'react-native'

import { webStyle } from '../components/glass'
import { usePaneFrame } from '../components/useBreakpoint'

/**
 * On the web the layer is a fixed layer on the pane's frame, portalled into
 * the document body as the multi-angle view is. Drawn inside the app it
 * would stay under that view, a fixed layer at z-index 100 in the body,
 * whatever its own z-index: a chart opened from the chat has to show over
 * whatever the pane is showing.
 */
export function TessOverlayLayer({
  children
}: {
  children: ReactNode
}): React.ReactElement {
  const frame = usePaneFrame()
  return createPortal(
    <View
      testID="Tess overlay"
      style={webStyle({
        position: 'fixed',
        top: frame.y,
        left: frame.x,
        width: frame.width,
        height: frame.height,
        zIndex: 110
      })}
    >
      {children}
    </View>,
    document.body
  )
}
