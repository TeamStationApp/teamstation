import { useMemo } from 'react'

import {
  EXIT_WIPE_MS,
  type ExitReading,
  exitReturnAt
} from '../../common/scoreboard'

/** The wall time of the displayed picture, or of a live socket message. */
export interface BoardClock {
  now: () => number | null
  subscribe: (tick: () => void) => () => void
}

/** Share the player's existing frame samples with the batter row. */
export function usePictureClock(): BoardClock & {
  sample: (wall: number | null) => void
} {
  return useMemo(() => {
    let wall: number | null = null
    const listeners = new Set<() => void>()
    return {
      now: () => wall,
      subscribe(tick: () => void) {
        listeners.add(tick)
        return () => {
          listeners.delete(tick)
        }
      },
      sample(next: number | null) {
        if (next === wall) return
        wall = next
        for (const tick of listeners) tick()
      }
    }
  }, [])
}

/** Anchor at socket receipt; sleep through the hold and stop at expiry. */
export function liveBoardClock(
  serverNow: number,
  reading: ExitReading
): BoardClock {
  const received = performance.now()
  const now = (): number => serverNow + (performance.now() - received)
  return {
    now,
    subscribe(listener) {
      const returns = exitReturnAt(reading)
      let frame: number | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const tick = (): void => {
        const time = now()
        listener()
        if (time < reading.startedAt)
          timer = setTimeout(tick, reading.startedAt - time)
        else if (time >= reading.startedAt + EXIT_WIPE_MS && time < returns)
          timer = setTimeout(tick, returns - time)
        else if (time < returns + EXIT_WIPE_MS)
          frame = requestAnimationFrame(tick)
      }
      tick()
      return () => {
        if (frame != null) cancelAnimationFrame(frame)
        clearTimeout(timer)
      }
    }
  }
}
