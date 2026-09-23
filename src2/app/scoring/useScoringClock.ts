import { type ScoringClock, scoringClock } from './scoringClock'
import type { ScoringEvent, ScoringState } from './scoringTypes'
import { type ScreenVisibility, useCorrectionClock } from './useCorrectionClock'
/** The page is hidden while its tab is in the background. */
export const pageVisibility: ScreenVisibility = {
  hidden: () => document.hidden,
  subscribe: change => {
    document.addEventListener('visibilitychange', change)
    return () => {
      document.removeEventListener('visibilitychange', change)
    }
  }
}
export function useScoringClock(
  state: ScoringState,
  paused: boolean,
  dispatch: (event: ScoringEvent) => void,
  clock: ScoringClock = scoringClock
): () => void {
  return useCorrectionClock(state, paused, dispatch, clock, pageVisibility)
}
