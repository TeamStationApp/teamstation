/**
 * Reads stored state back through the API, so "shown" can be told from "saved". Pass
 * the result to `expect` in a checkpoint's `readBack`.
 */
export async function readJson(
  origin: string,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await fetch(new URL(path, origin), init)
  if (!response.ok) {
    throw new Error(
      `Read-back of ${path} answered ${response.status}, not the stored state`
    )
  }
  return await response.json()
}

/** Asks until `check` stops throwing, for state a job or a socket writes shortly. */
export async function eventually(
  check: () => Promise<void>,
  timeoutMs = 10000,
  stepMs = 200
): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= end) throw error
    }
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}
