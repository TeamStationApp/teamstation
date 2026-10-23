/**
 * A clock a test turns by hand, for animations measured frame by frame.
 *
 * Reanimated on the web takes an animation's start from `performance.now()`
 * and advances it on `requestAnimationFrame`. This replaces both: frames run
 * only inside `advance`, in 16 ms steps, each with its own timestamp, which is
 * recorded so a test can compute where an easing curve should be at the last
 * frame actually run rather than at a time that falls between frames.
 */
export interface FrameClock {
  /** Steps `ms` in 16 ms frames, running what each frame has queued. */
  advance: (ms: number) => void
  now: () => number
  /** The timestamps of every frame run so far. */
  frames: number[]
  restore: () => void
}

export const FRAME_MS = 16

export function installFrameClock(start = 1000): FrameClock {
  const scope = globalThis as unknown as {
    requestAnimationFrame: (callback: FrameRequestCallback) => number
    cancelAnimationFrame: (id: number) => void
  }
  const windowScope = window as unknown as typeof scope
  const saved = {
    request: scope.requestAnimationFrame,
    cancel: scope.cancelAnimationFrame,
    windowRequest: windowScope.requestAnimationFrame,
    windowCancel: windowScope.cancelAnimationFrame
  }
  let time = start
  let next = 1
  let queue = new Map<number, FrameRequestCallback>()
  const frames: number[] = []
  const request = (callback: FrameRequestCallback): number => {
    const id = next++
    queue.set(id, callback)
    return id
  }
  const cancel = (id: number): void => {
    queue.delete(id)
  }
  scope.requestAnimationFrame = request
  scope.cancelAnimationFrame = cancel
  windowScope.requestAnimationFrame = request
  windowScope.cancelAnimationFrame = cancel
  performance.now = () => time
  return {
    frames,
    now: () => time,
    advance(ms: number): void {
      const steps = Math.round(ms / FRAME_MS)
      for (let step = 0; step < steps; step++) {
        time += FRAME_MS
        frames.push(time)
        const due = queue
        queue = new Map()
        for (const callback of due.values()) callback(time)
      }
    },
    restore(): void {
      scope.requestAnimationFrame = saved.request
      scope.cancelAnimationFrame = saved.cancel
      windowScope.requestAnimationFrame = saved.windowRequest
      windowScope.cancelAnimationFrame = saved.windowCancel
      // The clock's own `now` shadowed the prototype's; this uncovers it.
      delete (performance as { now?: () => number }).now
    }
  }
}

/** The x and y offsets of an element's inline `transform`, in px. */
export function translationOf(element: HTMLElement): { x: number; y: number } {
  const transform = element.style.transform
  const x = /translateX\((-?[\d.e-]+)px\)/.exec(transform)
  const y = /translateY\((-?[\d.e-]+)px\)/.exec(transform)
  return { x: x == null ? 0 : Number(x[1]), y: y == null ? 0 : Number(y[1]) }
}
