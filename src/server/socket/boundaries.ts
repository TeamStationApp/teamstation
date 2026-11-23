/** The longest a timer waits; a later moment is waited for in steps. */
const LONGEST_WAIT_MS = 2 ** 31 - 1

/**
 * One-shot moments, by key, at which something read changes with nothing
 * written: a game entering the phone's window, a request expiring. Each key
 * holds one moment: `arm` replaces it, `armEarliest` keeps the sooner. It
 * never reads anything.
 */
export class BoundaryTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When each key's moment is. */
  private readonly moments = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  /** Runs `fire` once at `at`, in place of anything armed under `key`. */
  arm(key: string, at: number, fire: () => void): void {
    this.drop(key)
    this.moments.set(key, at)
    const wait = (): void => {
      const left = at - this.now()
      const timer = setTimeout(
        () => {
          if (this.timers.get(key) !== timer) return
          if (at - this.now() > 0) {
            wait()
            return
          }
          this.timers.delete(key)
          this.moments.delete(key)
          fire()
        },
        Math.max(0, Math.min(left, LONGEST_WAIT_MS))
      )
      this.timers.set(key, timer)
    }
    wait()
  }

  /**
   * Runs `fire` at `at` unless an earlier moment already waits under `key`:
   * where several readers name a moment for one key, the soonest is told,
   * and each of them names its own again once it has read.
   */
  armEarliest(key: string, at: number, fire: () => void): void {
    const armed = this.moments.get(key)
    if (armed != null && armed <= at && this.timers.has(key)) return
    this.arm(key, at, fire)
  }

  drop(key: string): void {
    const timer = this.timers.get(key)
    this.moments.delete(key)
    if (timer == null) return
    clearTimeout(timer)
    this.timers.delete(key)
  }

  has(key: string): boolean {
    return this.timers.has(key)
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.moments.clear()
  }
}
