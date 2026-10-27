/**
 * How often a drag along the bar, or across the pictures, may seek the
 * players while the finger is still moving.
 *
 * Every move used to seek every player: dozens of seeks a second — a phone
 * reported sixty-five in the second of one drag — and a player given that
 * many can wedge, its data in hand and its picture stopped, with nothing left
 * to tell it to go on. Four a second keeps the picture following the finger;
 * the place the finger lifts is always sought, whatever the clock.
 */
export const SCRUB_SEEK_MS = 250

export interface ScrubSeeks {
  /** The finger has moved to here: seek now, or at the next allowed moment. */
  move: (wallMs: number) => void
  /** The finger has lifted here: seek there now, and drop any seek still waiting. */
  end: (wallMs: number) => void
  /** Drop any seek still waiting, as the view goes. */
  cancel: () => void
}

export interface ScrubClock {
  now: () => number
  set: (run: () => void, ms: number) => unknown
  clear: (timer: unknown) => void
}

const realClock: ScrubClock = {
  now: Date.now,
  set: (run, ms) => setTimeout(run, ms),
  clear: timer => {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/**
 * A drag's seeks: the first at once, then at most one every `everyMs`, each
 * to the newest place the finger has reached, and always the place it lifts.
 */
export function scrubSeeks(
  seek: (wallMs: number) => void,
  everyMs: number = SCRUB_SEEK_MS,
  clock: ScrubClock = realClock
): ScrubSeeks {
  let last = -Infinity
  let waiting: number | null = null
  let timer: unknown = null

  const stop = (): void => {
    if (timer != null) clock.clear(timer)
    timer = null
    waiting = null
  }

  const now = (wallMs: number): void => {
    last = clock.now()
    seek(wallMs)
  }

  return {
    move: wallMs => {
      const wait = everyMs - (clock.now() - last)
      if (wait <= 0 && timer == null) {
        now(wallMs)
        return
      }
      waiting = wallMs
      if (timer != null) return
      timer = clock.set(
        () => {
          timer = null
          const at = waiting
          waiting = null
          if (at != null) now(at)
        },
        Math.max(0, wait)
      )
    },
    end: wallMs => {
      stop()
      now(wallMs)
    },
    cancel: stop
  }
}
