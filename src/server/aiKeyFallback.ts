import { createHash } from 'node:crypto'

import { type ApiKeyPool, normalizedKeys } from '../common/aiKeys'

/** A new random order for each request; a duplicate never buys another attempt. */
export function shuffledKeys(
  pool: ApiKeyPool,
  random: () => number = Math.random
): string[] {
  const keys = normalizedKeys(pool)
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  return keys
}

/** The key that last answered for each conversation, most recent last. */
const answered = new Map<string, string>()
const ANSWERED_LIMIT = 1000

/**
 * The order to try a pool in. Without `affinity`, random. With one (a
 * conversation, a scorer's connection), the same order for every request it
 * makes, starting at the key that last answered it: providers cache prompts
 * per account, so moving between keys mid-conversation pays for the prompt
 * again. Different conversations still spread across the pool.
 */
export function orderedKeys(
  pool: ApiKeyPool,
  affinity?: string,
  random: () => number = Math.random
): string[] {
  if (affinity == null) return shuffledKeys(pool, random)
  const rank = (key: string): string =>
    createHash('sha256').update(`${affinity}\0${key}`).digest('hex')
  const keys = normalizedKeys(pool).sort((a, b) =>
    rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0
  )
  const last = answered.get(affinity)
  return last == null || !keys.includes(last)
    ? keys
    : [last, ...keys.filter(key => key !== last)]
}

function remember(affinity: string | undefined, key: string): void {
  if (affinity == null) return
  answered.delete(affinity)
  answered.set(affinity, key)
  if (answered.size > ANSWERED_LIMIT)
    answered.delete(answered.keys().next().value!)
}

export function retryableStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
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
  affinity?: string
): Promise<T> {
  const keys = orderedKeys(pool, affinity)
  if (keys.length === 0) throw new Error('No API keys are configured')
  for (let i = 0; ; i++) {
    try {
      const result = await attempt(keys[i])
      remember(affinity, keys[i])
      return result
    } catch (error) {
      if (i === keys.length - 1 || !retryable(error)) throw error
    }
  }
}

/**
 * `withApiKeys` for an attempt that answers its failures rather than throwing
 * them: the first answer `failed` does not claim, or the latest one;
 * undefined for an empty pool.
 */
export async function untilAnswered<T>(
  pool: ApiKeyPool,
  attempt: (key: string) => Promise<T>,
  failed: (answer: T) => 'retry' | 'final' | false,
  affinity?: string
): Promise<T | undefined> {
  class Failed extends Error {
    constructor(readonly answer: T) {
      super('The attempt answered a failure')
    }
  }
  if (normalizedKeys(pool).length === 0) return undefined
  try {
    return await withApiKeys(
      pool,
      async key => {
        const answer = await attempt(key)
        if (failed(answer) !== false) throw new Failed(answer)
        return answer
      },
      error => error instanceof Failed && failed(error.answer) === 'retry',
      affinity
    )
  } catch (error) {
    if (error instanceof Failed) return error.answer
    throw error
  }
}
