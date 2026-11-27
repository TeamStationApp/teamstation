/** Thrown by `withTimeout` when `work` did not settle in time. */
export class TimeoutError extends Error {
  name = 'TimeoutError'
}

/**
 * `work`, or a `TimeoutError` carrying `message` once `ms` pass first. The
 * work itself is not stopped: a caller that holds a resource it makes must
 * still release it when it settles late.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(message))
    }, ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}
