export interface ScoringClock {
  now: () => number
  schedule: (callback: () => void, delay: number) => unknown
  cancel: (id: unknown) => void
}
export const scoringClock: ScoringClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: id => {
    clearTimeout(id as ReturnType<typeof setTimeout>)
  }
}
/** A paused clock retains its remainder; edits replace its revision in the reducer. */
export function runCorrectionClock(
  clock: ScoringClock,
  tick: (elapsed: number) => void
): () => void {
  let previous = clock.now()
  let live = true
  let timer: unknown
  const run = (): void => {
    if (!live) return
    const now = clock.now()
    tick(Math.max(0, now - previous))
    previous = now
    if (live) timer = clock.schedule(run, 50)
  }
  timer = clock.schedule(run, 50)
  return () => {
    live = false
    clock.cancel(timer)
  }
}
