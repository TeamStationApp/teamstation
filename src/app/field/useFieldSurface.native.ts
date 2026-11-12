import type { ViewStyle } from 'react-native'

import type { Insets } from '../platform/insets'
import { useInsets } from '../platform/safeArea.native'
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

/** The hardware insets in points: the safe area's own numbers. */
export function useFieldInsets(): Insets {
  return useInsets()
}
