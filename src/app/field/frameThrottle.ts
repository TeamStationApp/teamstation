/**
 * Hands on at most one value a frame: the latest.
 *
 * A finger reports more often than the screen draws — 120 times a second on
 * a ProMotion iPhone — and every report of the trajectory angle re-renders
 * the scoring screen. Coalesced to one per frame, the drag keeps up.
 */
export interface FrameThrottle<T> {
  (value: T): void
  /** Deliver the pending value now, if there is one. */
  flush: () => void
  /** Drop the pending value. */
  cancel: () => void
}

export function frameThrottle<T>(
  deliver: (value: T) => void,
  schedule: (run: () => void) => number = nextFrame,
  unschedule: (handle: number) => void = cancelFrame
): FrameThrottle<T> {
  let pending: { value: T } | undefined
  let handle: number | undefined
  const run = (): void => {
    handle = undefined
    const next = pending
    pending = undefined
    if (next != null) deliver(next.value)
  }
  const cancel = (): void => {
    if (handle != null) unschedule(handle)
    handle = undefined
    pending = undefined
  }
  return Object.assign(
    (value: T): void => {
      pending = { value }
      handle ??= schedule(run)
    },
    {
      flush: () => {
        if (handle != null) unschedule(handle)
        run()
      },
      cancel
    }
  )
}

// A frame where there is one; Node, which runs the tests, has none.
function nextFrame(run: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(run)
    : (setTimeout(run, 16) as unknown as number)
}
function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else clearTimeout(handle)
}
