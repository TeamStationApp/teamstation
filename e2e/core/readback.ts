import {
  SCORING_FEATURE_HEADER,
  SCORING_FEATURES
} from '../../src/common/scoring/teamRecord'

/**
 * Reads stored state back through the API, so "shown" can be told from "saved". Pass
 * the result to `expect` in a checkpoint's `readBack`.
 */
export async function readJson(
  origin: string,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  // It reads as this checkout's app does, naming the scoring records it can
  // read: the API refuses a game's newer records to a reader that does not.
  const headers = new Headers(init.headers)
  if (!headers.has(SCORING_FEATURE_HEADER))
    headers.set(SCORING_FEATURE_HEADER, SCORING_FEATURES)
  const response = await fetch(new URL(path, origin), { ...init, headers })
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
