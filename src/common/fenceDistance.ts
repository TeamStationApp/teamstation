/**
 * How far the home-run fence stands from home plate, in whole feet.
 *
 * The scorer places the ball on a field whose fence is a circle, so where the
 * ball landed says how far it went only once the fence has a size. A game
 * takes its own, else its season's, else its league's, else this one: the
 * youth fields TeamStation scores are about 200 feet to the wall.
 */
export const DEFAULT_FENCE_DISTANCE_FT = 200

/** The database refuses a fence further out than this. */
export const MAX_FENCE_DISTANCE_FT = 600

/** Whole feet, more than none and at most `MAX_FENCE_DISTANCE_FT`. */
export function isFenceDistance(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_FENCE_DISTANCE_FT
  )
}

/**
 * The body that sets a fence distance, or clears it with `null` so the level
 * above decides. A `TypeError` names what is wrong.
 */
export function asFenceDistanceBody(raw: unknown): {
  fenceDistanceFt: number | null
} {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw))
    throw new TypeError('The body must be { fenceDistanceFt }')
  const { fenceDistanceFt } = raw as Record<string, unknown>
  if (fenceDistanceFt === null) return { fenceDistanceFt: null }
  if (!isFenceDistance(fenceDistanceFt))
    throw new TypeError(
      `fenceDistanceFt must be whole feet from 1 to ${MAX_FENCE_DISTANCE_FT}, or null`
    )
  return { fenceDistanceFt }
}
