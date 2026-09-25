import React, { useEffect } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import type { FieldCanvasProps } from './fieldTypes'

/**
 * The bare RN host does not yet install Expo GL. Keep the public route usable
 * until the native integrator installs Expo modules and swaps this adapter for
 * Canvas from @react-three/fiber/native with the shared FieldScene children.
 * Never substitute a WebView for the native renderer.
 */
export function FieldCanvas(_props: FieldCanvasProps): React.ReactElement {
  const theme = useTheme()
  useEffect(() => {
    const sequence = _props.presentation
    if (sequence != null)
      _props.onPresentationDone?.(
        sequence.id,
        sequence.generation,
        sequence.stage
      )
  }, [_props])
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 32, gap: 12 }}>
      <Text style={{ color: theme.primaryTextColor, fontSize: 22 }}>
        Field lab
      </Text>
      <Text style={{ color: theme.secondaryTextColor }}>
        The interactive 3D preview is available on the web. Native rendering
        will be enabled in the next integration step.
      </Text>
    </View>
  )
}
