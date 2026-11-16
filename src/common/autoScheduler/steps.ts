/** Consume cooperative engine steps synchronously for pure callers and tests. */
export function finishSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next()
    if (next.done === true) return next.value
  }
}

/**
 * A turn for rendering and input. A message channel's task is not held back
 * the way a background tab holds back timers, so a search keeps going while
 * the admin looks at another tab; where there is none, a timer.
 */
export async function yieldTurn(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    return
  }
  // Typed by hand: the browser's and Node's MessagePort types differ, and
  // both have onmessage, close and postMessage at run time.
  const channel = new MessageChannel() as unknown as {
    port1: { onmessage: (() => void) | null; close: () => void }
    port2: { postMessage: (message: null) => void }
  }
  await new Promise<void>(resolve => {
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** Give rendering and input a turn throughout a device search. */
export async function finishStepsAsync<T>(
  steps: Generator<void, T>,
  pause: () => Promise<void> = yieldTurn
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
