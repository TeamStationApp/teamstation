import { useEffect, useRef } from 'react'

import { type ScoringClock, scoringClock } from './scoringClock'
import type { HomeRunCelebration, ScoringEvent } from './scoringTypes'
export const CELEBRATION_MS = 6000
export function useHomeRunCelebration(
  celebration: HomeRunCelebration | null | undefined,
  paused: boolean,
  dispatch: (event: ScoringEvent) => void,
  clock: ScoringClock = scoringClock
): void {
  const budget = useRef({ id: '', remaining: CELEBRATION_MS })
  const id = celebration?.id
  const generation = celebration?.generation
  useEffect(() => {
    if (id == null || generation == null) {
      budget.current.id = ''
      return
    }
    if (budget.current.id !== id)
      budget.current = { id, remaining: CELEBRATION_MS }
    if (paused) return
    const started = clock.now()
    let live = true
    const timer = clock.schedule(() => {
      if (live) dispatch({ type: 'CELEBRATION_DONE', id, generation })
    }, budget.current.remaining)
    return () => {
      live = false
      clock.cancel(timer)
      budget.current.remaining = Math.max(
        0,
        budget.current.remaining - (clock.now() - started)
      )
    }
  }, [clock, dispatch, generation, id, paused])
}
