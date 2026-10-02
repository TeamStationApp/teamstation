import { useEffect, useState } from 'react'

import { AT_BAT_SWEEP_MS } from './atBatColors'

/** How far the string has been pulled, from 0 to 1, one lap per period. */
export function useRingOffset(): number {
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    let frame = 0
    const start = performance.now()
    const tick = (now: number): void => {
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
