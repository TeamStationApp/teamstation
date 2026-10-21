import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { Insets } from '../platform/insets'

/**
 * What the hardware takes out of the screen, for the full-screen grid: the
 * status bar or the camera, the home indicator or the gesture bar, and the
 * notch and the rounded corners sideways, from the grid's own
 * `SafeAreaProvider` inside its modal.
 */
export function useScreenInsets(): Insets {
  return useSafeAreaInsets()
}
