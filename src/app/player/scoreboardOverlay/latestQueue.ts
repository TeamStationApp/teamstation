/**
 * Runs one task at a time, and of those asked for while one runs, only the
 * newest: each answer still lands in the order asked, so an older one never
 * goes on top of a newer one.
 *
 * A scrub asks for the board and the box score around every frame it passes.
 * Each of those queued behind the last kept the requests coming for seconds
 * after the finger lifted — a one-second drag over a long game was a hundred
 * of them, one after another.
 */
export function latestQueue(): (task: () => Promise<void>) => void {
  let running = false
  let next: (() => Promise<void>) | null = null
  const pump = async (): Promise<void> => {
    running = true
    while (next != null) {
      const task = next
      next = null
      try {
        await task()
      } catch {
        // The task's own; the next one runs all the same.
      }
    }
    running = false
  }
  return task => {
    next = task
    if (!running) pump().catch(() => undefined)
  }
}
