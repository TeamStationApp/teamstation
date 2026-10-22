/** A source of numbers in [0, 1), the same sequence for the same seed. */
export type Random = () => number

/**
 * The mulberry32 generator: small, fast and good enough for a search. The
 * engine never uses `Math.random`, so a run is repeatable from its seed.
 */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A whole number from 0 up to, not including, `length`. */
export function randomIndex(random: Random, length: number): number {
  return Math.min(length - 1, Math.floor(random() * length))
}

/** A copy of the items in an order the generator picks. */
export function shuffled<T>(items: readonly T[], random: Random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(random, i + 1)
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

/** The seed of the `k`th search run after the first. */
export function nthSeed(seed: number, k: number): number {
  return (seed + Math.imul(k, 0x9e3779b9)) >>> 0
}
