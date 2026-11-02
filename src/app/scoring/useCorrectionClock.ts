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
 * and keeps its remainder across a pause. `pause` stops it at once, before
 * React has re-rendered. `resume` starts it again while the window is still
 * open and nothing else is holding it.
 */
export function useCorrectionClock(
  state: ScoringState,
  paused: boolean,
  dispatch: (event: ScoringEvent) => void,
  clock: ScoringClock,
  visibility: ScreenVisibility,
  /** While set, ticks keep the remainder and do not close the play. */
  held?: { current: boolean }
): { pause: () => void; resume: () => void } {
  const activeStop = useRef<(() => void) | null>(null)
  const [resumeTick, setResumeTick] = useState(0)
  const pauseNow = useCallback(() => {
    activeStop.current?.()
    activeStop.current = null
  }, [])
  const resumeNow = useCallback(() => {
    setResumeTick(tick => tick + 1)
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
      if (held?.current === true || visibility.hidden()) return
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
    held,
    hidden,
    paused,
    revision,
    state.generation,
    state.phase,
    visibility,
    resumeTick
  ])
  return { pause: pauseNow, resume: resumeNow }
}
