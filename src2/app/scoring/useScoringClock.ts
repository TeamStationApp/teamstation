import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'

import {
  runCorrectionClock,
  type ScoringClock,
  scoringClock
} from './scoringClock'
import type { ScoringEvent, ScoringState } from './scoringTypes'
export function useScoringClock(
  state: ScoringState,
  paused: boolean,
  dispatch: (event: ScoringEvent) => void,
  clock: ScoringClock = scoringClock
): () => void {
  const activeStop = useRef<(() => void) | null>(null)
  const pauseNow = useCallback(() => {
    activeStop.current?.()
    activeStop.current = null
  }, [])
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const change = (): void => {
      setHidden(document.hidden)
    }
    document.addEventListener('visibilitychange', change)
    return () => {
      document.removeEventListener('visibilitychange', change)
    }
  }, [])
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
      if (!document.hidden)
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
  }, [clock, dispatch, hidden, paused, revision, state.generation, state.phase])
  return pauseNow
}
