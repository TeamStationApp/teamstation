import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { Insets } from './insets'

export type { Insets }

/**
 * What the hardware takes out of the window.
 *
 * On a phone this is the status bar and the Dynamic Island at the top, the home
 * indicator at the bottom, and — held sideways — the notch at one edge and the
 * rounded corner at the other. React Native 0.87 draws Android edge to edge by
 * default, so both platforms need this rather than only iOS.
 *
 * It changes on rotation, and everything that reads it re-renders when it does.
 */
export function useInsets(): Insets {
  return useSafeAreaInsets()
}
