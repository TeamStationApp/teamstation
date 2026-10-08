import type React from 'react'
import { findNodeHandle, TurboModuleRegistry, type View } from 'react-native'

import type { Spec } from '../feedback/NativeHaptics'

/** The bridge may not exist yet in an older development binary. */
export function lightHaptic(
  view?: React.ComponentRef<typeof View> | null
): void {
  try {
    const tag = view == null ? null : findNodeHandle(view)
    if (tag != null) TurboModuleRegistry.get<Spec>('TSHaptics')?.light(tag)
  } catch {
    // Native feedback must never fail or cancel the gesture.
  }
}
