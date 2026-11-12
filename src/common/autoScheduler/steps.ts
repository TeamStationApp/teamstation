/** Consume cooperative engine steps synchronously for pure callers and tests. */
export function finishSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}

/** Give rendering and input a turn throughout a device search. */
export async function finishStepsAsync<T>(
  steps: Generator<void, T>,
  pause: () => Promise<void> = async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
): Promise<T> {
  await pause()
  let until = Date.now() + 8
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
    if (Date.now() >= until) {
      await pause()
      until = Date.now() + 8
    }
  }
}
