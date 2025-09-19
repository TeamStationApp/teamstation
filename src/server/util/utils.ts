import type nano from 'nano'

/**
 * Removes _id and _rev from a CouchDb document.
 */
export function cleanCouchDoc<T>(doc: T & nano.Document): T {
  const out = { ...doc } as any
  delete out._id
  delete out._rev
  return out as T
}

/**
 * Helps TypeScript see that Array.filter is removing undefined values.
 */
export function exists<T>(x: T | null | undefined): x is T {
  return x != null
}

/**
 * Calls the provided function,
 * turning exceptions into undefined return values.
 */
export function safelyCall<In extends any[], Out>(
  f: (...args: In) => Out,
  ...args: In
): Out | undefined {
  try {
    return f(...args)
  } catch (e) {}
}
