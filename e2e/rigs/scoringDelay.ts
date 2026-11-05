/** Repeatable scheduling variation; baseball outcomes remain deterministic. */
export function scoringDelay(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error(
      'Concurrent scoring delay seed must be an unsigned 32-bit integer'
    )
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % 251
  }
}
