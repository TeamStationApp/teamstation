import type { ViewStyle } from 'react-native'

import { useInsets } from '../platform/safeArea'

// Translucent fallback until the native renderer chooses its blur host.
export const glassStyle: ViewStyle = {}
export function useFieldSurface(): { root: ViewStyle; safe: ViewStyle } {
  const insets = useInsets()
  return {
    root: { flex: 1, overflow: 'hidden' },
    safe: {
      paddingTop: Math.max(8, insets.top),
      paddingBottom: Math.max(8, insets.bottom),
      paddingLeft: Math.max(8, insets.left),
      paddingRight: Math.max(8, insets.right)
    }
  }
}
