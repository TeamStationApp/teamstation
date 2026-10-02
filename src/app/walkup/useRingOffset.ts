import { useEffect, useState } from 'react'

import { AT_BAT_SWEEP_MS } from './atBatColors'

/** How far the string has been pulled, from 0 to 1, one lap per period. */
export function useRingOffset(): number {
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    let frame = 0
    // Timed from the first frame's own stamp, on the clock the frames keep.
    // React Native's types leave out `performance`, so the phone's build
    // cannot name it.
    let start: number | undefined
    const tick = (now: number): void => {
      start ??= now
      const next = ((now - start) / AT_BAT_SWEEP_MS) % 1
      setOffset(current => (Math.abs(current - next) < 0.01 ? current : next))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [])
  return offset
}
