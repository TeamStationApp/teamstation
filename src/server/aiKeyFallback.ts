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

export function retryableStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  )
}

/** Throw the actual latest failure, preserving the caller's error contract. */
export async function withApiKeys<T>(
  pool: ApiKeyPool,
  attempt: (key: string) => Promise<T>,
  retryable: (error: unknown) => boolean
): Promise<T> {
  const keys = shuffledKeys(pool)
  if (keys.length === 0) throw new Error('No API keys are configured')
  for (let i = 0; ; i++) {
    try {
      return await attempt(keys[i])
    } catch (error) {
      if (i === keys.length - 1 || !retryable(error)) throw error
    }
  }
}
