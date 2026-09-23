import type { ViewStyle } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { fieldSafePadding } from './fieldSafeArea'

// Translucent fallback until the native renderer chooses its blur host.
export const glassStyle: ViewStyle = {}
export function useFieldSurface(): { root: ViewStyle; safe: ViewStyle } {
  const insets = useInsets()
  return {
    root: { flex: 1, overflow: 'hidden' },
    safe: fieldSafePadding(insets)
  }
}
