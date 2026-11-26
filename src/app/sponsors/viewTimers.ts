/** How long a sponsored row must stay on screen to be a view. */
export const ROW_VIEW_MS = 5000

export interface ViewTimers {
  /** The keys on screen now; each one new to it starts its own timer. */
  update: (keys: readonly string[]) => void
  /** Cancels every timer, as for a screen that has gone. */
  stop: () => void
}

/**
 * Timers for keys on screen: `onSeen(key)` once a key has stayed in
 * `update`'s set for `ms` without leaving it. Leaving cancels its timer and
 * coming back starts a new one, so each stay of `ms` is a view of its own.
 * Keys time separately. Pure but for the timer it is given.
 */
export function viewTimers(
  onSeen: (key: string) => void,
  {
    ms = ROW_VIEW_MS,
    setTimer = (run: () => void, wait: number): unknown =>
      setTimeout(run, wait),
    clearTimer = (handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  }: {
    ms?: number
    setTimer?: (run: () => void, wait: number) => unknown
    clearTimer?: (handle: unknown) => void
  } = {}
): ViewTimers {
  /** Each key on screen, and its timer while it has not yet been seen. */
  const shown = new Map<string, unknown>()
  return {
    update: keys => {
      const now = new Set(keys)
      for (const [key, handle] of shown)
        if (!now.has(key)) {
          if (handle != null) clearTimer(handle)
          shown.delete(key)
        }
      for (const key of now)
        if (!shown.has(key))
          shown.set(
            key,
            setTimer(() => {
              if (!shown.has(key)) return
              shown.set(key, null)
              onSeen(key)
            }, ms)
          )
    },
    stop: () => {
      for (const handle of shown.values())
        if (handle != null) clearTimer(handle)
      shown.clear()
    }
  }
}
