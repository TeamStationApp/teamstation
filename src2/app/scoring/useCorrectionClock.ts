import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import { runCorrectionClock, type ScoringClock } from './scoringClock'
import type { ScoringEvent, ScoringState } from './scoringTypes'
/** Whether the scorer can see the screen: the page's, or the app's. */
export interface ScreenVisibility {
  hidden: () => boolean
  /** Calls `change` whenever `hidden()` may have changed; returns the unsubscribe. */
  subscribe: (change: () => void) => () => void
}
/**
 * The correction window's countdown. It ticks from a monotonic clock while
 * the window is open, stops while anything pauses it or the screen is hidden,
 * and keeps its remainder across a pause. The returned function stops it at
 * once, before React has re-rendered with the pause.
 */
export function useCorrectionClock(
  state: ScoringState,
  paused: boolean,
  dispatch: (event: ScoringEvent) => void,
  clock: ScoringClock,
  visibility: ScreenVisibility
): () => void {
  const activeStop = useRef<(() => void) | null>(null)
  const pauseNow = useCallback(() => {
    activeStop.current?.()
    activeStop.current = null
  }, [])
  const [hidden, setHidden] = useState(() => visibility.hidden())
  useEffect(() => {
    setHidden(visibility.hidden())
    return visibility.subscribe(() => {
      setHidden(visibility.hidden())
    })
  }, [visibility])
  const revision = state.correctionWindow?.revision
  useLayoutEffect(() => {
    if (
      paused ||
      hidden ||
      state.phase !== 'correctionWindow' ||
      revision == null
    )
      return
    const stop = runCorrectionClock(clock, elapsedMs => {
      if (!visibility.hidden())
        dispatch({
          type: 'TIMER_TICK',
          elapsedMs,
          generation: state.generation,
          revision
        })
    })
    activeStop.current = stop
    return () => {
      stop()
      if (activeStop.current === stop) activeStop.current = null
    }
  }, [
    clock,
    dispatch,
    hidden,
    paused,
    revision,
    state.generation,
    state.phase,
    visibility
  ])
  return pauseNow
}
