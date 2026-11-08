/** How long a resync's reconnects and reads are spread over, unless given. */
export const RESYNC_SPREAD_MS = 30_000

/**
 * How long one screen notice's `changed` frames are spread over, so the
 * screens following a scope do not all read at the same instant. Well inside
 * the 3 s each screen already waits between its reads.
 */
export const SCREEN_NOTICE_SPREAD_MS = 1000

/**
 * Runs `act` once for each item, each at its own random moment within
 * `windowMs`, so what reaches many clients at once, a resync after a gap in the
 * feed or one screen notice, does not bring them all back at the same instant.
 * 0 acts at once.
 *
 * The items are those of this moment: one that arrives later read current data
 * and is left alone. One that leaves meanwhile is for `act` to skip, by looking
 * at it when its turn comes.
 *
 * `timers` holds what is still to run, so its owner can clear them on closing.
 * They do not keep the process up. One `act` throwing stops no other, and is
 * logged after `label`, which names what was spread.
 */
export function spread<T>(
  label: string,
  items: Iterable<T>,
  windowMs: number,
  act: (item: T) => void,
  timers = new Set<ReturnType<typeof setTimeout>>()
): void {
  const run = (item: T): void => {
    try {
      act(item)
    } catch (error) {
      console.error(`${label}: ${String(error)}`)
    }
  }
  for (const item of [...items]) {
    if (windowMs <= 0) {
      run(item)
      continue
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      run(item)
    }, Math.random() * windowMs)
    timer.unref()
    timers.add(timer)
  }
}
