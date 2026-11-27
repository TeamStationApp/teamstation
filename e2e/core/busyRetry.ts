/**
 * The stack's password sign-in hashes on the API worker, two accounts at a
 * time and one at a time per account (`PasswordHasher.run`), and answers
 * "Password verification is busy" beyond that. Parallel scenarios hit it, so
 * a harness sign-in tries again, with jittered backoff, until it gets in or
 * its budget is spent. Any other failure is the sign-in's own and is thrown
 * at once.
 */

export interface BusyRetryOptions {
  /** How long to keep trying, from the first try. */
  budgetMs?: number
  /** The first wait; each next one doubles, up to `maxDelayMs`. */
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** 0 ≤ x < 1, for the jitter. */
  random?: () => number
  now?: () => number
}

export const BUSY_BUDGET_MS = 60_000

/** The API's answer while every password job is taken. */
export function isPasswordBusy(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return (
    code === 'unavailable' &&
    typeof message === 'string' &&
    /password verification is busy/i.test(message)
  )
}

const realSleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** `attempt`'s answer, tried again while the stack's password hashing is busy. */
export async function retryWhileBusy<T>(
  what: string,
  attempt: () => Promise<T>,
  options: BusyRetryOptions = {}
): Promise<T> {
  const budgetMs = options.budgetMs ?? BUSY_BUDGET_MS
  const baseDelayMs = options.baseDelayMs ?? 250
  const maxDelayMs = options.maxDelayMs ?? 4000
  const sleep = options.sleep ?? realSleep
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const start = now()
  for (let tries = 1; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      if (!isPasswordBusy(error)) throw error
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (tries - 1))
      // Half the ceiling plus a random half: parallel sign-ins spread out.
      const delay = Math.round(ceiling / 2 + random() * (ceiling / 2))
      const elapsed = now() - start
      if (elapsed + delay > budgetMs) {
        throw new Error(
          `${what}: the stack's password verification stayed busy for ${Math.round(elapsed / 1000)} s (${tries} tries)`,
          { cause: error }
        )
      }
      await sleep(delay)
    }
  }
}
