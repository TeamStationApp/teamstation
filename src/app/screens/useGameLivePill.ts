import { useEffect, useState } from 'react'

import type { EventTabState } from './eventTabPolicy'
import { gameLiveWindow, showGameLivePill } from './livePillPolicy'

/** Keeps mounted cards current when the clock crosses either LIVE boundary. */
export function useGameLivePill(event?: EventTabState): boolean {
  const [clock, setClock] = useState(Date.now)
  const [start, end] =
    event == null ? [null, null] : (gameLiveWindow(event) ?? [null, null])
  useEffect(() => {
    if (start == null || end == null) return
    const now = Date.now()
    const marks = [start, end + 1]
    if (marks.some(mark => clock < mark && mark <= now)) {
      setClock(now)
      return
    }
    const pending = marks.filter(mark => mark > now)
    if (pending.length === 0) return
    const timer = setTimeout(
      () => {
        setClock(Date.now())
      },
      Math.min(2147483647, Math.min(...pending) - now + 1)
    )
    return () => {
      clearTimeout(timer)
    }
  }, [start, end, clock])
  return event != null && showGameLivePill(event, Math.max(clock, Date.now()))
}
