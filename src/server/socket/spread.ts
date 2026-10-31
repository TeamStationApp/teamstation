/** How long a resync's reconnects and reads are spread over, unless given. */
export const RESYNC_SPREAD_MS = 30_000

/**
 * Runs `act` once for each item, each at its own random moment within
 * `resyncSpreadMs`, so a gap in the feed does not bring every client back at
 * the same instant. 0 acts at once.
 *
 * The items are those of this moment: one that arrives later read current data
 * and is left alone. One that leaves meanwhile is for `act` to skip, by looking
 * at it when its turn comes.
 *
 * `timers` holds what is still to run, so its owner can clear them on closing.
 * They do not keep the process up. One `act` throwing stops no other.
 */
export function spread<T>(
  items: Iterable<T>,
  resyncSpreadMs: number,
  act: (item: T) => void,
  timers = new Set<ReturnType<typeof setTimeout>>()
): void {
  const run = (item: T): void => {
    try {
      act(item)
    } catch (error) {
      console.error(`resync: ${String(error)}`)
    }
  }
  for (const item of [...items]) {
    if (resyncSpreadMs <= 0) {
      run(item)
      continue
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      run(item)
    }, Math.random() * resyncSpreadMs)
    timer.unref()
    timers.add(timer)
  }
}
