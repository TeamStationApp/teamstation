import { createHash } from 'node:crypto'

import { type ApiKeyPool, normalizedKeys } from '../common/aiKeys'

/**
 * The key each pool is on: its first until that one fails, then whichever
 * took over. Providers cache prompts per account, so every request stays on
 * one key for as long as it works. Kept per process, by the pool's keys.
 */
const current = new Map<string, string>()

const poolId = (keys: readonly string[]): string =>
  createHash('sha256').update(keys.join('\n')).digest('hex')

/**
 * The order to try a pool in: the key it is on, then the keys after it in
 * the pool's order, round to the ones before. A duplicate never buys another
 * attempt.
 */
export function orderedKeys(pool: ApiKeyPool): string[] {
  const keys = normalizedKeys(pool)
  const at = Math.max(0, keys.indexOf(current.get(poolId(keys)) ?? ''))
  return [...keys.slice(at), ...keys.slice(0, at)]
}

/** `key` answered: the pool stays on it until it fails. */
export function keyAnswered(pool: ApiKeyPool, key: string): void {
  const id = poolId(normalizedKeys(pool))
  if (current.get(id) === key) return
  current.delete(id)
  current.set(id, key)
  // A pool edited many times leaves old entries; keep the newest.
  if (current.size > 100) current.delete(current.keys().next().value!)
}

/** Every pool back on its first key. For tests. */
export function forgetCurrentKeys(): void {
  current.clear()
}

export function retryableStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  )
}

/**
 * A refusal another key may fix. Both providers answer some key and account
 * trouble with a plain 400: Anthropic an account out of credit, xAI a wrong
 * or revoked key. A 400 that names neither is the request's own fault.
 */
export function keyMayHelp(status: number, body = ''): boolean {
  return (
    retryableStatus(status) ||
    (status === 400 &&
      /credit|billing|api[ _-]?key|quota|spending limit/i.test(body))
  )
}

/**
 * Says that a request passed over a key: which purpose, which key by its
 * place in the pool and a fingerprint (never the key), and why. A dead key
 * shows in the log long before its pool runs out.
 */
export function passedOver(
  purpose: string,
  pool: ApiKeyPool,
  key: string,
  why: string
): void {
  const keys = normalizedKeys(pool)
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 8)
  console.error(
    `${purpose}: API key ${keys.indexOf(key) + 1} of ${keys.length} (${fingerprint}) failed, ${why}; trying the next`
  )
}

/** Provider text may quote what it was sent: never the key, never at length. */
export function redacted(text: string, key: string): string {
  return (key === '' ? text : text.split(key).join('[redacted]')).slice(0, 200)
}

/** Throw the actual latest failure, preserving the caller's error contract. */
export async function withApiKeys<T>(
  pool: ApiKeyPool,
  attempt: (key: string) => Promise<T>,
  retryable: (error: unknown) => boolean,
  purpose: string
): Promise<T> {
  const keys = orderedKeys(pool)
  if (keys.length === 0) throw new Error('No API keys are configured')
  for (let i = 0; ; i++) {
    try {
      const result = await attempt(keys[i])
      keyAnswered(pool, keys[i])
      return result
    } catch (error) {
      if (i === keys.length - 1 || !retryable(error)) throw error
      // Messages here are the callers' own, with no provider text in them.
      passedOver(
        purpose,
        pool,
        keys[i],
        error instanceof Error ? error.message : 'an error'
      )
    }
  }
}

/**
 * `withApiKeys` for an attempt that answers its failures rather than throwing
 * them. `failed` says of an answer whether it is a failure, why, and whether
 * another key may help. The result is the first answer that is not a
 * failure, or the latest one; undefined for an empty pool.
 */
export async function untilAnswered<T>(
  pool: ApiKeyPool,
  attempt: (key: string) => Promise<T>,
  failed: (answer: T) => { retry: boolean; why: string } | undefined,
  purpose: string
): Promise<T | undefined> {
  class Failed extends Error {
    constructor(
      readonly answer: T,
      readonly retry: boolean,
      why: string
    ) {
      super(why)
    }
  }
  if (normalizedKeys(pool).length === 0) return undefined
  try {
    return await withApiKeys(
      pool,
      async key => {
        const answer = await attempt(key)
        const failure = failed(answer)
        if (failure != null)
          throw new Failed(answer, failure.retry, failure.why)
        return answer
      },
      error => error instanceof Failed && error.retry,
      purpose
    )
  } catch (error) {
    if (error instanceof Failed) return error.answer
    throw error
  }
}
