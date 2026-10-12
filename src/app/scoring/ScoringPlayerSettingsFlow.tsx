import React from 'react'
import { Platform, View } from 'react-native'

/** Keep the scorer's session mounted while the normal light shell shows its
 * child. Native scoring modals are suspended by the scorer independently.
 */
export function ScoringPlayerSettingsFlow({
  scoring,
  active,
  children
}: {
  scoring?: React.ReactNode
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <View style={{ flex: 1 }}>
      {scoring != null && (
        <View
          key="retained-scorer"
          pointerEvents={active ? 'auto' : 'none'}
          accessibilityElementsHidden={!active}
          aria-hidden={!active}
          importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
          // A native Modal needs its host attached to the window to present
          // an exit confirmation over the light child. The field is suspended
          // separately, and this host cannot receive pointer/accessibility input.
          style={
            active
              ? { flex: 1 }
              : Platform.OS === 'web'
                ? { display: 'none' }
                : { position: 'absolute', inset: 0, opacity: 0 }
          }
        >
          {scoring}
        </View>
      )}
      {!active && (
        <View key="scoring-child" style={{ flex: 1 }}>
          {children}
        </View>
      )}
    </View>
  )
}
