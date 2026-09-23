import { AppState } from 'react-native'

import { type ScoringClock, scoringClock } from './scoringClock'
import type { ScoringEvent, ScoringState } from './scoringTypes'
import { type ScreenVisibility, useCorrectionClock } from './useCorrectionClock'
/**
 * The app is hidden in the background, as a web page is in a background tab.
 * iOS's `inactive` (Notification Centre pulled over it, a system alert) is
 * still visible, as the same page would be, so the window keeps counting.
 */
export const appVisibility: ScreenVisibility = {
  hidden: () => AppState.currentState === 'background',
  subscribe: change => {
    const subscription = AppState.addEventListener('change', change)
    return () => {
      subscription?.remove()
    }
  }
}
export function useScoringClock(
  state: ScoringState,
  paused: boolean,
  dispatch: (event: ScoringEvent) => void,
  clock: ScoringClock = scoringClock
): () => void {
  return useCorrectionClock(state, paused, dispatch, clock, appVisibility)
}
