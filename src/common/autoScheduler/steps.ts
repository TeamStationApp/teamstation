/** Consume cooperative engine steps synchronously for pure callers and tests. */
export function finishSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}
